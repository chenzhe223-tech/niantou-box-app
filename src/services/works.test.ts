/**
 * 本机作品库测试。
 *
 * 这一层测的是「真的写进了 IndexedDB」：用 fake-indexeddb 在 Node 里模拟真实
 * 数据库，断言作品元数据（works 表）与图片（workImages 表）的落库、读取与删除，
 * 以及 v3 → v4 升级不会碰掉老用户的念头。
 *
 * 几条刻意的取舍：
 *   - 不伪造图片内容：data: URL 只是一个格式合法的字符串，断言的是「它被原样存取」，
 *     而不是「生成了一张看起来像样的图」；
 *   - 排序用例直接写库（带显式 createdAt）：saveWork 用的是 Date.now()，
 *     同一毫秒内的两次保存谁在前是没有意义的，不该拿它做排序断言；
 *   - 坏数据用例断言的是「拒绝写入且什么都没留下」，确保不会留下损坏记录。
 */

import { describe, expect, it } from 'vitest';
import {
  STORE_WORK_IMAGES,
  STORE_WORKS,
  closeDatabase,
  deleteDatabase,
  openDatabase,
  putRecord,
  readAll,
} from './idb';
import { NianBoxError, createIdea, purgeIdea } from './storage';
import {
  deleteWork,
  deleteWorksByIdeaId,
  getWork,
  listWorks,
  listWorksForIdea,
  readWorkImage,
  readWorkImages,
  saveWork,
  workRenderLabel,
  type WorkImageRecord,
  type WorkRecord,
} from './works';

const DATA_URL = `data:image/png;base64,${'A'.repeat(64)}`;

function cardInput(ideaId: string, overrides: Partial<Parameters<typeof saveWork>[0]> = {}) {
  return {
    ideaId,
    source: 'card' as const,
    render: 'local' as const,
    style: 'card',
    aspect: '3:4',
    title: '车位雷达',
    dataUrl: DATA_URL,
    ...overrides,
  };
}

function rawWork(overrides: Partial<WorkRecord> & { id: string }): WorkRecord {
  return {
    ideaId: 'idea_raw',
    kind: 'poster',
    source: 'card',
    render: 'local',
    style: 'card',
    aspect: '3:4',
    title: '作品',
    createdAt: 1,
    ...overrides,
  };
}

describe('作品：保存', () => {
  it('把元数据与图片一起写进 IndexedDB', async () => {
    const idea = await createIdea({ content: '车库入口的空位雷达' });

    const work = await saveWork(cardInput(idea.id));

    expect(work.id).toMatch(/^work_/);
    expect(work.ideaId).toBe(idea.id);
    expect(work.kind).toBe('poster');
    expect(work.source).toBe('card');
    expect(work.render).toBe('local');
    expect(work.style).toBe('card');
    expect(work.aspect).toBe('3:4');
    expect(work.title).toBe('车位雷达');
    expect(work.createdAt).toBeGreaterThan(0);

    // 元数据只有一条，图片按 workId 存着同一张。
    expect(await listWorks()).toHaveLength(1);
    expect(await readWorkImage(work.id)).toBe(DATA_URL);

    const images = await readAll<WorkImageRecord>(STORE_WORK_IMAGES);
    expect(images).toHaveLength(1);
    expect(images[0].workId).toBe(work.id);
    expect(images[0].mime).toBe('image/png');
    // base64 每 4 个字符 3 字节。
    expect(images[0].bytes).toBe(48);
  });

  it('标题去空白并截断到 80 字，避免作品列表被超长标题撑破', async () => {
    const idea = await createIdea({ content: '标题处理' });

    const work = await saveWork(cardInput(idea.id, { title: `  ${'长'.repeat(120)}  ` }));

    expect(work.title).toHaveLength(80);
    expect(work.title).toBe('长'.repeat(80));
  });

  it('拿不到图片数据时拒绝写入，并且什么都不留下', async () => {
    const idea = await createIdea({ content: '坏数据检查' });

    await expect(
      saveWork(cardInput(idea.id, { dataUrl: 'https://example.com/not-a-data-url.png' })),
    ).rejects.toBeInstanceOf(NianBoxError);
    await expect(saveWork(cardInput(idea.id, { dataUrl: '' }))).rejects.toThrow(
      '没有拿到可保存的图片数据',
    );

    expect(await listWorks()).toHaveLength(0);
    expect(await readAll<WorkImageRecord>(STORE_WORK_IMAGES)).toHaveLength(0);
  });

  it('没有关联念头时拒绝写入，不留悬空作品', async () => {
    await expect(saveWork(cardInput(''))).rejects.toThrow('作品必须关联一条念头');

    expect(await listWorks()).toHaveLength(0);
    expect(await readAll<WorkImageRecord>(STORE_WORK_IMAGES)).toHaveLength(0);
  });
});

