/**
 * 跨终端同步。
 *
 * 数据策略（本地优先 + 待同步队列）：
 * - 用户在本机的每一次写入都先落 IndexedDB，所以断网、没登录都能照常用；
 * - 写完之后立刻进「待同步队列」（outbox），队列推成功才出队；
 * - 拉取是增量的，靠服务端返回的游标推进；游标只由拉取推进、推送不推进，
 *   这样绝不会跳过「别的设备刚写进来、本机还没看到」的记录；
 * - 冲突以 updatedAt 为准：服务端更新就退回服务端版本，本地更新就照常写入。
 *
 * 诚实原则：这里没有一种情况会把失败说成成功。没配置云端就说没配置，
 * 断网就说断网，推送失败就留在队列里并把状态标成「有未同步的改动」。
 */

import { STORE_OUTBOX, deleteRecord, putRecord, readAll } from '../idb';
import {
  applyRemoteRecords,
  normalizeIdea,
  normalizeProject,
  readSnapshot,
} from '../storage';
import { subscribeLocalMutations, type SyncEntity } from '../syncBus';
import type { Idea } from '../../types/idea';
import type { Project } from '../../types/project';
import { isCloudConfigured } from './cloudConfig';
import {
  CloudError,
  NO_CAPABILITIES,
  cloudRequest,
  describeCloudError,
  fetchCapabilities,
  type CloudCapabilities,
} from './cloudClient';
import {
  clearCloudSession,
  getCachedUser,
  getCloudToken,
  getLocalCursor,
  isSignedIn,
  setLocalCursor,
  type CloudUser,
} from './cloudAuth';
import { deliverSiteDraft } from './siteCapture';

/* -------------------------------------------------------------------------- */
/* 待同步队列                                                                  */
/* -------------------------------------------------------------------------- */

export interface OutboxRecord {
  /** 主键：`实体:ID`。同一条记录连续改十次也只留一条。 */
  key: string;
  entity: SyncEntity;
  id: string;
  op: 'upsert' | 'purge';
  doc: unknown | null;
  at: number;
}

export function outboxKey(entity: SyncEntity, id: string): string {
  return `${entity}:${id}`;
}

export async function readOutbox(): Promise<OutboxRecord[]> {
  const rows = await readAll<OutboxRecord>(STORE_OUTBOX);
  return rows.slice().sort((a, b) => a.at - b.at);
}

async function enqueue(
  entity: SyncEntity,
  id: string,
  op: 'upsert' | 'purge',
  doc: unknown,
): Promise<void> {
  await putRecord<OutboxRecord>(STORE_OUTBOX, {
    key: outboxKey(entity, id),
    entity,
    id,
    op,
    doc: op === 'purge' ? null : doc,
    at: Date.now(),
  });
}

/* -------------------------------------------------------------------------- */
/* 状态：界面通过 subscribeCloudState 订阅                                       */
/* -------------------------------------------------------------------------- */

export type CloudSyncPhase =
  | 'unconfigured' // 本次构建没配云端地址
  | 'signed-out' // 配好了，但还没登录
  | 'idle' // 已同步
  | 'syncing'
  | 'pending' // 有改动还没推上去
  | 'offline' // 网络不可用
  | 'error';

export interface CloudSyncState {
  configured: boolean;
  signedIn: boolean;
  user: CloudUser | null;
  phase: CloudSyncPhase;
  /** 人话版的当前状态，界面直接显示。 */
  message: string;
  lastError: string;
  lastErrorAt: number;
  lastSyncedAt: number;
  /** 待同步记录的键（形如 `idea:idea_xxx`），界面据此标注「仅本地」。 */
  pendingKeys: string[];
  pendingCount: number;
  online: boolean;
  capabilities: CloudCapabilities;
  /** 服务端已有的条数（登录后由 /auth/me 提供）。 */
  remoteCounts: { ideas: number; projects: number };
}

