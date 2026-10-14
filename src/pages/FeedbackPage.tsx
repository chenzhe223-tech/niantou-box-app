/**
 * 意见反馈。
 *
 * 三条原则写死在交互里，而不是只写在文案里：
 * 1. 先落本机再发送——点过「提交」就不会丢，没发出去的下次打开应用自动补发；
 * 2. 附带的诊断信息默认**不勾选**，用户主动勾选才会带上，且只有技术参数与数量；
 * 3. 本机留存的反馈内容对用户完全可见，可随时删除。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { paths } from '../app/routes';
import { isTelemetryConfigured } from '../app/telemetryConfig';
import { Button } from '../components/Button';
import { TextArea, TextField } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { collectContext, track } from '../services/analytics';
import {
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_KINDS,
  FEEDBACK_MESSAGE_MAX,
  createFeedback,
  deleteFeedback,
  listFeedback,
  submitFeedback,
  toFeedbackDiagnostics,
  type FeedbackKind,
  type FeedbackRecord,
} from '../services/feedback';

const STATE_LABELS: Record<FeedbackRecord['uploadState'], string> = {
  local: '待发送（保存在本机）',
  sent: '已发送',
  failed: '暂未发送（联网后自动重试）',
};

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function kindLabel(kind: FeedbackKind): string {
  return FEEDBACK_KINDS.find((item) => item.value === kind)?.label ?? '其他';
}

export function FeedbackPage({ navigate }: { navigate: (hash: string) => void }) {
  const { ideas, projects } = useAppData();
  const toast = useToast();

  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<FeedbackRecord[]>([]);

  const countedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setRecords(await listFeedback());
    } catch {
      // 本机数据库不可用时列表留空，不影响填写与提交。
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // StrictMode 下 effect 会跑两次，这里只记一次「打开了反馈页」。
    if (countedRef.current) return;
    countedRef.current = true;
    track('feedback_opened');
  }, []);

  const activeIdeas = ideas.filter((idea) => idea.deletedAt === null).length;
  const activeProjects = projects.filter((project) => project.deletedAt === null).length;

  const handleSubmit = async () => {
    setError(null);
    if (message.trim() === '') {
      setError('请先写下你的想法或遇到的问题。');
      return;
    }

    setSubmitting(true);
    try {
      const record = await createFeedback({
        kind,
        message,
        contact,
        includeDiagnostics,
        diagnostics: includeDiagnostics
          ? toFeedbackDiagnostics(collectContext(), activeIdeas, activeProjects)
          : null,
      });
      const next = await submitFeedback(record);
      await refresh();
      track('feedback_submitted', { kind, result: next.uploadState === 'sent' ? 'ok' : 'error' });

      setMessage('');
      setContact('');
      setIncludeDiagnostics(false);

      if (next.uploadState === 'sent') {
        toast.push({ message: '反馈已发送，谢谢你。', tone: 'success' });
      } else if (!isTelemetryConfigured()) {
        toast.push({
          message: '反馈已保存在这台设备上（当前构建没有配置接收服务）。',
          tone: 'info',
        });
      } else {
        toast.push({
          message: '网络不通，反馈已保存在本机，下次打开会自动重试。',
          tone: 'info',
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '提交失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteFeedback(id);
      await refresh();
      toast.push({ message: '这条反馈已从本机删除。', tone: 'info' });
    } catch {
      toast.push({ message: '删除失败，请稍后重试。', tone: 'error' });
    }
  };

  return (
    <div className="nb-page">
      <div className="nb-backbar">
        <button
          type="button"
          className="nb-backbar__back"
          onClick={() => navigate(paths.settings)}
        >
          <Icon name="back" size={18} />
          返回设置
        </button>
      </div>

      <div className="nb-page__head">
        <h1 className="nb-page__title">意见反馈</h1>
        <p className="nb-page__lead">
          用着不顺手、想要什么功能、哪里出了错，都可以直接写在这里。
        </p>
      </div>

      <section className="nb-section" aria-labelledby="nb-feedback-form">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-feedback-form">
            写下你的反馈
          </h2>
        </div>
        <div className="nb-card nb-card--pad nb-stack">
          <div className="nb-chips" role="group" aria-label="反馈类型">
            {FEEDBACK_KINDS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={item.value === kind ? 'nb-chip nb-chip--active' : 'nb-chip'}
                aria-pressed={item.value === kind}
                onClick={() => setKind(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <TextArea
            label="反馈内容"
            value={message}
            onChange={setMessage}
            rows={6}
            maxLength={FEEDBACK_MESSAGE_MAX}
            placeholder="比如：在手机上编辑长文本时，光标会跳到开头。"
            hint={`${message.length}/${FEEDBACK_MESSAGE_MAX}`}
            error={error}
          />

          <TextField
            label="联系方式（可选）"
            value={contact}
            onChange={setContact}
            placeholder="邮箱或微信，方便我在需要时回复你"
            hint="留空也没关系，反馈一样会被看到。"
            autoComplete="email"
            maxLength={FEEDBACK_CONTACT_MAX}
          />

          <label className="nb-check">
            <input
              className="nb-check__input"
              type="checkbox"
              checked={includeDiagnostics}
              onChange={(event) => setIncludeDiagnostics(event.target.checked)}
            />
            <span className="nb-check__body">
              <span className="nb-check__label">附带诊断信息（可选）</span>
              <span className="nb-check__hint">
                只包含应用版本 {collectContext().app}、平台 {collectContext().platform}、
                界面语言 {collectContext().lang || '未知'}，以及念头 {activeIdeas} 条、项目{' '}
                {activeProjects} 个这类数量信息，
                <strong>不包含任何念头正文、标题或标签</strong>。
              </span>
            </span>
          </label>

          <div className="nb-actionbar">
            <Button
              variant="primary"
              icon="upload"
              disabled={submitting}
              onClick={() => {
                void handleSubmit();
              }}
            >
              {submitting ? '正在提交…' : '提交反馈'}
            </Button>
          </div>

          <p className="nb-kv">
            提交后先保存在这台设备上，再尝试发送；发送失败不会丢，下次打开应用会自动重试。
          </p>
        </div>
      </section>

      {records.length > 0 ? (
        <section className="nb-section" aria-labelledby="nb-feedback-local">
          <div className="nb-section__head">
            <h2 className="nb-section__title" id="nb-feedback-local">
              本机留存的反馈
            </h2>
            <span className="nb-section__count">{records.length} 条</span>
          </div>
          <ul className="nb-list">
            {records.map((record) => (
              <li key={record.id} className="nb-idea">
                <div className="nb-idea__foot">
                  <span className="nb-badge nb-badge--outline">{kindLabel(record.kind)}</span>
                  <span
                    className={
                      record.uploadState === 'sent'
                        ? 'nb-badge nb-badge--done'
                        : 'nb-badge nb-badge--neutral'
                    }
                  >
                    {STATE_LABELS[record.uploadState]}
                  </span>
                  <span className="nb-meta__value">{formatTime(record.createdAt)}</span>
                </div>
                <p className="nb-idea__excerpt">{record.message}</p>
                <div className="nb-idea__actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    onClick={() => {
                      void handleDelete(record.id);
                    }}
                  >
                    从本机删除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="nb-section" aria-labelledby="nb-feedback-privacy">
        <div className="nb-notice">
          <p className="nb-notice__title" id="nb-feedback-privacy">
            这条反馈会去到哪里
          </p>
          <p>
            反馈内容只在你点「提交反馈」之后才离开这台设备，用于改进念头盒；
            不会用于其他用途，也不会与你的念头内容一起被采集。
          </p>
        </div>
      </section>
    </div>
  );
}
