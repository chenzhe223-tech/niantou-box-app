/**
 * 匿名使用统计（开发者用来判断「下一步该做什么」的运营数据）。
 *
 * 这里是整份代码里约束最严的一个模块，因为它是唯一会让数据离开本机的地方。
 * 下面几条不是文档里的口号，而是写死在代码里的机制：
 *
 * 1. 绝不发送念头内容。事件名只能取自 EVENT_NAMES；事件参数必须通过
 *    PROP_SCHEMA 白名单过滤（见 sanitizeProps）。没有登记的字段会在发送前
 *    被丢掉，所以即使调用方误传 { content: idea.content }，也不会有任何
 *    内容离开这台设备。
 * 2. 未配置后端就完全不联网。getTelemetryConfig() 为 null 时，track() 只
 *    更新本机计数，不会发起任何网络请求。
 * 3. 用户可一键关闭。关闭后立即停止上报，并清空待发送队列（见
 *    setTelemetryEnabled）。关闭这个动作本身不会上报任何数据。
 * 4. 不采集个人信息。只有一个随机生成的设备 ID（可随时重置）、应用版本、
 *    平台大类、界面语言与分辨率档位；没有 Cookie、没有指纹、不记录 IP。
 * 5. 永不阻塞界面。所有网络失败都被静默吞掉，事件留在本地队列等下次重试。
 */

import { getAppVersion, getTelemetryConfig } from '../app/telemetryConfig';
import { IDEA_STATUSES } from '../types/idea';
import { PROJECT_PROGRESSES } from '../types/project';

/* -------------------------------------------------------------------------- */
/* 事件表：只允许这里登记过的事件名                                            */
/* -------------------------------------------------------------------------- */

export const EVENT_NAMES = [
  'app_open',
  'idea_created',
  'idea_updated',
  'idea_status_changed',
  'idea_pinned',
  'idea_deleted',
  'idea_restored',
  'idea_purged',
  'idea_upgraded',
  'project_updated',
  'search_used',
  'backup_exported',
  'backup_imported',
  'data_cleared',
  'feedback_opened',
  'feedback_submitted',
  'telemetry_changed',
  // 云端同步
  'cloud_signup',
  'cloud_signin',
  'cloud_signout',
  'cloud_sync_result',
  'cloud_migrated',
  // AI 与流转
  'ai_classify_used',
  'ai_tool_opened',
  'mail_handoff',
  'poster_used',
  // 本机作品库
  'work_saved',
  'work_deleted',
] as const;

export type AnalyticsEventName = (typeof EVENT_NAMES)[number];

/* -------------------------------------------------------------------------- */
/* 参数白名单：只有「枚举值」能出去，自由文本一律出不去                        */
/* -------------------------------------------------------------------------- */

const SOURCES = [
  'home',
  'inbox',
  'idea_detail',
  'projects',
  'project_detail',
  'trash',
  'settings',
  'cloud',
  'dev',
  'works',
] as const;

/**
 * 允许上报的参数名，以及每个参数允许的取值。
 *
 * 刻意只放「低信息量、可枚举」的字段：
 * - status / progress：用户在哪个环节卡住，是产品改进的关键依据；
 * - source：功能入口的使用分布；
 * - bucket：数量档位（不报精确条数，降低识别性）；
 * - kind / result / state：反馈类型与操作结果。
 *
 * 注意这里没有、也不会有 title / content / notes / tags / category / url：
 * 那些字段一旦上报就等于把用户的灵感传了出去。
 */
const PROP_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  source: SOURCES,
  status: IDEA_STATUSES.map((item) => item.value),
  progress: PROJECT_PROGRESSES.map((item) => item.value),
  bucket: ['1', '2-5', '6-20', '21-100', '100+'],
  kind: ['bug', 'suggestion', 'praise', 'other'],
  /* 操作结果：ok / error / cancelled（用户取消）/ skipped（按规则跳过，例如已手动分类）。 */
  result: ['ok', 'error', 'cancelled', 'skipped'],
  state: ['on', 'off'],
  /* 云端同步结果：只上报「这台设备目前在什么状态」，不含账号、邮箱或条数。 */
  sync: ['idle', 'pending', 'offline', 'error', 'unconfigured', 'signed-out'],
  /* AI 分类来源：AI / 规则 / 用户手改。 */
  via: ['ai', 'rules', 'manual', 'none'],
  /* 交给哪个 AI 工具、用的是哪种任务模板。 */
  tool: ['chatgpt', 'workbuddy', 'doubao', 'qwen', 'glm', 'custom'],
  template: ['analyze', 'app', 'skill', 'website', 'feasibility', 'custom'],
  /* 邮件到底发出去了没有：'mailto' = 只是预填，'server' = 服务端已发送。 */
  channel: ['mailto', 'server'],
  style: ['brand', 'dream', 'toy3d', 'minimal', 'journal', 'future'],
  aspect: ['3:4', '1:1'],
  render: ['ai', 'local'],
};

