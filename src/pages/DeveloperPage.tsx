/**
 * 开发者看板（`#/dev`）。
 *
 * 边界说明（很关键，页面上也会如实写出来）：
 * - 这一页读到的**只有这台设备自己的数据**：本机计数、待发送队列、自己提交的
 *   反馈。它拿不到其他用户的任何信息。
 * - 跨用户的运营数据存在后端，读取需要凭据；凭据永不进前端产物，
 *   所以通过独立的运营看板（admin.html）读，或在后端控制台里看。
 *
 * 入口默认关闭，由构建时变量 VITE_DEV_DASHBOARD=1 打开（CI 用仓库变量注入）。
 */

import { useCallback, useEffect, useState } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { paths } from '../app/routes';
import { getAdminConsoleUrl, isDevDashboardEnabled } from '../app/telemetryConfig';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import {
  clearLocalUsageSummary,
  clearTelemetryQueue,
  getLocalUsageSummary,
  getTelemetryStatus,
  resetInstallId,
  setTelemetryEnabled,
  type TelemetryStatus,
  type UsageSummary,
} from '../services/analytics';
import {
  clearFeedback,
  listFeedback,
  type FeedbackRecord,
} from '../services/feedback';
import { downloadTextFile } from '../services/fileTransfer';

/** 事件名到中文的对照，只为了看得懂，不影响采集内容。 */
const EVENT_LABELS: Record<string, string> = {
  app_open: '打开应用',
  idea_created: '记下念头',
  idea_updated: '编辑念头',
  idea_status_changed: '念头状态变更',
  idea_pinned: '置顶 / 取消置顶',
  idea_deleted: '移到回收站',
  idea_restored: '从回收站恢复',
  idea_purged: '永久删除',
  idea_upgraded: '升级为创意项目',
  project_updated: '更新项目',
  search_used: '使用搜索',
  backup_exported: '导出备份',
  backup_imported: '导入备份',
  data_cleared: '清空本机数据',
  feedback_opened: '打开反馈页',
  feedback_submitted: '提交反馈',
  telemetry_changed: '切换匿名统计开关',
};

const EMPTY_SUMMARY: UsageSummary = {
  days: {},
  totals: {},
  activeDays: 0,
  firstDay: null,
  lastDay: null,
  recentDays: [],
};

function eventLabel(name: string): string {
  return EVENT_LABELS[name] ?? name;
}

function formatDay(day: string): string {
  // 只显示 MM-DD，窄屏也放得下。
  return day.slice(5);
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  return `${value} 条`;
}

