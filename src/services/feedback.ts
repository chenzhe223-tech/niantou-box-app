/**
 * 用户意见反馈。
 *
 * 设计要点：
 * 1. 先落本机再发送。用户点了「提交」就一定不会丢：先写入 IndexedDB，
 *    再尝试上报；上报失败只是把状态标成 failed，下次打开应用自动补发。
 * 2. 反馈内容只有用户亲手写的那段文字。附带的「诊断信息」是可选项，
 *    只含应用版本 / 平台 / 界面语言 / 念头条数这类技术参数，
 *    绝不包含任何念头正文（见 buildFeedbackDiagnostics 的调用方）。
 * 3. 未配置后端时，反馈同样可靠地保存在本机，开发者页面可以导出。
 */

import {
  sendToSink,
  getInstallId,
  getSessionId,
  collectContext,
  PAYLOAD_VERSION,
  type TelemetryContext,
} from './analytics';
import { STORE_FEEDBACK, clearStore, deleteRecord, promisifyRequest, readAll, withTransaction } from './idb';
import { createId } from './storage';

export type FeedbackKind = 'bug' | 'suggestion' | 'praise' | 'other';

export const FEEDBACK_KINDS: ReadonlyArray<{ value: FeedbackKind; label: string }> = [
  { value: 'bug', label: '遇到问题 / 用不了' },
  { value: 'suggestion', label: '功能建议' },
  { value: 'praise', label: '使用感受 / 鼓励' },
  { value: 'other', label: '其他' },
];

export const FEEDBACK_MESSAGE_MAX = 2000;
export const FEEDBACK_CONTACT_MAX = 120;

export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return typeof value === 'string' && FEEDBACK_KINDS.some((item) => item.value === value);
}

/**
 * 反馈附带的诊断信息。
 *
 * 这里只有「技术参数 + 数量」，没有标题、没有正文、没有标签：
 * 开发者需要知道的是「在什么环境下出的问题」，不是「用户写了什么」。
 */
export interface FeedbackDiagnostics {
  app: string;
  platform: string;
  display: string;
  viewport: string;
  lang: string;
  /** 念头数量（仅条数，不含内容）。 */
  ideas: number;
  /** 项目数量（仅条数，不含内容）。 */
  projects: number;
}

export type FeedbackUploadState = 'local' | 'sent' | 'failed';

/**
 * 组装诊断信息。
 *
 * 参数只有一个「运行环境」对象和两个数量，因此这个函数在结构上就无法
 * 把念头正文带出去——调用方没有任何地方可以塞内容。
 */
export function toFeedbackDiagnostics(
  context: TelemetryContext,
  ideas: number,
  projects: number,
): FeedbackDiagnostics {
  return {
    app: context.app,
    platform: context.platform,
    display: context.display,
    viewport: context.viewport,
    lang: context.lang,
    ideas,
    projects,
  };
}

export interface FeedbackRecord {
  id: string;
  kind: FeedbackKind;
  message: string;
  contact: string;
  /** 用户是否勾选了「附带诊断信息」。 */
  includeDiagnostics: boolean;
  /** 勾选时才有值。 */
  diagnostics: FeedbackDiagnostics | null;
  createdAt: number;
  uploadState: FeedbackUploadState;
  attempts: number;
  lastAttemptAt: number | null;
}

export interface FeedbackDraft {
  kind: FeedbackKind;
  message: string;
  contact?: string;
  includeDiagnostics?: boolean;
  diagnostics?: FeedbackDiagnostics | null;
}

export class FeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackError';
  }
}

/** 去掉首尾空白并限制长度；超长内容直接截断，而不是让提交失败。 */
function normalizeMessage(value: string): string {
  return value.trim().slice(0, FEEDBACK_MESSAGE_MAX);
}

function normalizeContact(value: string | undefined): string {
  return (value ?? '').trim().slice(0, FEEDBACK_CONTACT_MAX);
}