describe('作品：读取', () => {
  it('按创建时间倒序返回，并能按念头筛出作品', async () => {
    const first = await createIdea({ content: '第一条' });
    const second = await createIdea({ content: '第二条' });
    await putRecord<WorkRecord>(
      STORE_WORKS,
      rawWork({ id: 'work_a', ideaId: first.id, title: '旧', createdAt: 1_000 }),
    );
    await putRecord<WorkRecord>(
      STORE_WORKS,
      rawWork({ id: 'work_b', ideaId: second.id, title: '新', createdAt: 2_000 }),
    );

    expect((await listWorks()).map((work) => work.id)).toEqual(['work_b', 'work_a']);
    expect((await listWorksForIdea(first.id)).map((work) => work.id)).toEqual(['work_a']);
  });

  it('补齐缺失的风格与比例，并丢掉坏掉的记录', async () => {
    // 老版本写进去、只有必备字段的记录：读出来应当有可用的默认值。
    await putRecord(STORE_WORKS, {
      id: 'work_legacyish',
      ideaId: 'idea_x',
      kind: 'poster',
      source: 'poster',
      render: 'local',
      createdAt: 5,
    });
    // 缺 ideaId / 类型不对的记录不该出现在列表里。
    await putRecord(STORE_WORKS, { id: 'work_broken', kind: 'poster', createdAt: 9 });

    const list = await listWorks();

    expect(list.map((work) => work.id)).toEqual(['work_legacyish']);
    expect(list[0].style).toBe('brand');
    expect(list[0].aspect).toBe('3:4');
    expect(list[0].title).toBe('');
  });

  it('作品或图片不存在时返回 null，而不是造一条空记录', async () => {
    expect(await getWork('work_missing')).toBeNull();
    expect(await readWorkImage('work_missing')).toBeNull();
  });

  it('批量读图片：空数组直接返回空 Map，其余只带出存在的那几张', async () => {
    const idea = await createIdea({ content: '批量读图' });
    const withImage = await saveWork(cardInput(idea.id));
    // 只有元数据、没有图片的记录（模拟图片丢失的坏状态）。
    await putRecord<WorkRecord>(STORE_WORKS, rawWork({ id: 'work_no_image', ideaId: idea.id }));

    expect((await readWorkImages([])).size).toBe(0);

    const images = await readWorkImages([withImage.id, 'work_no_image', 'work_missing']);
    expect(images.size).toBe(1);
    expect(images.get(withImage.id)).toBe(DATA_URL);
  });
});

