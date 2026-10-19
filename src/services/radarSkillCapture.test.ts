import { describe, expect, it } from 'vitest';
import { listIdeas } from './storage';
import {
  importPendingRadarSkills,
  RADAR_SKILL_QUEUE_KEY,
  type PendingRadarSkillCapture,
} from './radarSkillCapture';

function capture(overrides: Partial<PendingRadarSkillCapture> = {}): PendingRadarSkillCapture {
  return {
    id: 'davy-radar-2026-10-19-test1',
    source: 'davy-radar',
    createdAt: 1,
    reportDate: '2026-10-19',
    name: 'Example Skill',
    url: 'https://github.com/example/skill',
    description: '将重复流程变成可复用的 AI Skill。',
    topics: 'ai · workflow · automation',
    sourcePage: 'https://chenzhe223-tech.github.io/radar/daily/?date=2026-10-19',
    ...overrides,
  };
}

function writeQueue(items: unknown[]): void {
  window.localStorage.setItem(RADAR_SKILL_QUEUE_KEY, JSON.stringify(items));
}

describe('DAVYLAB Radar → NianBox Skill hand-off', () => {
  it('将 Skill 保存为待研究的念头，并保留项目地址和来源信息', async () => {
    writeQueue([capture()]);

    const result = await importPendingRadarSkills();
    const ideas = await listIdeas({ includeDeleted: true });

    expect(result.imported).toBe(1);
    expect(result.failed).toBe(0);
    expect(ideas).toHaveLength(1);
    expect(ideas[0].title).toBe('Skill：Example Skill');
    expect(ideas[0].category).toBe('skill');
    expect(ideas[0].status).toBe('research');
    expect(ideas[0].productForm).toBe('skill');
    expect(ideas[0].projectUrl).toBe('https://github.com/example/skill');
    expect(ideas[0].content).toContain('将重复流程变成可复用的 AI Skill。');
    expect(ideas[0].content).toContain('简报日期：2026-10-19');
    expect(ideas[0].notes).toContain('https://chenzhe223-tech.github.io/radar/daily/?date=2026-10-19');
    expect(window.localStorage.getItem(RADAR_SKILL_QUEUE_KEY)).toBeNull();
  });

  it('同一个捕获 ID 即使在队列里出现两次，也只创建一条念头', async () => {
    writeQueue([capture(), capture()]);

    const result = await importPendingRadarSkills();
    const ideas = await listIdeas({ includeDeleted: true });

    expect(result.imported).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(ideas).toHaveLength(1);
    expect(window.localStorage.getItem(RADAR_SKILL_QUEUE_KEY)).toBeNull();
  });

  it('再次执行导入不会重复创建已经收录的 Skill', async () => {
    writeQueue([capture()]);
    await importPendingRadarSkills();
    writeQueue([capture()]);

    const result = await importPendingRadarSkills();
    const ideas = await listIdeas({ includeDeleted: true });

    expect(result.imported).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(ideas).toHaveLength(1);
  });

  it('拒绝非 GitHub 或非 HTTPS 链接，避免把任意地址伪装成开源 Skill', async () => {
    writeQueue([capture({ id: 'davy-radar-2026-10-19-bad1', url: 'http://github.com/example/skill' })]);

    const result = await importPendingRadarSkills();

    expect(result.rejected).toBe(1);
    expect(result.imported).toBe(0);
    expect(window.localStorage.getItem(RADAR_SKILL_QUEUE_KEY)).toBeNull();
    expect(await listIdeas({ includeDeleted: true })).toHaveLength(0);
  });

  it('没有待导入项时不发请求、不创建任何内容', async () => {
    const result = await importPendingRadarSkills();
    expect(result.imported).toBe(0);
    expect(result.remaining).toBe(0);
    expect(await listIdeas({ includeDeleted: true })).toHaveLength(0);
  });
});
