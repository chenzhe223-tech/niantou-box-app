/**
 * AI 隐私海报页。
 *
 * 这一页的每一步都围绕「不泄露原始念头」来设计，界面上写的每句话都必须与实际行为一致：
 *
 * 1. **先抽象，再画图。** 第一步把念头提炼成主题 / 情绪 / 隐喻 / 视觉元素，
 *    并把这次抽象用的是哪家服务如实写出来（没配模型时写明是服务端规则抽象）。
 * 2. **原文不进图像模型。** 抽象结果会先在服务端做一次隐私检查；不通过就直接停下，
 *    界面明确写「已停止生成」，不会生成任何图片。
 * 3. **没有图像服务就不假装有。** 服务端未配置图像服务时改由本机 Canvas 绘制品牌模板，
 *    并明确标注「本机绘制，不是 AI 生成」。
 * 4. 原始念头不会被写进海报：本机模板只用抽象结果里的主题词与情绪词。
 */

import { useCallback, useMemo, useState } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { paths } from '../app/routes';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { useCloudSync } from '../hooks/useCloudSync';
import { track } from '../services/analytics';
import { CloudError, describeCloudError } from '../services/cloud/cloudClient';
import {
  POSTER_ASPECTS,
  POSTER_STYLES,
  abstractionInput,
  downloadPoster,
  getPosterStyle,
  renderLocalPoster,
  requestAbstraction,
  requestPoster,
  sharePoster,
  type AbstractionResult,
  type PosterAspect,
  type PosterImageResult,
  type PosterStyleId,
} from '../services/poster';
import { displayTitle, type Idea } from '../types/idea';

