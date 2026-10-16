/**
 * 首页 —— 此刻，你想到了什么？
 *
 * 首屏只做一件事：把一句话记下来。其余能力排在次级区域。
 *
 * 三条不许违反的规矩：
 * 1. 打开页面就能输入，不前置登录、不前置配置、不前置分类；
 * 2. 只有真正写进数据库才提示成功，写入失败时保留输入并说明原因；
 * 3. 「生成图片」「交给 AI」这类外部能力，可用与否都如实写出来，
 *    不可用时给出去哪里的指引，不做假的成功提示。
 */

import { useMemo, useState, type FormEvent } from 'react';
import { formatRelative } from '../app/format';
import { useAppData } from '../app/AppDataProvider';
import { paths } from '../app/routes';
import { AiToolDialog } from '../components/AiToolDialog';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { TextArea } from '../components/Fields';
import { IdeaCard } from '../components/IdeaCard';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { useDraft } from '../hooks/useDraft';
import { useNow } from '../hooks/useNow';
import { useWorks } from '../hooks/useWorks';
import { isIdeaPending, useCloudSync } from '../hooks/useCloudSync';
import { classifyIdeaInBackground, trackClassifyOutcome } from '../services/aiClassify';
import { copyText, shareText } from '../services/aiTools';
import { SHARE_UNSUPPORTED_MESSAGE, sharePoster } from '../services/poster';
import { createIdea, setIdeaPinned, softDeleteIdea, toNianBoxError } from '../services/storage';
import { workRenderLabel, type WorkRecord } from '../services/works';
import {
  IDEA_CATEGORIES,
  displayTitle,
  hasSavableContent,
  type Idea,
  type IdeaCategory,
} from '../types/idea';

type CategoryChoice = IdeaCategory | 'none';

const CATEGORY_CHOICES: ReadonlyArray<{ value: CategoryChoice; label: string }> = [
  { value: 'none', label: '不选分类' },
  ...IDEA_CATEGORIES.map((item) => ({ value: item.value, label: item.label })),
];

const PLACEHOLDER = '比如：为什么每次停车时，我明明知道停车场位置，却总是找不到空车位？';
const COMPOSER_ID = 'nb-home-composer';

/**
 * 本机念头卡片的统一说法：不需要登录、不需要联网、不消耗 AI 模型额度。
 * 凡是提到「AI 生图不可用」的地方，都紧跟这一句，明确替代路径一直都在。
 */
const LOCAL_CARD_HINT =
  '不登录也能在这台设备上直接制作本机念头卡片：不需要联网，也不消耗 AI 模型额度，做好之后可以保存到我的作品并分享。';