describe('作品：删除', () => {
  it('删除作品后，元数据与图片都不在了', async () => {
    const idea = await createIdea({ content: '删除检查' });
    const keep = await saveWork(cardInput(idea.id, { title: '留下的' }));
    const drop = await saveWork(cardInput(idea.id, { title: '要删的' }));

    await deleteWork(drop.id);

    expect(await getWork(drop.id)).toBeNull();
    expect(await readWorkImage(drop.id)).toBeNull();
    expect((await listWorks()).map((work) => work.id)).toEqual([keep.id]);
    // 图片表里也不会留下孤儿数据。
    expect((await readAll<WorkImageRecord>(STORE_WORK_IMAGES)).map((item) => item.workId)).toEqual([
      keep.id,
    ]);
  });

  it('按念头批量删除会返回真实件数，并清干净两张表', async () => {
    const target = await createIdea({ content: '要被清掉的念头' });
    const other = await createIdea({ content: '别的念头' });
    await saveWork(cardInput(target.id, { title: '一' }));
    await saveWork(cardInput(target.id, { title: '二' }));
    const survivor = await saveWork(cardInput(other.id, { title: '别动我' }));

    expect(await deleteWorksByIdeaId(target.id)).toBe(2);
    expect(await deleteWorksByIdeaId(target.id)).toBe(0);

    expect((await listWorks()).map((work) => work.id)).toEqual([survivor.id]);
    expect((await readAll<WorkImageRecord>(STORE_WORK_IMAGES)).map((item) => item.workId)).toEqual([
      survivor.id,
    ]);
  });

  it('永久删除念头时，同一事务里连带删掉它的作品与图片', async () => {
    const doomed = await createIdea({ content: '会被永久删除的念头' });
    const other = await createIdea({ content: '不受影响的念头' });
    await saveWork(cardInput(doomed.id, { title: '跟着走' }));
    const survivor = await saveWork(cardInput(other.id, { title: '留下来' }));

    await purgeIdea(doomed.id);

    expect((await listWorks()).map((work) => work.id)).toEqual([survivor.id]);
    expect((await readAll<WorkImageRecord>(STORE_WORK_IMAGES)).map((item) => item.workId)).toEqual([
      survivor.id,
    ]);
  });
});

describe('作品：类型说法', () => {
  it('本机卡片、AI 海报、本机海报各有各的说法，互不冒充', () => {
    expect(workRenderLabel({ source: 'card', render: 'local' })).toBe('本机制作的念头卡片');
    expect(workRenderLabel({ source: 'poster', render: 'ai' })).toBe('AI 灵感海报');
    expect(workRenderLabel({ source: 'poster', render: 'local' })).toBe('本机绘制的海报');
  });
});

describe('数据库升级', () => {
  it('从 v3 升到 v4 只补上作品表，老用户的念头原样保留', async () => {
    // openDatabase() 会缓存连接，构造旧版本库之前必须先断开。
    await closeDatabase();
    await deleteDatabase();

    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nianbox', 3);
      request.onupgradeneeded = () => {
        // 只建 v3 时代真实存在的表，用来模拟老用户升级前的数据库。
        const db = request.result;
        const ideas = db.createObjectStore('ideas', { keyPath: 'id' });
        ideas.createIndex('by_createdAt', 'createdAt');
        ideas.createIndex('by_updatedAt', 'updatedAt');
        ideas.createIndex('by_status', 'status');
        ideas.createIndex('by_deletedAt', 'deletedAt');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction('ideas', 'readwrite');
      tx.objectStore('ideas').put({
        id: 'idea_legacy',
        content: '升级前就存在的念头',
        createdAt: 1,
        updatedAt: 1,
        status: 'inbox',
        category: null,
        tags: [],
        pinned: false,
        projectId: null,
        deletedAt: null,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacy.close();

    const db = await openDatabase();
    expect(db.version).toBe(4);
    expect(db.objectStoreNames.contains(STORE_WORKS)).toBe(true);
    expect(db.objectStoreNames.contains(STORE_WORK_IMAGES)).toBe(true);

    const rows = await readAll<{ id: string; content: string }>('ideas');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('idea_legacy');
    expect(rows[0].content).toBe('升级前就存在的念头');

    // 升级之后作品库能正常用。
    const work = await saveWork(cardInput('idea_legacy', { title: '升级后的第一件作品' }));
    expect(await readWorkImage(work.id)).toBe(DATA_URL);
  });
});
