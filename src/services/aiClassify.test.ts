/**
 * 补分类（收件箱里还没分类的念头）的测试。
 *
 * 关心三件事：
 * 1. 未登录 / 未配置云端时一条请求都不发；
 * 2. 只碰「还没分类」的念头，用户手动选过的分类绝不被改写；
 * 3. 分类失败不影响任何一条已保存的内容。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyUncategorizedIdeas,
  resetCategoryBackfillForTests,
} from './aiClassify';
import { createIdea, listIdeas } from './storage';

const TOKEN_KEY = 'nb.cloud.token.v1';
const ENDPOINT = 'https://nianbox-cloud.example.workers.dev';

function classifyResponse(category: string): Response {
  const body = {
    configured: false,
    category,
    label: category,
    source: 'rules',
    message: '服务端尚未配置 AI 模型，已用本地关键词规则完成分类。',
  };
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function signIn(): void {
  window.localStorage.setItem(TOKEN_KEY, 'test-token');
}

beforeEach(() => {
  vi.stubEnv('VITE_CLOUD_ENDPOINT', ENDPOINT);
  resetCategoryBackfillForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetCategoryBackfillForTests();
});

describe('classifyUncategorizedIdeas', () => {
  it('未登录时不发任何请求', async () => {
    await createIdea({ content: '做一个只给我自己用的记账小工具' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(classifyUncategorizedIdeas()).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('没有配置云端地址时不发任何请求', async () => {
    vi.stubEnv('VITE_CLOUD_ENDPOINT', '');
    signIn();
    await createIdea({ content: '做一个只给我自己用的记账小工具' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(classifyUncategorizedIdeas()).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('给还没分类的念头补上分类', async () => {
    signIn();
    await createIdea({ content: '想给家里做一个自动浇花的提醒' });
    await createIdea({ content: '写一个自动整理下载文件夹的脚本' });

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(classifyResponse('app'))),
    );

    await expect(classifyUncategorizedIdeas()).resolves.toBe(2);
    const ideas = await listIdeas();
    expect(ideas.every((idea) => idea.category === 'app')).toBe(true);
    expect(ideas.every((idea) => idea.categorySource === 'rules')).toBe(true);
  });

  it('不会改写用户手动选过的分类', async () => {
    signIn();
    const manual = await createIdea({ content: '手动分好类的一条', category: 'life' });
    await createIdea({ content: '还没分类的一条' });

    const fetchMock = vi.fn(() => Promise.resolve(classifyResponse('app')));
    vi.stubGlobal('fetch', fetchMock);

    await expect(classifyUncategorizedIdeas()).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const ideas = await listIdeas();
    expect(ideas.find((idea) => idea.id === manual.id)?.category).toBe('life');
  });

  it('分类接口失败时不抛错，也不影响已保存的内容', async () => {
    signIn();
    await createIdea({ content: '网络不好时写下的念头' });

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );

    await expect(classifyUncategorizedIdeas()).resolves.toBe(0);
    const ideas = await listIdeas();
    expect(ideas).toHaveLength(1);
    expect(ideas[0].content).toBe('网络不好时写下的念头');
    expect(ideas[0].category).toBeNull();
  });

  it('limit 之外的不在这一轮处理', async () => {
    signIn();
    await createIdea({ content: '第一条' });
    await createIdea({ content: '第二条' });
    await createIdea({ content: '第三条' });

    const fetchMock = vi.fn(() => Promise.resolve(classifyResponse('other')));
    vi.stubGlobal('fetch', fetchMock);

    await expect(classifyUncategorizedIdeas({ limit: 1 })).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
