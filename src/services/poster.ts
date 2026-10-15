/**
 * AI 隐私海报。
 *
 * 隐私设计（这是这个功能的重点，不是附属说明）：
 * 1. **原始念头不直接交给图像模型。** 第一步先做「抽象」：把念头提炼成主题、
 *    情绪、隐喻与视觉元素，并在服务端做一次隐私检查（人名、联系方式、私人项目名
 *    这类内容会被拦下并直接中止生成）。
 * 2. 第二步只把**抽象结果**交给图像模型，因此海报里不会出现原文、个人信息或
 *    私人项目名。
 * 3. 抽象用的是哪家服务，会在界面上如实写出来；数据发给谁由用户自己决定。
 * 4. 没有配置图像服务时，**不会**编造一张「AI 生成」的图。此时改为在本机用
 *    Canvas 画一张品牌模板海报，界面上明确标注「本机绘制，不是 AI 生成」。
 *
 * 固定品牌标识（星形 + 文字）由前端叠加，保证不同风格的海报上品牌呈现一致。
 */

import { BRAND_STAR_PATH } from '../components/BrandMark';
import { cloudRequest } from './cloud/cloudClient';
import { getCloudToken } from './cloud/cloudAuth';

export type PosterStyleId = 'brand' | 'dream' | 'toy3d' | 'minimal' | 'journal' | 'future';
export type PosterAspect = '3:4' | '1:1';

export interface PosterStyle {
  id: PosterStyleId;
  label: string;
  description: string;
  /** 交给图像模型的风格描述（纯文字，不含色值）。 */
  promptStyle: string;
  /** 本机绘制时用到的语义色变量（只引用第 2 层 --nb-*）。 */
  palette: { bg: string; ink: string; accent: string; shape: string };
}

export const POSTER_STYLES: ReadonlyArray<PosterStyle> = [
  {
    id: 'brand',
    label: 'NianBox 品牌主视觉',
    description: '品牌紫底 + 白色星形，最像念头盒自己。',
    promptStyle: 'deep violet background, single off-white twelve-point star as the hero shape, clean minimal composition',
    palette: { bg: '--nb-accent', ink: '--nb-star', accent: '--nb-accent-soft', shape: '--nb-star' },
  },
  {
    id: 'dream',
    label: '梦境漂浮风',
    description: '淡紫渐变 + 漂浮的形状，像梦里的一片云。',
    promptStyle: 'soft lavender dreamscape, floating translucent shapes, gentle glow, calm and airy',
    palette: { bg: '--nb-accent-soft', ink: '--nb-accent-strong', accent: '--nb-white', shape: '--nb-accent' },
  },
  {
    id: 'toy3d',
    label: '趣味 3D 创意风',
    description: '暖阳黄底 + 圆润立体形状，轻松不幼稚。',
    promptStyle: 'playful soft 3D toy shapes, warm sunny yellow backdrop, rounded friendly forms, studio lighting',
    palette: { bg: '--nb-discover-soft', ink: '--nb-ink', accent: '--nb-accent', shape: '--nb-accent' },
  },
  {
    id: 'minimal',
    label: '极简艺术海报',
    description: '大量留白 + 一个几何主体，安静有质感。',
    promptStyle: 'minimalist art poster, generous negative space, one geometric subject, muted warm paper background',
    palette: { bg: '--nb-surface', ink: '--nb-ink', accent: '--nb-accent', shape: '--nb-line' },
  },
  {
    id: 'journal',
    label: '手绘灵感日记风',
    description: '纸感底 + 手绘线条，像随手翻到的笔记。',
    promptStyle: 'hand drawn journal page, paper texture, loose ink sketch lines, warm notebook feel',
    palette: { bg: '--nb-bg-tint', ink: '--nb-ink-soft', accent: '--nb-accent', shape: '--nb-accent-soft' },
  },
  {
    id: 'future',
    label: '未来创想风',
    description: '深色底 + 紫色光带，适合写给未来的自己。',
    promptStyle: 'futuristic dark composition, violet light beams, subtle grid horizon, speculative and clean',
    palette: { bg: '--nb-ink', ink: '--nb-white', accent: '--nb-accent', shape: '--nb-accent-soft' },
  },
];

export function getPosterStyle(id: PosterStyleId): PosterStyle {
  return POSTER_STYLES.find((style) => style.id === id) ?? POSTER_STYLES[0];
}

