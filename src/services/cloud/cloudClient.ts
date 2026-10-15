/**
 * 云端 API 的底层 HTTP 封装。
 *
 * 三条纪律：
 * 1. 绝不说谎。没有配置就抛 `not-configured`，网络不通就抛 `network`，
 *    服务端返回 4xx/5xx 就带着真实状态码抛出去，绝不把失败包装成成功。
 * 2. 区分「可安全重试」与「不可重试」。GET 与同步推送天然幂等，可以自动重试；
 *    发邮件这类动作绝不能悄悄重发，只能由用户手动再点一次。
 * 3. 超时可控。移动端弱网下请求可能长时间挂起，统一用 AbortController 兜底。
 */

import { getCloudEndpoint } from './cloudConfig';

export type CloudErrorCode =
  | 'not-configured'
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'bad-request'
  | 'rate-limited'
  | 'server'
  | 'bad-response';

export class CloudError extends Error {
  readonly code: CloudErrorCode;
  readonly status: number;
  readonly detail: string;
  /** 服务端在错误体里给出的机器可读原因（例如 STALE、BAD_CURSOR）。 */
  readonly reason: string;

  constructor(
    code: CloudErrorCode,
    message: string,
    options: { status?: number; detail?: string; reason?: string } = {},
  ) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.status = options.status ?? 0;
    this.detail = options.detail ?? '';
    this.reason = options.reason ?? '';
  }
}

/** 把底层异常统一翻译成中文，界面直接可用。 */
export function describeCloudError(error: unknown): string {
  if (error instanceof CloudError) return error.message;
  if (error instanceof Error) return `云端请求出错：${error.message}`;
  return '云端请求出错，请稍后重试。';
}

export function isCloudAuthError(error: unknown): boolean {
  return error instanceof CloudError && error.code === 'unauthorized';
}

export interface CloudCapabilities {
  version: number;
  /** 服务端是否配置了 AI 文本模型（分类 / 抽象用）。 */
  classify: boolean;
  abstract: boolean;
  /** 服务端是否配置了图像生成服务。 */
  image: boolean;
  /** 服务端是否配置了真实邮件服务。 */
  mail: boolean;
  /** 文本会发给哪个服务商（服务端如实填写，用于界面告知用户）。 */
  aiProvider: string;
  imageProvider: string;
}

export const NO_CAPABILITIES: CloudCapabilities = {
  version: 0,
  classify: false,
  abstract: false,
  image: false,
  mail: false,
  aiProvider: '',
  imageProvider: '',
};

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  /** 自动重试次数。只有幂等请求才允许大于 0。 */
  retries?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 600;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetriable(error: CloudError): boolean {
  return (
    error.code === 'network' ||
    error.code === 'timeout' ||
    error.code === 'server' ||
    error.code === 'rate-limited'
  );
}

function statusToCode(status: number): CloudErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return 'bad-request';
}

const STATUS_MESSAGES: Partial<Record<number, string>> = {
  401: '登录状态已失效，请重新登录。',
  403: '没有权限访问这条数据。',
  404: '服务端没有这个接口，请确认云端地址是否正确。',
  413: '一次提交的内容太多，已自动分片，请稍后重试。',
  429: '操作太频繁了，请稍等一会儿再试。',
};

async function readBody(response: Response): Promise<{ payload: unknown; text: string }> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return { payload: null, text: '' };
  }
  if (text.trim() === '') return { payload: null, text: '' };
  try {
    return { payload: JSON.parse(text), text };
  } catch {
    return { payload: null, text };
  }
}

/**
 * 发一次云端请求。失败一律抛 CloudError，调用方据此决定提示与重试策略。
 *
 * 注意：这里不做任何「静默成功」。2xx 之外全部抛错，并保留服务端原始信息。
 */
export async function cloudRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const endpoint = getCloudEndpoint();
  if (!endpoint) {
    throw new CloudError(
      'not-configured',
      '本次构建没有配置云端同步地址，无法访问云端。',
      { reason: 'NOT_CONFIGURED' },
    );
  }

  const method = options.method ?? 'GET';
  const retries = Math.max(0, options.retries ?? 0);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${endpoint}${path.startsWith('/') ? path : `/${path}`}`;

  let lastError: CloudError | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await delay(RETRY_DELAY_MS * attempt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onAbort);
    }

    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (options.token) headers.authorization = `Bearer ${options.token}`;

      const response = await fetch(url, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });

      const { payload, text } = await readBody(response);

      if (response.ok) {
        return payload as T;
      }

      const code = statusToCode(response.status);
      const record = (payload ?? {}) as Record<string, unknown>;
      const detail =
        typeof record.error === 'string'
          ? record.error
          : typeof record.message === 'string'
            ? record.message
            : text.slice(0, 200);
      const reason = typeof record.code === 'string' ? record.code : '';
      const message =
        detail || STATUS_MESSAGES[response.status] || `云端返回了 HTTP ${response.status}。`;
      throw new CloudError(code, message, {
        status: response.status,
        detail: text.slice(0, 500),
        reason,
      });
    } catch (caught) {
      if (caught instanceof CloudError) {
        lastError = caught;
      } else if (caught instanceof DOMException && caught.name === 'AbortError') {
        lastError = new CloudError('timeout', '云端请求超时，请检查网络后重试。', {
          reason: 'TIMEOUT',
        });
      } else if (caught instanceof Error && caught.name === 'AbortError') {
        lastError = new CloudError('timeout', '云端请求超时，请检查网络后重试。', {
          reason: 'TIMEOUT',
        });
      } else {
        lastError = new CloudError('network', '连不上云端服务，请检查网络连接。', {
          reason: 'NETWORK',
          detail: caught instanceof Error ? caught.message : String(caught),
        });
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    if (!lastError || !isRetriable(lastError) || attempt === retries) break;
  }

  throw lastError ?? new CloudError('network', '云端请求失败。', { reason: 'UNKNOWN' });
}

/** 探测服务端能力。失败返回 null，绝不猜测「大概配置好了」。 */
export async function fetchCapabilities(signal?: AbortSignal): Promise<CloudCapabilities | null> {
  try {
    const payload = await cloudRequest<Partial<CloudCapabilities>>('/capabilities', {
      retries: 1,
      timeoutMs: 8_000,
      signal,
    });
    if (!payload || typeof payload !== 'object') return null;
    return {
      version: typeof payload.version === 'number' ? payload.version : 1,
      classify: payload.classify === true,
      abstract: payload.abstract === true,
      image: payload.image === true,
      mail: payload.mail === true,
      aiProvider: typeof payload.aiProvider === 'string' ? payload.aiProvider : '',
      imageProvider: typeof payload.imageProvider === 'string' ? payload.imageProvider : '',
    };
  } catch {
    return null;
  }
}

/**
 * 生成一个可以用在重试场景的稳定 ID（幂等键）。
 * 同一个操作重发时复用同一个 ID，服务端据此识别重复提交。
 */
export function createCloudId(prefix = 'idea'): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return `${prefix}_${cryptoRef.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
