/**
 * 念头盒的本地数据服务（IndexedDB 持久化）。
 *
 * 这一层是「唯一」的读写入口：
 * - 页面组件不直接触碰 IndexedDB，全部通过这里的方法；
 * - 所有写入都等待事务真正提交后才返回，界面提示与实际结果一致；
 * - 记录 ID 稳定唯一，编辑不会重新生成 ID，创建时间不会被覆盖。
 */

import {
  STORE_IDEAS,
  STORE_PROJECTS,
  IndexedDbError,
  clearStore,
  deleteRecord,
  openDatabase,
  promisifyRequest,
  readAll,
  readOne,
  transactionDone,
  withTransaction,
} from './idb';
import type { MetaRecord } from './idb';
import {
  DEFAULT_STATUS,
  hasSavableContent,
  type Idea,
  type IdeaPatch,
  type IdeaQuery,
  type NewIdeaInput,
  isIdeaCategory,
  isIdeaStatus,
  isProductForm,
} from '../types/idea';
import {
  DEFAULT_PROGRESS,
  type NewProjectInput,
  type Project,
  type ProjectPatch,
  isProjectProgress,
} from '../types/project';
import { matchesIdeaQuery, sortIdeas } from './query';

export type StorageErrorCode =
  | 'EMPTY_CONTENT'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'STORAGE_UNAVAILABLE';

export class NianBoxError extends Error {
  readonly code: StorageErrorCode;
  readonly cause?: unknown;

  constructor(code: StorageErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'NianBoxError';
    this.code = code;
    this.cause = cause;
  }
}

/** 把底层异常统一转换成可读的中文错误。 */
export function toNianBoxError(error: unknown): NianBoxError {
  if (error instanceof NianBoxError) return error;
  if (error instanceof IndexedDbError) {
    return new NianBoxError('STORAGE_UNAVAILABLE', error.message, error);
  }
  if (error instanceof Error) {
    return new NianBoxError('STORAGE_UNAVAILABLE', `本地存储出错：${error.message}`, error);
  }
  return new NianBoxError('STORAGE_UNAVAILABLE', '本地存储出错，请稍后重试。', error);
}

