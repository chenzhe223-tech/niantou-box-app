/**
 * 备份文件（导出 / 导入）的数据结构。
 *
 * 备份文件包含格式版本号与导出时间，便于未来做数据迁移。
 *
 * 版本历史：
 * - v1：念头与项目；
 * - v2：加入本机作品元数据（works）与作品图片（workImages）。
 *   旧版 v1 文件仍然可以导入，缺少的作品字段按「空作品集」处理。
 */

import type { Idea } from './idea';
import type { Project } from './project';
import type { WorkImageRecord, WorkRecord } from '../services/works';

export const BACKUP_FORMAT = 'nianbox-backup';
export const BACKUP_VERSION = 2;

export interface BackupCounts {
  ideas: number;
  projects: number;
  deletedIdeas: number;
  deletedProjects: number;
  /** 作品总件数（含关联念头在回收站里的作品）。 */
  works: number;
  /** 关联念头在回收站里的作品件数：这些作品也一并备份，恢复念头后能继续创作。 */
  deletedWorks: number;
  /** 备份中带图片数据的作品件数，正常情况下应与 works 相等。 */
  workImages: number;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  /** 数据格式版本号。 */
  version: number;
  /** 导出时间（ISO 8601，UTC）。 */
  exportedAt: string;
  /** 导出时的应用版本，仅作参考。 */
  appVersion: string;
  counts: BackupCounts;
  ideas: Idea[];
  projects: Project[];
  /**
   * 本机作品的元数据（v2 起）。
   * 图片本体单独放在 workImages 里：一件作品对应最多一条图片记录（以 workId 关联）。
   */
  works: WorkRecord[];
  /**
   * 本机作品图片（v2 起）。
   * 图片始终只在本机流转：备份不会让图片自动上传到任何服务器。
   */
  workImages: WorkImageRecord[];
}

/** 重复记录（相同 ID）的处理策略。 */
export type DuplicateStrategy =
  /** 保留现有数据，跳过重复记录（默认）。 */
  | 'skip'
  /** 使用备份中的记录覆盖同 ID 的现有记录。 */
  | 'overwrite'
  /** 作为新记录导入（生成新的 ID，绝不覆盖、绝不丢弃）。 */
  | 'duplicate';

export interface ImportOptions {
  duplicateStrategy?: DuplicateStrategy;
}

export interface ImportReport {
  strategy: DuplicateStrategy;
  ideasImported: number;
  ideasOverwritten: number;
  ideasSkipped: number;
  ideasDuplicated: number;
  projectsImported: number;
  projectsOverwritten: number;
  projectsSkipped: number;
  projectsDuplicated: number;
  worksImported: number;
  worksOverwritten: number;
  worksSkipped: number;
  worksDuplicated: number;
  /** 实际写入到本机的作品图片数量。 */
  imagesRestored: number;
  /** 单条记录级别的警告（例如关联的念头缺失、作品没有图片数据）。 */
  warnings: string[];
}

export interface ValidationResult {
  ok: boolean;
  /** 校验通过时返回规范化后的备份数据。 */
  backup?: BackupFile;
  /** 校验失败时的可读错误列表。 */
  errors: string[];
  warnings: string[];
}