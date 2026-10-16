/**
 * 本机作品库。
 *
 * 设计边界（和 PRD 第四节一致，改代码时别越界）：
 * - 作品**只存在这台设备上**：不写进念头记录、不进入云端同步队列、不自动公开；
 * - 元数据（works 表）与图片（workImages 表）分开放：
 *   列作品时只读元数据，不用把几 MB 的图片一起读进内存；
 * - 图片以 data: URL 形式持久化（Canvas 出来的就是这个格式，读写都不会失真，
 *   在本项目的测试环境里也已验证可稳定往返）；
 * - 关联的念头被**永久删除**时，作品与图片会一起删掉（见 storage.purgeIdea），
 *   不留悬空作品；念头只是进回收站时，作品先收起来，念头恢复后又能看到。
 */

import { emitChange } from './changeBus';
import { track } from './analytics';
import {
  STORE_WORK_IMAGES,
  STORE_WORKS,
  promisifyRequest,
  readAll,
  readOne,
  withTransaction,
} from './idb';
import { NianBoxError, createId, toNianBoxError } from './storage';

/** 作品来自哪条路径：'card' = 本机念头卡片；'poster' = 生图页（AI 或本机兜底海报）。 */
export type WorkSource = 'card' | 'poster';
/** 图上内容的生成方式。 */
export type WorkRender = 'ai' | 'local';

/** 作品元数据（不含图片本体）。 */
export interface WorkRecord {
  id: string;
  /** 关联的念头 ID。 */
  ideaId: string;
  /** 作品类型；目前只有海报 / 卡片这一类竖版图片。 */
  kind: 'poster';
  source: WorkSource;
  render: WorkRender;
  /** 风格 ID；本机念头卡片固定为 'card'。 */
  style: string;
  aspect: string;
  /** 用户可读的作品标题（默认取念头标题）。 */
  title: string;
  createdAt: number;
}

/** 作品图片：与元数据同事务写入 / 删除。 */
export interface WorkImageRecord {
  workId: string;
  mime: string;
  dataUrl: string;
  bytes: number;
  createdAt: number;
}

export interface SaveWorkInput {
  ideaId: string;
  source: WorkSource;
  render: WorkRender;
  style: string;
  aspect: string;
  title: string;
  /** Canvas 产出的 data: URL。不是图片数据时直接拒绝，不留损坏记录。 */
  dataUrl: string;
}

const DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i;

/** 宽松校验：只用来挡住明显坏掉的记录，正常写入的数据都满足。 */
export function isWorkRecord(value: unknown): value is WorkRecord {
  if (typeof value !== 'object' || value === null) return false;
  const work = value as Partial<WorkRecord>;
  return (
    typeof work.id === 'string' &&
    work.id !== '' &&
    typeof work.ideaId === 'string' &&
    work.ideaId !== '' &&
    work.kind === 'poster' &&
    (work.source === 'card' || work.source === 'poster') &&
    (work.render === 'ai' || work.render === 'local') &&
    typeof work.createdAt === 'number' &&
    Number.isFinite(work.createdAt)
  );
}

function normalizeWork(raw: unknown): WorkRecord | null {
  if (!isWorkRecord(raw)) return null;
  return {
    id: raw.id,
    ideaId: raw.ideaId,
    kind: 'poster',
    source: raw.source,
    render: raw.render,
    style: typeof raw.style === 'string' && raw.style ? raw.style : 'brand',
    aspect: typeof raw.aspect === 'string' && raw.aspect ? raw.aspect : '3:4',
    title: typeof raw.title === 'string' ? raw.title : '',
    createdAt: raw.createdAt,
  };
}

function mimeOf(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match ? match[1] : 'image/png';
}

/** 估算 data: URL 里的二进制体积（base64 每 4 个字符 3 字节），只用于展示。 */
function approximateBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * 保存一件作品：元数据与图片在同一个事务里写入，
 * 事务提交后才算成功，界面提示与实际结果一致。
 */
