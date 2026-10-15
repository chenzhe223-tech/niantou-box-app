/**
 * 本地写入事件的「广播站」。
 *
 * 为什么单独一个文件：storage.ts 是唯一的本地读写入口，而云端同步层需要知道
 * 「刚才写的是哪条记录」，却又必须反过来调用 storage 读快照。如果让 storage
 * 直接 import 同步层，就会形成循环依赖。这里放一个不依赖任何业务模块的小广播，
 * storage 只负责「说」，同步层只负责「听」。
 *
 * 约定：只有「发生在用户本机的写入」才会被广播。云端拉取下来的记录由同步层
 * 直接写进本地库，不会走这里，因此不会出现「拉下来的数据又被推回云端」的循环。
 */

export type SyncEntity = 'idea' | 'project';

export interface LocalMutation {
  entity: SyncEntity;
  id: string;
  /** upsert = 新增或修改；purge = 永久删除（本地已经没有这条记录了）。 */
  op: 'upsert' | 'purge';
  /** 变更后的完整记录；purge 时为 null。 */
  doc: unknown | null;
}

export interface MutationMeta {
  /** 写入来源，仅用于界面展示与排查，不参与同步逻辑。 */
  origin?: string;
}

type Listener = (mutation: LocalMutation, meta: MutationMeta) => void;

const listeners = new Set<Listener>();

export function subscribeLocalMutations(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishLocalMutation(mutation: LocalMutation, meta: MutationMeta = {}): void {
  for (const listener of [...listeners]) {
    try {
      listener(mutation, meta);
    } catch {
      // 单个订阅者出错不能影响写入本身。
    }
  }
}
