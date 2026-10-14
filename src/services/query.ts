/**
 * 纯函数版的搜索 / 筛选 / 排序逻辑。
 *
 * 数据服务与界面共用同一份实现，避免「服务里筛一遍、界面里再筛一遍」
 * 导致两边行为不一致。
 */

import type { Idea, IdeaQuery } from '../types/idea';

export function matchesIdeaQuery(idea: Idea, query: IdeaQuery): boolean {
  if (query.onlyDeleted) {
    if (idea.deletedAt === null) return false;
  } else if (!query.includeDeleted && idea.deletedAt !== null) {
    return false;
  }

  if (query.pinnedOnly && !idea.pinned) return false;

  if (query.category === 'uncategorized') {
    if (idea.category !== null) return false;
  } else if (query.category) {
    if (idea.category !== query.category) return false;
  }

  if (query.status && idea.status !== query.status) return false;

  const keyword = query.keyword?.trim().toLowerCase();
  if (keyword) {
    const haystack = [
      idea.title,
      idea.content,
      idea.notes,
      idea.problem,
      idea.targetUsers,
      idea.tags.join(' '),
    ]
      .join('\n')
      .toLowerCase();
    if (!haystack.includes(keyword)) return false;
  }

  return true;
}

export function filterIdeas(ideas: readonly Idea[], query: IdeaQuery = {}): Idea[] {
  const filtered = ideas.filter((idea) => matchesIdeaQuery(idea, query));
  return sortIdeas(filtered, query);
}

export function sortIdeas(ideas: readonly Idea[], query: IdeaQuery = {}): Idea[] {
  const sortField: 'createdAt' | 'updatedAt' = query.sort ?? 'updatedAt';
  const factor = (query.order ?? 'desc') === 'asc' ? 1 : -1;

  return [...ideas].sort((a, b) => {
    // 置顶的念头始终排在最前（回收站视图也保持一致）。
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const delta = (a[sortField] - b[sortField]) * factor;
    if (delta !== 0) return delta;
    return a.createdAt - b.createdAt;
  });
}
