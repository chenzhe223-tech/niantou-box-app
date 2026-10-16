/**
 * 极薄的 IndexedDB 封装：只负责连接管理与 Promise 化，
 * 不含任何业务逻辑，方便被 storage 服务和测试复用。
 */

export const DB_NAME = 'nianbox';
/**
 * 数据库版本。
 *
 * v1 → v2：新增 feedback 表（用户主动提交的意见反馈）。
 * v2 → v3：新增 outbox 表（待同步到云端的本地变更队列）。
 * v3 → v4：新增 works / workImages 两张表（本机作品库：作品元数据与图片分开存放）。
 * upgradeSchema 里每个建表语句都带 contains 守卫，因此老用户升级时
 * 已有表与数据不会被重建，只会补上缺的那张表。
 */
export const DB_VERSION = 4;

export const STORE_IDEAS = 'ideas';
export const STORE_PROJECTS = 'projects';
export const STORE_META = 'meta';
/** 用户主动提交的反馈（先落本机，再尝试上报）。 */
export const STORE_FEEDBACK = 'feedback';
/**
 * 待同步队列：本地改了哪条记录、要做什么。以「实体 + ID」为主键，
 * 因此同一条记录连续改十次也只留一条，不会把队列撑爆。
 */
export const STORE_OUTBOX = 'outbox';
/**
 * 本机作品（元数据）：作品 ID、关联念头、类型、生成方式、风格、比例、创建时间。
 * 刻意与图片分开存放，列表页只读这一张表，不会把图片一起读进内存。
 */
export const STORE_WORKS = 'works';
/** 本机作品图片：以 workId 为主键，与元数据同事务写入 / 删除。 */
export const STORE_WORK_IMAGES = 'workImages';

export interface MetaRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class IndexedDbError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'IndexedDbError';
    this.cause = cause;
  }
}

/** IndexedDB 是否可用（隐私模式、禁用的存储等场景下可能不可用）。 */
export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function upgradeSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_IDEAS)) {
    const ideas = db.createObjectStore(STORE_IDEAS, { keyPath: 'id' });
    ideas.createIndex('by_createdAt', 'createdAt');
    ideas.createIndex('by_updatedAt', 'updatedAt');
    ideas.createIndex('by_status', 'status');
    ideas.createIndex('by_deletedAt', 'deletedAt');
  }
  if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
    const projects = db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
    projects.createIndex('by_ideaId', 'ideaId');
    projects.createIndex('by_updatedAt', 'updatedAt');
    projects.createIndex('by_deletedAt', 'deletedAt');
  }
  if (!db.objectStoreNames.contains(STORE_META)) {
    db.createObjectStore(STORE_META, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORE_FEEDBACK)) {
    const feedback = db.createObjectStore(STORE_FEEDBACK, { keyPath: 'id' });
    feedback.createIndex('by_createdAt', 'createdAt');
    feedback.createIndex('by_uploadState', 'uploadState');
  }
  if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
    const outbox = db.createObjectStore(STORE_OUTBOX, { keyPath: 'key' });
    outbox.createIndex('by_at', 'at');
  }
  if (!db.objectStoreNames.contains(STORE_WORKS)) {
    const works = db.createObjectStore(STORE_WORKS, { keyPath: 'id' });
    works.createIndex('by_ideaId', 'ideaId');
    works.createIndex('by_createdAt', 'createdAt');
  }
  if (!db.objectStoreNames.contains(STORE_WORK_IMAGES)) {
    db.createObjectStore(STORE_WORK_IMAGES, { keyPath: 'workId' });
  }
}

let connection: Promise<IDBDatabase> | null = null;

/**
 * 打开（并缓存）数据库连接。失败时抛出可读错误，连接不会被缓存。
 */