export type AnalyticsProps = Readonly<Record<string, unknown>>;

/**
 * 按白名单过滤事件参数：只遍历 PROP_SCHEMA 里的键，
 * 因此任何未登记的字段（包括误传的正文）都会被丢弃。
 */
export function sanitizeProps(input: AnalyticsProps | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  if (!input) return output;
  for (const key of Object.keys(PROP_SCHEMA)) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    if (PROP_SCHEMA[key].includes(value)) output[key] = value;
  }
  return output;
}

/** 把数量折算成档位，避免上报精确条数。 */
export function bucketCount(value: number): string {
  if (value <= 1) return '1';
  if (value <= 5) return '2-5';
  if (value <= 20) return '6-20';
  if (value <= 100) return '21-100';
  return '100+';
}

/* -------------------------------------------------------------------------- */
/* 本机存储：隐私模式下 localStorage 可能不可用，全部操作都必须容错             */
/* -------------------------------------------------------------------------- */

const STORAGE_PREFIX = 'nb.telemetry.';
const INSTALL_ID_KEY = `${STORAGE_PREFIX}install.v1`;
const ENABLED_KEY = `${STORAGE_PREFIX}enabled.v1`;
const NOTICE_SEEN_KEY = `${STORAGE_PREFIX}notice.v1`;
const QUEUE_KEY = `${STORAGE_PREFIX}queue.v1`;
const COUNTER_KEY = `${STORAGE_PREFIX}counters.v1`;

/** 默认是否开启匿名统计（后端未配置时无论如何都不会联网）。 */
export const DEFAULT_TELEMETRY_ENABLED = false;

const MAX_QUEUE = 300;
const MAX_BATCH = 40;
const FLUSH_DELAY_MS = 12_000;
const COUNTER_DAYS = 90;
const RECENT_WINDOW_DAYS = 14;
const REQUEST_TIMEOUT_MS = 8_000;

export const PAYLOAD_VERSION = 1;

function readLocalStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // 隐私模式 / 存储配额不足：统计能力降级，但不影响应用本身。
  }
}

function removeLocalStorage(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // 同上。
  }
}