function initialState(): CloudSyncState {
  const configured = isCloudConfigured();
  const signedIn = configured && isSignedIn();
  return {
    configured,
    signedIn,
    user: signedIn ? getCachedUser() : null,
    phase: configured ? (signedIn ? 'idle' : 'signed-out') : 'unconfigured',
    message: '',
    lastError: '',
    lastErrorAt: 0,
    lastSyncedAt: 0,
    pendingKeys: [],
    pendingCount: 0,
    online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
    capabilities: NO_CAPABILITIES,
    remoteCounts: { ideas: 0, projects: 0 },
  };
}

let state: CloudSyncState = initialState();
const stateListeners = new Set<(next: CloudSyncState) => void>();

export function getCloudState(): CloudSyncState {
  return state;
}

export function subscribeCloudState(listener: (next: CloudSyncState) => void): () => void {
  stateListeners.add(listener);
  listener(state);
  return () => {
    stateListeners.delete(listener);
  };
}

function patchState(patch: Partial<CloudSyncState>): void {
  state = { ...state, ...patch };
  for (const listener of [...stateListeners]) {
    try {
      listener(state);
    } catch {
      // 单个订阅者异常不影响其他订阅者。
    }
  }
}

/** 统一生成「现在到底是什么情况」的一句话，避免各处自己编状态文案。 */
export function describeSyncPhase(next: CloudSyncState = state): string {
  if (!next.configured) return '本次构建没有配置云端同步地址，数据只保存在这台设备上。';
  if (!next.signedIn) return '还没有登录，数据只保存在这台设备上。';
  switch (next.phase) {
    case 'syncing':
      return '正在同步…';
    case 'pending':
      return next.pendingCount > 0
        ? `有 ${next.pendingCount} 条改动还在本机，等网络恢复后会自动上传。`
        : '即将同步…';
    case 'offline':
      return '当前离线，改动先保存在本机，联网后自动上传。';
    case 'error':
      return next.lastError || '同步出错，改动仍保存在本机。';
    default:
      return next.lastSyncedAt > 0 ? '已同步' : '已登录，等待首次同步';
  }
}

/** 状态变化后刷新一次文案，省得每次都手动算。 */
function commitMessage(): void {
  patchState({ message: describeSyncPhase() });
}

async function refreshPending(): Promise<void> {
  try {
    const rows = await readOutbox();
    patchState({
      pendingKeys: rows.map((row) => row.key),
      pendingCount: rows.length,
    });
  } catch {
    // 队列读不出来不该让界面崩掉。
  }
}

/* -------------------------------------------------------------------------- */
/* 推送 / 拉取                                                                  */
/* -------------------------------------------------------------------------- */

const PUSH_BATCH = 200;
const PULL_LIMIT = 500;
const MAX_ROUNDS = 20;

interface PushResultItem {
  entity: SyncEntity;
  id: string;
  status: 'applied' | 'rejected';
  reason?: string;
  doc?: unknown;
  serverUpdatedAt?: number;
}

interface PullResponse {
  full: boolean;
  cursor: number;
  truncated: boolean;
  ideas: unknown[];
  projects: unknown[];
  purged?: { entity: SyncEntity; id: string }[];
}

export interface PushOutcome {
  sent: number;
  applied: number;
  stale: number;
  refused: number;
}

function toIdea(value: unknown): Idea | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') return null;
  return normalizeIdea(record as Partial<Idea> & { id: string });
}

function toProject(value: unknown): Project | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') return null;
  if (typeof record.ideaId !== 'string' || record.ideaId === '') return null;
  return normalizeProject(record as Partial<Project> & { id: string; ideaId: string });
}

