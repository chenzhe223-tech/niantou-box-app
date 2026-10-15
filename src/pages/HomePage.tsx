/**
 * 首页 —— 随手记。
 *
 * 目标：打开网页即可输入。
 * - 输入框占据视觉中心，不需要先写标题、选分类；
 * - 保存成功才提示成功，写入失败时给出真实错误并保留输入内容；
 * - 未保存内容会在本地留一份草稿，刷新后可恢复（保存成功后静默清除）。
 */

import { useMemo, useState, type FormEvent } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { paths } from '../app/routes';
import { IdeaCard } from '../components/IdeaCard';
import { Button } from '../components/Button';
import { TextArea } from '../components/Fields';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';
import { useDraft } from '../hooks/useDraft';
import { useNow } from '../hooks/useNow';
import { isIdeaPending, useCloudSync } from '../hooks/useCloudSync';
import { classifyIdeaInBackground, trackClassifyOutcome } from '../services/aiClassify';
import { createIdea, setIdeaPinned, softDeleteIdea, toNianBoxError } from '../services/storage';
import {
  IDEA_CATEGORIES,
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

export function HomePage({ navigate }: { navigate: (hash: string) => void }) {
  const { ideas, projects } = useAppData();
  const toast = useToast();
  const draft = useDraft('home');
  const now = useNow();
  const sync = useCloudSync();

  const [category, setCategory] = useState<CategoryChoice>('none');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;

    const content = draft.value;
    if (!hasSavableContent(content)) {
      setError('先写下一句话，再收进念头盒。');
      return;
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
    } catch (caught) {
      const message = toNianBoxError(caught).message;
      setError(message);
      toast.push({ message: `没有保存成功：${message}`, tone: 'error' });
    } finally {
      setSaving(false);
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
        <h1 className="nb-hero__title">念头盒</h1>
        <p className="nb-hero__sub">每个好想法，都值得留下。</p>
      </div>

      <form className="nb-composer" onSubmit={handleSubmit} noValidate>
        <TextArea
          label="现在有什么新念头？"
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

        <div>
          <p className="nb-composer__meta" id="nb-home-category-label">
            <span>分类（可以跳过）</span>
          </p>
          <div className="nb-chips" role="group" aria-labelledby="nb-home-category-label">
            {CATEGORY_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                className={
                  choice.value === category ? 'nb-chip nb-chip--active' : 'nb-chip'
                }
                aria-pressed={choice.value === category}
                onClick={() => setCategory(choice.value)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>

        <div className="nb-composer__actions">
          <Button type="submit" variant="primary" icon="plus" disabled={saving}>
            {saving ? '正在保存…' : '记下这个念头'}
          </Button>
        </div>
      </form>

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
              查看全部
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
    </div>
  );
}
