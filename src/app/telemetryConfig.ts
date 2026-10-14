/**
 * 运营统计 / 用户反馈后端的构建时配置。
 *
 * 与官网地址（siteConfig.ts）采用同一套思路：地址不写死在源码里，而是由构建
 * 环境变量注入。因此「换后端」「临时关掉统计」都不需要改任何代码：
 *
 *   VITE_TELEMETRY_ENDPOINT=https://<后端地址>/ingest \
 *   VITE_TELEMETRY_KEY=<只能写入的公开令牌> \
 *   VITE_APP_VERSION=<构建号> pnpm build
 *
 * 重要：这里注入的必须是「只能写入、不能读取」的公开令牌（例如 Supabase 的
 * anon key，或自建 Worker 的写入令牌）。读取运营数据的凭据永远不进前端产物。
 *
 * 没有注入时 getTelemetryConfig() 返回 null，应用不会发出任何网络请求，
 * 设置页也会如实显示「当前构建没有配置统计服务」。
 */

declare global {
  interface ImportMetaEnv {
    readonly VITE_TELEMETRY_ENDPOINT?: string;
    readonly VITE_TELEMETRY_KEY?: string;
    readonly VITE_APP_VERSION?: string;
    readonly VITE_DEV_DASHBOARD?: string;
    readonly VITE_ADMIN_CONSOLE_URL?: string;
  }
}

export interface TelemetryConfig {
  /** 接收事件的接口地址（POST）。 */
  endpoint: string;
  /** 写入令牌；后端不要求令牌时为空字符串。 */
  key: string;
}

/** 只接受 http/https 绝对地址；其余（含伪协议、相对路径）一律视为未配置。 */
function asHttpUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return trimmed;
}

export function getTelemetryConfig(): TelemetryConfig | null {
  const endpoint = asHttpUrl(import.meta.env.VITE_TELEMETRY_ENDPOINT);
  if (!endpoint) return null;

  const rawKey = import.meta.env.VITE_TELEMETRY_KEY;
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  return { endpoint, key };
}

export function isTelemetryConfigured(): boolean {
  return getTelemetryConfig() !== null;
}

/**
 * 开发者看板（`#/dev`）是否对外开放入口。
 *
 * 默认关闭：普通构建里设置页不会出现任何开发者入口，`#/dev` 也只显示一句
 * 「本次构建未开启」。CI 通过仓库变量 `DEV_DASHBOARD=1` 打开。
 *
 * 说明：这个页面只能读到「这台设备上自己的数据」（本机计数、待发送队列、
 * 自己提交的反馈），拿不到其他用户的任何信息——跨用户的运营数据在后台，
 * 需要读取凭据（永不进前端产物）。
 */
export function isDevDashboardEnabled(): boolean {
  const raw = import.meta.env.VITE_DEV_DASHBOARD;
  if (typeof raw !== 'string') return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}

/**
 * 独立运营看板（admin.html）的地址，可选。
 *
 * 这个页面不随应用一起发布：它需要管理员在本地手动输入读取令牌才能查到
 * 全量数据，因此读取凭据永远不进应用产物。
 */
export function getAdminConsoleUrl(): string {
  return asHttpUrl(import.meta.env.VITE_ADMIN_CONSOLE_URL);
}

/**
 * 应用版本号：构建时注入（CI 里用 Git 短 SHA）。
 * 用于区分用户实际运行的是哪一版，而不是靠猜。
 */
export function getAppVersion(): string {
  const raw = import.meta.env.VITE_APP_VERSION;
  if (typeof raw !== 'string') return 'dev';
  const trimmed = raw.trim();
  if (trimmed === '') return 'dev';
  // 注入完整 SHA 时只保留前 7 位，既够区分构建，也不多带无关信息。
  return /^[0-9a-f]{40}$/i.test(trimmed) ? trimmed.slice(0, 7) : trimmed.slice(0, 24);
}