export function openDatabase(name = DB_NAME, version = DB_VERSION): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(
      new IndexedDbError('当前浏览器不支持本地数据库（IndexedDB），无法保存念头。'),
    );
  }
  if (connection) return connection;

  connection = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(name, version);
    } catch (error) {
      reject(new IndexedDbError('打开本地数据库失败（可能是浏览器隐私模式限制）。', error));
      return;
    }

    request.onupgradeneeded = () => {
      upgradeSchema(request.result);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      connection = null;
      reject(
        new IndexedDbError(
          '打开本地数据库失败，请检查浏览器是否允许本站使用本地存储。',
          request.error,
        ),
      );
    };
    request.onblocked = () => {
      connection = null;
      reject(new IndexedDbError('数据库被其他标签页占用，请关闭其他念头盒页面后重试。'));
    };
  });

  return connection;
}

/** 关闭连接并清空缓存（测试与数据库版本切换时使用）。 */
export async function closeDatabase(): Promise<void> {
  if (!connection) return;
  try {
    const db = await connection;
    db.close();
  } catch {
    // 忽略关闭时的异常，缓存一定会被清理。
  }
  connection = null;
}

/** 删除整个数据库（仅用于测试与「清空全部数据」的极端场景）。 */
export function deleteDatabase(name = DB_NAME): Promise<void> {
  if (!isIndexedDbAvailable()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new IndexedDbError('删除本地数据库失败。', request.error));
    request.onblocked = () => resolve();
  });
}

export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new IndexedDbError('读写本地数据失败。'));
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new IndexedDbError('本地数据事务失败。'));
    tx.onabort = () => reject(tx.error ?? new IndexedDbError('本地数据事务被中止。'));
  });
}

export interface ReadWriteOptions {
  stores: string[];
  name?: string;
  dbName?: string;
}

/**
 * 在同一个事务中执行一段操作，事务结束时才 resolve，
 * 确保「写入完成」与「界面提示成功」严格对应。
 */
export async function withTransaction<T>(
  options: ReadWriteOptions,
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDatabase(options.dbName);
  let tx: IDBTransaction;
  try {
    tx = db.transaction(options.stores, mode, { durability: 'strict' });
  } catch (error) {
    throw new IndexedDbError('无法访问本地数据表，请刷新页面后重试。', error);
  }
  const done = transactionDone(tx);
  // 事务失败时由 done 负责抛出，这里避免出现未处理的 Promise 异常。
  done.catch(() => undefined);
  const result = await run(tx);
  await done;
  return result;
}

export async function readAll<T>(storeName: string): Promise<T[]> {
  return withTransaction({ stores: [storeName] }, 'readonly', async (tx) => {
    const store = tx.objectStore(storeName);
    return (await promisifyRequest(store.getAll())) as T[];
  });
}

export async function readOne<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return withTransaction({ stores: [storeName] }, 'readonly', async (tx) => {
    const store = tx.objectStore(storeName);
    return (await promisifyRequest(store.get(key))) as T | undefined;
  });
}

export async function putRecord<T>(storeName: string, value: T): Promise<void> {
  await withTransaction({ stores: [storeName] }, 'readwrite', async (tx) => {
    const store = tx.objectStore(storeName);
    await promisifyRequest(store.put(value as unknown as T));
  });
}

export async function putMany<T>(
  storeName: string,
  values: readonly T[],
): Promise<void> {
  if (values.length === 0) return;
  await withTransaction({ stores: [storeName] }, 'readwrite', async (tx) => {
    const store = tx.objectStore(storeName);
    for (const value of values) {
      await promisifyRequest(store.put(value as unknown as T));
    }
  });
}

export async function deleteRecord(storeName: string, key: IDBValidKey): Promise<void> {
  await withTransaction({ stores: [storeName] }, 'readwrite', async (tx) => {
    const store = tx.objectStore(storeName);
    await promisifyRequest(store.delete(key));
  });
}

export async function clearStore(storeName: string): Promise<void> {
  await withTransaction({ stores: [storeName] }, 'readwrite', async (tx) => {
    const store = tx.objectStore(storeName);
    await promisifyRequest(store.clear());
  });
}
