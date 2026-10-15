/**
 * 官网快速记录接力棒的测试。
 *
 * 重点只有一个：任何「没能交上去」的情况都不许被说成成功，
 * 原文必须原样留在本机（草稿不被清掉），下次启动 / 登录后还能补交。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SITE_DRAFT_KEY, clearSiteDraft, deliverSiteDraft, readSiteDraft } from './siteCapture';

const TOKEN_KEY = 'nb.cloud.token.v1';
const ENDPOINT = 'https://nianbox-cloud.example.workers.dev';

function seedDraft(content = '路上的一个小发现', id = 'idea_site_1'): void {
  window.localStorage.setItem(SITE_DRAFT_KEY, JSON.stringify({ id, content, createdAt: 1 }));
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function readDraftFromStorage(): { id: string; content: string } | null {
  const raw = window.localStorage.getItem(SITE_DRAFT_KEY);
  return raw === null ? null : (JSON.parse(raw) as { id: string; content: string });
}

beforeEach(() => {
  vi.stubEnv('VITE_CLOUD_ENDPOINT', ENDPOINT);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('readSiteDraft', () => {
  it('没有草稿时返回 null', () => {
    expect(readSiteDraft()).toBeNull();
  });

  it('坏数据不会被当成草稿，并且会被清掉', () => {
    window.localStorage.setItem(SITE_DRAFT_KEY, '{ this is not json');
    expect(readSiteDraft()).toBeNull();
    expect(window.localStorage.getItem(SITE_DRAFT_KEY)).toBeNull();
  });

  it('空内容的草稿会被清掉', () => {
    window.localStorage.setItem(SITE_DRAFT_KEY, JSON.stringify({ id: 'x', content: '   ' }));
    expect(readSiteDraft()).toBeNull();
    expect(window.localStorage.getItem(SITE_DRAFT_KEY)).toBeNull();
  });
});

describe('deliverSiteDraft', () => {
  it('没有草稿时什么都不做，也不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await deliverSiteDraft();

    expect(result.status).toBe('none');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('没有配置云端地址时如实说明，原文留在本机', async () => {
    vi.stubEnv('VITE_CLOUD_ENDPOINT', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    seedDraft();
    window.localStorage.setItem(TOKEN_KEY, 'tok_1');

    const result = await deliverSiteDraft();

    expect(result.status).toBe('not-configured');
    expect(result.message).not.toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readDraftFromStorage()?.content).toBe('路上的一个小发现');
  });

  it('没有登录时不发请求，原文继续留着', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    seedDraft();

    const result = await deliverSiteDraft();

    expect(result.status).toBe('signed-out');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readDraftFromStorage()?.content).toBe('路上的一个小发现');
  });

  it('登录后提交成功：带上令牌与幂等 id，成功后清掉草稿', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true, idea: { id: 'idea_site_1' } }));
    vi.stubGlobal('fetch', fetchMock);
    seedDraft();
    window.localStorage.setItem(TOKEN_KEY, 'tok_1');

    const result = await deliverSiteDraft();

    expect(result.status).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ENDPOINT}/capture`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok_1');
    const body = JSON.parse(String(init.body)) as { content: string; source: string; id: string };
    expect(body.content).toBe('路上的一个小发现');
    expect(body.source).toBe('website');
    expect(body.id).toBe('idea_site_1');
    expect(readDraftFromStorage()).toBeNull();
  });

  it('服务端拒绝时保留原文，并如实带上服务端的说法', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: '服务端说这句话格式不对。' }));
    vi.stubGlobal('fetch', fetchMock);
    seedDraft();
    window.localStorage.setItem(TOKEN_KEY, 'tok_1');

    const result = await deliverSiteDraft();

    expect(result.status).toBe('failed');
    expect(result.message).toContain('服务端说这句话格式不对');
    expect(readDraftFromStorage()?.content).toBe('路上的一个小发现');
  });

  it('2xx 但返回体没有明确的 ok: true 时不算成功', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { received: true }));
    vi.stubGlobal('fetch', fetchMock);
    seedDraft();
    window.localStorage.setItem(TOKEN_KEY, 'tok_1');

    const result = await deliverSiteDraft();

    expect(result.status).toBe('failed');
    expect(readDraftFromStorage()?.content).toBe('路上的一个小发现');
  });

  it('网络失败会重试，仍然失败时原文留在本机', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    seedDraft();
    window.localStorage.setItem(TOKEN_KEY, 'tok_1');

    const result = await deliverSiteDraft();

    expect(result.status).toBe('failed');
    expect(fetchMock.mock.calls.length).toBe(3);
    expect(readDraftFromStorage()?.content).toBe('路上的一个小发现');
  });

  it('手动清掉草稿之后不再补交', async () => {
    seedDraft();
    clearSiteDraft();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await deliverSiteDraft();

    expect(result.status).toBe('none');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});