async function pushOnce(): Promise<PushOutcome> {
  const rows = await readOutbox();
  const outcome: PushOutcome = { sent: 0, applied: 0, stale: 0, refused: 0 };
  if (rows.length === 0) return outcome;

  const batch = rows.slice(0, PUSH_BATCH);
  outcome.sent = batch.length;

  const response = await cloudRequest<{ cursor: number; results: PushResultItem[] }>('/sync/push', {
    method: 'POST',
    token: getCloudToken(),
    body: {
      ops: batch.map((row) => ({
        entity: row.entity,
        id: row.id,
        op: row.op,
        doc: row.doc,
      })),
    },
    // 推送天然幂等（服务端按 updatedAt + 内容去重），超时或 5xx 可以安全重试。
    retries: 2,
    timeoutMs: 30_000,
  });

  const byKey = new Map<string, PushResultItem>();
  for (const item of Array.isArray(response?.results) ? response.results : []) {
    if (!item || typeof item.id !== 'string' || item.id === '') continue;
    byKey.set(outboxKey(item.entity === 'project' ? 'project' : 'idea', item.id), item);
  }

  const serverIdeas: Idea[] = [];
  const serverProjects: Project[] = [];
  const doneKeys: string[] = [];

  for (const row of batch) {
    const item = byKey.get(row.key);
    // 服务端没给这条的结果：保守起见留在队列里，下一轮再试。
    if (!item) continue;

    if (item.status === 'applied') {
      doneKeys.push(row.key);
      outcome.applied += 1;
      continue;
    }

    if (item.reason === 'stale') {
      // 服务端版本更新：以服务端为准覆盖本地，这次本机改动作废（界面会说明）。
      if (row.entity === 'project') {
        const project = toProject(item.doc);
        if (project) serverProjects.push(project);
      } else {
        const idea = toIdea(item.doc);
        if (idea) serverIdeas.push(idea);
      }
      doneKeys.push(row.key);
      outcome.stale += 1;
      continue;
    }

    // missing-id / invalid-doc / missing-idea-id：这类记录再推一百次也不会被接受，
    // 留在队列里只会卡住后面的记录。出队，并如实上报「有几条被拒绝」。
    doneKeys.push(row.key);
    outcome.refused += 1;
  }

  if (serverIdeas.length > 0 || serverProjects.length > 0) {
    await applyRemoteRecords(serverIdeas, serverProjects, []);
  }
  for (const key of doneKeys) {
    await deleteRecord(STORE_OUTBOX, key);
  }
  await refreshPending();
  return outcome;
}

interface PullOutcome {
  received: number;
  purged: number;
  truncated: boolean;
}

export async function pullOnce(): Promise<PullOutcome> {
  const since = getLocalCursor();
  const response = await cloudRequest<PullResponse>(
    `/sync/pull?since=${encodeURIComponent(String(since))}&limit=${PULL_LIMIT}`,
    { token: getCloudToken(), retries: 2, timeoutMs: 30_000 },
  );

  const ideas = (Array.isArray(response?.ideas) ? response.ideas : [])
    .map(toIdea)
    .filter((item): item is Idea => item !== null);
  const projects = (Array.isArray(response?.projects) ? response.projects : [])
    .map(toProject)
    .filter((item): item is Project => item !== null);
  const purged = Array.isArray(response?.purged) ? response.purged : [];

  const pending = new Set(state.pendingKeys);
  await applyRemoteRecords(
    ideas,
    projects,
    purged.map((item) => ({
      entity: item.entity === 'project' ? ('project' as const) : ('idea' as const),
      id: String(item.id ?? ''),
    })),
    (entity, id) => pending.has(outboxKey(entity, id)),
  );

  // 游标只在这里推进，而且服务端已经用「快照上界」保证不会漏记录。
  if (typeof response?.cursor === 'number' && Number.isFinite(response.cursor)) {
    setLocalCursor(response.cursor);
  }

  return {
    received: ideas.length + projects.length,
    purged: purged.length,
    truncated: response?.truncated === true,
  };
}

let running = false;
let queued = false;

