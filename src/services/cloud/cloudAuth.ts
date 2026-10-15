/**
 * 账户与登录状态。
 *
 * 令牌只保存在本机 localStorage 里，且只用来在请求头里带 `Bearer`；
 * 它不会进 URL、不会进埋点、不会被打印到界面以外的任何地方。
 * 服务端的身份识别完全依赖这个令牌，客户端传的任何 user id 都不被信任。
 */

import { cloudRequest, CloudError, type CloudErrorCode } from './cloudClient';

const TOKEN_KEY = 'nb.cloud.token.v1';
const USER_KEY = 'nb.cloud.user.v1';
const CURSOR_KEY = 'nb.cloud.cursor.v1';

export interface CloudUser {
  id: string;
  email: string;
  displayName: string;
}

export interface CloudDevice {
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface CloudMe {
  user: CloudUser;
  devices: CloudDevice[];
  cursor: number;
  lastSyncAt: number;
  counts: { ideas: number; projects: number };
}

function readLocal(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeLocal(key: string, value: string): void {
  try {
    if (value === '') globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // 隐私模式下 localStorage 可能不可写：登录状态只保留在内存里，不影响本次使用。
  }
}

export function getCloudToken(): string {
  return readLocal(TOKEN_KEY);
}

export function isSignedIn(): boolean {
  return getCloudToken() !== '';
}

function setToken(token: string): void {
  writeLocal(TOKEN_KEY, token);
}

export function getCachedUser(): CloudUser | null {
  const raw = readLocal(USER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CloudUser>;
    if (typeof parsed.id !== 'string' || parsed.id === '') return null;
    return {
      id: parsed.id,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
    };
  } catch {
    return null;
  }
}

function setCachedUser(user: CloudUser | null): void {
  writeLocal(USER_KEY, user ? JSON.stringify(user) : '');
}

/**
 * 上次拉取到的服务端游标。只由「拉取」推进，推送成功不推进游标，
 * 避免把别的设备刚写进来、本机还没看到的那几条记录永久跳过。
 */
export function getLocalCursor(): number {
  const raw = readLocal(CURSOR_KEY);
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function setLocalCursor(cursor: number): void {
  writeLocal(CURSOR_KEY, String(Math.max(0, Math.floor(cursor))));
}

/**
 * 给这台设备起一个人类可读的名字，方便用户在「已登录设备」里认出是谁。
 * 只用于会话标签，不含任何设备指纹。
 */
export function describeDeviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const lower = ua.toLowerCase();
  const platform = detectPlatform(lower);
  const mode = detectDisplayMode();
  if (mode === 'standalone') return `${platform} · 已安装应用`;
  if (mode === 'wechat') return '微信内置浏览器';
  return platform;
}

export function detectPlatform(lowerUserAgent = ''): string {
  const ua = lowerUserAgent || (typeof navigator === 'undefined' ? '' : navigator.userAgent.toLowerCase());
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'iPhone / iPad';
  if (ua.includes('android')) return 'Android 手机';
  if (ua.includes('mac os')) return 'Mac 电脑';
  if (ua.includes('windows')) return 'Windows 电脑';
  if (ua.includes('linux')) return 'Linux 电脑';
  return '未知设备';
}

export type DisplayMode = 'browser' | 'standalone' | 'wechat' | 'mini';

/**
 * 判断当前运行环境。这个结果只用于「怎么保存数据」的提示，
 * 例如微信内置浏览器里下载文件不可用，就要改用长按保存 / 系统分享。
 */
export function detectDisplayMode(): DisplayMode {
  if (typeof navigator === 'undefined') return 'browser';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('micromessenger')) return 'wechat';
  const standalone =
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return 'standalone';
  if (ua.includes('miniprogram') || ua.includes('miniapp')) return 'mini';
  return 'browser';
}

interface AuthResponse {
  token: string;
  user: CloudUser;
  cursor: number;
}

function normalizeUser(raw: unknown): CloudUser {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof record.id === 'string' ? record.id : '',
    email: typeof record.email === 'string' ? record.email : '',
    displayName: typeof record.displayName === 'string' ? record.displayName : '',
  };
}

function adopt(response: AuthResponse): CloudUser {
  if (!response || typeof response.token !== 'string' || response.token === '') {
    throw new CloudError('bad-response', '服务端没有返回登录凭据，请稍后重试。', {
      reason: 'NO_TOKEN',
    });
  }
  const user = normalizeUser(response.user);
  setToken(response.token);
  setCachedUser(user);
  return user;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string;
}

export async function cloudRegister(input: RegisterInput): Promise<CloudUser> {
  const response = await cloudRequest<AuthResponse>('/auth/register', {
    method: 'POST',
    body: {
      email: input.email,
      password: input.password,
      displayName: input.displayName ?? '',
      deviceLabel: describeDeviceLabel(),
    },
    timeoutMs: 25_000,
  });
  return adopt(response);
}

export async function cloudLogin(email: string, password: string): Promise<CloudUser> {
  const response = await cloudRequest<AuthResponse>('/auth/login', {
    method: 'POST',
    body: { email, password, deviceLabel: describeDeviceLabel() },
    timeoutMs: 25_000,
  });
  return adopt(response);
}

/**
 * 退出登录。先本地清干净（保证「退出」这个动作一定生效），
 * 再尽力通知服务端作废这个令牌；通知失败不影响本地退出。
 */
export async function cloudLogout(): Promise<void> {
  const token = getCloudToken();
  clearCloudSession();
  if (!token) return;
  try {
    await cloudRequest('/auth/logout', { method: 'POST', body: {}, token, timeoutMs: 8_000 });
  } catch {
    // 服务端没收到也没关系：令牌在本机已经删掉，而且会自然过期。
  }
}

/** 只清本机登录状态，不碰本地已缓存的数据。 */
export function clearCloudSession(): void {
  setToken('');
  setCachedUser(null);
}

export async function fetchMe(): Promise<CloudMe> {
  const payload = await cloudRequest<CloudMe>('/auth/me', {
    token: getCloudToken(),
    retries: 1,
  });
  const user = normalizeUser(payload?.user);
  if (user.id) setCachedUser(user);
  return {
    user,
    devices: Array.isArray(payload?.devices) ? payload.devices : [],
    cursor: typeof payload?.cursor === 'number' ? payload.cursor : 0,
    lastSyncAt: typeof payload?.lastSyncAt === 'number' ? payload.lastSyncAt : 0,
    counts: {
      ideas: typeof payload?.counts?.ideas === 'number' ? payload.counts.ideas : 0,
      projects: typeof payload?.counts?.projects === 'number' ? payload.counts.projects : 0,
    },
  };
}

/** 登录状态失效时统一走的清理路径（令牌过期 / 被改口令踢下线）。 */
export function handleAuthExpired(): void {
  clearCloudSession();
}

export function isAuthFailure(error: unknown): { failed: boolean; code: CloudErrorCode } {
  if (error instanceof CloudError && error.code === 'unauthorized') {
    return { failed: true, code: error.code };
  }
  return { failed: false, code: 'server' };
}