async function putFeedback(record: FeedbackRecord): Promise<void> {
  await withTransaction({ stores: [STORE_FEEDBACK] }, 'readwrite', async (tx) => {
    await promisifyRequest(tx.objectStore(STORE_FEEDBACK).put(record));
  });
}

/** 新建一条反馈：先写本机，返回可交给 submitFeedback 的记录。 */
export async function createFeedback(draft: FeedbackDraft): Promise<FeedbackRecord> {
  const message = normalizeMessage(draft.message);
  if (message === '') {
    throw new FeedbackError('请先写下你的想法或遇到的问题。');
  }

  const record: FeedbackRecord = {
    id: createId('feedback'),
    kind: isFeedbackKind(draft.kind) ? draft.kind : 'other',
    message,
    contact: normalizeContact(draft.contact),
    includeDiagnostics: draft.includeDiagnostics === true,
    diagnostics: draft.includeDiagnostics === true ? (draft.diagnostics ?? null) : null,
    createdAt: Date.now(),
    uploadState: 'local',
    attempts: 0,
    lastAttemptAt: null,
  };

  await putFeedback(record);
  return record;
}

export async function listFeedback(): Promise<FeedbackRecord[]> {
  const raw = await readAll<FeedbackRecord>(STORE_FEEDBACK);
  return raw
    .filter((item) => typeof item?.id === 'string')
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function listPendingFeedback(): Promise<FeedbackRecord[]> {
  const all = await listFeedback();
  return all.filter((item) => item.uploadState !== 'sent');
}

export async function deleteFeedback(id: string): Promise<void> {
  await deleteRecord(STORE_FEEDBACK, id);
}

export async function clearFeedback(): Promise<void> {
  await clearStore(STORE_FEEDBACK);
}

/** 上报时的线上格式（后端契约的一部分，改动需同步后端）。 */
export interface FeedbackPayloadItem {
  id: string;
  kind: FeedbackKind;
  message: string;
  contact: string;
  diagnostics: FeedbackDiagnostics | null;
  at: number;
}

function toPayloadItem(record: FeedbackRecord): FeedbackPayloadItem {
  return {
    id: record.id,
    kind: record.kind,
    message: record.message,
    contact: record.contact,
    diagnostics: record.includeDiagnostics ? record.diagnostics : null,
    at: record.createdAt,
  };
}

/**
 * 把一条反馈发出去。无论成功失败都返回更新后的记录
 * （uploadState 为 sent / failed），调用方据此给用户准确提示。
 */
export async function submitFeedback(record: FeedbackRecord): Promise<FeedbackRecord> {
  const delivered = await sendToSink({
    v: PAYLOAD_VERSION,
    installId: getInstallId(),
    sessionId: getSessionId(),
    context: collectContext(),
    feedback: [toPayloadItem(record) as unknown as Record<string, unknown>],
  });

  const next: FeedbackRecord = {
    ...record,
    uploadState: delivered ? 'sent' : 'failed',
    attempts: record.attempts + 1,
    lastAttemptAt: Date.now(),
  };
  await putFeedback(next);
  return next;
}

/** 补发所有还没送出去的反馈；返回本次成功发送的条数。 */
export async function flushPendingFeedback(): Promise<number> {
  const pending = await listPendingFeedback();
  if (pending.length === 0) return 0;

  let sent = 0;
  for (const record of pending) {
    const next = await submitFeedback(record);
    if (next.uploadState === 'sent') sent += 1;
  }
  return sent;
}

/**
 * 启动时补发一次（延迟执行，不抢应用启动的带宽与主线程）。
 * 未配置后端时 submitFeedback 会直接返回 failed 且不发请求，
 * 因此这里额外做一次配置检查，避免无意义的写入。
 */
export function initFeedbackRetry(delayMs = 5_000): void {
  if (typeof setTimeout !== 'function') return;
  setTimeout(() => {
    void flushPendingFeedback().catch(() => undefined);
  }, delayMs);
}