function createRandomId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  return `nb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let sessionId = '';

/** 设备 ID：随机生成、只存在本机、可以随时重置（不含任何硬件或账号信息）。 */
export function getInstallId(): string {
  const existing = readLocalStorage(INSTALL_ID_KEY);
  if (existing) return existing;
  const created = createRandomId();
  writeLocalStorage(INSTALL_ID_KEY, created);
  return created;
}

/** 重置设备 ID：旧数据不会被删除，但之后的上报无法与之前的关联。 */
export function resetInstallId(): string {
  const created = createRandomId();
  writeLocalStorage(INSTALL_ID_KEY, created);
  return created;
}

/** 会话 ID：每次打开页面重新生成，用于区分「访问次数」。 */
export function getSessionId(): string {
  if (!sessionId) sessionId = createRandomId();
  return sessionId;
}

/* -------------------------------------------------------------------------- */
/* 开关：默认开启，但随时可以关，关掉之后一个字节都不会发出去                   */
/* -------------------------------------------------------------------------- */

export function isTelemetryEnabled(): boolean {
  const raw = readLocalStorage(ENABLED_KEY);
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return DEFAULT_TELEMETRY_ENABLED;
}

export function setTelemetryEnabled(enabled: boolean): void {
  writeLocalStorage(ENABLED_KEY, enabled ? 'on' : 'off');
  if (!enabled) {
    // 关闭即销毁待发送队列：不存在「关了之后还在偷偷补发」的情况。
    removeLocalStorage(QUEUE_KEY);
  }
  // 关闭动作本身不上报；只有开启动作会留下一条记录，方便开发者知道有多少人选择开启。
  track('telemetry_changed', { state: enabled ? 'on' : 'off' });
}

export function hasSeenTelemetryNotice(): boolean {
  return readLocalStorage(NOTICE_SEEN_KEY) === 'seen';
}

export function markTelemetryNoticeSeen(): void {
  writeLocalStorage(NOTICE_SEEN_KEY, 'seen');
}

/** 是否需要在界面上给出「首次使用告知」。未配置后端时永远不显示。 */
export function shouldShowTelemetryNotice(): boolean {
  if (!getTelemetryConfig()) return false;
  return isTelemetryEnabled() && !hasSeenTelemetryNotice();
}

/* -------------------------------------------------------------------------- */
/* 运行环境：只上报粗粒度档位，不构成指纹                                       */
/* -------------------------------------------------------------------------- */

export interface TelemetryContext {
  /** 应用版本（CI 注入的构建号）。 */
  app: string;
  /** 平台大类：wechat / ios / android / macos / windows / linux / other。 */
  platform: string;
  /** 是否以「添加到主屏幕」的方式运行。 */
  display: 'standalone' | 'browser';
  /** 视口档位：narrow / medium / wide / unknown。 */
  viewport: 'narrow' | 'medium' | 'wide' | 'unknown';
  /** 界面语言标签（截断到 12 字符）。 */
  lang: string;
}

function platformLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : (navigator.userAgent ?? '');
  if (/MicroMessenger/i.test(ua)) return 'wechat';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

function displayLabel(): TelemetryContext['display'] {
  try {
    if (typeof globalThis.matchMedia === 'function') {
      return globalThis.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser';
    }
  } catch {
    // 忽略：无法判断时按浏览器处理。
  }
  return 'browser';
}

function viewportLabel(): TelemetryContext['viewport'] {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth;
  if (!width) return 'unknown';
  if (width < 480) return 'narrow';
  if (width < 900) return 'medium';
  return 'wide';
}

export function collectContext(): TelemetryContext {
  const rawLang = typeof navigator === 'undefined' ? '' : (navigator.language ?? '');
  return {
    app: getAppVersion(),
    platform: platformLabel(),
    display: displayLabel(),
    viewport: viewportLabel(),
    lang: rawLang.slice(0, 12),
  };
}

/* -------------------------------------------------------------------------- */
/* 待发送队列：断网时留在本机，下次打开应用再补发                               */
/* -------------------------------------------------------------------------- */

interface QueuedEvent {
  n: string;
  t: number;
  p: Record<string, string>;
}

function isQueuedEvent(value: unknown): value is QueuedEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<QueuedEvent>;
  return (
    typeof event.n === 'string' &&
    typeof event.t === 'number' &&
    typeof event.p === 'object' &&
    event.p !== null
  );
}

function loadQueue(): QueuedEvent[] {
  const raw = readLocalStorage(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isQueuedEvent);
  } catch {
    return [];
  }
}

function saveQueue(events: QueuedEvent[]): void {
  writeLocalStorage(QUEUE_KEY, JSON.stringify(events.slice(-MAX_QUEUE)));
}

export function countQueuedEvents(): number {
  return loadQueue().length;
}

export function clearTelemetryQueue(): void {
  removeLocalStorage(QUEUE_KEY);
}

/* -------------------------------------------------------------------------- */
/* 本机统计：开发者页面与断网情况下依然能看到使用情况                           */
/* -------------------------------------------------------------------------- */

type LocalCounters = Record<string, Record<string, number>>;

function dayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function loadCounters(): LocalCounters {
  const raw = readLocalStorage(COUNTER_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as LocalCounters;
  } catch {
    return {};
  }
}

function recordLocalUsage(name: string, at = Date.now()): void {
  const counters = loadCounters();
  const key = dayKey(new Date(at));
  const forDay = counters[key] ?? {};
  forDay[name] = (forDay[name] ?? 0) + 1;
  counters[key] = forDay;

  // 只保留最近 COUNTER_DAYS 天，长期使用也不会无限增长。
  const days = Object.keys(counters).sort();
  if (days.length > COUNTER_DAYS) {
    for (const stale of days.slice(0, days.length - COUNTER_DAYS)) {
      delete counters[stale];
    }
  }
  writeLocalStorage(COUNTER_KEY, JSON.stringify(counters));
}

export interface UsageSummary {
  /** 按天统计：{ '2026-10-14': { app_open: 1, idea_created: 3 } } */
  days: LocalCounters;
  /** 全部事件的累计次数。 */
  totals: Record<string, number>;
  /** 有使用记录的天数。 */
  activeDays: number;
  firstDay: string | null;
  lastDay: string | null;
  /** 最近 14 天（含今天）的逐日事件数，用于画活跃柱状图。 */
  recentDays: ReadonlyArray<{ day: string; total: number }>;
}

export function getLocalUsageSummary(): UsageSummary {
  const days = loadCounters();
  const totals: Record<string, number> = {};
  for (const day of Object.keys(days)) {
    for (const [name, count] of Object.entries(days[day] ?? {})) {
      totals[name] = (totals[name] ?? 0) + count;
    }
  }

  const sorted = Object.keys(days).sort();
  const now = new Date();
  const recentDays: Array<{ day: string; total: number }> = [];
  for (let offset = RECENT_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const key = dayKey(date);
    const forDay = days[key] ?? {};
    recentDays.push({
      day: key,
      total: Object.values(forDay).reduce((sum, value) => sum + value, 0),
    });
  }

  return {
    days,
    totals,
    activeDays: sorted.length,
    firstDay: sorted[0] ?? null,
    lastDay: sorted[sorted.length - 1] ?? null,
    recentDays,
  };
}

export function clearLocalUsageSummary(): void {
  removeLocalStorage(COUNTER_KEY);
}

/* -------------------------------------------------------------------------- */
/* 传输：唯一的出口。所有网络请求都必须经过 sendToSink                         */
/* -------------------------------------------------------------------------- */

export interface OutgoingPayload {
  v: number;
  installId: string;
  sessionId: string;
  context: TelemetryContext;
  events?: ReadonlyArray<QueuedEvent>;
  /** 用户主动提交的反馈；与事件共用同一个出口，但只在用户点「提交」时发送。 */
  feedback?: ReadonlyArray<Record<string, unknown>>;
}

/**
 * 把一批数据发到配置的接口。
 *
 * 返回是否成功；失败（离线、跨域被拦、后端不可用、超时）一律返回 false，
 * 绝不抛异常——统计失败不能让用户看到报错，更不能影响记录念头。
 */
export async function sendToSink(payload: OutgoingPayload): Promise<boolean> {
  const config = getTelemetryConfig();
  if (!config) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.key) headers['X-NianBox-Key'] = config.key;

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      keepalive: true,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let flushing = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(delay = FLUSH_DELAY_MS): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushTelemetry();
  }, delay);
}

/**
 * 发送待发送队列（最多 MAX_BATCH 条）。成功才从队列里移除，
 * 因此断网、关掉页面都不会丢事件。
 */
export async function flushTelemetry(): Promise<boolean> {
  if (flushing) return false;
  if (!getTelemetryConfig() || !isTelemetryEnabled()) return false;

  const queue = loadQueue();
  if (queue.length === 0) return false;

  const batch = queue.slice(0, MAX_BATCH);
  flushing = true;
  try {
    const delivered = await sendToSink({
      v: PAYLOAD_VERSION,
      installId: getInstallId(),
      sessionId: getSessionId(),
      context: collectContext(),
      events: batch,
    });
    if (delivered) saveQueue(queue.slice(batch.length));
    return delivered;
  } finally {
    flushing = false;
  }
}

/* -------------------------------------------------------------------------- */
/* 对外入口                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 记录一个事件。
 *
 * 本机计数永远会更新（开发者页面据此展示使用情况）；只有「后端已配置且用户
 * 没关闭」时才会把事件放进待发送队列。
 */
export function track(name: AnalyticsEventName, props?: AnalyticsProps): void {
  recordLocalUsage(name);

  if (!getTelemetryConfig()) return;
  if (!isTelemetryEnabled()) return;

  const queue = loadQueue();
  queue.push({ n: name, t: Date.now(), p: sanitizeProps(props) });
  saveQueue(queue);

  if (queue.length >= MAX_BATCH) {
    void flushTelemetry();
    return;
  }
  scheduleFlush();
}

export interface TelemetryStatus {
  /** 后端是否已配置（未配置 = 应用不联网）。 */
  configured: boolean;
  /** 用户是否允许上报。 */
  enabled: boolean;
  installId: string;
  queuedEvents: number;
  hasSeenNotice: boolean;
  appVersion: string;
}

export function getTelemetryStatus(): TelemetryStatus {
  return {
    configured: getTelemetryConfig() !== null,
    enabled: isTelemetryEnabled(),
    installId: getInstallId(),
    queuedEvents: countQueuedEvents(),
    hasSeenNotice: hasSeenTelemetryNotice(),
    appVersion: getAppVersion(),
  };
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') void flushTelemetry();
}

function handlePageHide(): void {
  void flushTelemetry();
}

/**
 * 启动统计：记录一次 app_open，并在页面隐藏 / 关闭时把队列发出去。
 * 由 main.tsx 调用一次。
 */
export function initTelemetry(): void {
  track('app_open');
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', handlePageHide);
  }
}
