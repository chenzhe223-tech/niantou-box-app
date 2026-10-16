/**
 * 我的作品 —— 本机保存下来的卡片与海报。
 *
 * 几条不会含糊的规矩：
 * 1. 这里列的是**这台设备上真实存在的图片**，从 IndexedDB 读出来，不是占位数据；
 * 2. 作品默认只在本机，不上传、不公开；删除前有明确提示，删除是彻底删掉；
 * 3. 关联的念头被永久删除时，作品已经在同一个事务里一起删掉了（见 storage.purgeIdea）；
 *    念头只是进了回收站时，图片先留着，恢复念头后又能继续创作。
 *
 * 读取性能（作品变多以后的关键）：
 * - 先只读元数据（很轻）把列表搭起来；
 * - 缩略图按「可见优先」逐条读，滚到哪读到哪，旧图片不预先全部进内存；
 * - 打开预览、保存图片、系统分享之前会确保拿到对应原图；
 * - 读不出来时如实提示（缺图 / 读取失败），不用空白图或假缩略图掩盖。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatRelative } from '../app/format';
import { useAppData } from '../app/AppDataProvider';
import { paths } from '../app/routes';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { ErrorState, LoadingState } from '../components/States';
import { useToast } from '../components/Toast';
import { useNow } from '../hooks/useNow';
import { IMAGE_MISSING_MESSAGE, useWorks } from '../hooks/useWorks';
import { SHARE_UNSUPPORTED_MESSAGE, downloadPoster, sharePoster } from '../services/poster';
import { toNianBoxError } from '../services/storage';
import { deleteWork, workRenderLabel, type WorkRecord } from '../services/works';
import { displayTitle, type Idea } from '../types/idea';

function workFileName(work: WorkRecord): string {
  const base = (work.title || '念头卡片').slice(0, 12).replace(/[\\/:*?"<>|]/g, '');
  return `nianbox-work-${base}-${work.aspect.replace(':', 'x')}.png`;
}

type IdeaLink = { idea: Idea | null; note: string; canContinue: boolean };

function linkOf(work: WorkRecord, ideaById: Map<string, Idea>): IdeaLink {
  const idea = ideaById.get(work.ideaId) ?? null;
  if (!idea) {
    return {
      idea: null,
      note: '关联的念头已经不在了；图片仍然保存在这台设备上，可以预览、保存或删除。',
      canContinue: false,
    };
  }
  if (idea.deletedAt !== null) {
    return {
      idea,
      note: '关联的念头在回收站里，恢复之后就能继续创作。',
      canContinue: false,
    };
  }
  return { idea, note: '', canContinue: true };
}

/** 取原图的结果：要么拿到 data: URL，要么带着如实的原因。 */
type ImageLookup =
  | { ok: true; dataUrl: string }
  | { ok: false; message: string };