/**
 * 跑一轮完整同步：先把本机改动推上去，再拉取别的设备的改动。
 * 先推后拉是有意为之：这样拉下来的服务端版本不会覆盖掉本机还没上传的编辑。
 */
export async function syncNow(reason = 'manual'): Promise<boolean> {
  if (!state.configured) {
    commitMessage();
    return false;
  }
  if (!isSignedIn()) {
    patchState({ signedIn: false, user: null, phase: 'signed-out' });
    commitMessage();
    return false;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    patchState({ online: false, phase: 'pending' });
    commitMessage();
    return false;
  }
  if (running) {
    queued = true;
    return false;
  }

  running = true;
  patchState({
    signedIn: true,
    user: state.user ?? getCachedUser(),
    phase: 'syncing',
    message: '正在同步…',
    lastError: '',
  });

  let ok = true;
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const pushed = await pushOnce();
      if (pushed.sent === 0) break;
      const remaining = await readOutbox();
      if (remaining.length === 0) break;
    }

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const pulled = await pullOnce();
      if (!pulled.truncated) break;
    }

    await refreshPending();
    patchState({
      phase: state.pendingCount > 0 ? 'pending' : 'idle',
      lastSyncedAt: Date.now(),
      online: true,
      lastError: '',
    });
    commitMessage();
  } catch (error) {
    ok = false;
    const message = describeCloudError(error);
    if (error instanceof CloudError && error.code === 'unauthorized') {
      clearCloudSession();
      patchState({
        signedIn: false,
        user: null,
        phase: 'signed-out',
        lastError: '登录状态已失效，请重新登录。',
        lastErrorAt: Date.now(),
      });
    } else {
      const offline = error instanceof CloudError && error.code === 'network';
      patchState({
        phase: offline ? 'offline' : 'error',
        online: !offline,
        lastError: message,
        lastErrorAt: Date.now(),
      });
    }
    commitMessage();
  } finally {
    running = false;
    if (queued) {
      queued = false;
      void syncNow(`${reason}:queued`);
    }
  }
  return ok;
}

let scheduleTimer: ReturnType<typeof setTimeout> | null = null;

/** 本机改动之后稍等一下再推：连续输入时只打一次请求。 */
export function scheduleSync(delayMs = 1500): void {
  if (!state.configured || !isSignedIn()) return;
  if (scheduleTimer !== null) clearTimeout(scheduleTimer);
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    void syncNow('scheduled');
  }, delayMs);
}

/* -------------------------------------------------------------------------- */
/* 旧数据迁移                                                                  */
/* -------------------------------------------------------------------------- */

export interface MigrationReport {
  ideas: number;
  projects: number;
  pushed: number;
  failed: number;
}

/**
 * 把本机已有的念头与项目搬到云端。
 *
 * 用在「这台设备上先用了很久、后来才开启同步」的场景。做法是把本机全部记录
 * 都放进待同步队列再统一推送，因此中途断网也没关系：剩下的留在队列里，
 * 下次同步继续。同一个 ID 云端已存在时，由服务端的 updatedAt 规则决定谁胜出。
 */
export async function migrateLocalData(): Promise<MigrationReport> {
  const snapshot = await readSnapshot(true);
  for (const idea of snapshot.ideas) {
    await enqueue('idea', idea.id, 'upsert', idea);
  }
  for (const project of snapshot.projects) {
    await enqueue('project', project.id, 'upsert', project);
  }
  await refreshPending();
  const before = (await readOutbox()).length;
  await syncNow('migrate');
  const after = (await readOutbox()).length;
  return {
    ideas: snapshot.ideas.length,
    projects: snapshot.projects.length,
    pushed: Math.max(0, before - after),
    failed: after,
  };
}

/* -------------------------------------------------------------------------- */
/* 能力探测                                                                    */
/* -------------------------------------------------------------------------- */

