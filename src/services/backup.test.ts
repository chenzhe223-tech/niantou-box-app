/**
 * 导入 / 导出（备份）服务测试。
 *
 * 重点验证规格里明确要求的行为：
 * - 导出的数据可以重新导入恢复；
 * - 错误格式的导入文件会被拒绝，并且不会覆盖现有数据；
 * - 相同 ID 的记录有明确策略，不会静默丢失内容。
 */

import { describe, expect, it } from 'vitest';
import { deleteDatabase, closeDatabase } from './idb';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFileName,
  buildBackup,
  describeReport,
  exportBackup,
  importBackup,
  parseBackup,
  serializeBackup,
  validateBackup,
} from './backup';
import {
  NianBoxError,
  createIdea,
  getIdea,
  getProject,
  listIdeas,
  listProjects,
  purgeIdea,
  softDeleteIdea,
  upgradeIdeaToProject,
} from './storage';
import type { BackupFile } from '../types/backup';

const LONG_CONTENT = [
  '一件长期想做的事情：给社区里的旧书做一次漂流。',
  '📚 中文、Emoji 与特殊字符 <>&“引号”都要能完整往返。',
  '参考：https://example.com/books?tag=%E6%97%A7%E4%B9%A6#top',
].join('\n');

/** 把本机数据库重置为「全新安装」的状态，用于验证导入恢复。 */
async function resetLocalDatabase(): Promise<void> {
  await closeDatabase();
  await deleteDatabase();
}

describe('备份文件：构造与文件名', () => {
  it('buildBackup 统计有效记录与回收站记录', async () => {
    const kept = await createIdea({ content: '保留的念头' });
    const removed = await createIdea({ content: '要删掉的念头' });
    await softDeleteIdea(removed.id);

    const { project } = await upgradeIdeaToProject(kept.id);

    const backup = await exportBackup();

    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.counts.ideas).toBe(1);
    expect(backup.counts.deletedIdeas).toBe(1);
    expect(backup.counts.projects).toBe(1);
    expect(backup.counts.deletedProjects).toBe(0);
    // 回收站里的记录也会被导出，避免备份不完整。
    expect(backup.ideas).toHaveLength(2);
    expect(backup.projects.map((item) => item.id)).toEqual([project.id]);
    expect(Date.parse(backup.exportedAt)).not.toBeNaN();
  });

  it('文件名使用本地日期并补零，格式为 nianbox-backup-YYYY-MM-DD.json', () => {
    expect(backupFileName(new Date(2026, 0, 5, 23, 30))).toBe('nianbox-backup-2026-01-05.json');
    expect(backupFileName(new Date(2026, 11, 31, 0, 5))).toBe('nianbox-backup-2026-12-31.json');
  });

  it('序列化结果是格式化的 JSON，可直接被 parseBackup 接受', async () => {
    await createIdea({ content: '要被序列化的念头' });
    const text = serializeBackup(await exportBackup());

    expect(text).toContain(BACKUP_FORMAT);
    const parsed = JSON.parse(text) as BackupFile;
    expect(parsed.ideas).toHaveLength(1);
    expect(parseBackup(text).ok).toBe(true);
  });
});

describe('导出 → 重新导入', () => {
  it('导出的数据可以完整重新导入到空数据库', async () => {
    const idea = await createIdea({
      content: LONG_CONTENT,
      title: '旧书漂流',
      category: 'life',
      status: 'research',
      tags: ['社区', '阅读'],
      notes: '先从小范围试点。',
    });
    const { project } = await upgradeIdeaToProject(idea.id);

    const backup = await exportBackup();
    const text = serializeBackup(backup);

    // 模拟「换了一台设备 / 清空了浏览器数据」。
    await resetLocalDatabase();

    const report = await importBackup(text);
    expect(report.ideasImported).toBe(1);
    expect(report.projectsImported).toBe(1);

    const restored = await getIdea(idea.id);
    expect(restored).not.toBeNull();
    expect(restored?.id).toBe(idea.id);
    expect(restored?.content).toBe(LONG_CONTENT);
    expect(restored?.title).toBe('旧书漂流');
    expect(restored?.category).toBe('life');
    expect(restored?.tags).toEqual(['社区', '阅读']);
    expect(restored?.createdAt).toBe(idea.createdAt);
    expect(restored?.notes).toBe('先从小范围试点。');

    const restoredProject = await getProject(project.id);
    expect(restoredProject?.ideaId).toBe(idea.id);
    expect(restored?.projectId).toBe(project.id);
  });

  it('回收站记录也会被一起导出并恢复', async () => {
    const idea = await createIdea({ content: '被误删的念头' });
    await softDeleteIdea(idea.id);

    const backup = await exportBackup();
    await resetLocalDatabase();
    await importBackup(backup);

    expect(await listIdeas()).toHaveLength(0);
    expect((await listIdeas({ onlyDeleted: true })).map((item) => item.id)).toEqual([idea.id]);
  });
});

