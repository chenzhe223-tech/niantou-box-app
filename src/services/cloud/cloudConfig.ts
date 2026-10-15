/**
 * 云端同步的构建时配置。
 *
 * 与 telemetryConfig.ts 同一套思路：服务地址不写死在源码里，由构建环境注入。
 *
 *   VITE_CLOUD_ENDPOINT=https://nianbox-cloud.<account>.workers.dev pnpm build
 *
 * 没有注入时 getCloudEndpoint() 返回空字符串，整个同步层不会发出任何网络请求，
 * 界面会如实显示「本次构建未配置云端同步」。这样本地功能永远可用，
 * 不会因为云端没配好而白屏或报错。
 */

declare global {
  interface ImportMetaEnv {
    readonly VITE_CLOUD_ENDPOINT?: string;
  }
}

/**
 * 只接受 http/https 绝对地址，并去掉结尾斜杠。
 * 其余（相对路径、伪协议、空值）一律视为未配置。
 */
export function normalizeCloudEndpoint(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return trimmed.replace(/\/+$/, '');
}

export function getCloudEndpoint(): string {
  return normalizeCloudEndpoint(import.meta.env.VITE_CLOUD_ENDPOINT);
}

export function isCloudConfigured(): boolean {
  return getCloudEndpoint() !== '';
}

/** 给界面用的一句话说明，避免把「没配置」说成「同步失败」。 */
export function describeCloudConfig(): string {
  const endpoint = getCloudEndpoint();
  if (!endpoint) return '本次构建没有配置云端同步地址，数据只保存在这台设备上。';
  return endpoint;
}