export function WorksPage({ navigate }: { navigate: (hash: string) => void }) {
  const { ideas } = useAppData();
  // imageLimit: 0 —— 列表不预读任何图片，交给下面的可见性按需取。
  const { status, error, works, images, imageErrors, loadImages, reload } = useWorks({
    imageLimit: 0,
  });
  const toast = useToast();
  const now = useNow();

  const [previewId, setPreviewId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  /** 已经发起过读取的 workId：切路由回来不会把同一批图片再读一遍。 */
  const requested = useRef(new Set<string>());
  const nodes = useRef(new Map<string, HTMLElement>());
  const observer = useRef<IntersectionObserver | null>(null);
  const nodeRefs = useRef(new Map<string, (node: HTMLButtonElement | null) => void>());

  const requestImage = useCallback(
    (id: string) => {
      if (!id || requested.current.has(id)) return;
      requested.current.add(id);
      void loadImages([id]).catch((caught) => {
        // 整张表都读不动（例如本地数据库不可用）时才走到这里：如实说，不装作没事。
        toast.push({
          message: `读取作品图片失败：${toNianBoxError(caught).message}`,
          tone: 'error',
        });
      });
    },
    [loadImages, toast],
  );

  const requestRef = useRef(requestImage);
  requestRef.current = requestImage;

  /** 缩略图进入视野才读图；不支持的浏览器直接读（功能优先于优化）。 */
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }
    const instance = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = (entry.target as HTMLElement).dataset.workId;
          instance.unobserve(entry.target);
          if (id) requestRef.current(id);
        }
      },
      { rootMargin: '200px' },
    );
    observer.current = instance;
    for (const [id, node] of nodes.current) {
      node.dataset.workId = id;
      instance.observe(node);
    }
    return () => {
      instance.disconnect();
      observer.current = null;
    };
  }, []);

  const thumbRef = (id: string) => {
    const existing = nodeRefs.current.get(id);
    if (existing) return existing;
    const callback = (node: HTMLButtonElement | null) => {
      const previous = nodes.current.get(id);
      if (previous && previous !== node) {
        observer.current?.unobserve(previous);
        nodes.current.delete(id);
      }
      if (node) {
        node.dataset.workId = id;
        nodes.current.set(id, node);
        if (observer.current) observer.current.observe(node);
        else if (typeof IntersectionObserver === 'undefined') requestRef.current(id);
      }
    };
    nodeRefs.current.set(id, callback);
    return callback;
  };

  /** 先命中已加载 / 缓存的图；没有就去读这一条，读不到给出原因。 */
  const lookupImage = useCallback(
    async (work: WorkRecord): Promise<ImageLookup> => {
      const known = images.get(work.id);
      if (known) return { ok: true, dataUrl: known };
      requested.current.add(work.id);
      try {
        const fetched = await loadImages([work.id]);
        const dataUrl = fetched.get(work.id);
        if (dataUrl) return { ok: true, dataUrl };
        return { ok: false, message: IMAGE_MISSING_MESSAGE };
      } catch (caught) {
        return {
          ok: false,
          message: `读取作品图片失败：${toNianBoxError(caught).message}`,
        };
      }
    },
    [images, loadImages],
  );

  const ideaById = useMemo(() => {
    const map = new Map<string, Idea>();
    for (const idea of ideas) map.set(idea.id, idea);
    return map;
  }, [ideas]);

  const preview = previewId ? works.find((work) => work.id === previewId) ?? null : null;

  // 打开预览时确保对应原图已经读出来（列表里可能只读了缩略图）。
  useEffect(() => {
    if (previewId) requestImage(previewId);
  }, [previewId, requestImage]);

  const handleDownload = async (work: WorkRecord) => {
    const found = await lookupImage(work);
    if (!found.ok) {
      toast.push({ message: `${found.message}所以这次没有保存图片。`, tone: 'error' });
      return;
    }
    downloadPoster(found.dataUrl, workFileName(work));
    toast.push({ message: '已保存到本机下载目录。', tone: 'success' });
  };

  const handleShare = async (work: WorkRecord) => {
    const found = await lookupImage(work);
    if (!found.ok) {
      toast.push({ message: `${found.message}所以这次没有发起分享。`, tone: 'error' });
      return;
    }
    const result = await sharePoster(found.dataUrl, workFileName(work), work.title || '念头盒作品');
    if (result === 'unsupported') {
      toast.push({ message: SHARE_UNSUPPORTED_MESSAGE, tone: 'info' });
    } else if (result === 'failed') {
      toast.push({ message: '分享没有完成，图片还在，可以再试一次。', tone: 'info' });
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteWork(pendingDelete.id);
      setPendingDelete(null);
      setPreviewId(null);
      toast.push({ message: '这件作品已经从本机删掉，不会再出现在列表里。', tone: 'info' });
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="nb-page">
      <div className="nb-backbar">
        <button type="button" className="nb-backbar__back" onClick={() => navigate(paths.home)}>
          <Icon name="back" size={18} />
          首页
        </button>
      </div>

      <div className="nb-page__head">
        <h1 className="nb-page__title">我的作品</h1>
        <p className="nb-page__lead">
          这里是你自己保存下来的卡片和海报。作品只存在这台设备上，不会自动上传，也不会自动公开。
        </p>
      </div>

      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? (
        <ErrorState
          message={error ?? '本地作品读取失败，请刷新页面后重试。'}
          onRetry={() => {
            void reload();
          }}
        />
      ) : null}

      {status === 'ready' && works.length === 0 ? (
        <EmptyState
          icon="image"
          title="这里还没有作品。"
          description="记下一个念头，就能在这台设备上把它排成一张卡片，不用登录，也不会消耗任何模型额度。"
          action={
            <Button variant="primary" icon="plus" onClick={() => navigate(paths.home)}>
              去记一个念头
            </Button>
          }
        />
      ) : null}

      {status === 'ready' && works.length > 0 ? (
        <>
          <div className="nb-actionbar">
            <Button variant="secondary" icon="sparkle" onClick={() => navigate(paths.posterTool)}>
              再创作一张
            </Button>
            <span className="nb-kv">共 {works.length} 件，按创建时间从新到旧排列。</span>
          </div>

          <ul className="nb-gallery">
            {works.map((work) => {
              const link = linkOf(work, ideaById);
              const dataUrl = images.get(work.id) ?? null;
              const imageError = imageErrors.get(work.id) ?? null;
              const title = link.idea ? displayTitle(link.idea) : work.title || '（无标题）';
              return (
                <li key={work.id} className="nb-gallery__item">
                  <button
                    type="button"
                    ref={thumbRef(work.id)}
                    className="nb-gallery__thumb"
                    aria-label={`预览作品：${title}`}
                    onClick={() => setPreviewId(work.id)}
                  >
                    {dataUrl ? (
                      <img className="nb-gallery__image" src={dataUrl} alt="" />
                    ) : imageError ? (
                      <span className="nb-gallery__missing">图片数据缺失</span>
                    ) : (
                      <span className="nb-gallery__missing">图片读取中…</span>
                    )}
                  </button>
                  <div className="nb-gallery__meta">
                    <p className="nb-gallery__title">{title}</p>
                    <p className="nb-gallery__sub">
                      {workRenderLabel(work)} · {work.aspect} · {formatRelative(work.createdAt, now)}
                    </p>
                    {link.note ? <p className="nb-gallery__note">{link.note}</p> : null}
                    <div className="nb-gallery__actions">
                      <Button size="sm" variant="ghost" onClick={() => setPreviewId(work.id)}>
                        预览
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          void handleShare(work);
                        }}
                      >
                        分享
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPendingDelete(work)}>
                        删除
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <p className="nb-kv">
            作品默认只在这台设备上。想让手机和电脑都用同一份<strong>念头</strong>，可以登录云端账号；
            图片本身不会因为登录而上传。换设备或清理浏览器数据之前，记得在
            <button
              type="button"
              className="nb-link nb-link--button"
              onClick={() => navigate(paths.settings)}
            >
              备份与恢复
            </button>
            里把作品一起导出。
          </p>
        </>
      ) : null}

      <Dialog
        open={preview !== null}
        title="作品预览"
        lead={preview ? `${workRenderLabel(preview)} · ${preview.aspect} · ${formatRelative(preview.createdAt, now)}` : undefined}
        onClose={() => setPreviewId(null)}
        footer={
          preview ? (
            <>
              <Button
                variant="secondary"
                icon="download"
                onClick={() => {
                  void handleDownload(preview);
                }}
              >
                保存图片
              </Button>
              <Button
                variant="secondary"
                icon="external"
                onClick={() => {
                  void handleShare(preview);
                }}
              >
                系统分享
              </Button>
              {linkOf(preview, ideaById).canContinue ? (
                <Button
                  variant="primary"
                  icon="image"
                  onClick={() => navigate(paths.poster(preview.ideaId))}
                >
                  继续创作
                </Button>
              ) : null}
              <Button variant="danger" icon="trash" onClick={() => setPendingDelete(preview)}>
                删除
              </Button>
            </>
          ) : null
        }
      >
        {preview ? (
          <>
            <div className="nb-poster__preview">
              {images.get(preview.id) ? (
                <img className="nb-poster__image" src={images.get(preview.id)} alt="作品预览" />
              ) : (
                <p className="nb-kv">
                  {imageErrors.get(preview.id) ??
                    '正在读取这件作品的图片……如果一直读不出来，会在这里说明原因。'}
                </p>
              )}
            </div>
            <p className="nb-kv">
              {preview.title ? `作品标题：${preview.title}` : '这件作品没有标题。'}
              {linkOf(preview, ideaById).note ? ` ${linkOf(preview, ideaById).note}` : ''}
            </p>
            <p className="nb-kv">保存和分享都由你手动触发；念头盒不会自动把这张图发到任何公开的地方。</p>
          </>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这件作品？"
        description={
          <p>
            删除之后这件作品和它的图片都会从这台设备上消失，不能再恢复。原来的念头不受影响，
            仍然留在收件箱里。
          </p>
        }
        confirmLabel="删除作品"
        tone="danger"
        busy={deleting}
        onConfirm={() => {
          void confirmDelete();
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