describe('导入校验：拒绝非法文件', () => {
  it('空内容与非法 JSON 都会被拒绝', () => {
    expect(parseBackup('').ok).toBe(false);
    expect(parseBackup('   ').ok).toBe(false);
    expect(parseBackup('这不是 JSON').errors[0]).toContain('不是合法的 JSON');
    expect(parseBackup('{ "format": ').ok).toBe(false);
  });

  it('不是念头盒备份的 JSON 会被拒绝', () => {
    const result = parseBackup(JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(BACKUP_FORMAT);
  });

  it('缺少 version 或 version 过高都会被拒绝', () => {
    const base = { format: BACKUP_FORMAT, exportedAt: new Date().toISOString(), ideas: [] };

    const missing = validateBackup(base);
    expect(missing.ok).toBe(false);
    expect(missing.errors.join()).toContain('版本');

    const future = validateBackup({ ...base, version: BACKUP_VERSION + 1 });
    expect(future.ok).toBe(false);
    expect(future.errors.join()).toContain('高于当前应用支持的版本');
  });

  it('ideas 不是数组会被拒绝', () => {
    const result = validateBackup({ format: BACKUP_FORMAT, version: 1, ideas: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('ideas');
  });

  it('记录缺少 ID 或正文会被拒绝', () => {
    const result = validateBackup({
      format: BACKUP_FORMAT,
      version: 1,
      ideas: [
        { content: '没有 ID 的记录' },
        { id: 'idea_1', content: '   ' },
        { id: 'idea_2', content: '正常的记录' },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('缺少有效的记录 ID');
    expect(result.errors.join('\n')).toContain('正文缺失或为空');
  });

  it('备份文件内部出现重复 ID 会被拒绝，而不是静默覆盖', () => {
    const result = validateBackup({
      format: BACKUP_FORMAT,
      version: 1,
      ideas: [
        { id: 'idea_same', content: '第一条' },
        { id: 'idea_same', content: '第二条' },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('重复的念头 ID');
  });

  it('非法的状态与分类会给出警告并回落到安全默认值', () => {
    const result = validateBackup({
      format: BACKUP_FORMAT,
      version: 1,
      ideas: [{ id: 'idea_1', content: '一条内容', status: '不存在的状态', category: '???' }],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.join('\n')).toContain('状态值');
    expect(result.warnings.join('\n')).toContain('分类值');
    expect(result.backup?.ideas[0].status).toBe('inbox');
    expect(result.backup?.ideas[0].category).toBeNull();
  });

  it('项目关联的念头不在备份中时会给出警告并跳过该项目', () => {
    const result = validateBackup({
      format: BACKUP_FORMAT,
      version: 1,
      ideas: [{ id: 'idea_1', content: '一条内容' }],
      projects: [{ id: 'project_1', ideaId: 'idea_missing', name: '孤儿项目' }],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.join()).toContain('不在备份文件中');
    expect(result.backup?.projects).toHaveLength(0);
  });

  it('时间字段支持 ISO 字符串与毫秒时间戳', () => {
    const result = validateBackup({
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: '2026-01-02T03:04:05.000Z',
      ideas: [
        { id: 'idea_iso', content: '字符串时间', createdAt: '2026-01-02T03:04:05.000Z' },
        { id: 'idea_ms', content: '数字时间', createdAt: 1_767_000_000_000 },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.backup?.ideas[0].createdAt).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
    expect(result.backup?.ideas[1].createdAt).toBe(1_767_000_000_000);
  });
});

describe('导入策略：重复 ID 不会导致数据丢失', () => {
  it('默认策略（skip）保留现有数据，跳过相同 ID 的记录', async () => {
    const local = await createIdea({ content: '本机现有的内容' });
    const backup = buildBackup([{ ...local, content: '备份里的内容' }], []);

    const report = await importBackup(backup);

    expect(report.strategy).toBe('skip');
    expect(report.ideasSkipped).toBe(1);
    expect(report.ideasImported).toBe(0);
    // 现有内容没有被覆盖。
    expect((await getIdea(local.id))?.content).toBe('本机现有的内容');
    expect(await listIdeas()).toHaveLength(1);
  });

  it('overwrite 策略会覆盖同 ID 的记录', async () => {
    const local = await createIdea({ content: '本机现有的内容' });
    const backup = buildBackup([{ ...local, content: '备份里的内容' }], []);

    const report = await importBackup(backup, { duplicateStrategy: 'overwrite' });

    expect(report.ideasOverwritten).toBe(1);
    expect((await getIdea(local.id))?.content).toBe('备份里的内容');
  });

  it('duplicate 策略把同 ID 记录另存为新记录，新旧并存', async () => {
    const local = await createIdea({ content: '本机现有的内容' });
    const backup = buildBackup([{ ...local, content: '备份里的内容' }], []);

    const report = await importBackup(backup, { duplicateStrategy: 'duplicate' });

    expect(report.ideasDuplicated).toBe(1);
    const all = await listIdeas();
    expect(all).toHaveLength(2);
    expect(all.map((idea) => idea.id)).toContain(local.id);
    const copies = all.filter((idea) => idea.id !== local.id);
    expect(copies).toHaveLength(1);
    expect(copies[0].content).toBe('备份里的内容');
  });

  it('导入新记录不会清空现有数据', async () => {
    const local = await createIdea({ content: '原有的念头' });
    const incoming = await createIdea({ content: '来自备份的念头' });
    const backup = buildBackup([incoming], []);

    // 先把「来自备份的念头」从本机永久删除，模拟它只存在于备份文件里。
    await purgeIdea(incoming.id);
    expect(await listIdeas()).toHaveLength(1);

    const report = await importBackup(backup);
    expect(report.ideasImported).toBe(1);

    const all = await listIdeas();
    expect(all).toHaveLength(2);
    expect(all.map((idea) => idea.id).sort()).toEqual([local.id, incoming.id].sort());
  });

  it('导入非法数据时会抛错，且不会改动现有数据', async () => {
    const local = await createIdea({ content: '必须保住的内容' });

    await expect(importBackup('{"not":"a backup"}')).rejects.toBeInstanceOf(NianBoxError);
    await expect(importBackup({ format: 'other', version: 1, ideas: [] })).rejects.toThrow(
      // 抛出的错误必须是可读的具体原因，而不是一句笼统的失败。
      '缺少标识',
    );

    const all = await listIdeas();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(local.id);
    expect(all[0].content).toBe('必须保住的内容');
  });

  it('导入的项目会指向导入后的念头，不会产生悬空引用', async () => {
    const idea = await createIdea({ content: '升级成项目的念头' });
    const { project } = await upgradeIdeaToProject(idea.id);
    const backup = await exportBackup();

    await resetLocalDatabase();
    const report = await importBackup(backup, { duplicateStrategy: 'duplicate' });

    expect(report.projectsImported).toBe(1);
    const projects = await listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].ideaId).toBe(idea.id);
    // 备份里的 projectId 与实际写入的项目保持一致。
    expect((await getIdea(idea.id))?.projectId).toBe(project.id);
  });
});

describe('导入结果提示', () => {
  it('describeReport 会说明每一条导入结果', async () => {
    await createIdea({ content: '报告文案检查' });
    const backup = await exportBackup();
    await resetLocalDatabase();

    const report = await importBackup(backup);
    const text = describeReport(report);
    expect(text).toContain('导入完成');
    expect(text).toContain('新增 1 条念头');
  });

  it('没有任何记录需要导入时给出明确文案', () => {
    const report = {
      strategy: 'skip' as const,
      ideasImported: 0,
      ideasOverwritten: 0,
      ideasSkipped: 0,
      ideasDuplicated: 0,
      projectsImported: 0,
      projectsOverwritten: 0,
      projectsSkipped: 0,
      projectsDuplicated: 0,
      warnings: [],
    };
    expect(describeReport(report)).toBe('没有需要导入的记录。');
  });
});
