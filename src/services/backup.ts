/**
 * 数据的导出与导入。
 *
 * 原则：
 * - 导出的 JSON 自带格式版本号与导出时间，可被完整地重新导入；
 * - 导入前先严格校验，校验失败时给出可理解的错误，且绝不覆盖现有数据；
 * - 相同 ID 的记录有明确的冲突策略，默认保留现有数据，不静默丢失内容。
 *
 * 格式版本：
 * - v1：念头 + 项目；
 * - v2：追加本机作品元数据（works）与作品图片（workImages）。
 *   v1 文件仍然可以导入，缺少的作品字段按「空作品集」处理；
 *   作品图片始终只在本机 IndexedDB 里流转，备份只是让用户可以自己搬走，
 *   过程中不会把图片上传到任何服务器。
 */

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  type BackupCounts,
  type BackupFile,
  type DuplicateStrategy,
  type ImportOptions,
  type ImportReport,
  type ValidationResult,
} from '../types/backup';
import type { Idea } from '../types/idea';
import type { Project } from '../types/project';
import {
  MAX_WORK_IMAGE_BYTES,
  estimateImageBytes,
  isImageDataUrl,
  normalizeWorkImage,
  normalizeWorkRecord,
  type WorkImageRecord,
  type WorkRecord,
} from './works';
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

/** 统计备份内容的条数（供导出提示与导入确认使用）。 */
export function countBackup(
  ideas: readonly Idea[],
  projects: readonly Project[],
  works: readonly WorkRecord[] = [],
  workImages: readonly WorkImageRecord[] = [],
): BackupCounts {
  const deletedIdeaIds = new Set(
    ideas.filter((idea) => idea.deletedAt !== null).map((idea) => idea.id),
  );
  const workIds = new Set(works.map((work) => work.id));
  const imagesWithWork = new Set(
    workImages.filter((image) => workIds.has(image.workId)).map((image) => image.workId),
  );
  return {
    ideas: ideas.filter((idea) => idea.deletedAt === null).length,
    projects: projects.filter((project) => project.deletedAt === null).length,
    deletedIdeas: deletedIdeaIds.size,
    deletedProjects: projects.filter((project) => project.deletedAt !== null).length,
    works: works.length,
    // 关联念头在回收站里的作品也会一起备份：念头恢复后作品还能继续创作。
    deletedWorks: works.filter((work) => deletedIdeaIds.has(work.ideaId)).length,
    workImages: imagesWithWork.size,
  };
}

export function buildBackup(
  ideas: readonly Idea[],
  projects: readonly Project[],
  works: readonly WorkRecord[] = [],
  workImages: readonly WorkImageRecord[] = [],
): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    counts: countBackup(ideas, projects, works, workImages),
    ideas: [...ideas],
    projects: [...projects],
    works: [...works],
    workImages: [...workImages],
  };
}

