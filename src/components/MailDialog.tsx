/**
 * 把念头发出去的弹层。
 *
 * 两条路线，界面必须让人一眼分得清：
 * - 服务端已配置邮件服务 → 由服务端发送，成功后如实提示「已发出」；
 * - 未配置 → 只做 `mailto:` 预填，按钮文案是「打开邮件应用」，
 *   并明确写出「这不是已发送」。
 */

import { useEffect, useMemo, useState } from 'react';
import { displayTitle, type Idea } from '../types/idea';
import type { CloudCapabilities } from '../services/cloud/cloudClient';
import {
  buildMailDraft,
  isMailtoTooLong,
  mailtoHref,
  sendMail,
  type MailDraft,
} from '../services/mail';
import { track } from '../services/analytics';
import { describeCloudError } from '../services/cloud/cloudClient';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { TextArea, TextField } from './Fields';
import { useToast } from './Toast';

export interface MailDialogProps {
  open: boolean;
  ideas: Idea[];
  capabilities: CloudCapabilities;
  onClose: () => void;
}

export function MailDialog({ open, ideas, capabilities, onClose }: MailDialogProps) {
  const toast = useToast();
  const [draft, setDraft] = useState<MailDraft>({ to: '', subject: '', body: '' });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = useMemo(() => buildMailDraft(ideas), [ideas]);

  useEffect(() => {
    if (!open) return;
    setDraft(initial);
    setError(null);
  }, [open, initial]);

  const mailto = useMemo(() => mailtoHref(draft), [draft]);
  const tooLong = isMailtoTooLong(draft);

  const handleServerSend = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await sendMail(draft, capabilities);
      if (result.sent) {
        track('mail_handoff', { source: 'inbox', channel: 'server', result: 'ok' });
        toast.push({ message: '邮件已由服务端发出。', tone: 'success' });
        onClose();
        return;
      }
      track('mail_handoff', { source: 'inbox', channel: 'mailto', result: 'cancelled' });
      setError(result.message);
    } catch (caught) {
      track('mail_handoff', { source: 'inbox', channel: 'server', result: 'error' });
      setError(`发送失败：${describeCloudError(caught)}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      open={open}
      size="lg"
      title={ideas.length > 1 ? `把这 ${ideas.length} 条念头发出去` : '把这条念头发出去'}
      lead={
        capabilities.mail
          ? '服务端已配置邮件服务：确认内容后可以直接发送。'
          : '服务端还没有配置邮件服务。这里会帮你把主题和正文预填到自己的邮件应用里，最终由你确认发送。'
      }
      onClose={onClose}
      dismissOnBackdrop={!sending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            取消
          </Button>
          {capabilities.mail ? (
            <Button variant="primary" icon="external" disabled={sending} onClick={() => void handleServerSend()}>
              {sending ? '正在发送…' : '由服务端发送'}
            </Button>
          ) : (
            <a
              className="nb-btn nb-btn--primary"
              href={mailto}
              onClick={() => {
                track('mail_handoff', { source: 'inbox', channel: 'mailto', result: 'ok' });
                toast.push({
                  message: '已把内容交给你的邮件应用，请在那边确认并发送。',
                  tone: 'info',
                });
              }}
            >
              打开邮件应用
            </a>
          )}
        </>
      }
    >
      <div className="nb-stack nb-stack--tight">
        <p className="nb-kv">
          本次包含：
          {ideas.length === 1 ? displayTitle(ideas[0]) : `共 ${ideas.length} 条念头`}
        </p>

        <TextField
          label="收件人（可留空，在邮件应用里填写）"
          type="text"
          inputMode="email"
          value={draft.to}
          onChange={(value) => setDraft((previous) => ({ ...previous, to: value }))}
          placeholder="name@example.com"
        />

        <TextField
          label="主题"
          value={draft.subject}
          onChange={(value) => setDraft((previous) => ({ ...previous, subject: value }))}
        />

        <TextArea
          label="正文（可修改）"
          rows={10}
          value={draft.body}
          onChange={(value) => setDraft((previous) => ({ ...previous, body: value }))}
          hint="正文使用你保存的原始内容，只自动补上了编号与分类、状态这类信息。"
        />

        {tooLong && !capabilities.mail ? (
          <p className="nb-notice nb-notice--warn">
            内容比较长，部分系统的邮件应用可能截断预填内容（建议选少几条第，或改用服务端邮件服务）。
          </p>
        ) : null}

        {error ? (
          <p className="nb-notice nb-notice--warn" role="status">
            {error}
          </p>
        ) : null}

        <p className="nb-kv">
          {capabilities.mail
            ? '只有服务端返回「已发送」才算发出去了；失败时会如实告诉你，不会把失败说成成功。'
            : '这里不会替你发送，也不会假装发送成功——预填之后，发送与否由你在邮件应用里决定。'}
        </p>
      </div>
    </Dialog>
  );
}