export function DeveloperPage({ navigate }: { navigate: (hash: string) => void }) {
  const { ideas, projects, reload } = useAppData();
  const toast = useToast();
  const enabled = isDevDashboardEnabled();
  const adminConsoleUrl = getAdminConsoleUrl();

  const [summary, setSummary] = useState<UsageSummary>(EMPTY_SUMMARY);
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [records, setRecords] = useState<FeedbackRecord[]>([]);

  const refresh = useCallback(async () => {
    setSummary(getLocalUsageSummary());
    setStatus(getTelemetryStatus());
    try {
      setRecords(await listFeedback());
    } catch {
      setRecords([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeIdeas = ideas.filter((idea) => idea.deletedAt === null);
  const activeProjects = projects.filter((project) => project.deletedAt === null);

  const totalEvents = Object.values(summary.totals).reduce((sum, value) => sum + value, 0);
  const maxDay = Math.max(1, ...summary.recentDays.map((item) => item.total));
  const orderedTotals = Object.entries(summary.totals).sort((a, b) => b[1] - a[1]);

  const handleExportDiagnostics = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      scope: 'this-device-only',
      appVersion: status?.appVersion ?? 'dev',
      installId: status?.installId ?? '',
      telemetry: status
        ? {
            configured: status.configured,
            enabled: status.enabled,
            queuedEvents: status.queuedEvents,
          }
        : null,
      counts: {
        ideas: activeIdeas.length,
        projects: activeProjects.length,
        pinned: activeIdeas.filter((idea) => idea.pinned).length,
      },
      usage: summary,
      feedback: records,
      note: '本文件只包含这台设备上的统计数据与你自己提交的反馈，不含任何念头正文。',
    };
    downloadTextFile(
      `nianbox-dev-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
    );
    toast.push({ message: '诊断数据已导出。', tone: 'success' });
  };

  const handleClearFeedback = async () => {
    try {
      await clearFeedback();
      await refresh();
      toast.push({ message: '本机反馈记录已清空。', tone: 'info' });
    } catch {
      toast.push({ message: '清空失败，请稍后重试。', tone: 'error' });
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
        <h1 className="nb-page__title">开发者看板</h1>
        <p className="nb-page__lead">
          这里显示的是<strong>这台设备</strong>上的使用情况与你自己提交的反馈；
          其他用户的汇总数据在后端，需要读取凭据才能查看。
        </p>
      </div>

      {!enabled ? (
        <div className="nb-notice nb-notice--warn">
          <p className="nb-notice__title">本次构建没有开启开发者看板</p>
          <p>
            构建时注入 <code className="nb-code">VITE_DEV_DASHBOARD=1</code> 后即可查看。
            当前页只显示本机数据，打开与否都不会把设备上的内容暴露给其他人。
          </p>
        </div>
      ) : null}

      {enabled ? (
        <>
          <section className="nb-section" aria-labelledby="nb-dev-state">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-dev-state">
                采集状态
              </h2>
              <span className="nb-section__hint">仅本机</span>
            </div>
            <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
              <p className="nb-kv">
                接收服务：{status?.configured ? '已配置，事件会批量上报' : '未配置，完全不会联网'}
                {' · '}
                用户开关：
                {status?.enabled ? '已开启匿名统计' : '已关闭'}
                {' · '}
                待发送队列：{formatBytes(status?.queuedEvents ?? 0)}
              </p>
              <p className="nb-kv">
                应用版本：<code className="nb-code">{status?.appVersion ?? 'dev'}</code>
                {' · '}
                设备标识：<code className="nb-code">{status?.installId ?? ''}</code>
              </p>
              <p className="nb-kv">
                采集内容只有事件名与枚举参数（来源、状态、进度、数量档位），
                <strong>不含念头正文、标题、标签或链接</strong>。
              </p>
              <div className="nb-actionbar">
                <Button
                  size="sm"
                  variant="secondary"
                  icon="refresh"
                  onClick={() => {
                    resetInstallId();
                    void refresh();
                    toast.push({ message: '设备标识已重置，之后的数据无法与之前关联。', tone: 'info' });
                  }}
                >
                  重置设备标识
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  onClick={() => {
                    clearTelemetryQueue();
                    void refresh();
                    toast.push({ message: '待发送队列已清空。', tone: 'info' });
                  }}
                >
                  清空待发送队列
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTelemetryEnabled(!(status?.enabled ?? true));
                    void refresh();
                  }}
                >
                  {status?.enabled ? '关闭匿名统计' : '开启匿名统计'}
                </Button>
              </div>
            </div>
          </section>

          <section className="nb-section" aria-labelledby="nb-dev-usage">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-dev-usage">
                本机使用情况
              </h2>
              <span className="nb-section__hint">最近 14 天</span>
            </div>
            <div className="nb-stat-grid">
              <div className="nb-stat">
                <span className="nb-stat__value">{summary.activeDays}</span>
                <span className="nb-stat__label">有记录的天数</span>
              </div>
              <div className="nb-stat">
                <span className="nb-stat__value">{totalEvents}</span>
                <span className="nb-stat__label">累计事件</span>
              </div>
              <div className="nb-stat">
                <span className="nb-stat__value">{activeIdeas.length}</span>
                <span className="nb-stat__label">现有念头</span>
              </div>
              <div className="nb-stat">
                <span className="nb-stat__value">{activeProjects.length}</span>
                <span className="nb-stat__label">现有项目</span>
              </div>
            </div>

            <div className="nb-bars" role="img" aria-label="最近 14 天的使用活跃度">
              {summary.recentDays.map((item) => (
                <span className="nb-bars__item" key={item.day}>
                  <span className="nb-bars__count">{item.total > 0 ? item.total : ''}</span>
                  <span className="nb-bars__track">
                    <span
                      className="nb-bars__fill"
                      style={{ height: `${Math.round((item.total / maxDay) * 100)}%` }}
                    />
                  </span>
                  <span className="nb-bars__day">{formatDay(item.day)}</span>
                </span>
              ))}
            </div>
            <p className="nb-kv">
              {summary.firstDay
                ? `第一次记录：${summary.firstDay} · 最近一次：${summary.lastDay}`
                : '这台设备上还没有任何统计数据。'}
            </p>
          </section>

          <section className="nb-section" aria-labelledby="nb-dev-events">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-dev-events">
                事件明细
              </h2>
              <span className="nb-section__hint">累计次数（降序）</span>
            </div>
            {orderedTotals.length === 0 ? (
              <div className="nb-notice">
                <p>还没有事件。用一会儿应用再回来看。</p>
              </div>
            ) : (
              <ul className="nb-kvlist">
                {orderedTotals.map(([name, count]) => (
                  <li key={name} className="nb-kvlist__row">
                    <span>{eventLabel(name)}</span>
                    <span className="nb-kvlist__value">{count}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="nb-actionbar">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  clearLocalUsageSummary();
                  void refresh();
                  toast.push({ message: '本机统计数据已清空。', tone: 'info' });
                }}
              >
                清空本机统计
              </Button>
            </div>
          </section>

          <section className="nb-section" aria-labelledby="nb-dev-feedback">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-dev-feedback">
                本机反馈记录
              </h2>
              <span className="nb-section__count">{records.length} 条</span>
            </div>
            {records.length === 0 ? (
              <div className="nb-notice">
                <p>还没有反馈。反馈入口在设置页的「意见反馈」。</p>
              </div>
            ) : (
              <ul className="nb-list">
                {records.map((record) => (
                  <li key={record.id} className="nb-idea">
                    <div className="nb-idea__foot">
                      <span className="nb-badge nb-badge--outline">{record.kind}</span>
                      <span className="nb-badge nb-badge--neutral">{record.uploadState}</span>
                      <span className="nb-meta__value">{formatTime(record.createdAt)}</span>
                    </div>
                    <p className="nb-idea__excerpt">{record.message}</p>
                    {record.contact ? (
                      <p className="nb-kv">联系方式：{record.contact}</p>
                    ) : null}
                    {record.diagnostics ? (
                      <p className="nb-kv">
                        诊断：{record.diagnostics.app} / {record.diagnostics.platform} /{' '}
                        {record.diagnostics.lang || '未知语言'} / 念头{' '}
                        {record.diagnostics.ideas} 条
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="nb-actionbar">
              <Button size="sm" variant="secondary" icon="download" onClick={handleExportDiagnostics}>
                导出诊断数据
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                disabled={records.length === 0}
                onClick={() => {
                  void handleClearFeedback();
                }}
              >
                清空本机反馈
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate(paths.feedback)}>
                打开反馈页
              </Button>
            </div>
          </section>
        </>
      ) : null}

      <section className="nb-section" aria-labelledby="nb-dev-backend">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-dev-backend">
            其他用户的运营数据
          </h2>
        </div>
        <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
          <p className="nb-kv">
            跨用户的汇总（活跃设备、留存、功能使用分布、反馈列表）保存在你自己的后端里。
            应用只带「只能写入」的令牌，读取凭据不在前端产物中，因此别人拿到网址也读不到数据。
          </p>
          <p className="nb-kv">
            读取方式：用独立的运营看板（<code className="nb-code">admin.html</code>）输入读取令牌，
            或直接在后端控制台里查表。接入步骤见交付文档《运营数据与用户反馈-接入指南》。
          </p>
          {adminConsoleUrl ? (
            <div className="nb-actionbar">
              <a className="nb-btn nb-btn--secondary nb-btn--sm" href={adminConsoleUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={16} />
                <span>打开运营看板</span>
              </a>
            </div>
          ) : null}
        </div>
      </section>

      <section className="nb-section" aria-labelledby="nb-dev-reload">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-dev-reload">
            维护
          </h2>
        </div>
        <div className="nb-actionbar">
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={() => {
              void reload();
              void refresh();
            }}
          >
            刷新数据
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate(paths.settings)}>
            回到设置
          </Button>
        </div>
      </section>
    </div>
  );
}