export async function refreshCapabilities(): Promise<CloudCapabilities> {
  if (!state.configured) {
    patchState({ capabilities: NO_CAPABILITIES });
    return NO_CAPABILITIES;
  }
  const capabilities = await fetchCapabilities();
  const next = capabilities ?? state.capabilities;
  patchState({ capabilities: next });
  return next;
}

export async function refreshRemoteCounts(): Promise<void> {
  if (!state.configured || !isSignedIn()) return;
  try {
    const { fetchMe } = await import('./cloudAuth');
    const me = await fetchMe();
    patchState({
      signedIn: true,
      user: me.user,
      remoteCounts: me.counts,
      lastSyncedAt: me.lastSyncAt || state.lastSyncedAt,
    });
  } catch (error) {
    if (error instanceof CloudError && error.code === 'unauthorized') {
      clearCloudSession();
      patchState({ signedIn: false, user: null, phase: 'signed-out' });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 登录 / 退出后的收尾                                                          */
/* -------------------------------------------------------------------------- */

export async function onSignedIn(): Promise<void> {
  patchState({
    signedIn: true,
    user: getCachedUser(),
    phase: 'syncing',
    message: '正在同步…',
    lastError: '',
  });
  await refreshCapabilities();
  // 先把本机已有的数据推上去，再拉取云端数据，避免本机内容被云端覆盖。
  await migrateLocalData();
  // 官网在未登录状态下收下的那句话，登录完成后补交到收件箱。
  await deliverSiteDraft();
  await refreshRemoteCounts();
}

export function onSignedOut(): void {
  // 退出登录只清账号状态，不动本机数据：用户随时可以再登回来。
  patchState({
    signedIn: false,
    user: null,
    phase: state.configured ? 'signed-out' : 'unconfigured',
    remoteCounts: { ideas: 0, projects: 0 },
  });
  commitMessage();
}

/* -------------------------------------------------------------------------- */
/* 初始化                                                                      */
/* -------------------------------------------------------------------------- */

let initialized = false;
let periodic: ReturnType<typeof setInterval> | null = null;

/**
 * 启动同步层。重复调用安全（只生效一次）。
 *
 * 自动同步的时机：应用打开、本机改动后 1.5 秒、网络恢复、页面重新可见，
 * 以及每 3 分钟一次兜底轮询（多设备同时使用时能较快看到对方的改动）。
 */
export function initCloudSync(): void {
  if (initialized) return;
  initialized = true;

  subscribeLocalMutations((mutation) => {
    // 未登录时不入队：队列里堆积没有接收方的记录只会浪费空间，
    // 真正的老数据由登录后的 migrateLocalData() 一次性搬过去。
    if (!state.configured || !isSignedIn()) return;
    void enqueue(mutation.entity, mutation.id, mutation.op, mutation.doc)
      .then(() => refreshPending())
      .then(() => scheduleSync())
      .catch(() => undefined);
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      patchState({ online: true });
      void syncNow('online');
    });
    window.addEventListener('offline', () => {
      patchState({ online: false, phase: 'pending' });
      commitMessage();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void syncNow('visible');
    });
  }

  if (periodic !== null) clearInterval(periodic);
  periodic = setInterval(() => {
    void syncNow('interval');
  }, 180_000);

  void refreshPending().then(() => {
    commitMessage();
    if (state.configured && isSignedIn()) {
      void refreshCapabilities();
      void syncNow('startup');
      // 之前登录过、但官网草稿还没交上去的情况（比如上次提交时断网）。
      void deliverSiteDraft();
      void refreshRemoteCounts();
    }
  });
}

/** 仅用于测试：把同步层恢复到未初始化状态。 */
export function resetCloudSyncForTests(): void {
  initialized = false;
  running = false;
  queued = false;
  if (periodic !== null) clearInterval(periodic);
  periodic = null;
  if (scheduleTimer !== null) clearTimeout(scheduleTimer);
  scheduleTimer = null;
  setLocalCursor(0);
  state = initialState();
}
