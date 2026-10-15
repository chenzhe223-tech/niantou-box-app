/**
 * 官网快速记录的接力棒。
 *
 * 官网（`.../niantou-box/`）和正式应用（`.../niantou-box-app/`）在 GitHub Pages 上
 * 属于同一个 origin（协议 + 域名 + 端口一致，路径不参与判定），因此两边共用同一份
 * localStorage。官网在「还没登录」时收下的那句话，会先原样放在这里，等用户在应用里
 * 登录完成后由应用补交到云端收件箱 —— 用户不会因为「先去登录」而丢掉刚写下的东西。
 *
 * 诚实原则（和同步层一致）：只有服务端明确回了成功才清掉本机草稿；
 * 提交失败、没登录、没配置云端地址，原文都留在原地，并如实告诉调用方原因。
 */

import { cloudRequest, describeCloudError } from './cloudClient';
import { isCloudConfigured } from './cloudConfig';
import { getCloudToken, isSignedIn } from './cloudAuth';

/** 官网写入、应用读取的草稿键。两边必须保持一致的字面量。 */
export const SITE_DRAFT_KEY = 'nb.site.pending-capture.v1';

export interface SiteDraft {
  /** 幂等键：网络超时后重试不会在收件箱里多出一条重复的念头。 */
  id: string;
  content: string;
  createdAt: number;
}

export type SiteDeliveryStatus = 'none' | 'sent' | 'signed-out' | 'not-configured' | 'failed';

export interface SiteDelivery {
  status: SiteDeliveryStatus;
  /** 交给云端的那句话（原文）。失败时调用方可以据此展示「还留着什么」。 */
  content?: string;
  /** 给用户看的一句话说明，失败原因直接来自服务端或网络层。 */
  message: string;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // 隐私模式下访问 localStorage 可能直接抛错：当作没有草稿处理。
    return null;
  }
}

/** 读出官网留下的草稿；没有或是坏数据都返回 null（坏数据顺手清掉，避免反复报错）。 */
export function readSiteDraft(): SiteDraft | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(SITE_DRAFT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SiteDraft> | null;
    const content = typeof parsed?.content === 'string' ? parsed.content.trim() : '';
    if (!content) {
      store.removeItem(SITE_DRAFT_KEY);
      return null;
    }
    const id = typeof parsed?.id === 'string' && parsed.id.trim() !== '' ? parsed.id.trim() : '';
    return {
      id: id || `idea_site_${Date.now().toString(36)}`,
      content,
      createdAt: typeof parsed?.createdAt === 'number' ? parsed.createdAt : Date.now(),
    };
  } catch {
    store.removeItem(SITE_DRAFT_KEY);
    return null;
  }
}

/** 清掉草稿。只在服务端确认收到之后调用。 */
export function clearSiteDraft(): void {
  storage()?.removeItem(SITE_DRAFT_KEY);
}

/**
 * 把官网留下的草稿交到云端收件箱。
 *
 * 调用时机：登录成功后，以及应用每次启动且已登录时（弱网下失败的会顺带重试）。
 * 返回结构里没有任何「假装成功」的分支：只有服务端回 `ok: true` 才是 `sent`。
 */
export async function deliverSiteDraft(): Promise<SiteDelivery> {
  const draft = readSiteDraft();
  if (!draft) return { status: 'none', message: '' };

  if (!isCloudConfigured()) {
    return {
      status: 'not-configured',
      content: draft.content,
      message: '这个版本没有配置云端地址，官网写下的话先留在这台设备上。',
    };
  }
  if (!isSignedIn()) {
    return {
      status: 'signed-out',
      content: draft.content,
      message: '还没有登录云端账号，官网写下的话先留在这台设备上。',
    };
  }

  try {
    const result = await cloudRequest<{ ok?: boolean; duplicate?: boolean } | null>('/capture', {
      method: 'POST',
      // 服务端只用 content（原文）和 id（幂等键），source 仅用于区分入口。
      body: { content: draft.content, source: 'website', id: draft.id },
      token: getCloudToken(),
      timeoutMs: 15_000,
      retries: 2,
    });
    if (!result || result.ok !== true) {
      // 只有 2xx 才会走到这里；但返回体没有明确 ok 时仍然不算成功，草稿继续留着。
      return {
        status: 'failed',
        content: draft.content,
        message: '服务端没有确认接收这句话，原文还留在这台设备上。',
      };
    }
    clearSiteDraft();
    return {
      status: 'sent',
      content: draft.content,
      message: '官网里写下的那句话，已经收进你的收件箱了。',
    };
  } catch (error) {
    // 原文照旧留在本机，下次启动会再试一次。
    return { status: 'failed', content: draft.content, message: describeCloudError(error) };
  }
}

