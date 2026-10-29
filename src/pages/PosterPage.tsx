/**
 * 一键生图页 —— 把这个念头变成图片。
 *
 * 与上一版（四步向导）的区别：从某条念头进来时**进来就开始生成**，
 * 用户不需要先点「开始抽象」再点「生成海报」。风格由分类自动匹配，
 * 比例、抽象详情、实际提示词这些高级内容收进折叠区，不影响首次操作。
 *
 * 这一页的每一步都围绕「不泄露原始念头」来设计，界面上写的每句话都必须与实际行为一致：
 *
 * 1. **先抽象，再画图。** 先把念头提炼成主题 / 情绪 / 隐喻 / 视觉元素，
 *    并把这次抽象用的是哪家服务如实写出来（没配模型时写明是服务端规则抽象）。
 * 2. **原文不进图像模型。** 抽象结果会先在服务端做一次隐私检查；不通过就直接停下，
 *    界面明确写「已停止生成」，不会生成任何图片。
 * 3. **没有图像服务就不假装有。** 服务端未配置图像服务时改由本机 Canvas 绘制品牌模板，
 *    并明确标注「本机绘制，不是 AI 生成」。
 * 4. 原始念头不会被写进海报，也不会因为生成图片而改变；生成失败时重试即可。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { paths } from '../app/routes';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { ShareCardPanel } from '../components/ShareCardPanel';
import { useToast } from '../components/Toast';
import { useCloudSync } from '../hooks/useCloudSync';
import { track } from '../services/analytics';
import { CloudError, describeCloudError } from '../services/cloud/cloudClient';
import {
  POSTER_ASPECTS,
  PRIMARY_STYLE_ORDER,
  SECONDARY_STYLE_ORDER,
  SHARE_UNSUPPORTED_MESSAGE,
  STYLE_TONE_LABEL,
  abstractionInput,
  applyBrandFooter,
  autoStyleFor,
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
import { toNianBoxError } from '../services/storage';
import { saveWork } from '../services/works';
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
  /** 自动生成只跑一次：避免重复请求、重复消耗额度。 */
  const autoStarted = useRef(false);

  /** 入口来源：从某条念头进来，还是从海报工具页自己挑一条。 */
  const entrySource: 'idea_detail' | 'inbox' = ideaId ? 'idea_detail' : 'inbox';

  /** 生图的前提：这个构建配了云端地址，并且已经登录。两者缺一都如实说明。 */
  const usable = sync.configured && sync.signedIn;

  /** 每次成功出图后自动写入本机作品库，失败不会让已生成的图片消失。 */
  const saveGeneratedWork = useCallback(
    async (
      target: Idea,
      dataUrl: string,
      render: PosterImageResult['render'],
      nextStyle: PosterStyleId,
      nextAspect: PosterAspect,
    ) => {
      try {
        await saveWork({
          ideaId: target.id,
          source: 'poster',
          render,
          style: nextStyle,
          aspect: nextAspect,
          title: displayTitle(target),
          dataUrl,
        });
        toast.push({ message: '图片已自动归集到「最近作品」，并按关联念头分类。', tone: 'success' });
      } catch (caught) {
        toast.push({
          message: `图片已生成，但自动归集失败：${toNianBoxError(caught).message}。可以先保存图片，稍后重试。`,
          tone: 'error',
          duration: 0,
        });
      }
    },
    [toast],
  );

  const idea: Idea | null = useMemo(
    () => (selectedId ? activeIdeas.find((item) => item.id === selectedId) ?? null : null),
    [activeIdeas, selectedId],
  );

  /** 第一步：抽象 + 隐私检查。成功返回抽象结果，失败返回 null（原因已经写在界面上）。 */
  const runAbstraction = useCallback(async (target: Idea): Promise<AbstractionResult | null> => {
    setPhase('abstracting');
    setError(null);
    setStopReason(null);
    try {
      const result = await requestAbstraction(abstractionInput(target));
      setAbstracted(result);
      setPhase('ready');
      return result;
    } catch (caught) {
      setAbstracted(null);
      if (isPrivacyStop(caught)) {
        setStopReason({
          message: describeCloudError(caught),
          violations: extractViolations(caught),
        });
        setPhase('blocked');
        return null;
      }
      setError(describeCloudError(caught));
      setPhase('ready');
      return null;
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
          // 图像模型给的图不一定干净（免费档会在右下角打水印），
          // 统一裁掉底部一小条并补上品牌页脚 —— 六种风格的海报收尾一致。
          const branded = await applyBrandFooter(generated.dataUrl, nextAspect);
          const finalPoster = branded ? { ...generated, dataUrl: branded } : generated;
          setPoster(finalPoster);
          await saveGeneratedWork(target, finalPoster.dataUrl, finalPoster.render, nextStyle, nextAspect);
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
        const localPoster: PosterImageResult = {
          render: 'local',
          dataUrl: local.dataUrl,
          provider: '',
          promptPreview: '',
          privacy: abstraction.privacy,
        };
        setPoster(localPoster);
        await saveGeneratedWork(target, localPoster.dataUrl, localPoster.render, nextStyle, nextAspect);
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
    [entrySource, saveGeneratedWork],
  );

  /**
   * 一键路径：抽象 + 生成。
   * 已经拿到抽象结果时（换风格、重新生成）不再重复请求抽象。
   */
  const runFlow = useCallback(
    async (
      target: Idea,
      nextStyle: PosterStyleId,
      nextAspect: PosterAspect,
      reuse: AbstractionResult | null,
    ) => {
      const abstraction = reuse ?? (await runAbstraction(target));
      if (!abstraction) return;
      await runPoster(target, nextStyle, nextAspect, abstraction);
    },
    [runAbstraction, runPoster],
  );

  /**
   * 从某条念头直接进来（点「生成图片」）时自动跑一次。
   * 未登录 / 未配置云端时不自动请求任何服务端接口，只显示诚实的说明。
   */
  useEffect(() => {
    if (autoStarted.current) return;
    if (!ideaId || !usable) return;
    const target = activeIdeas.find((item) => item.id === ideaId);
    if (!target) return;
    autoStarted.current = true;
    const matched = autoStyleFor(target);
    setStyle(matched);
    void runFlow(target, matched, aspect, null);
  }, [ideaId, usable, activeIdeas, aspect, runFlow]);

  /** 手动选一条念头：同样直接开始生成，少点一次按钮。 */
  const chooseIdea = (next: Idea) => {
    setSelectedId(next.id);
    setAbstracted(null);
    setPoster(null);
    setError(null);
    setStopReason(null);
    setPhase('ready');
    const matched = autoStyleFor(next);
    setStyle(matched);
    if (usable) void runFlow(next, matched, aspect, null);
  };

  const handleGenerate = () => {
    if (!idea || phase === 'blocked') return;
    void runFlow(idea, style, aspect, abstracted);
  };

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
      toast.push({ message: SHARE_UNSUPPORTED_MESSAGE, tone: 'info' });
    } else if (result === 'failed') {
      toast.push({ message: '分享没有完成，图片还在，可以再试一次。', tone: 'info' });
    }
  };

  const busy = phase === 'abstracting' || phase === 'rendering';
  const recommendedStyle = idea ? autoStyleFor(idea) : null;
  const primaryStyles = PRIMARY_STYLE_ORDER.map((id) => getPosterStyle(id));
  const secondaryStyles = SECONDARY_STYLE_ORDER.map((id) => getPosterStyle(id));

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
          title="还没有可以做成图片的念头。"
          description="先记下一个念头，再回来把它变成一张图片。"
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
        <h1 className="nb-page__title">把这个念头变成图片</h1>
        <p className="nb-page__lead">
          不用自己写提示词。先把念头抽象成主题与情绪，再交给图像模型；海报里不会出现原文，原文也不会直接发给图像模型。
        </p>
      </div>

      {!sync.configured ? (
        <div className="nb-notice nb-notice--warn">
          <p className="nb-notice__title">这个构建没有配置云端地址</p>
          <p>
            AI 增强生图（抽象 + 图像生成）都在服务端完成，没有云端地址时无法使用。这不影响下面：
            你仍然可以立即制作「本机制作的念头卡片」。接入方式写在「云端同步」页。
          </p>
          <div className="nb-actionbar">
            <Button size="sm" variant="secondary" onClick={() => navigate(paths.cloud)}>
              查看云端同步
            </Button>
          </div>
        </div>
      ) : !sync.signedIn ? (
        <div className="nb-notice nb-notice--warn">
          <p className="nb-notice__title">AI 增强生图需要先登录</p>
          <p>
            AI 增强生图会调用服务端模型，需要登录账号才能进行，登录只用来确认这些念头属于你。
            不登录也能继续：下面可以直接制作「本机制作的念头卡片」，同样能保存图片和分享。
          </p>
          <div className="nb-actionbar">
            <Button size="sm" variant="primary" onClick={() => navigate(paths.cloud)}>
              去登录
            </Button>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------ 从工具页进来时先选念头 */}
      {!ideaId ? (
        <section className="nb-section" aria-labelledby="nb-poster-pick">
          <div className="nb-section__head">
            <h2 className="nb-section__title" id="nb-poster-pick">
              选一条念头
            </h2>
            {idea ? <span className="nb-section__hint">已选：{displayTitle(idea)}</span> : null}
          </div>
          <div className="nb-card nb-card--pad">
            <div
              className="nb-chips nb-poster__ideas"
              role="group"
              aria-label="选择用于生成图片的念头"
            >
              {activeIdeas.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === selectedId ? 'nb-chip nb-chip--active' : 'nb-chip'}
                  aria-pressed={item.id === selectedId}
                  disabled={busy}
                  onClick={() => chooseIdea(item)}
                >
                  {displayTitle(item)}
                </button>
              ))}
            </div>
            <p className="nb-kv">
              {usable
                ? '点一条念头就会开始生成，不需要再点别的按钮。'
                : '点一条念头，就能在这台设备上把它排成一张卡片，不用登录。'}
            </p>
          </div>
        </section>
      ) : null}

      {idea && !usable ? (
        /**
         * 未登录 / 没有云端地址时的路：不把用户挡在登录页前，
         * 直接在本机把这条念头排成一张可保存、可分享的卡片。
         * 这里只做本机 Canvas，不发任何网络请求，也不冒充 AI 绘图。
         */
        <>
          <div className="nb-notice" role="status">
            <p className="nb-notice__title">现在能做的是「本机制作的念头卡片」</p>
            <p>
              这不是 AI 绘图，也不会消耗任何模型额度：卡片在这台设备上用 Canvas 排版，不联网、不需要登录，
              品牌星形与配色都来自念头盒自己的设计。AI 增强生图是另一种能力，登录后才可用。
            </p>
          </div>
          <ShareCardPanel idea={idea} defaultOpen />
        </>
      ) : null}

      {usable && idea ? (
        <>
          {/* -------------------------------------------------------- 生成结果 */}
          <section className="nb-section" aria-labelledby="nb-poster-result">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-poster-result">
                1. 生成结果
              </h2>
              <span className="nb-section__hint">
                {phase === 'abstracting'
                  ? '正在抽象…'
                  : phase === 'rendering'
                    ? '正在画图…'
                    : poster
                      ? poster.render === 'ai'
                        ? `图像模型生成${poster.provider ? `（${poster.provider}）` : ''}`
                        : '本机绘制，不是 AI 生成'
                      : '还没生成'}
              </span>
            </div>

            <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
              <p className="nb-kv">
                用「<strong>{displayTitle(idea)}</strong>」生成。原文原样留在收件箱，
                生成图片、换风格、重新生成都不会改动它。
              </p>

              {busy ? (
                <div className="nb-state" role="status" aria-live="polite">
                  <span className="nb-spinner" aria-hidden="true" />
                  <p className="nb-state__title">
                    {phase === 'abstracting' ? '正在把念头抽象成主题与情绪…' : '正在生成图片…'}
                  </p>
                  <p className="nb-state__message">
                    这一步在服务端完成，通常需要几秒；期间按钮不可点，避免重复提交。
                  </p>
                </div>
              ) : null}

              {!busy && poster ? (
                <>
                  <div className="nb-poster__preview">
                    <img
                      className="nb-poster__image"
                      src={poster.dataUrl}
                      alt={`${STYLE_TONE_LABEL[style]}预览`}
                    />
                  </div>
                  <p className="nb-kv">
                    {poster.render === 'ai'
                      ? '这张图由图像模型根据抽象结果生成，提示词里只有主题、情绪与视觉元素，没有念头原文。底部的品牌页脚由念头盒叠加，用来盖住服务商水印。'
                      : '服务端没有配置图像生成服务，所以这张图是在这台设备上用品牌模板绘制的，不是 AI 生成的图片。'}
                  </p>
                  <p className="nb-kv">
                    当前风格：{STYLE_TONE_LABEL[style]} · 比例：{aspect}。
                  </p>
                </>
              ) : null}

              {!busy && !poster && !error && !stopReason ? (
                <p className="nb-kv">还没有图片。点下面的按钮开始，不需要自己写提示词。</p>
              ) : null}

              {!busy && error ? (
                <div className="nb-notice nb-notice--warn" role="status">
                  <p className="nb-notice__title">这次没有生成成功</p>
                  <p>{error}</p>
                  <p className="nb-kv">
                    原始念头没有变化，仍然完整保存在收件箱里；可以再点一次「生成图片」重试。
                  </p>
                </div>
              ) : null}

              {!busy && stopReason ? (
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
                  <div className="nb-actionbar">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="edit"
                      onClick={() => navigate(paths.idea(idea.id))}
                    >
                      回去修改念头
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="nb-actionbar">
                <Button
                  variant="primary"
                  icon="image"
                  disabled={busy || phase === 'blocked'}
                  onClick={handleGenerate}
                >
                  {busy ? '正在生成…' : poster ? '重新生成' : '生成图片'}
                </Button>
                {poster && !busy ? (
                  <>
                    <Button variant="secondary" icon="download" onClick={handleDownload}>
                      保存图片
                    </Button>
                    <Button variant="secondary" icon="external" onClick={() => void handleShare()}>
                      系统分享
                    </Button>
                    <Button
                      variant="secondary"
                      icon="sparkle"
                      onClick={() => {
                        const config = {
                          title: '灵感海报',
                          subtitle: '念头盒 · 灵感视觉作品',
                          signature: 'NIANBOX',
                          theme: 'forest',
                          style: 'editorial',
                          motion: 'rise',
                          duration: 800,
                          fontEn: 'Inter',
                          fontZh: 'Noto Sans SC',
                        };
                        window.open(
                          'https://chenzhe223-tech.github.io/motion-lab/motion-poster.html#poster=' +
                            encodeURIComponent(JSON.stringify(config)),
                          '_blank',
                          'noopener,noreferrer',
                        );
                      }}
                    >
                      统一海报工坊
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          </section>

          {/* ------------------------------------------------------------ 风格 */}
          <section className="nb-section" aria-labelledby="nb-poster-style">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-poster-style">
                2. 换个风格（可选）
              </h2>
              <span className="nb-section__hint">当前：{STYLE_TONE_LABEL[style]}</span>
            </div>
            <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
              <p className="nb-kv">
                默认已经按念头的分类替你选好风格，不挑也能生成。想让画面不一样，点一种风格，再点上面的「重新生成」。
              </p>
              <div className="nb-poster__styles" role="group" aria-label="海报风格">
                {primaryStyles.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={
                      item.id === style
                        ? 'nb-poster__style nb-poster__style--active'
                        : 'nb-poster__style'
                    }
                    aria-pressed={item.id === style}
                    disabled={busy}
                    onClick={() => setStyle(item.id)}
                  >
                    <span className="nb-poster__style-name">
                      {STYLE_TONE_LABEL[item.id]}
                      {recommendedStyle === item.id ? ' · 系统推荐' : ''}
                    </span>
                    <span className="nb-poster__style-desc">{item.description}</span>
                  </button>
                ))}
              </div>

              <details className="nb-disclosure">
                <summary className="nb-disclosure__summary">
                  <span>更多风格（{secondaryStyles.length} 种）</span>
                  <span className="nb-disclosure__chevron" aria-hidden="true">
                    <Icon name="chevron" size={18} />
                  </span>
                </summary>
                <div className="nb-disclosure__body">
                  <div className="nb-poster__styles" role="group" aria-label="更多海报风格">
                    {secondaryStyles.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={
                          item.id === style
                            ? 'nb-poster__style nb-poster__style--active'
                            : 'nb-poster__style'
                        }
                        aria-pressed={item.id === style}
                        disabled={busy}
                        onClick={() => setStyle(item.id)}
                      >
                        <span className="nb-poster__style-name">{STYLE_TONE_LABEL[item.id]}</span>
                        <span className="nb-poster__style-desc">{item.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </details>
            </div>
          </section>
          {/* --------------------------------------------------------- 高级选项 */}
          <section className="nb-section" aria-labelledby="nb-poster-advanced">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-poster-advanced">
                3. 高级选项（可选）
              </h2>
              <span className="nb-section__hint">不打开也能用</span>
            </div>
            <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
              <details className="nb-disclosure">
                <summary className="nb-disclosure__summary">
                  <span>海报比例（当前 {aspect}）</span>
                  <span className="nb-disclosure__chevron" aria-hidden="true">
                    <Icon name="chevron" size={18} />
                  </span>
                </summary>
                <div className="nb-disclosure__body">
                  <div className="nb-chips" role="group" aria-label="海报比例">
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
                  <p className="nb-kv">
                    换比例不会自动重画：上面那张图还是原来的比例，改完点一次「重新生成」才会按新比例出图。
                  </p>
                </div>
              </details>

              <details className="nb-disclosure">
                <summary className="nb-disclosure__summary">
                  <span>抽象结果与隐私检查</span>
                  <span className="nb-disclosure__chevron" aria-hidden="true">
                    <Icon name="chevron" size={18} />
                  </span>
                </summary>
                <div className="nb-disclosure__body">
                  {abstracted ? (
                    <>
                      <p className="nb-kv">
                        {abstracted.source === 'ai'
                          ? `抽象这一步由模型完成${
                              abstracted.service ? `（${abstracted.service}）` : ''
                            }：念头原文只用于抽象，交给图像模型的是下面这些词。`
                          : '服务端没有配置抽象模型，这一步用的是服务端内置规则：念头在服务端被提炼成下面这些词，交给图像模型的同样只有这些词。'}
                      </p>
                      <ul className="nb-kvlist">
                        <li className="nb-kvlist__row">
                          <span className="nb-kvlist__label">主题</span>
                          <span className="nb-kvlist__value">
                            {abstracted.abstraction.theme || '（无）'}
                          </span>
                        </li>
                        <li className="nb-kvlist__row">
                          <span className="nb-kvlist__label">情绪</span>
                          <span className="nb-kvlist__value">
                            {abstracted.abstraction.mood.length > 0
                              ? abstracted.abstraction.mood.join(' · ')
                              : '（无）'}
                          </span>
                        </li>
                        <li className="nb-kvlist__row">
                          <span className="nb-kvlist__label">隐喻</span>
                          <span className="nb-kvlist__value">
                            {abstracted.abstraction.metaphor || '（无）'}
                          </span>
                        </li>
                        <li className="nb-kvlist__row">
                          <span className="nb-kvlist__label">视觉元素</span>
                          <span className="nb-kvlist__value">
                            {abstracted.abstraction.visuals.length > 0
                              ? abstracted.abstraction.visuals.join(' · ')
                              : '（无）'}
                          </span>
                        </li>
                        <li className="nb-kvlist__row">
                          <span className="nb-kvlist__label">隐私检查</span>
                          <span className="nb-kvlist__value">
                            {abstracted.privacy.safe
                              ? '通过：没有发现个人信息或私人项目名'
                              : `未通过：${abstracted.privacy.violations.join('、')}`}
                          </span>
                        </li>
                      </ul>
                      <p className="nb-kv">念头原文不在上面这张表里，也不会被写进海报。</p>
                    </>
                  ) : (
                    <p className="nb-kv">
                      还没有抽象结果。生成一次之后，这里会列出实际交给图像模型的内容，方便你自己核对。
                    </p>
                  )}

                  {poster?.promptPreview ? (
                    <>
                      <p className="nb-kv">服务端实际使用的图像提示词：</p>
                      <p className="nb-poster__prompt">{poster.promptPreview}</p>
                    </>
                  ) : null}
                </div>
              </details>
            </div>
          </section>
        </>
      ) : (
        usable ? (
          <EmptyState
            icon="sparkle"
            title="先选一条念头"
            description="从上面的列表里挑一条，再开始生成。"
          />
        ) : null
      )}
    </div>
  );
}
