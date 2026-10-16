/**
 * 我的作品 —— 本机保存下来的卡片与海报。
 *
 * 几条不会含糊的规矩：
 * 1. 这里列的是**这台设备上真实存在的图片**，从 IndexedDB 读出来，不是占位数据；
 * 2. 作品默认只在本机，不上传、不公开；删除前有明确提示，删除是彻底删掉；
 * 3. 关联的念头被永久删除时，作品已经在同一个事务里一起删掉了（见 storage.purgeIdea）；
 *    念头只是进了回收站时，图片先留着，恢复念头后又能继续创作。
 */

import { useMemo, useState } from 'react';
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
import { useWorks } from '../hooks/useWorks';
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

export function WorksPage({ navigate }: { navigate: (hash: string) => void }) {
  const { ideas } = useAppData();
  const { status, error, works, images, reload } = useWorks();
  const toast = useToast();
  const now = useNow();

  const [previewId, setPreviewId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const ideaById = useMemo(() => {
    const map = new Map<string, Idea>();
    for (const idea of ideas) map.set(idea.id, idea);
    return map;
  }, [ideas]);

  const preview = previewId ? works.find((work) => work.id === previewId) ?? null : null;

  const handleDownload = (work: WorkRecord) => {
    const dataUrl = images.get(work.id);
    if (!dataUrl) {
      toast.push({ message: '这件作品的图片数据缺失，无法保存；可以直接删除这条记录。', tone: 'error' });
      return;
    }
    downloadPoster(dataUrl, workFileName(work));
    toast.push({ message: '已保存到本机下载目录。', tone: 'success' });
  };

  const handleShare = async (work: WorkRecord) => {
    const dataUrl = images.get(work.id);
    if (!dataUrl) {
      toast.push({ message: '这件作品的图片数据缺失，暂时无法分享。', tone: 'error' });
      return;
    }
    const result = await sharePoster(dataUrl, workFileName(work), work.title || '念头盒作品');
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
              const title = link.idea ? displayTitle(link.idea) : work.title || '（无标题）';
              return (
                <li key={work.id} className="nb-gallery__item">
                  <button
                    type="button"
                    className="nb-gallery__thumb"
                    aria-label={`预览作品：${title}`}
                    onClick={() => setPreviewId(work.id)}
                  >
                    {dataUrl ? (
                      <img className="nb-gallery__image" src={dataUrl} alt="" />
                    ) : (
                      <span className="nb-gallery__missing">图片数据缺失</span>
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
                      <Button size="sm" variant="ghost" onClick={() => void handleShare(work)}>
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
            图片本身不会因为登录而上传。
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
              <Button variant="secondary" icon="download" onClick={() => handleDownload(preview)}>
                保存图片
              </Button>
              <Button variant="secondary" icon="external" onClick={() => void handleShare(preview)}>
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
                <p className="nb-kv">这件作品的图片数据缺失，只剩下这条记录。</p>
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
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
