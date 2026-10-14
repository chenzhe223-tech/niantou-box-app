/**
 * 数据的导出与导入。
 *
 * 原则：
 * - 导出的 JSON 自带格式版本号与导出时间，可被完整地重新导入；
 * - 导入前先严格校验，校验失败时给出可理解的错误，且绝不覆盖现有数据；
 * - 相同 ID 的记录有明确的冲突策略，默认保留现有数据，不静默丢失内容。
 */

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  type BackupFile,
  type DuplicateStrategy,
  type ImportOptions,
  type ImportReport,
  type ValidationResult,
} from '../types/backup';
import type { Idea } from '../types/idea';
import type { Project } from '../types/project';
import {
  NianBoxError,
  createId,
  normalizeIdea,
  normalizeProject,
  readSnapshot,
  toNianBoxError,
  writeRecords,
} from './storage';

export const APP_VERSION = '1.0.0';

export { BACKUP_FORMAT, BACKUP_VERSION };
export type { BackupFile, DuplicateStrategy, ImportOptions, ImportReport, ValidationResult };

/** 文件名：nianbox-backup-YYYY-MM-DD.json（按本地日期，避免时区导致的日期错位）。 */
export function backupFileName(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `nianbox-backup-${year}-${month}-${day}.json`;
}

export function buildBackup(ideas: readonly Idea[], projects: readonly Project[]): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    counts: {
      ideas: ideas.filter((idea) => idea.deletedAt === null).length,
      projects: projects.filter((project) => project.deletedAt === null).length,
      deletedIdeas: ideas.filter((idea) => idea.deletedAt !== null).length,
      deletedProjects: projects.filter((project) => project.deletedAt !== null).length,
    },
    ideas: [...ideas],
    projects: [...projects],
  };
}

export async function exportBackup(): Promise<BackupFile> {
  const snapshot = await readSnapshot(true);
  return buildBackup(snapshot.ideas, snapshot.projects);
}

