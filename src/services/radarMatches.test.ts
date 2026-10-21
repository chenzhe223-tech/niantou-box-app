import { describe, expect, it, vi } from 'vitest';
import { loadRadarMatches } from './radarMatches';

const now = Date.parse('2026-10-21T08:00:00.000Z');
const payload = {
  report_date: '2026-10-21',
  generated_at: '2026-10-21T07:30:00.000Z',
  status: 'ok',
  news: [
    {
      title: 'New AI app builder helps creators build prototypes',
      title_zh: 'AI 应用构建工具帮助创作者制作原型',
      summary: 'AI app builder and low-code prototype tools.',
      source: 'Example Tech',
      url: 'https://example.com/ai-app-builder',
      published: '2026-10-21T06:00:00.000Z',
    },
    {
      title: 'Malformed story',
      summary: 'no source URL',
      source: 'Example',
      url: 'javascript:alert(1)',
    },
  ],
  top5: [
    {
      title_zh: '谷歌加入亚马逊，用开发者工具冲击英伟达生态',
      title_en: 'Google AI developer tools challenge Nvidia ecosystem',
      what_zh: 'AI 开发者工具降低硬件迁移成本。',
      source: 'TechCrunch AI',
      source_url: 'https://techcrunch.com/google-ai-developer-tools',
      published: '2026-10-21T06:30:00.000Z',
    },
  ],
  skills: [
    {
      name: 'sample/ai-app-builder',
      url: 'https://github.com/sample/ai-app-builder',
      description: 'A skill for AI app builder workflows.',
      description_zh: 'AI 应用构建流程 Skill。',
      stars: 42,
      updated: '2026-10-20T00:00:00Z',
      language: 'TypeScript',
      topics: ['ai-app-builder', 'prototype'],
    },
    {
      name: 'bad/repo',
      url: 'https://example.com/bad/repo',
      description: 'should be rejected',
      topics: [],
    },
  ],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('loadRadarMatches', () => {
  it('matches source-linked news and GitHub Skills from a fresh feed', async () => {
    const fetcher = vi.fn(async () => response(payload));
    const result = await loadRadarMatches(['AI app builder'], ['AI app builder'], { fetcher, now });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.reportDate).toBe('2026-10-21');
    expect(result.stale).toBe(false);
    expect(result.newsMatches).toHaveLength(2);
    expect(result.newsMatches.some((item) => item.url === 'https://example.com/ai-app-builder')).toBe(true);
    expect(result.skillMatches).toHaveLength(1);
    expect(result.skillMatches[0].url).toBe('https://github.com/sample/ai-app-builder');
    expect(result.skillMatches[0].matchedBy).toContain('AI app builder');
  });

  it('also searches editorial top-five records that use source_url and what_zh fields', async () => {
    const result = await loadRadarMatches(['Nvidia ecosystem'], [], { fetcher: async () => response(payload), now });
    expect(result.newsMatches).toHaveLength(1);
    expect(result.newsMatches[0].url).toBe('https://techcrunch.com/google-ai-developer-tools');
    expect(result.newsMatches[0].summary).toContain('硬件迁移成本');
  });

  it('marks old reports as stale instead of silently treating them as current', async () => {
    const old = { ...payload, generated_at: '2026-10-17T07:30:00.000Z' };
    const result = await loadRadarMatches(['AI app builder'], [], { fetcher: async () => response(old), now });
    expect(result.stale).toBe(true);
  });

  it('rejects bad payload metadata and non-HTTPS or non-GitHub Skill URLs', async () => {
    await expect(loadRadarMatches([], [], { fetcher: async () => response({ status: 'ok', news: [], skills: [] }), now })).rejects.toThrow('日期或更新时间');
    const result = await loadRadarMatches([], ['AI app builder'], {
      fetcher: async () => response({ ...payload, skills: [{ name: 'bad', url: 'https://example.com/a/b', topics: [] }] }),
      now,
    });
    expect(result.skillMatches).toEqual([]);
  });

  it('returns no fake matches when query terms are unrelated', async () => {
    const result = await loadRadarMatches(['underwater basket weaving'], ['antique clock repair'], {
      fetcher: async () => response(payload),
      now,
    });
    expect(result.newsMatches).toEqual([]);
    expect(result.skillMatches).toEqual([]);
  });

  it('reports HTTP failures without fabricating an empty successful report', async () => {
    await expect(loadRadarMatches([], [], { fetcher: async () => response({}, 503), now })).rejects.toThrow('HTTP 503');
  });
});
