/**
 * 用户意见反馈测试。
 *
 * 这里验证的是「用户点过提交就一定不会丢」，以及「附带的东西只有技术参数」：
 * - 反馈先写 IndexedDB，再尝试上报；
 * - 上报失败只把状态标成 failed，下次打开应用自动补发；
 * - 未配置后端时一个请求都不发，但内容照旧安全地留在本机；
 * - 诊断信息在结构上就没有地方可以塞念头正文。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_MESSAGE_MAX,
  FeedbackError,
  createFeedback,
  deleteFeedback,
  flushPendingFeedback,
  listFeedback,
  submitFeedback,
  toFeedbackDiagnostics,
} from './feedback';
import type { TelemetryContext } from './analytics';
import { closeDatabase, openDatabase } from './idb';

const ENDPOINT = 'https://ingest.example.com/nianbox';

/**
 * 等待真实时间推进。
 *
 * IndexedDB 的写入是异步的，而 createdAt 用的是毫秒时间戳；连续两次写入
 * 可能落在同一毫秒里，导致「按时间倒序」的断言变得依赖实现的排序细节。
 * 这里显式错开一点时间，让顺序是确定的。
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function readSentPayloads(): Array<Record<string, unknown>> {
  const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
  return calls.map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>);
}

const CONTEXT: TelemetryContext = {
  app: 'a1b2c3d',
  platform: 'ios',
  display: 'browser',
  viewport: 'narrow',
  lang: 'zh-CN',
};

describe('新建反馈：先写在本机', () => {
  it('内容去掉首尾空白后落库，初始状态是「待发送」', async () => {
    const record = await createFeedback({
      kind: 'bug',
      message: '  在手机上编辑长文本时，光标会跳到开头。  ',
      contact: '  me@example.com  ',
    });

    expect(record.id).toMatch(/^feedback_/);
    expect(record.message).toBe('在手机上编辑长文本时，光标会跳到开头。');
    expect(record.contact).toBe('me@example.com');
    expect(record.uploadState).toBe('local');
    expect(record.attempts).toBe(0);
    expect(record.lastAttemptAt).toBeNull();
    expect(record.diagnostics).toBeNull();

    const stored = await listFeedback();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(record.id);
  });

  it('空内容会被拒绝，也不会产生任何记录', async () => {
    await expect(createFeedback({ kind: 'bug', message: '   \n\t ' })).rejects.toBeInstanceOf(
      FeedbackError,
    );
    await expect(createFeedback({ kind: 'bug', message: '' })).rejects.toThrow('请先写下');
    expect(await listFeedback()).toHaveLength(0);
  });

  it('超出长度上限的内容被截断，而不是让提交失败', async () => {
    const record = await createFeedback({
      kind: 'suggestion',
      message: 'a'.repeat(FEEDBACK_MESSAGE_MAX + 500),
      contact: 'b'.repeat(FEEDBACK_CONTACT_MAX + 500),
    });

    expect(record.message).toHaveLength(FEEDBACK_MESSAGE_MAX);
    expect(record.contact).toHaveLength(FEEDBACK_CONTACT_MAX);
  });

  it('非法的反馈类型会回落到「其他」', async () => {
    const record = await createFeedback({
      kind: 'not-a-kind' as never,
      message: '随便写点什么',
    });
    expect(record.kind).toBe('other');
  });

  it('列表按提交时间倒序返回', async () => {
    const first = await createFeedback({ kind: 'bug', message: '第一条' });
    await sleep(5);
    const second = await createFeedback({ kind: 'praise', message: '第二条' });

    const stored = await listFeedback();
    expect(stored.map((item) => item.id)).toEqual([second.id, first.id]);
  });
});

describe('发送：失败不丢，联网后自动补发', () => {
  it('未配置接收服务时发送失败，但内容完整留在本机', async () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', '');

    const record = await createFeedback({ kind: 'bug', message: '这条只留本机' });
    const next = await submitFeedback(record);

    expect(next.uploadState).toBe('failed');
    expect(next.attempts).toBe(1);
    expect(typeof next.lastAttemptAt).toBe('number');
    // 没有配置后端就不应该发出任何请求。
    expect(fetchMock).not.toHaveBeenCalled();

    const stored = await listFeedback();
    expect(stored).toHaveLength(1);
    expect(stored[0].message).toBe('这条只留本机');
    expect(stored[0].uploadState).toBe('failed');
  });

  it('发送成功后状态更新为 sent，请求体只带这条反馈', async () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);

    const record = await createFeedback({
      kind: 'bug',
      message: '提交给开发者的内容',
      contact: 'me@example.com',
    });
    const next = await submitFeedback(record);

    expect(next.uploadState).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const payload = readSentPayloads()[0] as {
      v: number;
      events?: unknown;
      feedback: Array<Record<string, unknown>>;
    };
    // 事件与反馈共用同一个出口，但这次只有反馈，没有事件。
    expect(payload.events).toBeUndefined();
    expect(payload.feedback).toHaveLength(1);
    expect(payload.feedback[0]).toMatchObject({
      id: record.id,
      kind: 'bug',
      message: '提交给开发者的内容',
      contact: 'me@example.com',
      diagnostics: null,
    });

    expect((await listFeedback())[0].uploadState).toBe('sent');
  });

  it('服务端不可用时标为 failed，下一次 flushPendingFeedback 补发成功', async () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);

    fetchMock.mockResolvedValueOnce({ ok: false });
    const record = await createFeedback({ kind: 'suggestion', message: '希望支持批量整理' });
    expect((await submitFeedback(record)).uploadState).toBe('failed');
    expect(await listFeedback()).toHaveLength(1);

    fetchMock.mockResolvedValueOnce({ ok: true });
    expect(await flushPendingFeedback()).toBe(1);
    expect((await listFeedback())[0].uploadState).toBe('sent');

    // 已经发出去的不会重复提交。
    expect(await flushPendingFeedback()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('没有待发送反馈时补发不发任何请求', async () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);
    expect(await flushPendingFeedback()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('诊断信息：结构上就没有内容字段', () => {
  it('只包含版本、平台、界面语言与两个数量', () => {
    const diagnostics = toFeedbackDiagnostics(CONTEXT, 7, 2);

    expect(Object.keys(diagnostics).sort()).toEqual([
      'app',
      'display',
      'ideas',
      'lang',
      'platform',
      'projects',
      'viewport',
    ]);
    expect(diagnostics).toEqual({
      app: 'a1b2c3d',
      platform: 'ios',
      display: 'browser',
      viewport: 'narrow',
      lang: 'zh-CN',
      ideas: 7,
      projects: 2,
    });
    // 数量是精确条数还是档位由调用方决定，但这里绝不可能带上正文。
    expect(JSON.stringify(diagnostics)).not.toContain('念头正文');
  });

  it('未勾选时不会保存、也不会发送任何诊断信息', async () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);

    const record = await createFeedback({
      kind: 'bug',
      message: '不附带诊断信息',
      includeDiagnostics: false,
      diagnostics: toFeedbackDiagnostics(CONTEXT, 3, 1),
    });
    expect(record.diagnostics).toBeNull();

    await submitFeedback(record);
    const payload = readSentPayloads()[0] as { feedback: Array<Record<string, unknown>> };
    expect(payload.feedback[0].diagnostics).toBeNull();
    expect(JSON.stringify(payload)).not.toContain('a1b2c3d');
  });

  it('勾选后才随反馈一起发送诊断信息', async () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);

    const record = await createFeedback({
      kind: 'bug',
      message: '附带诊断信息',
      includeDiagnostics: true,
      diagnostics: toFeedbackDiagnostics(CONTEXT, 3, 1),
    });
    expect(record.diagnostics?.app).toBe('a1b2c3d');

    await submitFeedback(record);
    const payload = readSentPayloads()[0] as { feedback: Array<Record<string, unknown>> };
    expect(payload.feedback[0].diagnostics).toEqual({
      app: 'a1b2c3d',
      platform: 'ios',
      display: 'browser',
      viewport: 'narrow',
      lang: 'zh-CN',
      ideas: 3,
      projects: 1,
    });
  });
});

describe('本机管理：用户可以删掉自己留下的反馈', () => {
  it('删除只影响这一条记录', async () => {
    const keep = await createFeedback({ kind: 'bug', message: '保留的反馈' });
    const remove = await createFeedback({ kind: 'other', message: '要删掉的反馈' });

    await deleteFeedback(remove.id);

    const stored = await listFeedback();
    expect(stored.map((item) => item.id)).toEqual([keep.id]);
    expect(stored[0].message).toBe('保留的反馈');
  });

  it('删除后再刷新（重开数据库连接）依然不会回来', async () => {
    const record = await createFeedback({ kind: 'bug', message: '删掉就别再出现' });
    await deleteFeedback(record.id);

    await closeDatabase();
    await openDatabase();

    expect(await listFeedback()).toHaveLength(0);
  });
});