export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDate(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * 校验任意输入是否为可用的备份文件。
 * 返回规范化后的数据，同时收集警告。
 */
export function validateBackup(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['备份文件的根结构不是对象，无法识别。'], warnings };
  }

  if (input.format !== BACKUP_FORMAT) {
    errors.push(
      `这不是念头盒的备份文件（缺少标识 “${BACKUP_FORMAT}”）。请选择由「导出数据」生成的 JSON 文件。`,
    );
  }

  const version = input.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    errors.push('备份文件缺少合法的格式版本号（version）。');
  } else if (version > BACKUP_VERSION) {
    errors.push(
      `备份文件版本（v${version}）高于当前应用支持的版本（v${BACKUP_VERSION}），请先升级应用再导入。`,
    );
  }

  if (!Array.isArray(input.ideas)) {
    errors.push('备份文件缺少 ideas 记录数组。');
  }
  if (input.projects !== undefined && !Array.isArray(input.projects)) {
    errors.push('备份文件中的 projects 字段必须是数组。');
  }
  if (input.exportedAt !== undefined && parseDate(input.exportedAt) === null) {
    warnings.push('备份文件中的导出时间无法解析，导入时会忽略该字段。');
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const rawIdeas = input.ideas as unknown[];
  const rawProjects = Array.isArray(input.projects) ? (input.projects as unknown[]) : [];

  const ideas: Idea[] = [];
  const seenIdeaIds = new Set<string>();

  rawIdeas.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      errors.push(`第 ${index + 1} 条念头不是对象，无法导入。`);
      return;
    }
    const id = raw.id;
    if (typeof id !== 'string' || id.trim() === '') {
      errors.push(`第 ${index + 1} 条念头缺少有效的记录 ID。`);
      return;
    }
    if (seenIdeaIds.has(id)) {
      errors.push(`备份文件中存在重复的念头 ID：${id}。`);
      return;
    }
    const content = raw.content;
    if (typeof content !== 'string' || content.trim() === '') {
      errors.push(`念头 ${id} 的正文缺失或为空，无法导入。`);
      return;
    }
    if (typeof raw.title !== 'string' && raw.title !== undefined && raw.title !== null) {
      warnings.push(`念头 ${id} 的标题不是文本，已按空标题处理。`);
    }
    if (raw.status !== undefined && raw.status !== null && !isKnownStatus(raw.status)) {
      warnings.push(`念头 ${id} 的状态值 “${String(raw.status)}” 无法识别，已重置为「待整理」。`);
    }
    if (raw.category !== undefined && raw.category !== null && !isKnownCategory(raw.category)) {
      warnings.push(`念头 ${id} 的分类值 “${String(raw.category)}” 无法识别，已清空分类。`);
    }
    if (parseDate(raw.createdAt) === null) {
      warnings.push(`念头 ${id} 缺少可解析的创建时间，已使用导入时间代替。`);
    }
    if (raw.deletedAt !== undefined && raw.deletedAt !== null && parseDate(raw.deletedAt) === null) {
      warnings.push(`念头 ${id} 的删除时间无法解析，已按「未删除」处理。`);
    }

    seenIdeaIds.add(id);
    ideas.push(
      normalizeIdea({
        ...(raw as Partial<Idea>),
        id,
        content,
        deletedAt:
          raw.deletedAt === undefined || raw.deletedAt === null
            ? null
            : (parseDate(raw.deletedAt) ?? null),
      }),
    );
  });

  const projects: Project[] = [];
  const seenProjectIds = new Set<string>();

  rawProjects.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      errors.push(`第 ${index + 1} 个项目不是对象，无法导入。`);
      return;
    }
    const id = raw.id;
    const ideaId = raw.ideaId;
    if (typeof id !== 'string' || id.trim() === '') {
      errors.push(`第 ${index + 1} 个项目缺少有效的记录 ID。`);
      return;
    }
    if (seenProjectIds.has(id)) {
      errors.push(`备份文件中存在重复的项目 ID：${id}。`);
      return;
    }
    if (typeof ideaId !== 'string' || ideaId.trim() === '') {
      errors.push(`项目 ${id} 缺少关联的念头 ID（ideaId），无法建立关联。`);
      return;
    }
    if (!seenIdeaIds.has(ideaId)) {
      warnings.push(`项目 ${id} 关联的念头 ${ideaId} 不在备份文件中，已跳过该项目。`);
      return;
    }
    if (raw.progress !== undefined && raw.progress !== null && !isKnownProgress(raw.progress)) {
      warnings.push(`项目 ${id} 的进度值 “${String(raw.progress)}” 无法识别，已重置为「准备中」。`);
    }

    seenProjectIds.add(id);
    projects.push(
      normalizeProject({
        ...(raw as Partial<Project>),
        id,
        ideaId,
        deletedAt:
          raw.deletedAt === undefined || raw.deletedAt === null
            ? null
            : (parseDate(raw.deletedAt) ?? null),
      }),
    );
  });

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    version: typeof version === 'number' ? version : BACKUP_VERSION,
    exportedAt:
      typeof input.exportedAt === 'string' && parseDate(input.exportedAt) !== null
        ? input.exportedAt
        : new Date().toISOString(),
    appVersion: typeof input.appVersion === 'string' ? input.appVersion : 'unknown',
    counts: {
      ideas: ideas.filter((idea) => idea.deletedAt === null).length,
      projects: projects.filter((project) => project.deletedAt === null).length,
      deletedIdeas: ideas.filter((idea) => idea.deletedAt !== null).length,
      deletedProjects: projects.filter((project) => project.deletedAt !== null).length,
    },
    ideas,
    projects,
  };

  return { ok: true, backup, errors, warnings };
}

function isKnownStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    ['inbox', 'research', 'ready', 'building', 'done', 'paused'].includes(value)
  );
}

function isKnownCategory(value: unknown): boolean {
  return (
    typeof value === 'string' && ['life', 'app', 'skill', 'web', 'other'].includes(value)
  );
}

function isKnownProgress(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    ['preparing', 'building', 'testing', 'released', 'paused'].includes(value)
  );
}

/** 解析 JSON 文本并校验；JSON 语法错误同样返回可读信息。 */
export function parseBackup(text: string): ValidationResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, errors: ['文件内容为空，无法导入。'], warnings: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errors: [`文件不是合法的 JSON，无法导入：${detail}`],
      warnings: [],
    };
  }
  return validateBackup(parsed);
}

/**
 * 导入备份数据。默认策略为「保留现有数据，跳过同 ID 的记录」。
 * 整个过程要么完整写入，要么完全不改动现有数据。
 */
