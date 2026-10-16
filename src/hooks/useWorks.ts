/**
 * 本机作品库的读取 hook。
 *
 * 作品存在 IndexedDB 里（元数据与图片分两张表），所以界面必须真的从库里读，
 * 不能靠组件状态记着。写入 / 删除都会通过 changeBus 广播，这里订阅同一个事件，
 * 因此从别处保存的作品回到首页也会立刻出现。
 *
 * 元数据与图片分两次读：列表页先用元数据（很轻）把结构搭起来，
 * 图片按需取回，避免一次把几 MB 的图片全读进内存。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeToChanges, toNianBoxError } from '../services/storage';
import { listWorks, readWorkImages, type WorkRecord } from '../services/works';

export interface WorksState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** 按创建时间倒序，新的在前。 */
  works: WorkRecord[];
  /** workId → data: URL；图片缺失时这里就没有这一项。 */
  images: Map<string, string>;
  reload: () => Promise<void>;
}

export function useWorks(): WorksState {
  const [status, setStatus] = useState<WorksState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [works, setWorks] = useState<WorkRecord[]>([]);
  const [images, setImages] = useState<Map<string, string>>(() => new Map());
  const mounted = useRef(true);
  const loading = useRef(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    if (loading.current) {
      pending.current = true;
      return;
    }
    loading.current = true;
    try {
      const next = await listWorks();
      const pictures = await readWorkImages(next.map((work) => work.id));
      if (!mounted.current) return;
      setWorks(next);
      setImages(pictures);
      setError(null);
      setStatus('ready');
    } catch (caught) {
      if (!mounted.current) return;
      setError(toNianBoxError(caught).message);
      setStatus('error');
    } finally {
      loading.current = false;
      if (pending.current) {
        pending.current = false;
        void load();
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const unsubscribe = subscribeToChanges(() => {
      void load();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [load]);

  return useMemo(
    () => ({ status, error, works, images, reload: load }),
    [status, error, works, images, load],
  );
}