/** 从服务端的 422 响应里取出隐私检查明细。 */
function extractViolations(error: unknown): string[] {
  if (!(error instanceof CloudError)) return [];
  try {
    const parsed = JSON.parse(error.detail) as { privacy?: { violations?: unknown } };
    const list = parsed?.privacy?.violations;
    return Array.isArray(list)
      ? list.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function isPrivacyStop(error: unknown): boolean {
  return error instanceof CloudError && error.status === 422;
}

type Phase = 'ready' | 'abstracting' | 'rendering' | 'blocked';

export function PosterPage({
  ideaId,
  navigate,
}: {
  ideaId: string | null;
  navigate: (hash: string) => void;
}) {
  const { ideas } = useAppData();
  const toast = useToast();
  const sync = useCloudSync();

  const activeIdeas = useMemo(() => ideas.filter((idea) => idea.deletedAt === null), [ideas]);

  const [selectedId, setSelectedId] = useState<string | null>(ideaId);
  const [style, setStyle] = useState<PosterStyleId>('brand');
  const [aspect, setAspect] = useState<PosterAspect>('3:4');
  const [phase, setPhase] = useState<Phase>('ready');
  const [abstracted, setAbstracted] = useState<AbstractionResult | null>(null);
  const [poster, setPoster] = useState<PosterImageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopReason, setStopReason] = useState<{ message: string; violations: string[] } | null>(
    null,
  );

  /** 入口来源：从某条念头进来，还是从海报工具页自己挑一条。 */
  const entrySource: 'idea_detail' | 'inbox' = ideaId ? 'idea_detail' : 'inbox';

  const idea: Idea | null = useMemo(
    () => (selectedId ? activeIdeas.find((item) => item.id === selectedId) ?? null : null),
    [activeIdeas, selectedId],
  );

  const chooseIdea = (next: Idea) => {
    setSelectedId(next.id);
    setPhase('ready');
    setAbstracted(null);
    setPoster(null);
    setError(null);
    setStopReason(null);
  };

  /** 第一步：抽象 + 隐私检查。 */
  const runAbstraction = useCallback(async (target: Idea) => {
    setPhase('abstracting');
    setError(null);
    setStopReason(null);
    setPoster(null);
    try {
      const result = await requestAbstraction(abstractionInput(target));
      setAbstracted(result);
      setPhase('ready');
    } catch (caught) {
      setAbstracted(null);
      if (isPrivacyStop(caught)) {
        setStopReason({
          message: describeCloudError(caught),
          violations: extractViolations(caught),
        });
        setPhase('blocked');
        return;
      }
      setError(describeCloudError(caught));
      setPhase('ready');
    }
  }, []);

  /** 第二步：把抽象结果交给图像模型；服务端没有图像服务时改由本机绘制。 */
  const runPoster = useCallback(
    async (
      target: Idea,
      nextStyle: PosterStyleId,
      nextAspect: PosterAspect,
      abstraction: AbstractionResult,
    ) => {
      setPhase('rendering');
      setError(null);
      try {
        const generated = await requestPoster({
          style: nextStyle,
          aspect: nextAspect,
          abstraction: abstraction.abstraction,
          original: target.content,
        });
        if (generated) {
          setPoster(generated);
          setPhase('ready');
          track('poster_used', {
            source: entrySource,
            style: nextStyle,
            aspect: nextAspect,
            render: 'ai',
            result: 'ok',
          });
          return;
        }

        // 服务端明确表示没有配置图像服务：本机画一张品牌模板，并如实标注。
        const local = await renderLocalPoster({
          style: nextStyle,
          aspect: nextAspect,
          abstraction: abstraction.abstraction,
        });
        setPoster({
          render: 'local',
          dataUrl: local.dataUrl,
          provider: '',
          promptPreview: '',
          privacy: abstraction.privacy,
        });
        setPhase('ready');
        track('poster_used', {
          source: entrySource,
          style: nextStyle,
          aspect: nextAspect,
          render: 'local',
          result: 'ok',
        });
      } catch (caught) {
        setPoster(null);
        if (isPrivacyStop(caught)) {
          setStopReason({
            message: describeCloudError(caught),
            violations: extractViolations(caught),
          });
          setPhase('blocked');
          track('poster_used', {
            source: entrySource,
            style: nextStyle,
            aspect: nextAspect,
            result: 'skipped',
          });
          return;
        }
        setError(describeCloudError(caught));
        setPhase('ready');
        track('poster_used', {
          source: entrySource,
          style: nextStyle,
          aspect: nextAspect,
          result: 'error',
        });
      }
    },
    [entrySource],
  );

  const fileName = useMemo(() => {
    const base = idea ? displayTitle(idea).slice(0, 12) : '灵感';
    return `nianbox-poster-${base}-${style}-${aspect.replace(':', 'x')}.png`;
  }, [idea, style, aspect]);

  const handleDownload = () => {
    if (!poster) return;
    downloadPoster(poster.dataUrl, fileName);
    toast.push({ message: '已保存到本机下载目录。', tone: 'success' });
  };

  const handleShare = async () => {
    if (!poster) return;
    const result = await sharePoster(
      poster.dataUrl,
      fileName,
      '用念头盒把这条念头变成了一张灵感海报。',
    );
    if (result === 'unsupported') {
      toast.push({ message: '这台设备的浏览器不支持系统分享，可以先下载再分享。', tone: 'info' });
    } else if (result === 'failed') {
      toast.push({ message: '分享没有完成，图片还在，可以再试一次。', tone: 'info' });
    }
  };

  const currentStyle = getPosterStyle(style);
  const busy = phase === 'abstracting' || phase === 'rendering';

  /* ---------------------------------------------------------------- 没有念头 */

  if (activeIdeas.length === 0) {
    return (
      <div className="nb-page">
        <div className="nb-backbar">
          <button type="button" className="nb-backbar__back" onClick={() => navigate(paths.inbox)}>
            <Icon name="back" size={18} />
            收件箱
          </button>
        </div>
        <EmptyState
          icon="sparkle"
          title="还没有可以做成海报的念头。"
          description="先记下一个念头，再回来把它变成一张灵感海报。"
          action={
            <Button variant="primary" icon="plus" onClick={() => navigate(paths.home)}>
              去记一个念头
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="nb-page">
      <div className="nb-backbar">
        <button
          type="button"
          className="nb-backbar__back"
          onClick={() => navigate(ideaId ? paths.idea(ideaId) : paths.inbox)}
        >
          <Icon name="back" size={18} />
          {ideaId ? '这条念头' : '收件箱'}
        </button>
      </div>

      <div className="nb-page__head">
        <h1 className="nb-page__title">生成灵感海报</h1>
        <p className="nb-page__lead">
          先把念头抽象成主题与情绪，再交给图像模型。海报里不会出现原文，也不会把原文直接发给图像模型。
        </p>
      </div>

      {!sync.configured ? (
        <div className="nb-notice nb-notice--warn">
          <p className="nb-notice__title">这个构建没有配置云端地址</p>
          <p>
            抽象与图像生成都在服务端完成，没有云端地址时无法使用。可以去「云端同步」页查看接入方式。
          </p>
          <div className="nb-actionbar">
            <Button size="sm" variant="secondary" onClick={() => navigate(paths.cloud)}>
              查看云端同步
            </Button>
          </div>
        </div>
      ) : !sync.signedIn ? (
        <div className="nb-notice nb-notice--warn">
          <p className="nb-notice__title">需要先登录</p>
          <p>生成海报会调用服务端，需要登录账号才能进行。登录只用来确认这些念头属于你。</p>
          <div className="nb-actionbar">
            <Button size="sm" variant="primary" onClick={() => navigate(paths.cloud)}>
              去登录
            </Button>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------------------ 选一条念头 */}
      <section className="nb-section" aria-labelledby="nb-poster-pick">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-poster-pick">
            1. 选一条念头
          </h2>
          {idea ? <span className="nb-section__hint">已选：{displayTitle(idea)}</span> : null}
        </div>
        {idea && ideaId ? (
          <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
            <p className="nb-kv">
              正在为「<strong>{displayTitle(idea)}</strong>」生成海报。
            </p>
            <p className="nb-kv">想换一条，回到收件箱从「生成海报」重新进入即可。</p>
          </div>
        ) : (
          <div className="nb-card nb-card--pad">
            <div
              className="nb-chips nb-poster__ideas"
              role="group"
              aria-label="选择用于生成海报的念头"
            >
              {activeIdeas.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === selectedId ? 'nb-chip nb-chip--active' : 'nb-chip'}
                  aria-pressed={item.id === selectedId}
                  onClick={() => chooseIdea(item)}
                >
                  {displayTitle(item)}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {idea ? (
        <>
          {/* ------------------------------------------------------- 抽象与隐私 */}
          <section className="nb-section" aria-labelledby="nb-poster-abstract">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-poster-abstract">
                2. 抽象与隐私检查
              </h2>
              <span className="nb-section__hint">
                {abstracted
                  ? abstracted.source === 'ai'
                    ? '模型抽象'
                    : '服务端规则抽象'
                  : '还没开始'}
              </span>
            </div>

            <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
              <p className="nb-kv">
                这一步只发送念头的标题与正文，用来提炼主题、情绪、隐喻与视觉元素。
                {abstracted && abstracted.source === 'ai'
                  ? `这次抽象由 ${abstracted.service || '服务端配置的模型'} 处理。`
                  : '目前没有接入文本模型，这一步由服务端规则在账号内完成，内容不会离开你的账号。'}
              </p>

              {abstracted ? (
                <>
                  <ul className="nb-kvlist">
                    <li className="nb-kvlist__row">
                      <span className="nb-kvlist__label">主题</span>
                      <span className="nb-kvlist__value">{abstracted.abstraction.theme || '—'}</span>
                    </li>
                    <li className="nb-kvlist__row">
                      <span className="nb-kvlist__label">情绪</span>
                      <span className="nb-kvlist__value">
                        {abstracted.abstraction.mood.join(' · ') || '—'}
                      </span>
                    </li>
                    <li className="nb-kvlist__row">
                      <span className="nb-kvlist__label">隐喻</span>
                      <span className="nb-kvlist__value">
                        {abstracted.abstraction.metaphor || '—'}
                      </span>
                    </li>
                    <li className="nb-kvlist__row">
                      <span className="nb-kvlist__label">视觉元素</span>
                      <span className="nb-kvlist__value">
                        {abstracted.abstraction.visuals.join(' · ') || '—'}
                      </span>
                    </li>
                  </ul>
                  <p className="nb-kv">
                    隐私检查：{abstracted.privacy.safe ? '通过，抽象结果里没有出现原文或个人信息。' : '未通过。'}
                  </p>
                  {abstracted.message ? <p className="nb-kv">{abstracted.message}</p> : null}
                </>
              ) : (
                <p className="nb-kv">还没有抽象结果。点下面的按钮开始。</p>
              )}

              <div className="nb-actionbar">
                <Button
                  variant="primary"
                  icon="sparkle"
                  disabled={busy}
                  onClick={() => {
                    void runAbstraction(idea);
                  }}
                >
                  {phase === 'abstracting' ? '正在抽象…' : abstracted ? '重新抽象' : '开始抽象'}
                </Button>
              </div>
            </div>

            {stopReason ? (
              <div className="nb-notice nb-notice--danger" role="alert">
                <p className="nb-notice__title">已停止生成</p>
                <p>{stopReason.message}</p>
                {stopReason.violations.length > 0 ? (
                  <ul className="nb-notice__list">
                    {stopReason.violations.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="nb-kv">
                  没有生成任何图片。可以先把念头里的个人信息删掉，再回来重试。
                </p>
              </div>
            ) : null}

            {error ? (
              <div className="nb-notice nb-notice--warn" role="status">
                <p className="nb-notice__title">这一步没有完成</p>
                <p>{error}</p>
                <p className="nb-kv">念头本身没有变化，仍然完整保存在你的收件箱里。</p>
              </div>
            ) : null}
          </section>

          {/* ------------------------------------------------------- 风格与比例 */}
          <section className="nb-section" aria-labelledby="nb-poster-style">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-poster-style">
                3. 选风格与比例
              </h2>
            </div>
            <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
              <div>
                <p className="nb-field__label" id="nb-poster-style-label">
                  海报风格
                </p>
                <div
                  className="nb-poster__styles"
                  role="group"
                  aria-labelledby="nb-poster-style-label"
                >
                  {POSTER_STYLES.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={
                        item.id === style ? 'nb-poster__style nb-poster__style--active' : 'nb-poster__style'
                      }
                      aria-pressed={item.id === style}
                      disabled={busy}
                      onClick={() => setStyle(item.id)}
                    >
                      <span className="nb-poster__style-name">{item.label}</span>
                      <span className="nb-poster__style-desc">{item.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="nb-field__label" id="nb-poster-aspect-label">
                  画面比例
                </p>
                <div
                  className="nb-chips"
                  role="group"
                  aria-labelledby="nb-poster-aspect-label"
                >
                  {POSTER_ASPECTS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={item.value === aspect ? 'nb-chip nb-chip--active' : 'nb-chip'}
                      aria-pressed={item.value === aspect}
                      disabled={busy}
                      onClick={() => setAspect(item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="nb-actionbar">
                <Button
                  variant="primary"
                  icon="sparkle"
                  disabled={busy || !abstracted || phase === 'blocked'}
                  onClick={() => {
                    if (abstracted) void runPoster(idea, style, aspect, abstracted);
                  }}
                >
                  {phase === 'rendering' ? '正在生成…' : poster ? '用这个风格重新生成' : '生成海报'}
                </Button>
                {!abstracted ? <span className="nb-kv">先完成上一步的抽象。</span> : null}
              </div>
            </div>
          </section>

          {/* ------------------------------------------------------------ 预览 */}
          <section className="nb-section" aria-labelledby="nb-poster-preview">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-poster-preview">
                4. 预览与保存
              </h2>
              {poster ? (
                <span className="nb-section__hint">
                  {poster.render === 'ai'
                    ? `图像模型生成${poster.provider ? `（${poster.provider}）` : ''}`
                    : '本机绘制，不是 AI 生成'}
                </span>
              ) : null}
            </div>

            {poster ? (
              <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
                <div className="nb-poster__preview">
                  <img className="nb-poster__image" src={poster.dataUrl} alt={`${currentStyle.label}灵感海报预览`} />
                </div>
                <p className="nb-kv">
                  {poster.render === 'ai'
                    ? '这张图由图像模型根据抽象结果生成，提示词里只有主题、情绪与视觉元素，没有念头原文。'
                    : '服务端没有配置图像生成服务，所以这张图是在这台设备上用品牌模板绘制的，不是 AI 生成的图片。'}
                </p>
                {poster.render === 'ai' && poster.promptPreview ? (
                  <details className="nb-disclosure">
                    <summary className="nb-disclosure__summary">
                      <span>查看这次实际使用的图像提示词</span>
                      <span className="nb-disclosure__chevron" aria-hidden="true">
                        <Icon name="chevron" size={18} />
                      </span>
                    </summary>
                    <div className="nb-disclosure__body">
                      <p className="nb-kv nb-poster__prompt">{poster.promptPreview}</p>
                    </div>
                  </details>
                ) : null}
                <div className="nb-actionbar">
                  <Button variant="primary" icon="download" onClick={handleDownload}>
                    下载海报
                  </Button>
                  <Button variant="secondary" icon="external" onClick={() => void handleShare()}>
                    系统分享
                  </Button>
                  <Button
                    variant="ghost"
                    icon="refresh"
                    disabled={busy || !abstracted}
                    onClick={() => {
                      if (abstracted) void runPoster(idea, style, aspect, abstracted);
                    }}
                  >
                    重新生成
                  </Button>
                </div>
              </div>
            ) : (
              <div className="nb-card nb-card--pad">
                <p className="nb-kv">还没有海报。完成上面的两步之后，预览会出现在这里。</p>
              </div>
            )}
          </section>
        </>
      ) : (
        <EmptyState
          icon="sparkle"
          title="先选一条念头"
          description="从上面的列表里挑一条，再开始抽象与生成。"
        />
      )}
    </div>
  );
}