export function HomePage({ navigate }: { navigate: (hash: string) => void }) {
  const { ideas, projects } = useAppData();
  const toast = useToast();
  const draft = useDraft('home');
  const now = useNow();
  const sync = useCloudSync();
  // 首页只展示最近几件作品：只把这几件作品的图片读进内存，旧图片不参与。
  const works = useWorks({ imageLimit: 4 });

  const [category, setCategory] = useState<CategoryChoice>('none');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 刚保存成功的那条念头：用来展示「下一步能做什么」。 */
  const [savedIdea, setSavedIdea] = useState<Idea | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiIdeas, setAiIdeas] = useState<Idea[]>([]);

  const activeIdeas = useMemo(
    () => ideas.filter((idea) => idea.deletedAt === null),
    [ideas],
  );

  const recent = useMemo(
    () => [...activeIdeas].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4),
    [activeIdeas],
  );

  const activeProjects = useMemo(
    () => projects.filter((project) => project.deletedAt === null),
    [projects],
  );

  const projectNameByIdeaId = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of activeProjects) {
      map.set(project.ideaId, project.name);
    }
    return map;
  }, [activeProjects]);

  /**
   * AI 增强生图的先决条件是「配了云端地址」且「已登录」。
   *
   * 注意：这只是**AI 生图**的前提，不是「能不能做出一张图片」的前提。
   * 没登录时用户照样可以在这台设备上制作本机念头卡片，所以入口按钮不会被禁用。
   */
  const posterReady = sync.configured && sync.signedIn;
  /**
   * 这里只说**原因**，句子的其余部分交给文案拼装。
   * 空字符串表示 AI 增强生图可用；否则是「这台设备上 AI 生图为什么用不了」。
   */
  const posterBlockedReason = !sync.configured
    ? '这个构建没有配置云端地址'
    : !sync.signedIn
      ? '还没有登录云端账号'
      : '';

  /** 首页只展示最近三件作品，其余的走「查看全部」。 */
  const recentWorks = useMemo(() => works.works.slice(0, 3), [works.works]);

  /**
   * 把输入框里的内容真正写进数据库。
   *
   * 成功返回写入的那条念头（调用方可以继续做下一步），失败返回 null 并保留输入。
   * 所有入口（保存 / 生成图片 / 交给 AI）都走这一个函数，避免出现
   * 「界面上说存好了、数据库里其实没有」这种不一致。
   */
  const persistDraft = async (): Promise<Idea | null> => {
    if (saving) return null;

    const content = draft.value;
    if (!hasSavableContent(content)) {
      setError('先写下一句话，再收进念头盒。');
      return null;
    }

    setSaving(true);
    setError(null);
    try {
      const created = await createIdea({
        content,
        category: category === 'none' ? null : category,
      });
      // 只有写入真正成功后才清空输入并提示成功。
      draft.clear();
      setCategory('none');
      toast.push({ message: '收好了，这个念头不会轻易丢失。', tone: 'success' });
      /**
       * 分类是「保存成功之后」的附加动作：
       * 先留住原始内容，再去问 AI；分类失败也不会影响已经存好的念头。
       * 未登录 / 未配置云端时 classifyIdeaInBackground 会静默跳过，不发任何请求。
       */
      classifyIdeaInBackground(created.id, {
        onDone: (outcome) => trackClassifyOutcome(outcome, 'home'),
      });
      return created;
    } catch (caught) {
      const message = toNianBoxError(caught).message;
      setError(message);
      toast.push({ message: `没有保存成功：${message}`, tone: 'error' });
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const created = await persistDraft();
    if (created) setSavedIdea(created);
  };

  /** 首页辅助入口 1：先存好，再直接把这条念头变成图片。 */
  const handleQuickPoster = async () => {
    if (!hasSavableContent(draft.value)) {
      toast.push({
        message: '先写下一句话，或从下面的最近念头里挑一条再生成图片。',
        tone: 'info',
      });
      return;
    }
    const created = await persistDraft();
    if (!created) return;
    setSavedIdea(created);
    navigate(paths.poster(created.id));
  };

  /** 首页辅助入口 2：先存好，再把这条念头交给 AI 工具整理。 */
  const handleQuickAi = async () => {
    if (!hasSavableContent(draft.value)) {
      const target = recent[0];
      if (!target) {
        toast.push({ message: '先写下一句话，再交给 AI 整理。', tone: 'info' });
        return;
      }
      setAiIdeas([target]);
      setAiOpen(true);
      return;
    }
    const created = await persistDraft();
    if (!created) return;
    setSavedIdea(created);
    setAiIdeas([created]);
    setAiOpen(true);
  };

  const handleCopySaved = async () => {
    if (!savedIdea) return;
    const ok = await copyText(savedIdea.content);
    toast.push(
      ok
        ? { message: '内容已复制，可以粘贴到任何地方。', tone: 'success' }
        : { message: '复制没有成功，可以手动选中内容后复制。', tone: 'error' },
    );
  };

  const handleShareSaved = async () => {
    if (!savedIdea) return;
    const result = await shareText('念头盒 · 一条新念头', savedIdea.content);
    if (result === 'unsupported') {
      toast.push({ message: '这台设备的浏览器不支持系统分享，可以先复制内容。', tone: 'info' });
    } else if (result === 'failed') {
      toast.push({ message: '分享没有完成，内容还在，可以再试一次。', tone: 'info' });
    }
  };

  /** 直接分享作品：系统分享用不了时给一条能照着做的替代路径，而不是静默失败。 */
  const handleShareWork = async (work: WorkRecord) => {
    const dataUrl = works.images.get(work.id);
    if (!dataUrl) {
      toast.push({ message: '这件作品的图片数据缺失，暂时无法分享。', tone: 'error' });
      return;
    }
    const result = await sharePoster(dataUrl, `nianbox-work-${work.aspect.replace(':', 'x')}.png`, work.title || '念头盒作品');
    if (result === 'unsupported') {
      toast.push({ message: SHARE_UNSUPPORTED_MESSAGE, tone: 'info' });
    } else if (result === 'failed') {
      toast.push({ message: '分享没有完成，图片还在，可以再试一次。', tone: 'info' });
    }
  };

  const handleTogglePin = async (idea: Idea) => {
    setBusyId(idea.id);
    try {
      await setIdeaPinned(idea.id, !idea.pinned);
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (idea: Idea) => {
    setBusyId(idea.id);
    try {
      await softDeleteIdea(idea.id);
      toast.push({ message: '已移到回收站，可随时恢复。', tone: 'info' });
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="nb-page">
      <div className="nb-hero">
        <h1 className="nb-hero__title">此刻，你想到了什么？</h1>
        <p className="nb-hero__sub">每个好想法，都值得留下。</p>
      </div>

      <form className="nb-composer" onSubmit={handleSubmit} noValidate>
        <TextArea
          id={COMPOSER_ID}
          label="记下一句话就好……"
          value={draft.value}
          onChange={(next) => {
            draft.setValue(next);
            if (error) setError(null);
          }}
          placeholder={PLACEHOLDER}
          rows={6}
          className="nb-composer__textarea"
          hint="不用先想标题，也不用分类。一句话、一个疑问都可以先记下。"
        />

        {error ? (
          <p className="nb-composer__error" role="alert">
            {error}
          </p>
        ) : null}

        {draft.restored ? (
          <div className="nb-draft">
            <span className="nb-draft__text">
              上次还有一段没保存的内容，已经帮你恢复到输入框里。
            </span>
            <Button size="sm" variant="ghost" onClick={draft.discard}>
              丢弃
            </Button>
          </div>
        ) : null}

        <div className="nb-composer__actions">
          <Button type="submit" variant="primary" icon="plus" disabled={saving}>
            {saving ? '正在保存…' : '记下这个念头'}
          </Button>
        </div>

        <div className="nb-quickstart">
          <p className="nb-quickstart__title">记下来之后，还可以马上：</p>
          <div className="nb-quickstart__row">
            <Button
              variant="secondary"
              icon="image"
              disabled={saving}
              onClick={() => {
                void handleQuickPoster();
              }}
            >
              一键生成图片
            </Button>
            <Button
              variant="secondary"
              icon="wand"
              disabled={saving}
              onClick={() => {
                void handleQuickAi();
              }}
            >
              让 AI 帮我整理
            </Button>
          </div>
          <p className="nb-quickstart__note">
            {posterReady
              ? '这两个入口都会先把这句话原样存好，再继续下一步；生成失败也不会影响已经存下的内容。'
              : `AI 增强生图需要云端配置、登录状态和可用的服务端模型，当前${posterBlockedReason}，所以暂时用不了。${LOCAL_CARD_HINT}两个入口都会先把这句话原样存好，再继续下一步。`}
          </p>
        </div>

        <details className="nb-disclosure">
          <summary className="nb-disclosure__summary">
            <span>分类（可以跳过，之后也能改）</span>
            <span className="nb-disclosure__chevron" aria-hidden="true">
              <Icon name="chevron" size={18} />
            </span>
          </summary>
          <div className="nb-disclosure__body">
            <div className="nb-chips" role="group" aria-label="给这条念头选一个分类">
              {CATEGORY_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  className={choice.value === category ? 'nb-chip nb-chip--active' : 'nb-chip'}
                  aria-pressed={choice.value === category}
                  onClick={() => setCategory(choice.value)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        </details>
      </form>

      {/* --------------------------------------------------- 保存成功后的下一步 */}
      {savedIdea ? (
        <section className="nb-card nb-card--pad nb-saved" aria-labelledby="nb-home-saved">
          <div className="nb-saved__head">
            <span className="nb-saved__badge">
              <Icon name="check" size={16} />
            </span>
            <div className="nb-saved__text">
              <h2 className="nb-saved__title" id="nb-home-saved">
                已经收好了。接下来想做什么？
              </h2>
              <p className="nb-saved__preview">{displayTitle(savedIdea)}</p>
            </div>
          </div>

          <div className="nb-actionbar">
            <Button
              variant="primary"
              icon="image"
              onClick={() => navigate(paths.poster(savedIdea.id))}
            >
              把它变成图片
            </Button>
            <Button
              variant="secondary"
              icon="wand"
              onClick={() => {
                setAiIdeas([savedIdea]);
                setAiOpen(true);
              }}
            >
              AI 整理
            </Button>
            <Button
              variant="ghost"
              icon="upload"
              onClick={() => {
                void handleCopySaved();
              }}
            >
              复制内容
            </Button>
            <Button
              variant="ghost"
              icon="external"
              onClick={() => {
                void handleShareSaved();
              }}
            >
              系统分享
            </Button>
            <Button
              variant="ghost"
              icon="plus"
              onClick={() => {
                setSavedIdea(null);
                document.getElementById(COMPOSER_ID)?.focus();
              }}
            >
              继续记录
            </Button>
          </div>

          {!posterReady ? (
            <p className="nb-saved__note">
              {`AI 增强生图需要云端配置、登录状态和可用的服务端模型，当前${posterBlockedReason}，所以暂时用不了。`}
              {LOCAL_CARD_HINT}
              <button
                type="button"
                className="nb-link nb-link--button"
                onClick={() => navigate(paths.cloud)}
              >
                去云端同步页
              </button>
              只在想用 AI 增强生图时才需要配置，制作本机念头卡片不经过这一步。
            </p>
          ) : (
            <p className="nb-saved__note">
              生成图片会先把念头抽象成主题与意象，默认不把原文交给图像模型。
            </p>
          )}
        </section>
      ) : null}

      {/* ------------------------------------------------------------ 最近作品 */}
      <section className="nb-section" aria-labelledby="nb-home-works">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-home-works">
            最近作品
          </h2>
          {works.works.length > 0 ? (
            <button
              type="button"
              className="nb-link nb-link--button"
              onClick={() => navigate(paths.works)}
            >
              查看全部（{works.works.length}）
            </button>
          ) : null}
        </div>

        {recentWorks.length === 0 ? (
          <EmptyState
            icon="image"
            title="还没有保存过作品。"
            description="随手记下一个念头，就能在这台设备上把它排成一张卡片，不用登录，也不会消耗任何模型额度。"
            action={
              <Button variant="secondary" icon="image" onClick={() => navigate(paths.posterTool)}>
                去做第一张卡片
              </Button>
            }
          />
        ) : (
          <>
            <ul className="nb-gallery nb-gallery--compact">
              {recentWorks.map((work) => (
                <li key={work.id} className="nb-gallery__item">
                  <button
                    type="button"
                    className="nb-gallery__thumb"
                    aria-label="打开我的作品"
                    onClick={() => navigate(paths.works)}
                  >
                    {works.images.get(work.id) ? (
                      <img className="nb-gallery__image" src={works.images.get(work.id)} alt="" />
                    ) : (
                      <span className="nb-gallery__missing">图片数据缺失</span>
                    )}
                  </button>
                  <div className="nb-gallery__meta">
                    <p className="nb-gallery__title">{work.title || '（无标题）'}</p>
                    <p className="nb-gallery__sub">
                      {workRenderLabel(work)} · {formatRelative(work.createdAt, now)}
                    </p>
                    <div className="nb-gallery__actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => navigate(paths.poster(work.ideaId))}
                      >
                        继续创作
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void handleShareWork(work)}>
                        分享
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <p className="nb-kv">
              作品只保存在这台设备上，不会自动上传，也不会自动公开。想找以前的图，可以进
              <button
                type="button"
                className="nb-link nb-link--button"
                onClick={() => navigate(paths.works)}
              >
                我的作品
              </button>
              。
            </p>
          </>
        )}
      </section>

      <section className="nb-section" aria-labelledby="nb-home-recent">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-home-recent">
            最近的念头
          </h2>
          {activeIdeas.length > 0 ? (
            <button
              type="button"
              className="nb-link nb-link--button"
              onClick={() => navigate(paths.inbox)}
            >
              重新看看以前的念头
            </button>
          ) : null}
        </div>

        {recent.length === 0 ? (
          <EmptyState
            title="这里还没有念头。"
            description="留意生活中的小问题，它们可能是下一个作品的起点。"
          />
        ) : (
          <ul className="nb-list">
            {recent.map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                now={now}
                busy={busyId === idea.id}
                projectName={projectNameByIdeaId.get(idea.id) ?? null}
                pending={isIdeaPending(sync, idea.id)}
                onOpen={() => navigate(paths.idea(idea.id))}
                onGeneratePoster={(target) => navigate(paths.poster(target.id))}
                onTogglePin={(target) => {
                  void handleTogglePin(target);
                }}
                onRequestDelete={(target) => {
                  void handleDelete(target);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------ 次级信息 */}
      <p className="nb-kv nb-kv--spaced">
        已记录 <strong>{activeIdeas.length}</strong> 条念头 · <strong>{activeProjects.length}</strong>{' '}
        个创意项目 ·{' '}
        {sync.signedIn
          ? '本机保存一份，登录的云端账号里保存一份'
          : '数据保存在这台设备的浏览器里'}
      </p>

      {sync.signedIn ? (
        sync.pendingCount > 0 ? (
          <p className="nb-kv">
            还有 {sync.pendingCount} 项只在本机，联网后会自动同步到云端（也可以到
            <button
              type="button"
              className="nb-link nb-link--button"
              onClick={() => navigate(paths.cloud)}
            >
              云端同步
            </button>
            里手动重试）。
          </p>
        ) : null
      ) : (
        <p className="nb-kv">
          <button
            type="button"
            className="nb-link nb-link--button"
            onClick={() => navigate(paths.cloud)}
          >
            登录云端账号
          </button>
          ，手机和电脑就能共用同一份念头。
        </p>
      )}

      <AiToolDialog
        open={aiOpen}
        ideas={aiIdeas}
        source="home"
        onClose={() => setAiOpen(false)}
      />
    </div>
  );
}