export const POSTER_ASPECTS: ReadonlyArray<{ value: PosterAspect; label: string; ratio: number }> = [
  { value: '3:4', label: '3:4 竖版', ratio: 3 / 4 },
  { value: '1:1', label: '1:1 方形', ratio: 1 },
];

export interface Abstraction {
  theme: string;
  mood: string[];
  metaphor: string;
  visuals: string[];
}

export interface PrivacyReport {
  safe: boolean;
  violations: string[];
}

export interface AbstractionResult {
  abstraction: Abstraction;
  privacy: PrivacyReport;
  /** 'ai' = 模型生成；'local' = 服务端用本地规则抽象（没配模型时）。 */
  source: 'ai' | 'local';
  /** 数据发给了哪家服务；本地抽象时为空。 */
  service: string;
  message: string;
}

export interface PosterImageResult {
  /** 'ai' = 图像模型生成；'local' = 本机 Canvas 绘制（不是 AI 图）。 */
  render: 'ai' | 'local';
  /** data: URL，可直接放进 <img src> 或下载。 */
  dataUrl: string;
  provider: string;
  /** 服务端实际使用的图像提示词（抽象结果组成），便于用户核对。 */
  promptPreview: string;
  privacy: PrivacyReport;
}

const CATEGORY_LABEL: Record<string, string> = {
  life: '生活问题',
  app: 'App / 产品创意',
  skill: 'Skill / 自动化',
  web: '网站 / 小程序',
  other: '其他',
};

/** 给服务端的文本：只带正文与标题，不带标签、备注等其它字段。 */
export function abstractionInput(idea: { title: string; content: string; category: string | null }): string {
  const parts = [idea.title.trim(), idea.content.trim()].filter((part) => part !== '');
  const category = idea.category ? CATEGORY_LABEL[idea.category] : '';
  if (category) parts.push(`（分类：${category}）`);
  return parts.join('\n');
}

interface AbstractResponse {
  configured?: boolean;
  source?: string;
  service?: string;
  abstraction?: Partial<Abstraction>;
  privacy?: Partial<PrivacyReport>;
  message?: string;
}

/**
 * 第一步：抽象 + 隐私检查。
 * 隐私检查不通过时服务端返回 422，这里如实抛出，由界面提示用户「已停止生成」。
 */
export async function requestAbstraction(content: string): Promise<AbstractionResult> {
  const response = await cloudRequest<AbstractResponse>('/ai/abstract', {
    method: 'POST',
    token: getCloudToken(),
    body: { content },
    retries: 1,
    timeoutMs: 30_000,
  });

  const abstraction = response?.abstraction ?? {};
  return {
    abstraction: {
      theme: typeof abstraction.theme === 'string' ? abstraction.theme : '',
      mood: Array.isArray(abstraction.mood) ? abstraction.mood.map(String) : [],
      metaphor: typeof abstraction.metaphor === 'string' ? abstraction.metaphor : '',
      visuals: Array.isArray(abstraction.visuals) ? abstraction.visuals.map(String) : [],
    },
    privacy: {
      safe: response?.privacy?.safe !== false,
      violations: Array.isArray(response?.privacy?.violations)
        ? response.privacy.violations.map(String)
        : [],
    },
    source: response?.source === 'ai' ? 'ai' : 'local',
    service: typeof response?.service === 'string' ? response.service : '',
    message: typeof response?.message === 'string' ? response.message : '',
  };
}

interface PosterResponse {
  configured?: boolean;
  generated?: boolean;
  provider?: string;
  base64?: string;
  url?: string;
  prompt?: string;
  privacy?: Partial<PrivacyReport>;
  message?: string;
}

function toDataUrl(response: PosterResponse): string {
  if (typeof response.base64 === 'string' && response.base64.length > 0) {
    return response.base64.startsWith('data:')
      ? response.base64
      : `data:image/png;base64,${response.base64}`;
  }
  if (typeof response.url === 'string' && response.url.length > 0) return response.url;
  return '';
}

