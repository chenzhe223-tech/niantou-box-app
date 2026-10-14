/**
 * 念头（Idea）领域模型。
 *
 * 设计要点：
 * - id 一经创建永不改变，编辑不会重新生成 ID。
 * - createdAt / updatedAt 同时保留，避免编辑时丢失原始创建时间。
 * - 所有时间戳均为 UTC 毫秒（epoch ms），展示时再按用户本地时区格式化。
 * - 删除采用软删除（deletedAt），支持回收站恢复与永久删除。
 */

/** 分类：可留空，避免记录时的输入负担。 */
export type IdeaCategory = 'life' | 'app' | 'skill' | 'web' | 'other';

/** 状态：第一版固定为以下六种。 */
export type IdeaStatus =
  | 'inbox' // 待整理
  | 'research' // 值得研究
  | 'ready' // 准备开发
  | 'building' // 开发中
  | 'done' // 已完成
  | 'paused'; // 暂缓

/** 潜在产品形态。 */
export type ProductForm = 'app' | 'website' | 'miniprogram' | 'skill' | 'other';

export interface Idea {
  id: string;
  /** 标题可选：留空时列表使用正文首句作为展示标题，不修改原文。 */
  title: string;
  /** 正文必填：始终保留用户原始输入，不做任何改写。 */
  content: string;
  /** 分类可选。 */
  category: IdeaCategory | null;
  /** 状态，默认待整理。 */
  status: IdeaStatus;
  /** 标签，可多个。 */
  tags: string[];
  /** 置顶。 */
  pinned: boolean;
  /** 备注 / 补充思考。 */
  notes: string;
  /** 解决的问题。 */
  problem: string;
  /** 目标用户。 */
  targetUsers: string;
  /** 潜在产品形态。 */
  productForm: ProductForm | null;
  /** 项目链接（GitHub 仓库、发布网页等）。 */
  projectUrl: string;
  /** 升级为创意项目后，指向项目 ID；未升级为 null。 */
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 软删除时间；null 表示未删除。 */
  deletedAt: number | null;
}

/** 创建念头时的输入，只有正文是必填。 */
export interface NewIdeaInput {
  content: string;
  title?: string;
  category?: IdeaCategory | null;
  status?: IdeaStatus;
  tags?: string[];
  notes?: string;
  problem?: string;
  targetUsers?: string;
  productForm?: ProductForm | null;
  projectUrl?: string;
  pinned?: boolean;
}

/** 更新念头时的补丁：只有显式传入的字段才会被写入。 */
export type IdeaPatch = Partial<
  Pick<
    Idea,
    | 'title'
    | 'content'
    | 'category'
    | 'status'
    | 'tags'
    | 'pinned'
    | 'notes'
    | 'problem'
    | 'targetUsers'
    | 'productForm'
    | 'projectUrl'
    | 'projectId'
  >
>;

export type IdeaSort = 'updatedAt' | 'createdAt';

/** 查询条件：搜索 + 筛选 + 排序。 */
export interface IdeaQuery {
  keyword?: string;
  category?: IdeaCategory | 'uncategorized' | null;
  status?: IdeaStatus | null;
  pinnedOnly?: boolean;
  /** 是否包含已删除的念头（回收站视图）。 */
  includeDeleted?: boolean;
  /** 只看回收站（即只看已软删除的记录）。 */
  onlyDeleted?: boolean;
  sort?: IdeaSort;
  order?: 'asc' | 'desc';
}

export const IDEA_CATEGORIES: ReadonlyArray<{ value: IdeaCategory; label: string }> = [
  { value: 'life', label: '生活问题' },
  { value: 'app', label: 'App / 产品创意' },
  { value: 'skill', label: 'Skill / 自动化' },
  { value: 'web', label: '网站 / 小程序' },
  { value: 'other', label: '其他' },
];

export const IDEA_STATUSES: ReadonlyArray<{
  value: IdeaStatus;
  label: string;
  /** 用于状态标签的色调 key。 */
  tone: 'neutral' | 'research' | 'ready' | 'active' | 'done' | 'paused';
}> = [
  { value: 'inbox', label: '待整理', tone: 'neutral' },
  { value: 'research', label: '值得研究', tone: 'research' },
  { value: 'ready', label: '准备开发', tone: 'ready' },
  { value: 'building', label: '开发中', tone: 'active' },
  { value: 'done', label: '已完成', tone: 'done' },
  { value: 'paused', label: '暂缓', tone: 'paused' },
];

export const PRODUCT_FORMS: ReadonlyArray<{ value: ProductForm; label: string }> = [
  { value: 'app', label: 'App' },
  { value: 'website', label: '网站' },
  { value: 'miniprogram', label: '小程序' },
  { value: 'skill', label: 'Skill' },
  { value: 'other', label: '其他' },
];

export const DEFAULT_STATUS: IdeaStatus = 'inbox';

export function isIdeaCategory(value: unknown): value is IdeaCategory {
  return (
    typeof value === 'string' &&
    IDEA_CATEGORIES.some((item) => item.value === value)
  );
}

export function isIdeaStatus(value: unknown): value is IdeaStatus {
  return (
    typeof value === 'string' && IDEA_STATUSES.some((item) => item.value === value)
  );
}

export function isProductForm(value: unknown): value is ProductForm {
  return (
    typeof value === 'string' && PRODUCT_FORMS.some((item) => item.value === value)
  );
}

export function categoryLabel(value: IdeaCategory | null): string | null {
  if (!value) return null;
  return IDEA_CATEGORIES.find((item) => item.value === value)?.label ?? null;
}

export function statusLabel(value: IdeaStatus): string {
  return IDEA_STATUSES.find((item) => item.value === value)?.label ?? '待整理';
}

export function statusTone(
  value: IdeaStatus,
): 'neutral' | 'research' | 'ready' | 'active' | 'done' | 'paused' {
  return IDEA_STATUSES.find((item) => item.value === value)?.tone ?? 'neutral';
}

export function productFormLabel(value: ProductForm | null): string | null {
  if (!value) return null;
  return PRODUCT_FORMS.find((item) => item.value === value)?.label ?? null;
}

/**
 * 正文是否可以被保存：去掉空白后必须有内容，避免产生空白记录。
 */
export function hasSavableContent(content: string): boolean {
  return content.trim().length > 0;
}

/**
 * 列表展示用的标题：优先使用用户填写的标题；
 * 否则取正文第一句（不超过 48 个字符）。绝不修改正文本身。
 */
export function displayTitle(idea: Pick<Idea, 'title' | 'content'>): string {
  const title = idea.title.trim();
  if (title) return title;

  const normalized = idea.content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '（无内容）';

  const match = normalized.match(/^[^。！？!?\n]{1,48}/);
  const sentence = (match ? match[0] : normalized.slice(0, 48)).trim();
  return sentence.length < normalized.length ? `${sentence}…` : sentence;
}

/** 列表摘要：压缩空白后的正文，最多 140 字。 */
export function contentExcerpt(idea: Pick<Idea, 'content'>, max = 140): string {
  const normalized = idea.content.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
