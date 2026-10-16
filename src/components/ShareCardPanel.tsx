/**
 * 分享卡片 —— 把一条念头排成一张能保存、能分享的图片。
 *
 * 与「灵感海报」的分工（页面上也要写清楚，不能含糊）：
 * - 灵感海报走服务端 AI 抽象，图上只有主题词，没有原文；
 * - 分享卡片在这台设备上用 Canvas 绘制，图上**就是念头原文**，
 *   不上传、不联网、不需要登录。
 *
 * 因此这里的顺序是固定的：先选要放上去的文字 → 把这段文字逐字列出来让用户确认
 * → 再渲染预览 → 最后才允许保存或分享。
 * 用户没在屏幕上确认过的内容，不会出现在图片里。
 */

import { useCallback, useEffect, useState } from 'react';
import { copyText } from '../services/aiTools';
import {
  POSTER_ASPECTS,
  downloadPoster,
  renderLocalShareCard,
  sharePoster,
  type LocalPosterResult,
  type PosterAspect,
  type ShareCardTextMode,
} from '../services/poster';
import { displayTitle, type Idea } from '../types/idea';
import { Button } from './Button';
import { Icon } from './Icon';
import { useToast } from './Toast';

const TEXT_MODES: ReadonlyArray<{ value: ShareCardTextMode; label: string }> = [
  { value: 'content', label: '标题 + 正文' },
  { value: 'title', label: '只要标题' },
];

export function ShareCardPanel({ idea }: { idea: Idea }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ShareCardTextMode>('content');
  const [aspect, setAspect] = useState<PosterAspect>('3:4');
  const [card, setCard] = useState<LocalPosterResult | null>(null);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = displayTitle(idea);
  const body = idea.content.trim();
  /** 真正会被写进图片、也会被复制 / 分享的文字。 */
  const sharedText = mode === 'title' || title === body ? title : `${title}\n\n${body}`;

  const render = useCallback(async () => {
    setRendering(true);
    setError(null);
    try {
      const result = await renderLocalShareCard({ title, content: body, mode, aspect });
      setCard(result);
    } catch (caught) {
      setCard(null);
      setError(caught instanceof Error ? caught.message : '本机绘制失败，可以换一种比例再试。');
    } finally {
      setRendering(false);
    }
  }, [aspect, body, mode, title]);

  // 只有用户真的展开时才画图：打开详情页时不为这一块白白跑一遍 Canvas。
  useEffect(() => {
    if (!open) return;
    void render();
  }, [open, render]);

  const fileName = `nianbox-share-${title.slice(0, 12)}-${aspect.replace(':', 'x')}.png`;

  const handleDownload = () => {
    if (!card) return;
    downloadPoster(card.dataUrl, fileName);
    toast.push({ message: '已保存到本机下载目录。', tone: 'success' });
  };

  const handleCopy = async () => {
    const ok = await copyText(sharedText);
    toast.push(
      ok
        ? { message: '卡片文字已复制，粘贴到哪里都可以。', tone: 'success' }
        : { message: '复制没有成功，可以手动选中上面那段文字再复制。', tone: 'error' },
    );
  };

  const handleShare = async () => {
    if (!card) return;
    const result = await sharePoster(card.dataUrl, fileName, sharedText);
    if (result === 'unsupported') {
      toast.push({
        message: '这台设备的浏览器不支持系统分享，可以先保存图片，再在微信或相册里分享。',
        tone: 'info',
      });
    } else if (result === 'failed') {
      toast.push({ message: '分享没有完成，图片还在，可以再试一次。', tone: 'info' });
    }
  };

  return (
    <section className="nb-section" aria-labelledby="nb-detail-share">
      <div className="nb-section__head">
        <h2 className="nb-section__title" id="nb-detail-share">
          分享卡片
        </h2>
        <span className="nb-section__hint">本机绘制 · 不用登录</span>
      </div>
      <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
        <p className="nb-kv">
          把这条念头排成一张图片，直接保存或分享。卡片用的是念头原文，只在这台设备上绘制，
          不会上传到任何服务；生成之前会先把文字逐字列出来给你确认。
        </p>

        <details
          className="nb-disclosure"
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary className="nb-disclosure__summary">
            <span>生成分享卡片</span>
            <span className="nb-disclosure__chevron" aria-hidden="true">
              <Icon name="chevron" size={18} />
            </span>
          </summary>
          <div className="nb-disclosure__body">
            <div className="nb-chips" role="group" aria-label="卡片上放哪些文字">
              {TEXT_MODES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={item.value === mode ? 'nb-chip nb-chip--active' : 'nb-chip'}
                  aria-pressed={item.value === mode}
                  onClick={() => setMode(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="nb-chips" role="group" aria-label="卡片比例">
              {POSTER_ASPECTS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={item.value === aspect ? 'nb-chip nb-chip--active' : 'nb-chip'}
                  aria-pressed={item.value === aspect}
                  onClick={() => setAspect(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <p className="nb-kv">将要分享的文字（就是图片上会出现的内容）：</p>
            <p className="nb-sharecard__text">{sharedText}</p>
            <p className="nb-kv">
              分享给谁由你决定：如果这段话里有个人信息、私人项目名或不想公开的细节，
              「只要标题」或者先回去改一下念头都可以。
            </p>

            {rendering ? (
              <div className="nb-state" role="status" aria-live="polite">
                <span className="nb-spinner" aria-hidden="true" />
                <p className="nb-state__title">正在本机排版…</p>
              </div>
            ) : null}

            {!rendering && error ? (
              <div className="nb-notice nb-notice--warn" role="status">
                <p className="nb-notice__title">这次没有画出来</p>
                <p>{error}</p>
                <p className="nb-kv">念头原文没有变化，可以换一种比例或改成「只要标题」再试。</p>
              </div>
            ) : null}

            {!rendering && card ? (
              <div className="nb-poster__preview">
                <img
                  className="nb-poster__image"
                  src={card.dataUrl}
                  alt="分享卡片预览"
                />
              </div>
            ) : null}

            <div className="nb-actionbar">
              <Button variant="secondary" icon="refresh" disabled={rendering} onClick={() => void render()}>
                重新排版
              </Button>
              {card && !rendering ? (
                <>
                  <Button variant="primary" icon="download" onClick={handleDownload}>
                    保存图片
                  </Button>
                  <Button variant="secondary" icon="external" onClick={() => void handleShare()}>
                    系统分享
                  </Button>
                </>
              ) : null}
              <Button variant="ghost" icon="upload" onClick={() => void handleCopy()}>
                复制文字
              </Button>
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}
