/**
 * 官网（介绍页）与应用（本体）之间的对接配置。
 *
 * 两边的约定只有一条：应用在构建时通过环境变量 VITE_OFFICIAL_SITE_URL
 * 拿到官网地址，官网在构建时通过 app-config.js 拿到应用地址。
 *
 *   BASE_PATH=/niantou-box/app/ \
 *   VITE_OFFICIAL_SITE_URL=https://<user>.github.io/niantou-box/ pnpm build
 *
 * 地址不写死在源码里，因此换用户名、换仓库名、把应用单独部署到另一个
 * 仓库都不需要改动任何代码。
 *
 * 没有注入时返回空字符串，设置页就不会渲染任何指向官网的入口，
 * 避免出现「看起来能点、其实是假按钮」的情况。
 */

declare global {
  interface ImportMetaEnv {
    readonly VITE_OFFICIAL_SITE_URL?: string;
  }
}

/**
 * 读取官网地址。
 *
 * 只接受 http/https 绝对地址；相对路径、伪协议（如 javascript:）、空串
 * 一律视为「未配置」，直接返回空字符串。
 */
export function getOfficialSiteUrl(): string {
  const raw = import.meta.env.VITE_OFFICIAL_SITE_URL;
  if (typeof raw !== 'string') return '';

  const trimmed = raw.trim();
  if (trimmed === '') return '';

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }

  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}