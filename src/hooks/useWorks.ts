/**
 * 本机作品库的读取 hook。
 *
 * 作品存在 IndexedDB 里（元数据与图片分两张表），所以界面必须真的从库里读，
 * 不能靠组件状态记着。写入 / 删除都会通过 changeBus 广播，这里订阅同一个事件，
 * 因此从别处保存的作品回到首页也会立刻出现。
 *
 * 读取策略（作品一多就会显形，所以写清楚）：
 * 1. 元数据（works 表）总是全量读 —— 它很轻，列表需要知道一共有几件；
 * 2. 图片**只读调用方明确要的那几条**，绝不整表扫描；
 *    - 首页只需要最近几件（imageLimit），旧作品的几 MB 图片不进内存；
 *    - 作品列表先出骨架，可见缩略图按需 loadImages，预览 / 下载 / 分享前再补原图；
 * 3. 读过的图片进一个小的模块级缓存（LRU 上限 24 张），
 *    因此在页面之间来回切换时不会把同一批图片反复读一遍；
 * 4. 图片读不出来时在 imageErrors 里如实记一条，界面据此提示，
 *    不用空白图或假缩略图掩盖。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeToChanges, toNianBoxError } from '../services/storage';
import { listWorks, readWorkImages, type WorkRecord } from '../services/works';

export interface UseWorksOptions {
  /**
   * 最多自动为「最近 N 件」作品读取图片。
   * 首页传 4；作品列表传 0（一张都不预读，交给可见性按需取）。
   * 不传表示全量读取（小数据量场景下的兼容默认值）。
   */
  imageLimit?: number;
}

export interface WorksState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** 按创建时间倒序，新的在前。 */
  works: WorkRecord[];
  /** workId → data: URL；图片缺失时这里就没有这一项。 */
  images: Map<string, string>;
  /** workId → 图片读不到的原因（真的缺图或读取失败），用于如实提示。 */
  imageErrors: Map<string, string>;
  /** 按需取图：命中缓存直接返回，否则只读这几条；读取异常会抛出。 */
  loadImages: (ids: readonly string[]) => Promise<Map<string, string>>;
  reload: () => Promise<void>;
}

/** 库里没有这张图时给出的说明，界面直接展示。 */
export const IMAGE_MISSING_MESSAGE = '这件作品在本地库里没有图片数据，可能已被清理。';

/** 缓存上限：按张数控制，避免长期驻留大量 base64 图片。 */
const IMAGE_CACHE_LIMIT = 24;
/** workId → data: URL，最近用过的排在后面。 */
const imageCache = new Map<string, string>();

function cacheImage(workId: string, dataUrl: string): void {
  if (imageCache.has(workId)) imageCache.delete(workId);
  imageCache.set(workId, dataUrl);
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next();
    if (oldest.done) break;
    imageCache.delete(oldest.value);
  }
}

/** 仅用于测试：清掉图片缓存，避免用例之间互相影响。 */
export function resetWorkImageCacheForTests(): void {
  imageCache.clear();
}

/** 只读这几条图片：缓存命中的不重复读，缺失的不进结果、由调用方如实提示。 */
async function fetchImages(ids: readonly string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    const cached = imageCache.get(id);
    if (cached !== undefined) result.set(id, cached);
    else missing.push(id);
  }
  if (missing.length === 0) return result;
  const fetched = await readWorkImages(missing);
  for (const id of missing) {
    const dataUrl = fetched.get(id);
    if (dataUrl) {
      cacheImage(id, dataUrl);
      result.set(id, dataUrl);
    }
  }
  return result;
}

export function useWorks(options: UseWorksOptions = {}): WorksState {
  const imageLimit = options.imageLimit;
  const [status, setStatus] = useState<WorksState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [works, setWorks] = useState<WorkRecord[]>([]);
  const [images, setImages] = useState<Map<string, string>>(() => new Map());
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(() => new Map());
  const mounted = useRef(true);
  const loading = useRef(false);
  const pending = useRef(false);

  const mergeImages = useCallback((pictures: Map<string, string>, requested: readonly string[]) => {
    setImages((previous) => {
      if (pictures.size === 0) return previous;
      const merged = new Map(previous);
      for (const [id, dataUrl] of pictures) merged.set(id, dataUrl);
      return merged;
    });
    setImageErrors((previous) => {
      let changed = false;
      const merged = new Map(previous);
      for (const id of requested) {
        if (pictures.has(id)) {
          if (merged.delete(id)) changed = true;
        } else if (merged.get(id) !== IMAGE_MISSING_MESSAGE) {
          merged.set(id, IMAGE_MISSING_MESSAGE);
          changed = true;
        }
      }
      return changed ? merged : previous;
    });
  }, []);

  const load = useCallback(
    async (options2: { force?: boolean } = {}) => {
      if (loading.current) {
        pending.current = true;
        return;
      }
      loading.current = true;
      try {
        if (options2.force) resetWorkImageCacheForTests();
        const next = await listWorks();
        const limit =
          typeof imageLimit === 'number' && imageLimit >= 0
            ? Math.floor(imageLimit)
            : next.length;
        const wanted = next.slice(0, limit).map((work) => work.id);
        const pictures = await fetchImages(wanted);
        if (!mounted.current) return;
        setWorks(next);
        mergeImages(pictures, wanted);
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
    },
    [imageLimit, mergeImages],
  );

  const loadImages = useCallback(
    async (ids: readonly string[]) => {
      const pictures = await fetchImages(ids);
      if (mounted.current) mergeImages(pictures, ids);
      return pictures;
    },
    [mergeImages],
  );

  const reload = useCallback(async () => {
    await load({ force: true });
  }, [load]);

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
    () => ({ status, error, works, images, imageErrors, loadImages, reload }),
    [status, error, works, images, imageErrors, loadImages, reload],
  );
}