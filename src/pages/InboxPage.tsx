/**
 * 念头收件箱：集中展示、搜索、筛选、置顶、编辑、删除与批量流转。
 *
 * 筛选与排序复用服务层的纯函数实现（filterIdeas），
 * 避免界面与数据层出现两套不一致的规则。
 * 多选模式用来做批量「发送邮件 / 交给 AI / 生成海报」：
 * 开启后点卡片是选或取消选，不会跳转，避免误触打断批量操作。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { paths } from '../app/routes';
import { AiToolDialog } from '../components/AiToolDialog';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { IdeaCard } from '../components/IdeaCard';
import { MailDialog } from '../components/MailDialog';
import { useToast } from '../components/Toast';
import { isIdeaPending, useCloudSync } from '../hooks/useCloudSync';
import { useNow } from '../hooks/useNow';
import { track } from '../services/analytics';
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
  const sync = useCloudSync();

  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Idea | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mailOpen, setMailOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

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

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  /**
   * 批量操作只能作用在「当前看得见的记录」上。
   * 筛选条件一变，之前选中的记录可能已经不在列表里，
   * 这时必须把它们从选中集合里摘掉，否则用户会误以为自己在操作屏幕上看到的条目。
   */
  const selectedIdeas = useMemo(
    () => visible.filter((idea) => selectedSet.has(idea.id)),
    [visible, selectedSet],
  );

  useEffect(() => {
    setSelectedIds((previous) => {
      if (previous.length === 0) return previous;
      const alive = new Set(visible.map((idea) => idea.id));
      const next = previous.filter((id) => alive.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [visible]);

  /**
   * 记录「有人用了搜索」这一事实（用于判断搜索值不值得继续做），
   * 但**永远不上报关键词本身**——关键词是用户的灵感，不是运营数据。
   * 停顿 900ms 才算一次，避免边打字边刷事件。
   */
  useEffect(() => {
    if (keyword.trim() === '') return;
    const timer = setTimeout(() => track('search_used'), 900);
    return () => clearTimeout(timer);
  }, [keyword]);

  const resetFilters = () => {
    setKeyword('');
    setCategory('all');
    setStatus('all');
    setPinnedOnly(false);
  };

  const toggleSelect = useCallback((idea: Idea) => {
    setSelectedIds((previous) =>
      previous.includes(idea.id)
        ? previous.filter((id) => id !== idea.id)
        : [...previous, idea.id],
    );
  }, []);

  const enterSelectMode = () => {
    setSelectMode(true);
    setSelectedIds([]);
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds([]);
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

  const requireSelection = (): Idea[] | null => {
    if (selectedIdeas.length === 0) {
      toast.push({ message: '先选至少一条念头。', tone: 'info' });
      return null;
    }
    return selectedIdeas;
  };

  const handleBulkMail = () => {
    if (requireSelection()) setMailOpen(true);
  };

  const handleBulkAi = () => {
    if (requireSelection()) setAiOpen(true);
  };

  const handleBulkPoster = () => {
    const picked = requireSelection();
    if (!picked) return;
    if (picked.length > 1) {
      toast.push({
        message: '灵感海报一次针对一条念头生成，请只选一条。',
        tone: 'info',
      });
      return;
    }
    navigate(paths.poster(picked[0].id));
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
          <button
            type="button"
            className={selectMode ? 'nb-chip nb-chip--active' : 'nb-chip'}
            aria-pressed={selectMode}
            onClick={() => (selectMode ? exitSelectMode() : enterSelectMode())}
          >
            <Icon name="check" size={14} />
            {selectMode ? '退出多选' : '多选'}
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

      {selectMode ? (
        <div className="nb-actionbar" role="group" aria-label="批量操作">
          <span className="nb-kv">
            已选 {selectedIdeas.length} / {visible.length} 条
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon="check"
            disabled={visible.length === 0 || selectedIdeas.length === visible.length}
            onClick={() => setSelectedIds(visible.map((idea) => idea.id))}
          >
            全选
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="close"
            disabled={selectedIdeas.length === 0}
            onClick={() => setSelectedIds([])}
          >
            取消选择
          </Button>
          <Button size="sm" variant="primary" icon="external" onClick={handleBulkMail}>
            发送邮件
          </Button>
          <Button size="sm" variant="secondary" icon="sparkle" onClick={handleBulkAi}>
            交给 AI
          </Button>
          <Button size="sm" variant="secondary" icon="image" onClick={handleBulkPoster}>
            生成海报
          </Button>
        </div>
      ) : null}

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
              pending={isIdeaPending(sync, idea.id)}
              selectable={selectMode}
              selected={selectedSet.has(idea.id)}
              onToggleSelect={toggleSelect}
              onOpen={() => navigate(paths.idea(idea.id))}
              onTogglePin={(target) => {
                void handleTogglePin(target);
              }}
              onRequestDelete={(target) => setPendingDelete(target)}
              onGeneratePoster={(target) => navigate(paths.poster(target.id))}
            />
          ))}
        </ul>
      )}

      <MailDialog
        open={mailOpen}
        ideas={selectedIdeas}
        capabilities={sync.capabilities}
        onClose={() => setMailOpen(false)}
      />

      <AiToolDialog
        open={aiOpen}
        ideas={selectedIdeas}
        source="inbox"
        onClose={() => setAiOpen(false)}
      />

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