export async function exportBackup(): Promise<BackupFile> {
  const snapshot = await readSnapshot(true);
  return buildBackup(snapshot.ideas, snapshot.projects, snapshot.works, snapshot.workImages);
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

/** 把字节数说成人话，用于错误提示。 */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} 字节`;
}

/**
 * 校验任意输入是否为可用的备份文件。
 * 返回规范化后的数据，同时收集警告。
 *
 * 校验是「全量先验」的：任何一条记录不合法都会让 ok=false，
 * 调用方据此中止导入，不会出现只导入一半的结果。
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
  if (input.works !== undefined && !Array.isArray(input.works)) {
    errors.push('备份文件中的 works 字段必须是数组。');
  }
  if (input.workImages !== undefined && !Array.isArray(input.workImages)) {
    errors.push('备份文件中的 workImages 字段必须是数组。');
  }
  if (input.exportedAt !== undefined && parseDate(input.exportedAt) === null) {
    warnings.push('备份文件中的导出时间无法解析，导入时会忽略该字段。');
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const rawIdeas = input.ideas as unknown[];
  const rawProjects = Array.isArray(input.projects) ? (input.projects as unknown[]) : [];
  const rawWorks = Array.isArray(input.works) ? (input.works as unknown[]) : [];
  const rawImages = Array.isArray(input.workImages) ? (input.workImages as unknown[]) : [];

  if (input.works === undefined) {
    // v1 文件（或任何缺少作品字段的文件）：按「空作品集」处理，导入后作品库保持现状。
    warnings.push(
      '这份备份文件里没有作品数据（旧版 v1 格式），导入后本机作品库不会被改动。',
    );
  }

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

  /* ---------------------------------------------------------------------- */
  /* 作品（v2）：元数据与图片分别校验，任何一处坏掉都不写入。                 */
  /* ---------------------------------------------------------------------- */

  const works: WorkRecord[] = [];
  const seenWorkIds = new Set<string>();

  rawWorks.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      errors.push(`第 ${index + 1} 件作品不是对象，无法导入。`);
      return;
    }
    const work = normalizeWorkRecord(raw);
    if (!work) {
      errors.push(
        `第 ${index + 1} 件作品的数据不完整或格式不对（需要作品 ID、关联念头 ID、类型与创建时间），无法导入。`,
      );
      return;
    }
    if (seenWorkIds.has(work.id)) {
      errors.push(`备份文件中存在重复的作品 ID：${work.id}。`);
      return;
    }
    if (!seenIdeaIds.has(work.ideaId)) {
      // 明确警告并跳过：宁可少一件作品，也不能把图片挂到别的念头上。
      warnings.push(
        `作品 ${work.id} 关联的念头 ${work.ideaId} 不在备份文件中，已跳过该作品（不会改挂到别的念头上）。`,
      );
      return;
    }
    seenWorkIds.add(work.id);
    works.push(work);
  });

  const workImages: WorkImageRecord[] = [];
  const seenImageWorkIds = new Set<string>();

  rawImages.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      errors.push(`第 ${index + 1} 条作品图片不是对象，无法导入。`);
      return;
    }
    const workId = raw.workId;
    if (typeof workId !== 'string' || workId === '') {
      errors.push(`第 ${index + 1} 条作品图片缺少 workId，无法对应到作品。`);
      return;
    }
    if (!seenWorkIds.has(workId)) {
      warnings.push(`作品图片 ${workId} 在备份里找不到对应的作品，已跳过这张图片。`);
      return;
    }
    if (seenImageWorkIds.has(workId)) {
      errors.push(`作品 ${workId} 在备份里有重复的图片记录，无法判断该用哪一张。`);
      return;
    }
    const dataUrl = raw.dataUrl;
    if (!isImageDataUrl(dataUrl)) {
      errors.push(`作品 ${workId} 的图片数据不是合法的图片（data: URL），已中止导入以免丢图。`);
      return;
    }
    const bytes = estimateImageBytes(dataUrl);
    if (bytes > MAX_WORK_IMAGE_BYTES) {
      errors.push(
        `作品 ${workId} 的图片（约 ${humanBytes(bytes)}）超过单张上限 ${humanBytes(MAX_WORK_IMAGE_BYTES)}，已中止导入。`,
      );
      return;
    }
    const image = normalizeWorkImage(raw);
    if (!image) {
      errors.push(`作品 ${workId} 的图片记录无法识别，已中止导入。`);
      return;
    }
    seenImageWorkIds.add(workId);
    workImages.push(image);
  });

  if (errors.length === 0) {
    // 作品在、图片不在：明确告诉用户，不让「导入成功」掩盖图片缺失。
    for (const work of works) {
      if (!seenImageWorkIds.has(work.id)) {
        warnings.push(
          `作品 ${work.id} 在备份文件里没有图片数据，只恢复了记录（列表里会显示「图片数据缺失」）。`,
        );
      }
    }
  }

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
    counts: countBackup(ideas, projects, works, workImages),
    ideas,
    projects,
    works,
    workImages,
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
 *
 * 作品与作品图片和念头、项目共用同一个写事务：任何一步失败都会整体回滚，
 * 不会留下「念头进来了、图片没进来」的半截数据。
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
  const existingWorks = new Map(current.works.map((work) => [work.id, work]));
  const imageByBackupWorkId = new Map(backup.workImages.map((image) => [image.workId, image]));

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
    worksImported: 0,
    worksOverwritten: 0,
    worksSkipped: 0,
    worksDuplicated: 0,
    imagesRestored: 0,
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

  const worksToWrite: WorkRecord[] = [];
  const imagesToWrite: WorkImageRecord[] = [];

  for (const work of backup.works) {
    const mappedIdeaId = ideaIdMap.get(work.ideaId);
    if (!mappedIdeaId) {
      // 校验阶段已经挡过一轮；这里再保一道，确保作品永远不会悬空。
      report.warnings.push(`作品 ${work.id} 关联的念头未能导入，已跳过该作品。`);
      report.worksSkipped += 1;
      continue;
    }

    const conflict = existingWorks.has(work.id);
    if (conflict && strategy === 'skip') {
      report.worksSkipped += 1;
      continue;
    }

    const candidate: WorkRecord = { ...work, ideaId: mappedIdeaId };
    let finalId = work.id;
    if (conflict && strategy === 'overwrite') {
      report.worksOverwritten += 1;
    } else if (conflict) {
      // duplicate：作品另存一件，图片跟着新 ID 走，绝不覆盖已有作品。
      finalId = createId('work');
      report.worksDuplicated += 1;
    } else {
      report.worksImported += 1;
    }

    worksToWrite.push(finalId === work.id ? candidate : { ...candidate, id: finalId });
    const image = imageByBackupWorkId.get(work.id);
    if (image) {
      imagesToWrite.push(finalId === work.id ? image : { ...image, workId: finalId });
    }
  }

  report.imagesRestored = imagesToWrite.length;

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
    await writeRecords(linkedIdeas, projectsToWrite, worksToWrite, imagesToWrite);
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
  if (report.worksImported) parts.push(`新增 ${report.worksImported} 件作品`);
  if (report.worksOverwritten) parts.push(`覆盖 ${report.worksOverwritten} 件作品`);
  if (report.worksDuplicated) parts.push(`另存 ${report.worksDuplicated} 件重复作品`);
  if (report.worksSkipped) parts.push(`跳过 ${report.worksSkipped} 件已有作品`);
  if (report.imagesRestored) parts.push(`恢复 ${report.imagesRestored} 张作品图片`);
  if (parts.length === 0) return '没有需要导入的记录。';
  return `导入完成：${parts.join('，')}。`;
}