/** 生成稳定且唯一的记录 ID（编辑时不会重新生成）。 */
export function createId(prefix = 'idea'): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return `${prefix}_${cryptoRef.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/* -------------------------------------------------------------------------- */
/* 变更订阅：页面借此在数据变化后重新加载，避免各处自行轮询。                  */
/* -------------------------------------------------------------------------- */

type ChangeListener = () => void;
const changeListeners = new Set<ChangeListener>();
let changeVersion = 0;

export function subscribeToChanges(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function getChangeVersion(): number {
  return changeVersion;
}

function emitChange(): void {
  changeVersion += 1;
  for (const listener of [...changeListeners]) {
    try {
      listener();
    } catch {
      // 单个订阅者出错不应影响其他订阅者。
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 规范化：读取与导入时都经过这一层，避免残缺数据污染界面。                    */
/* -------------------------------------------------------------------------- */

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

export function normalizeIdea(raw: Partial<Idea> & { id: string }): Idea {
  const createdAt = asTimestamp(raw.createdAt, Date.now());
  const updatedAt = asTimestamp(raw.updatedAt, createdAt);
  return {
    id: raw.id,
    title: asString(raw.title),
    content: asString(raw.content),
    category: isIdeaCategory(raw.category) ? raw.category : null,
    status: isIdeaStatus(raw.status) ? raw.status : DEFAULT_STATUS,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
      : [],
    pinned: raw.pinned === true,
    notes: asString(raw.notes),
    problem: asString(raw.problem),
    targetUsers: asString(raw.targetUsers),
    productForm: isProductForm(raw.productForm) ? raw.productForm : null,
    projectUrl: asString(raw.projectUrl),
    projectId: typeof raw.projectId === 'string' && raw.projectId ? raw.projectId : null,
    createdAt,
    updatedAt,
    deletedAt:
      raw.deletedAt === null || raw.deletedAt === undefined
        ? null
        : asTimestamp(raw.deletedAt, updatedAt),
  };
}

export function normalizeProject(raw: Partial<Project> & { id: string; ideaId: string }): Project {
  const createdAt = asTimestamp(raw.createdAt, Date.now());
  const updatedAt = asTimestamp(raw.updatedAt, createdAt);
  return {
    id: raw.id,
    ideaId: raw.ideaId,
    name: asString(raw.name),
    problem: asString(raw.problem),
    targetUsers: asString(raw.targetUsers),
    features: asString(raw.features),
    productForm: isProductForm(raw.productForm) ? raw.productForm : null,
    progress: isProjectProgress(raw.progress) ? raw.progress : DEFAULT_PROGRESS,
    repoUrl: asString(raw.repoUrl),
    liveUrl: asString(raw.liveUrl),
    createdAt,
    updatedAt,
    deletedAt:
      raw.deletedAt === null || raw.deletedAt === undefined
        ? null
        : asTimestamp(raw.deletedAt, updatedAt),
  };
}

/* -------------------------------------------------------------------------- */
/* 念头：创建 / 查询 / 更新 / 删除 / 恢复 / 置顶                                */
/* -------------------------------------------------------------------------- */

export async function createIdea(input: NewIdeaInput): Promise<Idea> {
  const content = asString(input.content);
  if (!hasSavableContent(content)) {
    throw new NianBoxError('EMPTY_CONTENT', '内容为空，先写下一句话再保存。');
  }

  const now = Date.now();
  const idea: Idea = {
    id: createId('idea'),
    title: asString(input.title),
    content,
    category: isIdeaCategory(input.category) ? input.category : null,
    status: isIdeaStatus(input.status) ? input.status : DEFAULT_STATUS,
    tags: Array.isArray(input.tags)
      ? input.tags.map((tag) => tag.trim()).filter((tag) => tag !== '')
      : [],
    pinned: input.pinned === true,
    notes: asString(input.notes),
    problem: asString(input.problem),
    targetUsers: asString(input.targetUsers),
    productForm: isProductForm(input.productForm) ? input.productForm : null,
    projectUrl: asString(input.projectUrl),
    projectId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  await withTransaction({ stores: [STORE_IDEAS] }, 'readwrite', async (tx) => {
    await promisifyRequest(tx.objectStore(STORE_IDEAS).add(idea));
  });
  emitChange();
  return idea;
}

export async function getIdea(id: string): Promise<Idea | null> {
  const raw = await readOne<Idea>(STORE_IDEAS, id);
  return raw ? normalizeIdea(raw) : null;
}

export async function listIdeas(query: IdeaQuery = {}): Promise<Idea[]> {
  const raw = await readAll<Idea>(STORE_IDEAS);
  const ideas = raw
    .map((item) => normalizeIdea(item))
    .filter((idea) => matchesIdeaQuery(idea, query));
  return sortIdeas(ideas, query);
}

export interface IdeaCounts {
  active: number;
  deleted: number;
  total: number;
  pinned: number;
  projects: number;
}

export async function getCounts(): Promise<IdeaCounts> {
  const [rawIdeas, rawProjects] = await Promise.all([
    readAll<Idea>(STORE_IDEAS),
    readAll<Project>(STORE_PROJECTS),
  ]);
  const ideas = rawIdeas.map((item) => normalizeIdea(item)).filter((idea) => idea.deletedAt === null);
  const deleted = rawIdeas.length - ideas.length;
  return {
    active: ideas.length,
    deleted,
    total: rawIdeas.length,
    pinned: ideas.filter((idea) => idea.pinned).length,
    projects: rawProjects.filter((project) => project.deletedAt === null).length,
  };
}

export async function updateIdea(id: string, patch: IdeaPatch): Promise<Idea> {
  const existing = await getIdea(id);
  if (!existing) {
    throw new NianBoxError('NOT_FOUND', '这条念头不存在，可能已被永久删除。');
  }

  if (patch.content !== undefined && !hasSavableContent(asString(patch.content))) {
    throw new NianBoxError('EMPTY_CONTENT', '正文不能为空，请保留至少一句话。');
  }

  const updated: Idea = {
    ...existing,
    ...patch,
    title: patch.title !== undefined ? asString(patch.title) : existing.title,
    content: patch.content !== undefined ? asString(patch.content) : existing.content,
    category:
      patch.category === undefined
        ? existing.category
        : isIdeaCategory(patch.category)
          ? patch.category
          : null,
    status:
      patch.status === undefined
        ? existing.status
        : isIdeaStatus(patch.status)
          ? patch.status
          : existing.status,
    tags:
      patch.tags === undefined
        ? existing.tags
        : patch.tags.map((tag) => tag.trim()).filter((tag) => tag !== ''),
    productForm:
      patch.productForm === undefined
        ? existing.productForm
        : isProductForm(patch.productForm)
          ? patch.productForm
          : null,
    // 关键：ID 与创建时间永远保持原值。
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Math.max(Date.now(), existing.createdAt),
  };

  await withTransaction({ stores: [STORE_IDEAS] }, 'readwrite', async (tx) => {
    await promisifyRequest(tx.objectStore(STORE_IDEAS).put(updated));
  });
  emitChange();
  return updated;
}

export async function setIdeaPinned(id: string, pinned: boolean): Promise<Idea> {
  const existing = await getIdeaOrThrow(id);
  // 置顶只是「收藏」状态，不算对内容的修改，因此不推进 updatedAt。
  // 否则取消置顶会让这条记录突然跳到列表最前面，令人困惑。
  const updated: Idea = { ...existing, pinned };
  await withTransaction({ stores: [STORE_IDEAS] }, 'readwrite', async (tx) => {
    await promisifyRequest(tx.objectStore(STORE_IDEAS).put(updated));
  });
  emitChange();
  return updated;
}

async function getIdeaOrThrow(id: string): Promise<Idea> {
  const idea = await getIdea(id);
  if (!idea) {
    throw new NianBoxError('NOT_FOUND', '这条念头不存在，可能已被永久删除。');
  }
  return idea;
}

export async function softDeleteIdea(id: string): Promise<Idea> {
  const existing = await getIdeaOrThrow(id);
  const updated: Idea = { ...existing, deletedAt: Date.now(), updatedAt: Date.now() };
  await withTransaction({ stores: [STORE_IDEAS] }, 'readwrite', async (tx) => {
    await promisifyRequest(tx.objectStore(STORE_IDEAS).put(updated));
  });
  emitChange();
  return updated;
}

export async function restoreIdea(id: string): Promise<Idea> {
  const existing = await getIdeaOrThrow(id);
  const updated: Idea = { ...existing, deletedAt: null, updatedAt: Date.now() };
  await withTransaction({ stores: [STORE_IDEAS] }, 'readwrite', async (tx) => {
    await promisifyRequest(tx.objectStore(STORE_IDEAS).put(updated));
  });
  emitChange();
  return updated;
}

/** 永久删除念头，同时删除其关联项目，避免留下悬空的项目。 */
export async function purgeIdea(id: string): Promise<void> {
  const projects = await readAll<Project>(STORE_PROJECTS);
  const linked = projects.filter((project) => project.ideaId === id).map((project) => project.id);

  await withTransaction(
    { stores: [STORE_IDEAS, STORE_PROJECTS] },
    'readwrite',
    async (tx) => {
      await promisifyRequest(tx.objectStore(STORE_IDEAS).delete(id));
      const projectStore = tx.objectStore(STORE_PROJECTS);
      for (const projectId of linked) {
        await promisifyRequest(projectStore.delete(projectId));
      }
    },
  );
  emitChange();
}

export async function purgeDeletedIdeas(): Promise<number> {
  const raw = await readAll<Idea>(STORE_IDEAS);
  const deleted = raw.map((item) => normalizeIdea(item)).filter((idea) => idea.deletedAt !== null);
  for (const idea of deleted) {
    await purgeIdea(idea.id);
  }
  return deleted.length;
}

/* -------------------------------------------------------------------------- */
/* 创意项目：由念头升级而来，始终保留 ideaId 关联                              */
/* -------------------------------------------------------------------------- */

export async function listProjects(includeDeleted = false): Promise<Project[]> {
  const raw = await readAll<Project>(STORE_PROJECTS);
  return raw
    .map((item) => normalizeProject(item))
    .filter((project) => (includeDeleted ? true : project.deletedAt === null))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | null> {
  const raw = await readOne<Project>(STORE_PROJECTS, id);
  return raw ? normalizeProject(raw) : null;
}

export async function getProjectByIdeaId(ideaId: string): Promise<Project | null> {
  const projects = await listProjects(true);
  return projects.find((project) => project.ideaId === ideaId) ?? null;
}

export interface UpgradeResult {
  idea: Idea;
  project: Project;
}

/**
 * 把一条念头升级为待开发项目：
 * - 复用念头中已经填写的问题 / 目标用户 / 产品形态；
 * - 状态推进到「准备开发」（已经更进一步的状态不会被回退）；
 * - 念头与项目通过 ideaId 双向关联。
 */
export async function upgradeIdeaToProject(
  ideaId: string,
  input: Omit<NewProjectInput, 'ideaId'> = {},
): Promise<UpgradeResult> {
  const existingProject = await getProjectByIdeaId(ideaId);
  if (existingProject) {
    const idea = await getIdeaOrThrow(ideaId);
    return { idea, project: existingProject };
  }

  const idea = await getIdeaOrThrow(ideaId);
  const now = Date.now();
  const project: Project = {
    id: createId('project'),
    ideaId: idea.id,
    name: asString(input.name) || idea.title.trim() || idea.content.replace(/\s+/g, ' ').trim().slice(0, 40),
    problem: asString(input.problem) || idea.problem,
    targetUsers: asString(input.targetUsers) || idea.targetUsers,
    features: asString(input.features),
    productForm: isProductForm(input.productForm)
      ? input.productForm
      : idea.productForm,
    progress: isProjectProgress(input.progress) ? input.progress : DEFAULT_PROGRESS,
    repoUrl: asString(input.repoUrl) || idea.projectUrl,
    liveUrl: asString(input.liveUrl),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const advanced = ['ready', 'building', 'done'] as const;
  const nextStatus = advanced.includes(idea.status as (typeof advanced)[number])
    ? idea.status
    : 'ready';

  const updatedIdea: Idea = {
    ...idea,
    status: nextStatus,
    projectId: project.id,
    updatedAt: now,
  };

  await withTransaction(
    { stores: [STORE_IDEAS, STORE_PROJECTS] },
    'readwrite',
    async (tx) => {
      await promisifyRequest(tx.objectStore(STORE_IDEAS).put(updatedIdea));
      await promisifyRequest(tx.objectStore(STORE_PROJECTS).put(project));
    },
  );
  emitChange();
  return { idea: updatedIdea, project };
}

export async function updateProject(id: string, patch: ProjectPatch): Promise<Project> {
  const raw = await readOne<Project>(STORE_PROJECTS, id);
  if (!raw) {
    throw new NianBoxError('NOT_FOUND', '这个项目不存在，可能已被删除。');
  }
  const existing = normalizeProject(raw);
  const updated: Project = {
    ...existing,
    ...patch,
    name: patch.name !== undefined ? asString(patch.name) : existing.name,
    problem: patch.problem !== undefined ? asString(patch.problem) : existing.problem,
    targetUsers: patch.targetUsers !== undefined ? asString(patch.targetUsers) : existing.targetUsers,
    features: patch.features !== undefined ? asString(patch.features) : existing.features,
    productForm:
      patch.productForm === undefined
        ? existing.productForm
        : isProductForm(patch.productForm)
          ? patch.productForm
          : null,
    progress:
      patch.progress === undefined
        ? existing.progress
        : isProjectProgress(patch.progress)
          ? patch.progress
          : existing.progress,
    repoUrl: patch.repoUrl !== undefined ? asString(patch.repoUrl) : existing.repoUrl,
    liveUrl: patch.liveUrl !== undefined ? asString(patch.liveUrl) : existing.liveUrl,
    id: existing.id,
    ideaId: existing.ideaId,
    createdAt: existing.createdAt,
    updatedAt: Math.max(Date.now(), existing.createdAt),
  };

  await withTransaction({ stores: [STORE_PROJECTS] }, 'readwrite', async (tx) => {
    await promisifyRequest(tx.objectStore(STORE_PROJECTS).put(updated));
  });
  emitChange();
  return updated;
}

export async function softDeleteProject(id: string): Promise<void> {
  const raw = await readOne<Project>(STORE_PROJECTS, id);
  if (!raw) throw new NianBoxError('NOT_FOUND', '这个项目不存在。');
  const project = normalizeProject(raw);
  await withTransaction({ stores: [STORE_PROJECTS] }, 'readwrite', async (tx) => {
    await promisifyRequest(
      tx.objectStore(STORE_PROJECTS).put({ ...project, deletedAt: Date.now(), updatedAt: Date.now() }),
    );
  });
  emitChange();
}

export async function restoreProject(id: string): Promise<void> {
  const raw = await readOne<Project>(STORE_PROJECTS, id);
  if (!raw) throw new NianBoxError('NOT_FOUND', '这个项目不存在。');
  const project = normalizeProject(raw);
  await withTransaction({ stores: [STORE_PROJECTS] }, 'readwrite', async (tx) => {
    await promisifyRequest(
      tx.objectStore(STORE_PROJECTS).put({ ...project, deletedAt: null, updatedAt: Date.now() }),
    );
  });
  emitChange();
}

export async function purgeProject(id: string): Promise<void> {
  await deleteRecord(STORE_PROJECTS, id);
  emitChange();
}

/* -------------------------------------------------------------------------- */
/* 整体读写（导出 / 导入使用，保证原子性）                                      */
/* -------------------------------------------------------------------------- */

export interface RawSnapshot {
  ideas: Idea[];
  projects: Project[];
}

export async function readSnapshot(includeDeleted = true): Promise<RawSnapshot> {
  const [rawIdeas, rawProjects] = await Promise.all([
    readAll<Idea>(STORE_IDEAS),
    readAll<Project>(STORE_PROJECTS),
  ]);
  const ideas = rawIdeas.map((item) => normalizeIdea(item));
  const projects = rawProjects.map((item) => normalizeProject(item));
  return {
    ideas: includeDeleted ? ideas : ideas.filter((idea) => idea.deletedAt === null),
    projects: includeDeleted ? projects : projects.filter((project) => project.deletedAt === null),
  };
}

/** 在单个事务内写入一批记录：全部成功或全部不生效。 */
export async function writeRecords(
  ideas: readonly Idea[],
  projects: readonly Project[],
): Promise<void> {
  if (ideas.length === 0 && projects.length === 0) return;
  await withTransaction(
    { stores: [STORE_IDEAS, STORE_PROJECTS] },
    'readwrite',
    async (tx) => {
      const ideaStore = tx.objectStore(STORE_IDEAS);
      const projectStore = tx.objectStore(STORE_PROJECTS);
      for (const idea of ideas) {
        await promisifyRequest(ideaStore.put(idea));
      }
      for (const project of projects) {
        await promisifyRequest(projectStore.put(project));
      }
    },
  );
  emitChange();
}

export async function writeMeta(key: string, value: unknown): Promise<void> {
  const record: MetaRecord = { key, value, updatedAt: Date.now() };
  await withTransaction({ stores: ['meta'] }, 'readwrite', async (tx) => {
    await promisifyRequest(tx.objectStore('meta').put(record));
  });
}

export async function readMeta<T>(key: string): Promise<T | null> {
  const record = await readOne<MetaRecord>('meta', key);
  return record ? (record.value as T) : null;
}

/**
 * 清空全部本地数据（设置页的高危操作，需要用户二次确认）。
 */
export async function clearAllData(): Promise<void> {
  await openDatabase();
  await clearStore(STORE_IDEAS);
  await clearStore(STORE_PROJECTS);
  emitChange();
}

/** 仅用于测试：等待所有挂起事务收尾。 */
export async function flushPendingWrites(): Promise<void> {
  await withTransaction({ stores: [STORE_IDEAS] }, 'readonly', async (tx) => {
    await transactionDone(tx);
  });
}
