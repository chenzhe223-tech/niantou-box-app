/**
 * 把念头整理成一封邮件。
 *
 * 诚实原则（这一条不能含糊）：
 * - 服务端没有配置邮件服务时，本模块只生成 `mailto:` 链接，把内容预填到
 *   用户自己的邮件应用里。**这不是「已发送」**，界面必须说清楚，并把最终
 *   的发送决定权交给用户。
 * - 只有服务端真的返回 sent:true 才会被当成发送成功。
 * - 发信永不自动重试：重复发送一封邮件比失败更糟。
 */

import { displayTitle, statusLabel, type Idea } from '../types/idea';
import { cloudRequest } from './cloud/cloudClient';
import { getCloudToken } from './cloud/cloudAuth';

export interface MailDraft {
  to: string;
  subject: string;
  body: string;
}

export interface MailSendResult {
  /** 服务端是否真的发出去了。mailto 兜底永远是 false。 */
  sent: boolean;
  /** 服务端是否配置了邮件服务。 */
  configured: boolean;
  /** 用的是哪条通道：服务端发送，还是预填到本机邮件应用。 */
  channel: 'server' | 'mailto';
  message: string;
  id?: string;
}

function formatTime(value: number): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

/**
 * 自动整理主题与正文。
 *
 * 正文使用用户保存的原始内容，不做摘要、不改写；只有编号与元信息是自动加的。
 * 单条时主题直接取念头标题，多条时给出条数，方便在邮件列表里一眼认出来。
 */
export function buildMailDraft(
  ideas: readonly Idea[],
  options: { to?: string; subject?: string } = {},
): MailDraft {
  const list = [...ideas];
  const subject =
    options.subject && options.subject.trim() !== ''
      ? options.subject
      : list.length === 1
        ? `念头盒：${displayTitle(list[0])}`
        : `念头盒：整理好的 ${list.length} 条念头`;

  const blocks = list.map((idea, index) => {
    const lines: string[] = [];
    if (list.length > 1) lines.push(`【${index + 1}】${displayTitle(idea)}`);
    lines.push(idea.content.trim());
    const meta: string[] = [];
    if (idea.category) meta.push(`分类：${idea.category}`);
    meta.push(`状态：${statusLabel(idea.status)}`);
    if (idea.tags.length > 0) meta.push(`标签：${idea.tags.join('、')}`);
    meta.push(`记录时间：${formatTime(idea.createdAt)}`);
    if (idea.notes.trim()) meta.push(`备注：${idea.notes.trim()}`);
    if (idea.problem.trim()) meta.push(`要解决的问题：${idea.problem.trim()}`);
    if (idea.targetUsers.trim()) meta.push(`目标用户：${idea.targetUsers.trim()}`);
    if (idea.projectUrl.trim()) meta.push(`项目链接：${idea.projectUrl.trim()}`);
    lines.push('', meta.join('\n'));
    return lines.join('\n');
  });

  const body = [
    `来自念头盒的 ${list.length} 条念头：`,
    '',
    blocks.join('\n\n――――――\n\n'),
    '',
    '—— 由念头盒 NianBox 整理',
  ].join('\n');

  return { to: options.to ?? '', subject, body };
}

/**
 * 生成 `mailto:` 链接。
 *
 * 提醒：不同系统对 mailto 总长度有上限（常见 2000 字符左右），
 * 因此界面在「条数较多的批量发送」时会提示改用服务端邮件服务。
 */
export function mailtoHref(draft: MailDraft): string {
  const query: string[] = [];
  if (draft.subject) query.push(`subject=${encodeURIComponent(draft.subject)}`);
  if (draft.body) query.push(`body=${encodeURIComponent(draft.body)}`);
  const suffix = query.length > 0 ? `?${query.join('&')}` : '';
  return `mailto:${encodeURIComponent(draft.to.trim())}${suffix}`;
}

/** mailto 链接的安全长度：超过这个长度就提醒用户内容可能被系统截断。 */
export const MAILTO_SAFE_LENGTH = 1800;

export function isMailtoTooLong(draft: MailDraft): boolean {
  return mailtoHref(draft).length > MAILTO_SAFE_LENGTH;
}

/**
 * 交给服务端发送。
 *
 * 未配置邮件服务时**不会**发起请求，直接返回 configured:false，
 * 由界面改成 mailto 预填——绝不把「预填」说成「已发送」。
 */
export async function sendMail(
  draft: MailDraft,
  capabilities: { mail: boolean },
): Promise<MailSendResult> {
  if (!capabilities.mail) {
    return {
      sent: false,
      configured: false,
      channel: 'mailto',
      message: '服务端还没有配置邮件服务。内容已预填到你的邮件应用，请在那里确认后发送。',
    };
  }

  const response = await cloudRequest<{ configured?: boolean; sent?: boolean; id?: string; message?: string }>(
    '/mail/send',
    {
      method: 'POST',
      token: getCloudToken(),
      body: { to: draft.to, subject: draft.subject, text: draft.body },
      // 发信永不重试：宁可让用户手动再点一次，也不能重复发出。
      retries: 0,
      timeoutMs: 30_000,
    },
  );

  if (response?.sent === true) {
    return {
      sent: true,
      configured: true,
      channel: 'server',
      message: '邮件已经由服务端发出。',
      id: response.id,
    };
  }

  // 服务端在运行期发现没配好（配置被清掉 / 上游拒绝）：如实说，不假装成功。
  return {
    sent: false,
    configured: response?.configured === true,
    channel: 'mailto',
    message: response?.message ?? '邮件没有发出，请改用你的邮件应用发送。',
  };
}
