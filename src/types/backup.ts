/**
 * 备份文件（导出 / 导入）的数据结构。
 *
 * 备份文件包含格式版本号与导出时间，便于未来做数据迁移。
 */

import type { Idea } from './idea';
import type { Project } from './project';

export const BACKUP_FORMAT = 'nianbox-backup';
export const BACKUP_VERSION = 1;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  /** 数据格式版本号。 */
  version: number;
  /** 导出时间（ISO 8601，UTC）。 */
  exportedAt: string;
  /** 导出时的应用版本，仅作参考。 */
  appVersion: string;
  counts: {
    ideas: number;
    projects: number;
    deletedIdeas: number;
    deletedProjects: number;
  };
  ideas: Idea[];
  projects: Project[];
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
  /** 单条记录级别的警告（例如关联的念头缺失）。 */
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
