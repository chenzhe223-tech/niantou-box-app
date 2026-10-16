/**
 * 导入 / 导出（备份）服务测试。
 *
 * 重点验证规格里明确要求的行为：
 * - 导出的数据可以重新导入恢复；
 * - 错误格式的导入文件会被拒绝，并且不会覆盖现有数据；
 * - 相同 ID 的记录有明确策略，不会静默丢失内容。
 */

import { describe, expect, it } from 'vitest';
import { closeDatabase, deleteDatabase, openDatabase } from './idb';
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
import { getWork, listWorks, listWorksForIdea, readWorkImage, saveWork } from './works';
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
      worksImported: 0,
      worksOverwritten: 0,
      worksSkipped: 0,
      worksDuplicated: 0,
      imagesRestored: 0,
      warnings: [],
    };
    expect(describeReport(report)).toBe('没有需要导入的记录。');
  });
});

/* -------------------------------------------------------------------------- */
/* v2 备份：作品元数据与作品图片                                                */
/* -------------------------------------------------------------------------- */

const BACKUP_DATA_URL = `data:image/png;base64,${'B'.repeat(64)}`;
const OTHER_DATA_URL = `data:image/png;base64,${'C'.repeat(64)}`;

/** saveWork 的入参形状。 */
function cardWork(ideaId: string, overrides: Record<string, unknown> = {}) {
  return {
    ideaId,
    source: 'card' as const,
    render: 'local' as const,
    style: 'card',
    aspect: '3:4',
    title: '车位雷达',
    dataUrl: BACKUP_DATA_URL,
    ...overrides,
  };
}

/** 备份文件里的一条作品元数据（可以与 saveWork 的结果构造出同 ID 冲突）。 */
function workObject(id: string, ideaId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ideaId,
    kind: 'poster' as const,
    source: 'card' as const,
    render: 'local' as const,
    style: 'card',
    aspect: '3:4',
    title: '作品',
    createdAt: 1,
    ...overrides,
  };
}

describe('备份 v2：导出包含作品与图片', () => {
  it('导出的备份带上作品元数据与图片，版本升到 v2', async () => {
    const idea = await createIdea({ content: '车库入口的空位雷达' });
    const work = await saveWork(cardWork(idea.id));

    const backup = await exportBackup();

    expect(backup.version).toBe(2);
    expect(backup.counts.works).toBe(1);
    expect(backup.counts.workImages).toBe(1);
    expect(backup.works.map((item) => item.id)).toEqual([work.id]);
    expect(backup.works[0].ideaId).toBe(idea.id);
    expect(backup.workImages.map((item) => item.workId)).toEqual([work.id]);
    expect(backup.workImages[0].dataUrl).toBe(BACKUP_DATA_URL);
  });

  it('回收站里的念头，其作品与图片也一起备份', async () => {
    const kept = await createIdea({ content: '留下来的念头' });
    const removed = await createIdea({ content: '进了回收站的念头' });
    const keptWork = await saveWork(cardWork(kept.id, { title: '留着' }));
    const removedWork = await saveWork(cardWork(removed.id, { title: '跟着回收站' }));
    await softDeleteIdea(removed.id);

    const backup = await exportBackup();

    expect(backup.counts.deletedIdeas).toBe(1);
    expect(backup.counts.deletedWorks).toBe(1);
    expect(backup.works.map((item) => item.id).sort()).toEqual(
      [keptWork.id, removedWork.id].sort(),
    );
    expect(backup.workImages.map((item) => item.workId).sort()).toEqual(
      [keptWork.id, removedWork.id].sort(),
    );
  });
});