/** 第二步：把抽象结果交给图像模型。未配置图像服务时返回 null（由调用方改走本机绘制）。 */
export async function requestPoster(options: {
  style: PosterStyleId;
  aspect: PosterAspect;
  abstraction: Abstraction;
  original?: string;
}): Promise<PosterImageResult | null> {
  const response = await cloudRequest<PosterResponse>('/ai/poster', {
    method: 'POST',
    token: getCloudToken(),
    body: {
      style: options.style,
      aspect: options.aspect,
      abstraction: options.abstraction,
      original: options.original ?? '',
    },
    // 图像生成会消耗额度，重试交给用户自己点「重新生成」。
    retries: 0,
    timeoutMs: 90_000,
  });

  if (response?.generated !== true) return null;
  const dataUrl = toDataUrl(response);
  if (!dataUrl) return null;

  return {
    render: 'ai',
    dataUrl,
    provider: typeof response.provider === 'string' ? response.provider : '',
    promptPreview: typeof response.prompt === 'string' ? response.prompt : '',
    privacy: {
      safe: response.privacy?.safe !== false,
      violations: Array.isArray(response.privacy?.violations)
        ? response.privacy.violations.map(String)
        : [],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 本机绘制（未配置图像服务时的诚实兜底）                                        */
/* -------------------------------------------------------------------------- */

function readToken(name: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

/**
 * 画布用色：只从 global.css 的语义变量里取，取不到就逐级退回另一个语义变量，
 * 最后退回 transparent。**不在代码里写死任何色值**，品牌色只定义在 global.css。
 */
function readPaletteColor(name: string, fallbackName: string): string {
  return readToken(name) || readToken(fallbackName) || 'transparent';
}

/** 品牌星形的顶点：从 BrandMark 的路径解析，保证和应用里用的是同一个形状。 */
function starPoints(): Array<[number, number]> {
  const numbers = (BRAND_STAR_PATH.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const points: Array<[number, number]> = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push([numbers[index], numbers[index + 1]]);
  }
  return points;
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  const points = starPoints();
  if (points.length < 3) return;
  // 路径坐标基于 96×96 的 viewBox，这里等比缩放到目标尺寸。
  const scale = size / 96;
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    const px = cx + (x - 48) * scale;
    const py = cy + (y - 48) * scale;
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const char of text) {
    const next = current + char;
    if (ctx.measureText(next).width > maxWidth && current !== '') {
      lines.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export interface LocalPosterResult {
  dataUrl: string;
  width: number;
  height: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败。'));
    image.src = src;
  });
}

/**
 * 给 AI 生成的海报补一条固定品牌页脚。
 *
 * 为什么必须有这一步：
 * 1. 图像模型给的图不保证「干净」——免费档的 CogView 会在右下角打上「AI 生成」水印，
 *    拿这种图当分享海报既不统一也不好看。裁掉底部一小条再补上品牌紫页脚，
 *    既盖住水印，又让六种风格的海报有一致的品牌收尾。
 * 2. 页脚的星形来自 BrandMark 的同一段路径，和页面上的 Logo 是同一个形状，
 *    不会出现「换个页面就换个星星」的情况。
 *
 * 画布用的是同一个 data: URL，不跨域，因此 toDataURL 不会被污染。
 * 任何一步失败都返回 null，由调用方保留原图 —— 叠加品牌标识不该让用户拿不到图。
 */
export async function applyBrandFooter(
  dataUrl: string,
  aspect: PosterAspect,
): Promise<string | null> {
  try {
    const ratio = (POSTER_ASPECTS.find((item) => item.value === aspect) ?? POSTER_ASPECTS[0]).ratio;
    const width = 1080;
    const height = Math.round(width / ratio);
    // 页脚高度取 8.5%：足以盖住服务商打在右下角的水印，又不至于吃掉画面。
    const bandHeight = Math.round(height * 0.085);
    const artHeight = height - bandHeight;

    const source = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // 原图按 cover 方式铺满画面区，不留白边。
    const scale = Math.max(width / source.width, artHeight / source.height);
    const drawWidth = source.width * scale;
    const drawHeight = source.height * scale;
    ctx.drawImage(
      source,
      (width - drawWidth) / 2,
      (artHeight - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );

    // 品牌页脚：品牌紫底 + 米白星形与字标。
    const band = readPaletteColor('--nb-accent', '--nb-ink');
    const onBand = readPaletteColor('--nb-star', '--nb-white');
    ctx.fillStyle = band;
    ctx.fillRect(0, artHeight, width, bandHeight);

    const starSize = bandHeight * 0.62;
    const nameSize = Math.round(bandHeight * 0.42);
    ctx.font = `600 ${nameSize}px ${readToken('--nb-font') || 'sans-serif'}`;
    const nameText = '念头盒 NianBox';
    const gap = bandHeight * 0.22;
    const textWidth = ctx.measureText(nameText).width;
    const groupWidth = starSize + gap + textWidth;
    const groupLeft = (width - groupWidth) / 2;
    const centerY = artHeight + bandHeight / 2;

    drawStar(ctx, groupLeft + starSize / 2, centerY, starSize, onBand);
    ctx.fillStyle = onBand;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(nameText, groupLeft + starSize + gap, centerY);

    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * 在本机画一张品牌模板海报。
 *
 * 只使用抽象结果（主题词 + 情绪词），**不使用念头原文**，所以海报上
 * 不会有私人内容。这张图不是 AI 生成的，界面必须如实标注。
 */
export async function renderLocalPoster(options: {
  style: PosterStyleId;
  aspect: PosterAspect;
  abstraction: Abstraction;
}): Promise<LocalPosterResult> {
  const style = getPosterStyle(options.style);
  const aspect = POSTER_ASPECTS.find((item) => item.value === options.aspect) ?? POSTER_ASPECTS[0];
  const width = 1080;
  const height = Math.round(width / aspect.ratio);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('这台设备的浏览器不支持 Canvas 绘制，无法在本机生成海报。');
  }

  const bg = readPaletteColor(style.palette.bg, '--nb-bg');
  const ink = readPaletteColor(style.palette.ink, '--nb-ink');
  const accent = readPaletteColor(style.palette.accent, '--nb-accent');
  const shape = readPaletteColor(style.palette.shape, '--nb-accent-soft');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // 装饰：两枚半透明圆 + 一枚品牌星形，构成可辨认的「念头盒」气质。
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = shape;
  ctx.beginPath();
  ctx.arc(width * 0.82, height * 0.16, width * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(width * 0.14, height * 0.9, width * 0.26, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  drawStar(ctx, width * 0.5, height * 0.3, width * 0.2, accent);

  // 主题词（来自抽象结果，不是原文）。
  const theme = options.abstraction.theme.trim() || '一个念头';
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const themeSize = Math.round(width * 0.082);
  ctx.font = `600 ${themeSize}px ${readToken('--nb-font') || 'sans-serif'}`;
  const themeLines = wrapText(ctx, theme, width * 0.76).slice(0, 3);
  themeLines.forEach((line, index) => {
    ctx.fillText(line, width / 2, height * 0.55 + index * themeSize * 1.35);
  });

  const mood = options.abstraction.mood.slice(0, 3).join(' · ');
  if (mood) {
    ctx.globalAlpha = 0.85;
    const moodSize = Math.round(width * 0.035);
    ctx.font = `400 ${moodSize}px ${readToken('--nb-font') || 'sans-serif'}`;
    ctx.fillText(mood, width / 2, height * 0.55 + themeLines.length * themeSize * 1.35 + moodSize);
    ctx.globalAlpha = 1;
  }

  // 固定品牌标识：星形 + 文字，与页面里的 BrandMark 同源。
  const badgeSize = width * 0.052;
  const badgeY = height - width * 0.1;
  drawStar(ctx, width / 2 - width * 0.09, badgeY, badgeSize, ink);
  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  const nameSize = Math.round(width * 0.036);
  ctx.font = `600 ${nameSize}px ${readToken('--nb-font') || 'sans-serif'}`;
  ctx.fillText('念头盒 NianBox', width / 2 - width * 0.052, badgeY + nameSize * 0.36);
  ctx.textAlign = 'center';

  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

/** 在浏览器里下载一张 data: URL 图片。 */
export function downloadPoster(dataUrl: string, filename: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * 用系统分享面板分享图片。
 * 需要先把 data: URL 转成 File——多数浏览器只接受 File 形式。
 */
export async function sharePoster(
  dataUrl: string,
  filename: string,
  text: string,
): Promise<'shared' | 'unsupported' | 'failed'> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
      return 'unsupported';
    }
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], filename, { type: blob.type || 'image/png' });
    const canShareFiles =
      typeof navigator.canShare === 'function' ? navigator.canShare({ files: [file] }) : false;
    if (!canShareFiles) {
      await navigator.share({ title: '念头盒灵感海报', text });
      return 'shared';
    }
    await navigator.share({ files: [file], title: '念头盒灵感海报', text });
    return 'shared';
  } catch {
    return 'failed';
  }
}
