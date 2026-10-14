/**
 * 创意项目（Project）领域模型。
 *
 * 项目由某条念头升级而来，必须始终保留 ideaId 关联，
 * 避免把原始想法与后续开发过程割裂。
 */

import type { ProductForm } from './idea';

export type ProjectProgress =
  | 'preparing' // 准备中
  | 'building' // 开发中
  | 'testing' // 打磨中
  | 'released' // 已发布
  | 'paused'; // 暂缓

export interface Project {
  id: string;
  /** 关联的原始念头 ID，必填且不会变更。 */
  ideaId: string;
  name: string;
  /** 需要解决的问题。 */
  problem: string;
  /** 目标用户。 */
  targetUsers: string;
  /** 核心功能。 */
  features: string;
  productForm: ProductForm | null;
  progress: ProjectProgress;
  /** GitHub 仓库 URL。 */
  repoUrl: string;
  /** 已发布网址。 */
  liveUrl: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface NewProjectInput {
  ideaId: string;
  name?: string;
  problem?: string;
  targetUsers?: string;
  features?: string;
  productForm?: ProductForm | null;
  progress?: ProjectProgress;
  repoUrl?: string;
  liveUrl?: string;
}

export type ProjectPatch = Partial<
  Pick<
    Project,
    | 'name'
    | 'problem'
    | 'targetUsers'
    | 'features'
    | 'productForm'
    | 'progress'
    | 'repoUrl'
    | 'liveUrl'
  >
>;

export const PROJECT_PROGRESSES: ReadonlyArray<{
  value: ProjectProgress;
  label: string;
}> = [
  { value: 'preparing', label: '准备中' },
  { value: 'building', label: '开发中' },
  { value: 'testing', label: '打磨中' },
  { value: 'released', label: '已发布' },
  { value: 'paused', label: '暂缓' },
];

export const DEFAULT_PROGRESS: ProjectProgress = 'preparing';

export function isProjectProgress(value: unknown): value is ProjectProgress {
  return (
    typeof value === 'string' &&
    PROJECT_PROGRESSES.some((item) => item.value === value)
  );
}

export function progressLabel(value: ProjectProgress): string {
  return PROJECT_PROGRESSES.find((item) => item.value === value)?.label ?? '准备中';
}
