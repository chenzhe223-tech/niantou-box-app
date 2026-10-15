/**
 * 打开应用时给「还没分类」的念头补一次分类。
 *
 * 为什么需要这一步：分类只在「首页写下念头」时触发，而念头还有另外两条入口——
 * 旧设备迁移上云的、以及官网快速记录直接进收件箱的。这两类只有原文、没有分类，
 * 用户打开收件箱会看到一片「未分类」。这里的补分类把这三条入口拉齐。
 *
 * 只做加法：不覆盖用户手动选过的分类，失败时静默放弃（下次打开再试），
 * 未登录或本次构建没配云端地址时直接跳过，不发任何请求。
 */

import { useEffect, useMemo } from 'react';
import { classifyUncategorizedIdeas } from '../services/aiClassify';
import type { Idea } from '../types/idea';

export function useCategoryBackfill(ideas: Idea[], signedIn: boolean): void {
  const uncategorized = useMemo(
    () => ideas.filter((idea) => idea.deletedAt === null && idea.category === null).length,
    [ideas],
  );

  useEffect(() => {
    if (!signedIn || uncategorized === 0) return;
    // 服务层自带「同时只跑一轮」的保护，这里可以放心地按数据变化重复调用。
    void classifyUncategorizedIdeas();
  }, [signedIn, uncategorized]);
}