describe('备份 v2：导出后重置再导入可完整恢复', () => {
  it('念头、项目、作品、图片与关联关系都恢复到位', async () => {
    const idea = await createIdea({ content: '到店自取的储物柜', title: '储物柜' });
    const { project } = await upgradeIdeaToProject(idea.id);
    const work = await saveWork(cardWork(idea.id, { title: '储物柜卡片' }));
    const text = serializeBackup(await exportBackup());

    await resetLocalDatabase();

    const report = await importBackup(text);

    expect(report.ideasImported).toBe(1);
    expect(report.projectsImported).toBe(1);
    expect(report.worksImported).toBe(1);
    expect(report.imagesRestored).toBe(1);

    const works = await listWorks();
    expect(works).toHaveLength(1);
    expect(works[0].id).toBe(work.id);
    // 关联关系如实恢复：作品仍然挂在原来那条念头上。
    expect(works[0].ideaId).toBe(idea.id);
    expect(works[0].title).toBe('储物柜卡片');
    expect(works[0].source).toBe('card');
    expect(works[0].render).toBe('local');
    // 图片按 workId 一一对应，不是「导入成功但图片丢了」。
    expect(await readWorkImage(work.id)).toBe(BACKUP_DATA_URL);
    expect((await getIdea(idea.id))?.title).toBe('储物柜');
    expect((await getProject(project.id))?.ideaId).toBe(idea.id);

    // 导入不会重建数据库，版本仍是当前的 v4。
    expect((await openDatabase()).version).toBe(4);
  });

  it('作品在、图片不在时只恢复记录，并明确提示图片缺失', async () => {
    const result = validateBackup({
      format: BACKUP_FORMAT,
      version: 2,
      ideas: [{ id: 'idea_1', content: '一条内容' }],
      works: [workObject('work_1', 'idea_1', { title: '没有图的卡片' })],
      workImages: [],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.join()).toContain('没有图片数据');
    expect(result.backup?.works).toHaveLength(1);
  });
});

describe('备份 v2：v1 兼容', () => {
  it('旧版 v1 备份可以继续导入，且不改动本机作品库', async () => {
    const localIdea = await createIdea({ content: '本机已有的念头' });
    const localWork = await saveWork(cardWork(localIdea.id, { title: '本机作品' }));

    const v1 = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: '2026-01-02T03:04:05.000Z',
      ideas: [{ id: 'idea_v1', content: '来自旧版备份的念头' }],
    };

    const validation = validateBackup(v1);
    expect(validation.ok).toBe(true);
    expect(validation.warnings.join()).toContain('没有作品数据');

    const report = await importBackup(v1);
    expect(report.ideasImported).toBe(1);
    expect(report.warnings.join()).toContain('没有作品数据');
    expect((await getIdea('idea_v1'))?.content).toBe('来自旧版备份的念头');

    // v1 文件没有作品字段：导入后本机作品一件不多、一件不少。
    expect((await listWorks()).map((item) => item.id)).toEqual([localWork.id]);
    expect(await readWorkImage(localWork.id)).toBe(BACKUP_DATA_URL);
  });
});