export async function saveWork(input: SaveWorkInput): Promise<WorkRecord> {
  const dataUrl = typeof input.dataUrl === 'string' ? input.dataUrl : '';
  if (!DATA_URL_PATTERN.test(dataUrl)) {
    throw new NianBoxError('INVALID_INPUT', '没有拿到可保存的图片数据，这次没有写入作品。');
  }
  if (!input.ideaId) {
    throw new NianBoxError('INVALID_INPUT', '作品必须关联一条念头，这次没有写入作品。');
  }

  const createdAt = Date.now();
  const record: WorkRecord = {
    id: createId('work'),
    ideaId: input.ideaId,
    kind: 'poster',
    source: input.source,
    render: input.render,
    style: input.style,
    aspect: input.aspect,
    title: input.title.trim().slice(0, 80),
    createdAt,
  };
  const image: WorkImageRecord = {
    workId: record.id,
    mime: mimeOf(dataUrl),
    dataUrl,
    bytes: approximateBytes(dataUrl),
    createdAt,
  };

  try {
    await withTransaction(
      { stores: [STORE_WORKS, STORE_WORK_IMAGES] },
      'readwrite',
      async (tx) => {
        await promisifyRequest(tx.objectStore(STORE_WORKS).put(record));
        await promisifyRequest(tx.objectStore(STORE_WORK_IMAGES).put(image));
      },
    );
  } catch (caught) {
    throw toNianBoxError(caught);
  }

  emitChange();
  track('work_saved', { render: input.render, result: 'ok' });
  return record;
}

/** 全部作品，按创建时间倒序（新的在前）。 */
export async function listWorks(): Promise<WorkRecord[]> {
  const raw = await readAll<unknown>(STORE_WORKS);
  return raw
    .map((item) => normalizeWork(item))
    .filter((work): work is WorkRecord => work !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function listWorksForIdea(ideaId: string): Promise<WorkRecord[]> {
  return (await listWorks()).filter((work) => work.ideaId === ideaId);
}

export async function getWork(id: string): Promise<WorkRecord | null> {
  const raw = await readOne<unknown>(STORE_WORKS, id);
  return raw ? normalizeWork(raw) : null;
}

/** 读作品图片（data: URL）。图片缺失时返回 null，界面据此提示而不是显示空白。 */
export async function readWorkImage(workId: string): Promise<string | null> {
  const raw = await readOne<WorkImageRecord>(STORE_WORK_IMAGES, workId);
  if (!raw || typeof raw.dataUrl !== 'string' || !raw.dataUrl) return null;
  return raw.dataUrl;
}

/** 批量读图片，供列表页一次性取回（key = workId）。 */
export async function readWorkImages(ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = new Set(ids);
  const result = new Map<string, string>();
  if (wanted.size === 0) return result;
  const raw = await readAll<WorkImageRecord>(STORE_WORK_IMAGES);
  for (const item of raw) {
    if (item && typeof item.workId === 'string' && wanted.has(item.workId)) {
      if (typeof item.dataUrl === 'string' && item.dataUrl) result.set(item.workId, item.dataUrl);
    }
  }
  return result;
}

/** 删除一件作品（元数据与图片同一个事务）。 */
export async function deleteWork(id: string): Promise<void> {
  try {
    await withTransaction(
      { stores: [STORE_WORKS, STORE_WORK_IMAGES] },
      'readwrite',
      async (tx) => {
        await promisifyRequest(tx.objectStore(STORE_WORKS).delete(id));
        await promisifyRequest(tx.objectStore(STORE_WORK_IMAGES).delete(id));
      },
    );
  } catch (caught) {
    throw toNianBoxError(caught);
  }
  emitChange();
  track('work_deleted', { result: 'ok' });
}

/** 删除某条念头下的全部作品（元数据与图片一起），返回删掉的件数。 */
export async function deleteWorksByIdeaId(ideaId: string): Promise<number> {
  let removed = 0;
  try {
    await withTransaction(
      { stores: [STORE_WORKS, STORE_WORK_IMAGES] },
      'readwrite',
      async (tx) => {
        const workStore = tx.objectStore(STORE_WORKS);
        const imageStore = tx.objectStore(STORE_WORK_IMAGES);
        const keys = (await promisifyRequest(
          workStore.index('by_ideaId').getAllKeys(ideaId),
        )) as IDBValidKey[];
        for (const key of keys) {
          await promisifyRequest(workStore.delete(key));
          await promisifyRequest(imageStore.delete(key));
          removed += 1;
        }
      },
    );
  } catch (caught) {
    throw toNianBoxError(caught);
  }
  if (removed > 0) {
    emitChange();
    track('work_deleted', { result: 'ok' });
  }
  return removed;
}

/** 作品类型的人话说法：AI 生成的绝不叫「本机绘制」，本机画的也不冒充 AI。 */
export function workRenderLabel(work: Pick<WorkRecord, 'source' | 'render'>): string {
  if (work.source === 'card') return '本机制作的念头卡片';
  return work.render === 'ai' ? 'AI 灵感海报' : '本机绘制的海报';
}
