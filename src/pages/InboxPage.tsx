/**
 * 念头收件箱：集中展示、搜索、筛选、置顶、编辑与删除。
 *
 * 筛选与排序复用服务层的纯函数实现（filterIdeas），
 * 避免界面与数据层出现两套不一致的规则。
 */

import { useMemo, useState } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { paths } from '../app/routes';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { IdeaCard } from '../components/IdeaCard';
import { useToast } from '../components/Toast';
import { useNow } from '../hooks/useNow';
import { filterIdeas } from '../services/query';
import { setIdeaPinned, softDeleteIdea, toNianBoxError } from '../services/storage';
import {
  IDEA_CATEGORIES,
  IDEA_STATUSES,
  displayTitle,
  type Idea,
  type IdeaCategory,
  type IdeaStatus,
} from '../types/idea';

type CategoryFilter = 'all' | 'uncategorized' | IdeaCategory;
type StatusFilter = 'all' | IdeaStatus;

export function InboxPage({ navigate }: { navigate: (hash: string) => void }) {
  const { ideas, projects } = useAppData();
  const toast = useToast();
  const now = useNow();

  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Idea | null>(null);
  const [deleting, setDeleting] = useState(false);

  const activeIdeas = useMemo(() => ideas.filter((idea) => idea.deletedAt === null), [ideas]);

  const visible = useMemo(
    () =>
      filterIdeas(activeIdeas, {
        keyword,
        category: category === 'all' ? null : category,
        status: status === 'all' ? null : status,
        pinnedOnly,
        sort: 'updatedAt',
        order: 'desc',
      }),
    [activeIdeas, keyword, category, status, pinnedOnly],
  );

  const projectNameByIdeaId = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      if (project.deletedAt === null) map.set(project.ideaId, project.name);
    }
    return map;
  }, [projects]);

  const hasFilters = keyword.trim() !== '' || category !== 'all' || status !== 'all' || pinnedOnly;

  const resetFilters = () => {
    setKeyword('');
    setCategory('all');
    setStatus('all');
    setPinnedOnly(false);
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

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await softDeleteIdea(pendingDelete.id);
      toast.push({ message: '已移到回收站，可随时恢复。', tone: 'info' });
      setPendingDelete(null);
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="nb-page">
      <div className="nb-page__head">
        <h1 className="nb-page__title">念头收件箱</h1>
        <p className="nb-page__lead">
          共 {activeIdeas.length} 条念头
          {hasFilters ? `，当前筛选出 ${visible.length} 条` : ''}。
        </p>
      </div>

      <div className="nb-toolbar">
        <div className="nb-toolbar__row">
          <div className="nb-search">
            <span className="nb-search__icon" aria-hidden="true">
              <Icon name="search" size={16} />
            </span>
            <input
              className="nb-input"
              type="search"
              value={keyword}
              aria-label="搜索念头"
              placeholder="搜索正文、标题、备注或标签"
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>
          <button
            type="button"
            className={pinnedOnly ? 'nb-chip nb-chip--active' : 'nb-chip'}
            aria-pressed={pinnedOnly}
            onClick={() => setPinnedOnly((value) => !value)}
          >
            <Icon name="pin" size={14} />
            只看置顶
          </button>
        </div>
        <div className="nb-toolbar__row">
          <select
            className="nb-select nb-select--compact"
            aria-label="按分类筛选"
            value={category}
            onChange={(event) => setCategory(event.target.value as CategoryFilter)}
          >
            <option value="all">全部分类</option>
            <option value="uncategorized">未分类</option>
            {IDEA_CATEGORIES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <select
            className="nb-select nb-select--compact"
            aria-label="按状态筛选"
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
          >
            <option value="all">全部状态</option>
            {IDEA_STATUSES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          {hasFilters ? (
            <Button size="sm" variant="ghost" icon="close" onClick={resetFilters}>
              清除筛选
            </Button>
          ) : null}
        </div>
      </div>

      {activeIdeas.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="这里还没有念头。"
          description="留意生活中的小问题，它们可能是下一个作品的起点。"
          action={
            <Button variant="primary" icon="plus" onClick={() => navigate(paths.home)}>
              记下第一个念头
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="search"
          title="没有找到匹配的念头。"
          description="换个关键词，或者放宽分类与状态筛选试试。"
          action={
            <Button variant="secondary" onClick={resetFilters}>
              清除筛选
            </Button>
          }
        />
      ) : (
        <ul className="nb-list">
          {visible.map((idea) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              now={now}
              busy={busyId === idea.id}
              projectName={projectNameByIdeaId.get(idea.id) ?? null}
              onOpen={() => navigate(paths.idea(idea.id))}
              onTogglePin={(target) => {
                void handleTogglePin(target);
              }}
              onRequestDelete={(target) => setPendingDelete(target)}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        title="删除这条念头？"
        confirmLabel="移到回收站"
        busy={deleting}
        description={
          pendingDelete ? (
            <>
              <p>
                「{displayTitle(pendingDelete)}」会被移到回收站，
                之后仍可以恢复，不会被立即清除。
              </p>
            </>
          ) : null
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          void confirmDelete();
        }}
      />
    </div>
  );
}