describe('备份 v2：重复 ID 的三种策略不会错关联作品', () => {
  /** 构造「同一个念头 ID + 同一个作品 ID」的冲突备份。 */
  function conflictingBackup(localIdeaId: string, localWorkId: string) {
    return buildBackup(
      [
        {
          id: localIdeaId,
          title: '',
          content: '备份内容',
          category: null,
          categorySource: null,
          status: 'inbox',
          tags: [],
          pinned: false,
          notes: '',
          problem: '',
          targetUsers: '',
          productForm: null,
          projectUrl: '',
          projectId: null,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
      [],
      [workObject(localWorkId, localIdeaId, { title: '备份作品', createdAt: 2 })],
      [
        {
          workId: localWorkId,
          mime: 'image/png',
          dataUrl: OTHER_DATA_URL,
          bytes: 48,
          createdAt: 2,
        },
      ],
    );
  }

  it('duplicate：作品改挂到新导入的念头上，图片跟着新作品 ID 走', async () => {
    const localIdea = await createIdea({ content: '本机内容' });
    const localWork = await saveWork(cardWork(localIdea.id, { title: '本机作品' }));

    const report = await importBackup(conflictingBackup(localIdea.id, localWork.id), {
      duplicateStrategy: 'duplicate',
    });

    expect(report.ideasDuplicated).toBe(1);
    expect(report.worksDuplicated).toBe(1);

    const ideas = await listIdeas();
    expect(ideas).toHaveLength(2);
    const newIdea = ideas.find((idea) => idea.id !== localIdea.id);
    expect(newIdea).toBeDefined();

    const works = await listWorks();
    expect(works).toHaveLength(2);
    const newWork = works.find((work) => work.id !== localWork.id);
    expect(newWork).toBeDefined();
    // 关键：新作品挂到新念头上，绝不回挂到本机那条念头。
    expect(newWork?.ideaId).toBe(newIdea?.id);
    expect(newWork?.ideaId).not.toBe(localIdea.id);
    // 图片也跟着新作品 ID，而不是覆盖本机作品那张图。
    expect(await readWorkImage(newWork!.id)).toBe(OTHER_DATA_URL);
    expect(await readWorkImage(localWork.id)).toBe(BACKUP_DATA_URL);
  });

  it('skip：本机作品与图片原样保留', async () => {
    const localIdea = await createIdea({ content: '本机内容' });
    const localWork = await saveWork(cardWork(localIdea.id, { title: '本机作品' }));

    const report = await importBackup(conflictingBackup(localIdea.id, localWork.id));

    expect(report.strategy).toBe('skip');
    expect(report.ideasSkipped).toBe(1);
    expect(report.worksSkipped).toBe(1);

    expect((await listWorks()).map((item) => item.id)).toEqual([localWork.id]);
    expect(await readWorkImage(localWork.id)).toBe(BACKUP_DATA_URL);
    expect((await getIdea(localIdea.id))?.content).toBe('本机内容');
  });

  it('overwrite：作品按原 ID 覆盖，图片同步换成备份里的那张', async () => {
    const localIdea = await createIdea({ content: '本机内容' });
    const localWork = await saveWork(cardWork(localIdea.id, { title: '本机作品' }));

    const report = await importBackup(conflictingBackup(localIdea.id, localWork.id), {
      duplicateStrategy: 'overwrite',
    });

    expect(report.worksOverwritten).toBe(1);
    expect(report.imagesRestored).toBe(1);
    expect((await getWork(localWork.id))?.title).toBe('备份作品');
    expect(await readWorkImage(localWork.id)).toBe(OTHER_DATA_URL);
  });

  it('备份里孤立的作品不会被硬塞给本机念头', async () => {
    const localIdea = await createIdea({ content: '本机内容' });

    const raw = {
      format: BACKUP_FORMAT,
      version: 2,
      ideas: [{ id: 'idea_incoming', content: '备份里的念头' }],
      works: [workObject('work_orphan', 'idea_missing', { title: '孤儿作品' })],
      workImages: [],
    };

    const validation = validateBackup(raw);
    expect(validation.ok).toBe(true);
    expect(validation.warnings.join()).toContain('不在备份文件中');
    expect(validation.backup?.works).toHaveLength(0);

    await importBackup(raw);
    expect(await listWorks()).toHaveLength(0);
    expect(await listWorksForIdea(localIdea.id)).toHaveLength(0);
  });
});

describe('备份 v2：坏数据与失败回滚', () => {
  it('作品图片不是合法的 data: URL 时明确报错，不会静默丢图', () => {
    const result = validateBackup({
      format: BACKUP_FORMAT,
      version: 2,
      ideas: [{ id: 'idea_1', content: '一条内容' }],
      works: [workObject('work_1', 'idea_1')],
      workImages: [
        { workId: 'work_1', mime: 'image/png', dataUrl: 'https://example.com/x.png', createdAt: 1 },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('不是合法的图片');
  });

  it('作品元数据不完整（缺关联念头）时明确报错', () => {
    const result = validateBackup({
      format: BACKUP_FORMAT,
      version: 2,
      ideas: [{ id: 'idea_1', content: '一条内容' }],
      works: [workObject('work_bad', '')],
      workImages: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('数据不完整或格式不对');
  });

  it('图片超过单张上限时报错，并说明是哪一件作品', () => {
    // 23M 个 base64 字符 ≈ 17 MB 二进制，超过 16 MB 的单张上限。
    const huge = `data:image/png;base64,${'A'.repeat(23 * 1024 * 1024)}`;
    const result = validateBackup({
      format: BACKUP_FORMAT,
      version: 2,
      ideas: [{ id: 'idea_1', content: '一条内容' }],
      works: [workObject('work_1', 'idea_1')],
      workImages: [{ workId: 'work_1', mime: 'image/png', dataUrl: huge, createdAt: 1 }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('超过单张上限');
  });

  it('导入校验失败时抛错，本机念头与作品一点没变', async () => {
    const localIdea = await createIdea({ content: '必须保住的内容' });
    const localWork = await saveWork(cardWork(localIdea.id, { title: '必须保住的作品' }));

    const broken = {
      format: BACKUP_FORMAT,
      version: 2,
      ideas: [{ id: 'idea_incoming', content: '来自备份的念头' }],
      works: [workObject('work_ok', 'idea_incoming')],
      workImages: [
        { workId: 'work_ok', mime: 'image/png', dataUrl: 'not-a-data-url', createdAt: 1 },
      ],
    };

    await expect(importBackup(broken)).rejects.toBeInstanceOf(NianBoxError);

    // 校验先于写入：一条念头、一件作品都没被写进来。
    expect((await listIdeas()).map((item) => item.id)).toEqual([localIdea.id]);
    expect((await listWorks()).map((item) => item.id)).toEqual([localWork.id]);
    expect(await getIdea('idea_incoming')).toBeNull();
    expect(await readWorkImage(localWork.id)).toBe(BACKUP_DATA_URL);
    expect((await openDatabase()).version).toBe(4);
  });
});