export async function importBackup(
  input: BackupFile | string | unknown,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const strategy: DuplicateStrategy = options.duplicateStrategy ?? 'skip';
  const validation = typeof input === 'string' ? parseBackup(input) : validateBackup(input);

  if (!validation.ok || !validation.backup) {
    throw new NianBoxError(
      'INVALID_INPUT',
      validation.errors.join('\n') || '备份文件校验未通过。',
    );
  }

  const backup = validation.backup;
  const current = await readSnapshot(true);
  const existingIdeas = new Map(current.ideas.map((idea) => [idea.id, idea]));
  const existingProjects = new Map(current.projects.map((project) => [project.id, project]));

  const report: ImportReport = {
    strategy,
    ideasImported: 0,
    ideasOverwritten: 0,
    ideasSkipped: 0,
    ideasDuplicated: 0,
    projectsImported: 0,
    projectsOverwritten: 0,
    projectsSkipped: 0,
    projectsDuplicated: 0,
    warnings: [...validation.warnings],
  };

  const ideasToWrite: Idea[] = [];
  const projectsToWrite: Project[] = [];
  /** 备份中的念头 ID → 实际写入的念头 ID（「作为新记录导入」时会变化）。 */
  const ideaIdMap = new Map<string, string>();

  for (const idea of backup.ideas) {
    if (!existingIdeas.has(idea.id)) {
      ideasToWrite.push(idea);
      ideaIdMap.set(idea.id, idea.id);
      report.ideasImported += 1;
      continue;
    }

    if (strategy === 'skip') {
      ideaIdMap.set(idea.id, idea.id);
      report.ideasSkipped += 1;
      continue;
    }

    if (strategy === 'overwrite') {
      ideasToWrite.push(idea);
      ideaIdMap.set(idea.id, idea.id);
      report.ideasOverwritten += 1;
      continue;
    }

    const newId = createId('idea');
    ideasToWrite.push({
      ...idea,
      id: newId,
      title: idea.title,
      projectId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    ideaIdMap.set(idea.id, newId);
    report.ideasDuplicated += 1;
  }

  for (const project of backup.projects) {
    const mappedIdeaId = ideaIdMap.get(project.ideaId);
    if (!mappedIdeaId) {
      report.warnings.push(`项目 ${project.id} 关联的念头未能导入，已跳过该项目。`);
      report.projectsSkipped += 1;
      continue;
    }

    const conflict = existingProjects.has(project.id);
    if (conflict && strategy === 'skip') {
      report.projectsSkipped += 1;
      continue;
    }

    const candidate: Project = { ...project, ideaId: mappedIdeaId };

    if (conflict && strategy === 'overwrite') {
      projectsToWrite.push(candidate);
      report.projectsOverwritten += 1;
      continue;
    }

    if (conflict && strategy === 'duplicate') {
      projectsToWrite.push({
        ...candidate,
        id: createId('project'),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      report.projectsDuplicated += 1;
      continue;
    }

    projectsToWrite.push(candidate);
    report.projectsImported += 1;
  }

  // 让念头上的 projectId 与实际写入的项目保持一致。
  const projectByIdeaId = new Map<string, string>();
  for (const project of projectsToWrite) {
    projectByIdeaId.set(project.ideaId, project.id);
  }
  const linkedIdeas = ideasToWrite.map((idea) => {
    const projectId = idea.projectId ? projectByIdeaId.get(idea.id) ?? idea.projectId : null;
    return projectId === idea.projectId ? idea : { ...idea, projectId };
  });

  try {
    await writeRecords(linkedIdeas, projectsToWrite);
  } catch (error) {
    throw toNianBoxError(error);
  }

  return report;
}

/**
 * 「清空全部数据」等破坏性操作会用到；仅供设置页调用。
 */
export function describeReport(report: ImportReport): string {
  const parts: string[] = [];
  if (report.ideasImported) parts.push(`新增 ${report.ideasImported} 条念头`);
  if (report.ideasOverwritten) parts.push(`覆盖 ${report.ideasOverwritten} 条念头`);
  if (report.ideasDuplicated) parts.push(`另存 ${report.ideasDuplicated} 条重复念头`);
  if (report.ideasSkipped) parts.push(`跳过 ${report.ideasSkipped} 条已有念头`);
  if (report.projectsImported) parts.push(`新增 ${report.projectsImported} 个项目`);
  if (report.projectsOverwritten) parts.push(`覆盖 ${report.projectsOverwritten} 个项目`);
  if (report.projectsDuplicated) parts.push(`另存 ${report.projectsDuplicated} 个重复项目`);
  if (report.projectsSkipped) parts.push(`跳过 ${report.projectsSkipped} 个项目`);
  if (parts.length === 0) return '没有需要导入的记录。';
  return `导入完成：${parts.join('，')}。`;
}

