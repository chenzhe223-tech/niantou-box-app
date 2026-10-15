/**
 * 匿名使用统计测试。
 *
 * 这个模块是整份代码里唯一会让数据离开本机的地方，因此测试的重点不是
 * 「事件有没有发出去」，而是「有没有不该发的东西被发出去」：
 * - 参数白名单必须真的丢内容字段，而不是靠调用方自觉；
 * - 数量必须折算成档位，不能泄露精确条数；
 * - 没有配置后端时一个请求都不许发；
 * - 用户关闭后队列立刻清空，并且不再入队。
 *
 * 说明：这里刻意不使用 vi.useFakeTimers()。fake-indexeddb 依赖真实事件循环
 * 派发请求（同时 setup 里的数据库重置也要跑），伪造计时器会连带把
 * setImmediate 一起替换掉，导致写库的 Promise 永远不 resolve。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bucketCount,
  countQueuedEvents,
  flushTelemetry,
  getInstallId,
  getLocalUsageSummary,
  getTelemetryStatus,
  isTelemetryEnabled,
  resetInstallId,
  sanitizeProps,
  setTelemetryEnabled,
  track,
} from './analytics';

const QUEUE_KEY = 'nb.telemetry.queue.v1';
const ENDPOINT = 'https://ingest.example.com/nianbox';

interface QueueItem {
  n: string;
  t: number;
  p: Record<string, string>;
}

function readQueue(): QueueItem[] {
  const raw = window.localStorage.getItem(QUEUE_KEY);
  return raw ? (JSON.parse(raw) as QueueItem[]) : [];
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  // Most analytics tests exercise the explicit opt-in path; production defaults to off.
  window.localStorage.setItem('nb.telemetry.enabled.v1', 'on');
  fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('参数白名单：内容字段不可能离开设备', () => {
  it('未登记的字段（正文、标题、标签、链接）会被直接丢弃', () => {
    const props = sanitizeProps({
      // 这些字段即使被误传进来，也不会出现在结果里。
      content: '这是一条不能离开设备的灵感',
      title: '车位雷达',
      tags: '通勤,停车',
      url: 'https://example.com/secret',
      notes: '私人备注',
      // 只有白名单内的枚举值会保留。
      source: 'inbox',
      status: 'ready',
    });

    expect(props).toEqual({ source: 'inbox', status: 'ready' });
    expect(JSON.stringify(props)).not.toContain('灵感');
    expect(JSON.stringify(props)).not.toContain('车位雷达');
    expect(JSON.stringify(props)).not.toContain('secret');
  });

  it('白名单内的参数也只接受登记过的取值', () => {
    expect(sanitizeProps({ status: '随便写的状态' })).toEqual({});
    expect(sanitizeProps({ source: 'nowhere' })).toEqual({});
    expect(sanitizeProps({ kind: 'bug', result: 'ok', state: 'on' })).toEqual({
      kind: 'bug',
      result: 'ok',
      state: 'on',
    });
    expect(sanitizeProps({ progress: 'building' })).toEqual({ progress: 'building' });
  });

  it('没有参数时返回空对象，不会抛错', () => {
    expect(sanitizeProps(undefined)).toEqual({});
    expect(sanitizeProps({})).toEqual({});
  });
});

describe('数量档位：只报档位，不报精确条数', () => {
  it('bucketCount 的边界值落在正确档位', () => {
    expect(bucketCount(0)).toBe('1');
    expect(bucketCount(1)).toBe('1');
    expect(bucketCount(2)).toBe('2-5');
    expect(bucketCount(5)).toBe('2-5');
    expect(bucketCount(6)).toBe('6-20');
    expect(bucketCount(20)).toBe('6-20');
    expect(bucketCount(21)).toBe('21-100');
    expect(bucketCount(100)).toBe('21-100');
    expect(bucketCount(101)).toBe('100+');
    expect(bucketCount(9999)).toBe('100+');
  });

  it('档位取值本身都在白名单内，精确条数则无法通过', () => {
    for (const value of ['1', '2-5', '6-20', '21-100', '100+']) {
      expect(sanitizeProps({ bucket: value })).toEqual({ bucket: value });
    }
    expect(sanitizeProps({ bucket: '7' })).toEqual({});
    expect(sanitizeProps({ bucket: 7 })).toEqual({});
  });
});

describe('未配置后端：应用完全不联网', () => {
  it('track 不发请求，也不入队，但本机计数照常记录', async () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', '');

    track('idea_created', { source: 'home' });
    track('idea_created', { source: 'home' });

    expect(getLocalUsageSummary().totals.idea_created).toBe(2);
    expect(countQueuedEvents()).toBe(0);
    expect(window.localStorage.getItem(QUEUE_KEY)).toBeNull();

    await flushTelemetry();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('endpoint 不是 http/https 绝对地址时，等同于未配置', () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', 'javascript:alert(1)');
    expect(getTelemetryStatus().configured).toBe(false);

    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', '/ingest');
    expect(getTelemetryStatus().configured).toBe(false);

    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);
    expect(getTelemetryStatus().configured).toBe(true);
  });
});

describe('配置后端后：事件先入队，再由队列统一上报', () => {
  it('入队的事件只带过滤后的参数', () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);

    track('idea_created', {
      source: 'home',
      content: '不能离开设备的正文',
      title: '不能离开设备的标题',
      status: '不存在的状态',
    });

    const queue = readQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].n).toBe('idea_created');
    expect(queue[0].p).toEqual({ source: 'home' });
    expect(typeof queue[0].t).toBe('number');
    expect(window.localStorage.getItem(QUEUE_KEY)).not.toContain('不能离开设备');
  });

  it('上报成功后事件从队列移除，请求体里带有写入令牌与设备标识', async () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);
    vi.stubEnv('VITE_TELEMETRY_KEY', 'public-write-only-token');

    track('app_open');
    expect(await flushTelemetry()).toBe(true);

    expect(countQueuedEvents()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const [url, init] = calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-NianBox-Key']).toBe('public-write-only-token');

    const body = JSON.parse(String(init.body)) as {
      v: number;
      installId: string;
      sessionId: string;
      context: Record<string, string>;
      events: QueueItem[];
    };
    expect(body.v).toBe(1);
    expect(body.installId.length).toBeGreaterThan(8);
    expect(body.sessionId.length).toBeGreaterThan(8);
    expect(body.context.app).toBeTruthy();
    expect(body.events.map((event) => event.n)).toEqual(['app_open']);
  });

  it('上报失败时事件留在队列里，下一次成功后再移除', async () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    track('idea_created');
    expect(await flushTelemetry()).toBe(false);
    expect(countQueuedEvents()).toBe(1);

    fetchMock.mockResolvedValueOnce({ ok: false });
    expect(await flushTelemetry()).toBe(false);
    expect(countQueuedEvents()).toBe(1);

    fetchMock.mockResolvedValueOnce({ ok: true });
    expect(await flushTelemetry()).toBe(true);
    expect(countQueuedEvents()).toBe(0);
  });

  it('队列为空时不会发出请求', async () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);
    expect(await flushTelemetry()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('用户开关：关掉之后一个字节都不再发出去', () => {
  it('关闭会立即清空待发送队列，并停止入队', () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);

    track('app_open');
    track('idea_created');
    expect(countQueuedEvents()).toBe(2);

    setTelemetryEnabled(false);

    expect(isTelemetryEnabled()).toBe(false);
    expect(countQueuedEvents()).toBe(0);
    expect(window.localStorage.getItem(QUEUE_KEY)).toBeNull();

    track('idea_created');
    expect(countQueuedEvents()).toBe(0);
    // 本机计数仍然记录：关闭上报不影响开发者在本机看板上看自己的使用情况。
    expect(getLocalUsageSummary().totals.idea_created).toBe(2);
  });

  it('重新开启后恢复入队，开关状态写在本机', () => {
    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);

    setTelemetryEnabled(false);
    expect(countQueuedEvents()).toBe(0);

    setTelemetryEnabled(true);
    expect(isTelemetryEnabled()).toBe(true);
    // 开启动作本身留一条记录，方便开发者知道有多少人选择开启。
    expect(readQueue().map((event) => event.n)).toEqual(['telemetry_changed']);
    expect(readQueue()[0].p).toEqual({ state: 'on' });
  });
});

describe('设备标识与状态', () => {
  it('设备标识是随机生成、可重复读取、可重置的本地值', () => {
    const first = getInstallId();
    expect(first.length).toBeGreaterThan(8);
    expect(getInstallId()).toBe(first);

    const second = resetInstallId();
    expect(second).not.toBe(first);
    expect(getInstallId()).toBe(second);
  });

  it('getTelemetryStatus 如实反映配置、开关与队列长度', () => {
    expect(getTelemetryStatus()).toMatchObject({
      configured: false,
      enabled: true,
      queuedEvents: 0,
    });

    vi.stubEnv('VITE_TELEMETRY_ENDPOINT', ENDPOINT);
    track('app_open');

    const status = getTelemetryStatus();
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.queuedEvents).toBe(1);
    expect(status.installId.length).toBeGreaterThan(8);
  });
});

describe('本机使用情况：没有后端也能看到使用记录', () => {
  it('按天累计事件数，并给出累计值与活跃天数', () => {
    track('app_open');
    track('idea_created');
    track('idea_created');

    const summary = getLocalUsageSummary();
    expect(summary.totals).toMatchObject({ app_open: 1, idea_created: 2 });
    expect(summary.activeDays).toBe(1);
    expect(summary.firstDay).toBe(summary.lastDay);
    // 最近 14 天逐日数据固定 14 条，方便直接画柱状图。
    expect(summary.recentDays).toHaveLength(14);
    expect(summary.recentDays[summary.recentDays.length - 1].total).toBe(3);
    expect(summary.recentDays[summary.recentDays.length - 1].day).toBe(summary.lastDay);
  });
});
