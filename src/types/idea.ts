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

/**
 * 分类是谁定的。
 * - `ai`：服务端 AI 模型给出；
 * - `rules`：本机 / 服务端关键词规则兜底；
 * - `manual`：用户自己改过；
 * - `null`：还没分类。
 * 界面会如实展示来源，不会把「规则猜的」说成「AI 想的」。
 */
export type IdeaCategorySource = 'ai' | 'rules' | 'manual';

/**
 * 一件「作品」——目前只有灵感海报。
 *
 * 这里是 PRD 6.2「继续创作 / 回顾此前生成的结果」与后续「作品公开」预留的扩展点：
 * 本轮**不写入任何数据**（没有任何代码会生成 works），只先把字段位置与校验规则定下来，
 * 这样以后开始记录作品时，旧数据（没有这个字段）与新数据都能被安全读出。
 *
 * 范围说明：works 目前只在本机有意义 —— 服务端同步仍按既有字段白名单落库，
 * 真要跨端回顾作品或对外公开，必须同步扩展服务端结构，不能只靠这个字段。
 */
export interface IdeaWork {
  id: string;
  /** 作品类型；本轮只有海报。 */
  kind: 'poster';
  /** 生成方式：'ai' = 图像模型生成；'local' = 本机 Canvas 绘制。 */
  render: 'ai' | 'local';
  style: string;
  aspect: string;
  /** 是否已公开；公开机制未实现，当前只允许 false。 */
  public: boolean;
  createdAt: number;
}

export interface Idea {
  id: string;
  /** 标题可选：留空时列表使用正文首句作为展示标题，不修改原文。 */
  title: string;
  /** 正文必填：始终保留用户原始输入，不做任何改写。 */
  content: string;
  /** 分类可选。 */
  category: IdeaCategory | null;
  /** 分类来源（AI / 规则 / 手动），未分类时为 null。 */
  categorySource: IdeaCategorySource | null;
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
  /**
   * 已生成的作品（可选，本轮不写入）。
   * 缺省表示「从来没有记录过作品」，与空数组含义不同，因此不要补默认值。
   */
  works?: IdeaWork[];
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
    | 'categorySource'
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

export function isCategorySource(value: unknown): value is IdeaCategorySource {
  return value === 'ai' || value === 'rules' || value === 'manual';
}

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

/** 作品字段的兜底校验：只接受完整合法的条目，坏数据直接丢弃而不是照单全收。 */
export function isIdeaWork(value: unknown): value is IdeaWork {
  if (typeof value !== 'object' || value === null) return false;
  const work = value as Partial<IdeaWork>;
  return (
    typeof work.id === 'string' &&
    work.id !== '' &&
    work.kind === 'poster' &&
    (work.render === 'ai' || work.render === 'local') &&
    typeof work.style === 'string' &&
    typeof work.aspect === 'string' &&
    typeof work.public === 'boolean' &&
    typeof work.createdAt === 'number' &&
    Number.isFinite(work.createdAt)
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
