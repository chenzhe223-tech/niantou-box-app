/**
 * 本地数据服务测试。
 *
 * 使用 fake-indexeddb 在 Node 中模拟真实的 IndexedDB，
 * 因此这里验证的是「真的写进了数据库」，而不是 React 里的临时状态。
 */

import { describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from './idb';
import {
  NianBoxError,
  createIdea,
  getCounts,
  getIdea,
  getProject,
  getProjectByIdeaId,
  listIdeas,
  listProjects,
  purgeDeletedIdeas,
  purgeIdea,
  purgeProject,
  restoreIdea,
  restoreProject,
  setIdeaPinned,
  softDeleteIdea,
  softDeleteProject,
  subscribeToChanges,
  updateIdea,
  updateProject,
  upgradeIdeaToProject,
} from './storage';

const LONG_CONTENT = [
  '城市通勤里的小问题：地下车库入口没有实时空位提示。',
  '我试过在入口绕两圈，最后还是停在过道上被贴了条。',
  '🏎️🚗 如果入口就能看到哪一层还有几个位置，就不会堵在坡道上。',
  '参考链接：https://example.com/parking?layer=b2&status=free#top',
  '特殊字符：<script>、&、“引号”、\'单引号\'、emoji 👨‍👩‍👧‍👦 都应当原样保存。',
].join('\n');

/**
 * 等待真实时间推进。
 *
 * 这里刻意不使用 vi.useFakeTimers()：fake-indexeddb 依赖真实的事件循环来
 * 派发数据库请求，一旦伪造计时器，写库的 Promise 永远不会 resolve。
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('念头：创建', () => {
  it('成功创建记录，并写入必要的默认值', async () => {
    const idea = await createIdea({ content: '  停车场找车位的效率问题  ' });

    expect(idea.id).toMatch(/^idea_/);
    // 正文保留用户原始输入（包括首尾空格），不做改写。
    expect(idea.content).toBe('  停车场找车位的效率问题  ');
    expect(idea.title).toBe('');
    expect(idea.status).toBe('inbox');
    expect(idea.category).toBeNull();
    expect(idea.tags).toEqual([]);
    expect(idea.pinned).toBe(false);
    expect(idea.projectId).toBeNull();
    expect(idea.deletedAt).toBeNull();
    expect(idea.createdAt).toBe(idea.updatedAt);
  });

  it('拒绝保存空内容或纯空白内容', async () => {
    await expect(createIdea({ content: '' })).rejects.toBeInstanceOf(NianBoxError);
    await expect(createIdea({ content: '   \n\t  ' })).rejects.toThrow('内容为空');
    expect(await listIdeas()).toHaveLength(0);
  });

  it('接受分类、状态与标签，并过滤掉空标签', async () => {
    const idea = await createIdea({
      content: '做一个自动检查页面适配的 Skill',
      category: 'skill',
      status: 'research',
      tags: ['  适配  ', '', '   '],
    });

    expect(idea.category).toBe('skill');
    expect(idea.status).toBe('research');
    expect(idea.tags).toEqual(['适配']);
  });

  it('非法分类与状态会回落到安全默认值', async () => {
    const idea = await createIdea({
      content: '一条内容',
      category: 'not-a-category' as never,
      status: 'nope' as never,
    });

    expect(idea.category).toBeNull();
    expect(idea.status).toBe('inbox');
  });

  it('每次创建都会生成不同的 ID', async () => {
    const first = await createIdea({ content: '第一条' });
    const second = await createIdea({ content: '第二条' });
    expect(first.id).not.toBe(second.id);
  });
});

describe('念头：读取与持久化', () => {
  it('关闭并重新打开数据库连接后，记录依然存在（模拟刷新页面）', async () => {
    const created = await createIdea({ content: '刷新之后我应该还在' });
    await closeDatabase();
    // 重新建立连接，等价于浏览器刷新后重新打开数据库。
    await openDatabase();

    const reloaded = await getIdea(created.id);
    expect(reloaded?.content).toBe('刷新之后我应该还在');
    expect(reloaded?.createdAt).toBe(created.createdAt);
  });

  it('长文本、Emoji、中文与 URL 都能原样保存', async () => {
    const created = await createIdea({ content: LONG_CONTENT, title: '🅿️ 车位雷达' });
    await closeDatabase();
    await openDatabase();

    const reloaded = await getIdea(created.id);
    expect(reloaded?.content).toBe(LONG_CONTENT);
    expect(reloaded?.title).toBe('🅿️ 车位雷达');
    expect(reloaded?.content.startsWith('城市通勤里的小问题')).toBe(true);
  });

  it('getIdea 对不存在的 ID 返回 null', async () => {
    expect(await getIdea('idea_missing')).toBeNull();
  });
});

describe('念头：更新', () => {
  it('更新字段时保持 ID 与创建时间不变，并推进更新时间', async () => {
    const created = await createIdea({ content: '原始正文' });
    expect(created.updatedAt).toBe(created.createdAt);

    await sleep(15);

    const updated = await updateIdea(created.id, {
      title: '补一个标题',
      content: '更新后的正文',
      status: 'ready',
      tags: ['效率'],
    });

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(created.createdAt);
    expect(updated.title).toBe('补一个标题');
    expect(updated.content).toBe('更新后的正文');
    expect(updated.status).toBe('ready');
    expect(updated.tags).toEqual(['效率']);
  });

  it('更新会真正落库，重新读取即可看到', async () => {
    const created = await createIdea({ content: '第一版想法' });
    await updateIdea(created.id, { notes: '补充：可以先做最简版本' });

    const reloaded = await getIdea(created.id);
    expect(reloaded?.notes).toBe('补充：可以先做最简版本');
  });

  it('不允许把正文清空', async () => {
    const created = await createIdea({ content: '不能变空的正文' });
    await expect(updateIdea(created.id, { content: '   ' })).rejects.toThrow('正文不能为空');
    expect((await getIdea(created.id))?.content).toBe('不能变空的正文');
  });

  it('更新不存在的记录会抛出可读错误', async () => {
    await expect(updateIdea('idea_missing', { title: 'x' })).rejects.toThrow(
      '这条念头不存在',
    );
  });
});

describe('念头：置顶', () => {
  it('置顶后排在列表最前，取消置顶后恢复原顺序', async () => {
    const first = await createIdea({ content: '最早的念头' });
    // 毫秒级时间戳可能相同，这里显式等待，确保两条记录的时间戳有先后之分。
    await sleep(5);
    const second = await createIdea({ content: '稍晚的念头' });

    // 默认按更新时间倒序：后创建的排在前面。
    expect((await listIdeas()).map((idea) => idea.id)).toEqual([second.id, first.id]);

    await setIdeaPinned(first.id, true);
    const pinnedList = await listIdeas();
    expect(pinnedList[0].id).toBe(first.id);
    expect(pinnedList[0].pinned).toBe(true);

    await setIdeaPinned(first.id, false);
    const restored = await listIdeas();
    // 置顶 / 取消置顶不算内容修改，排序应回到原来的顺序。
    expect(restored.map((idea) => idea.id)).toEqual([second.id, first.id]);
  });

  it('置顶状态写入数据库，不会随刷新丢失', async () => {
    const idea = await createIdea({ content: '需要长期跟进' });
    await setIdeaPinned(idea.id, true);
    await closeDatabase();
    await openDatabase();

    expect((await getIdea(idea.id))?.pinned).toBe(true);
  });
});

describe('念头：删除与恢复', () => {
  it('软删除后不出现在默认列表，但保留在回收站中', async () => {
    const idea = await createIdea({ content: '误删的念头' });
    await softDeleteIdea(idea.id);

    expect(await listIdeas()).toHaveLength(0);
    expect((await listIdeas({ onlyDeleted: true })).map((item) => item.id)).toEqual([idea.id]);
    expect(await listIdeas({ includeDeleted: true })).toHaveLength(1);
    expect((await getIdea(idea.id))?.deletedAt).not.toBeNull();
  });

  it('恢复后重新回到收件箱，正文不变', async () => {
    const idea = await createIdea({ content: '需要恢复的念头' });
    await softDeleteIdea(idea.id);
    const restored = await restoreIdea(idea.id);

    expect(restored.deletedAt).toBeNull();
    expect(restored.content).toBe('需要恢复的念头');
    expect(restored.createdAt).toBe(idea.createdAt);
    expect(await listIdeas()).toHaveLength(1);
  });

  it('永久删除会同时清除关联项目，避免悬空引用', async () => {
    const idea = await createIdea({ content: '要被彻底删除的念头' });
    const { project } = await upgradeIdeaToProject(idea.id);

    await purgeIdea(idea.id);

    expect(await getIdea(idea.id)).toBeNull();
    expect(await getProject(project.id)).toBeNull();
  });

  it('清空回收站只删除已软删除的念头', async () => {
    const kept = await createIdea({ content: '保留的念头' });
    const removed = await createIdea({ content: '要清掉的念头' });
    await softDeleteIdea(removed.id);

    expect(await purgeDeletedIdeas()).toBe(1);
    expect((await listIdeas()).map((item) => item.id)).toEqual([kept.id]);
  });

  it('恢复不存在的记录会抛出可读错误', async () => {
    await expect(restoreIdea('idea_missing')).rejects.toThrow('这条念头不存在');
  });
});

describe('念头：搜索与筛选', () => {
  it('关键词可以命中正文、标题、备注与标签（英文不区分大小写）', async () => {
    const byContent = await createIdea({ content: 'Parking Radar 的想法' });
    const byTitle = await createIdea({ content: '正文里没有线索', title: 'Parking 助手' });
    const byNotes = await createIdea({ content: '另一条', notes: 'PARKING 是关键词' });
    const byTag = await createIdea({ content: '再一条', tags: ['parking'] });
    await createIdea({ content: '与关键词无关的一条' });

    const found = await listIdeas({ keyword: 'parking' });
    expect(found.map((idea) => idea.id).sort()).toEqual(
      [byContent.id, byTitle.id, byNotes.id, byTag.id].sort(),
    );
  });

  it('中文关键词同样可以命中', async () => {
    const target = await createIdea({ content: '下班路上想到的找车位问题' });
    await createIdea({ content: '完全无关的记录' });

    const found = await listIdeas({ keyword: '车位' });
    expect(found.map((idea) => idea.id)).toEqual([target.id]);
  });

  it('按分类筛选，并支持「未分类」', async () => {
    const life = await createIdea({ content: '生活问题一条', category: 'life' });
    const app = await createIdea({ content: 'App 创意一条', category: 'app' });
    const none = await createIdea({ content: '还没分类的一条' });

    expect((await listIdeas({ category: 'life' })).map((idea) => idea.id)).toEqual([life.id]);
    expect((await listIdeas({ category: 'app' })).map((idea) => idea.id)).toEqual([app.id]);
    expect((await listIdeas({ category: 'uncategorized' })).map((idea) => idea.id)).toEqual([
      none.id,
    ]);
  });

  it('按状态筛选', async () => {
    const ready = await createIdea({ content: '准备开发的一条', status: 'ready' });
    await createIdea({ content: '还在待整理的一条' });

    expect((await listIdeas({ status: 'ready' })).map((idea) => idea.id)).toEqual([ready.id]);
    expect(await listIdeas({ status: 'done' })).toHaveLength(0);
  });

  it('只看置顶', async () => {
    const pinned = await createIdea({ content: '置顶的念头' });
    await createIdea({ content: '普通念头' });
    await setIdeaPinned(pinned.id, true);

    expect((await listIdeas({ pinnedOnly: true })).map((idea) => idea.id)).toEqual([pinned.id]);
  });

  it('筛选条件可以叠加，并且只返回未删除的记录', async () => {
    const target = await createIdea({ content: '车位助手', category: 'app', status: 'ready' });
    await createIdea({ content: '车位助手（已删除）', category: 'app', status: 'ready' });
    const deleted = await listIdeas({ keyword: '已删除' });
    await softDeleteIdea(deleted[0].id);

    const found = await listIdeas({ keyword: '车位', category: 'app', status: 'ready' });
    expect(found.map((idea) => idea.id)).toEqual([target.id]);
  });
});

describe('统计与变更通知', () => {
  it('getCounts 统计有效记录、回收站、置顶与项目', async () => {
    const kept = await createIdea({ content: '有效记录' });
    const deleted = await createIdea({ content: '已删除记录' });
    await softDeleteIdea(deleted.id);
    await setIdeaPinned(kept.id, true);
    await upgradeIdeaToProject(kept.id);

    const counts = await getCounts();
    expect(counts).toEqual({ active: 1, deleted: 1, total: 2, pinned: 1, projects: 1 });
  });

  it('每次写入都会通知订阅者，取消订阅后不再收到通知', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToChanges(listener);

    await createIdea({ content: '触发一次变更' });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await createIdea({ content: '再触发一次变更' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('创意项目', () => {
  it('升级为项目会保留到原始念头的关联，并推进状态', async () => {
    const idea = await createIdea({
      content: '开发一个帮助检查 App 页面适配的 Skill',
      problem: '页面适配检查靠人眼，容易漏',
      targetUsers: '独立开发者',
      productForm: 'skill',
      projectUrl: 'https://github.com/example/adapt-check',
    });

    const { idea: upgradedIdea, project } = await upgradeIdeaToProject(idea.id);

    expect(project.ideaId).toBe(idea.id);
    expect(upgradedIdea.projectId).toBe(project.id);
    expect(upgradedIdea.status).toBe('ready');
    // 项目沿用念头里已经填写的信息。
    expect(project.problem).toBe('页面适配检查靠人眼，容易漏');
    expect(project.targetUsers).toBe('独立开发者');
    expect(project.productForm).toBe('skill');
    expect(project.repoUrl).toBe('https://github.com/example/adapt-check');
    expect(project.name.length).toBeGreaterThan(0);
  });

  it('关联关系是双向的，可以按念头反查项目', async () => {
    const idea = await createIdea({ content: '双向关联检查' });
    const { project } = await upgradeIdeaToProject(idea.id);

    expect((await getProjectByIdeaId(idea.id))?.id).toBe(project.id);
    expect((await getIdea(idea.id))?.projectId).toBe(project.id);
  });

  it('重复升级同一条念头不会创建第二个项目', async () => {
    const idea = await createIdea({ content: '重复升级检查' });
    const first = await upgradeIdeaToProject(idea.id);
    const second = await upgradeIdeaToProject(idea.id);

    expect(second.project.id).toBe(first.project.id);
    expect(await listProjects()).toHaveLength(1);
  });

  it('已经处于开发中的念头不会被升级操作回退状态', async () => {
    const idea = await createIdea({ content: '正在开发中的念头', status: 'building' });
    const { idea: upgraded } = await upgradeIdeaToProject(idea.id);
    expect(upgraded.status).toBe('building');
  });

  it('更新项目时保持 ID、关联念头与创建时间不变', async () => {
    const idea = await createIdea({ content: '项目更新检查' });
    const { project } = await upgradeIdeaToProject(idea.id);

    const updated = await updateProject(project.id, {
      name: '车位雷达',
      progress: 'building',
      liveUrl: 'https://example.com/car',
    });

    expect(updated.id).toBe(project.id);
    expect(updated.ideaId).toBe(idea.id);
    expect(updated.createdAt).toBe(project.createdAt);
    expect(updated.name).toBe('车位雷达');
    expect(updated.progress).toBe('building');
    expect(updated.liveUrl).toBe('https://example.com/car');
    expect((await getProject(project.id))?.progress).toBe('building');
  });

  it('项目支持软删除、恢复与永久删除', async () => {
    const idea = await createIdea({ content: '项目回收站检查' });
    const { project } = await upgradeIdeaToProject(idea.id);

    await softDeleteProject(project.id);
    expect(await listProjects()).toHaveLength(0);
    expect(await listProjects(true)).toHaveLength(1);

    await restoreProject(project.id);
    expect(await listProjects()).toHaveLength(1);

    await purgeProject(project.id);
    expect(await getProject(project.id)).toBeNull();
    // 念头本身不受影响，只是不再指向已删除的项目。
    expect(await getIdea(idea.id)).not.toBeNull();
  });
});
