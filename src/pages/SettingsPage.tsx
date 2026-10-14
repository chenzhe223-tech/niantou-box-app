/**
 * 设置：本地存储说明、数据导出、数据导入、清空全部数据，
 * 以及「意见反馈」入口与「匿名使用统计」开关。
 *
 * 隐私边界（必须与代码实际行为一致，不允许写成更宽松的说法）：
 * - 念头与项目的正文永远只在这台设备的当前浏览器里读写，不上传；
 * - 匿名使用统计只上报事件名与枚举参数（来源、状态、进度、数量档位），
 *   不含任何内容字段，可一键关闭，关闭即停止上报并清空待发送队列；
 * - 意见反馈只有用户亲手点「提交反馈」之后才离开设备。
 */

import { useMemo, useState } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { paths } from '../app/routes';
import { getOfficialSiteUrl } from '../app/siteConfig';
import { isDevDashboardEnabled, isTelemetryConfigured } from '../app/telemetryConfig';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SelectField } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import {
  getTelemetryStatus,
  resetInstallId,
  setTelemetryEnabled,
  track,
  type TelemetryStatus,
} from '../services/analytics';
import {
  importBackup,
  describeReport,
  parseBackup,
  type DuplicateStrategy,
  type ValidationResult,
} from '../services/backup';
import { downloadBackup, pickJsonFile } from '../services/fileTransfer';
import { clearAllData, toNianBoxError } from '../services/storage';

const STRATEGY_OPTIONS: ReadonlyArray<{ value: DuplicateStrategy; label: string }> = [
  { value: 'skip', label: '保留现有数据，跳过相同 ID（推荐）' },
  { value: 'overwrite', label: '用备份中的记录覆盖相同 ID' },
  { value: 'duplicate', label: '把相同 ID 的记录作为新记录导入' },
];

interface ImportSession {
  fileName: string;
  validation: ValidationResult;
}

function formatExportedAt(value: string | undefined): string {
  if (!value) return '未知';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed));
}

export function SettingsPage({ navigate }: { navigate: (hash: string) => void }) {
  const { ideas, projects, reload } = useAppData();
  const toast = useToast();
  // 构建时注入；没有配置时为空字符串，下面的「关于念头盒」区块不会渲染。
  const officialSiteUrl = getOfficialSiteUrl();
  // 构建时注入；默认关闭，普通用户看不到任何开发者入口。
  const devDashboardEnabled = isDevDashboardEnabled();
  const telemetryConfigured = isTelemetryConfigured();

  const [exporting, setExporting] = useState(false);
  const [importSession, setImportSession] = useState<ImportSession | null>(null);
  const [strategy, setStrategy] = useState<DuplicateStrategy>('skip');
  const [importing, setImporting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryStatus>(() => getTelemetryStatus());

  const toggleTelemetry = (next: boolean) => {
    setTelemetryEnabled(next);
    setTelemetry(getTelemetryStatus());
    toast.push({
      message: next
        ? '已开启匿名使用统计，谢谢你帮忙改进念头盒。'
        : '已关闭匿名使用统计，待发送的事件已清空。',
      tone: 'info',
    });
  };

  const counts = useMemo(() => {
    const activeIdeas = ideas.filter((idea) => idea.deletedAt === null);
    const activeProjects = projects.filter((project) => project.deletedAt === null);
    return {
      ideas: activeIdeas.length,
      projects: activeProjects.length,
      deleted: ideas.length - activeIdeas.length + (projects.length - activeProjects.length),
      pinned: activeIdeas.filter((idea) => idea.pinned).length,
    };
  }, [ideas, projects]);

  const backup = importSession?.validation.backup ?? null;

  /** 备份中与现有数据 ID 相同的记录数（用于导入前的冲突提示）。 */
  const conflicts = useMemo(() => {
    if (!backup) return { ideas: 0, projects: 0 };
    const ideaIds = new Set(ideas.map((idea) => idea.id));
    const projectIds = new Set(projects.map((project) => project.id));
    return {
      ideas: backup.ideas.filter((idea) => ideaIds.has(idea.id)).length,
      projects: backup.projects.filter((project) => projectIds.has(project.id)).length,
    };
  }, [backup, ideas, projects]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await downloadBackup();
      track('backup_exported');
      toast.push({
        message: `已导出 ${result.filename}（包含 ${result.ideaCount} 条念头、${result.projectCount} 个项目）。`,
        tone: 'success',
      });
    } catch (caught) {
      toast.push({ message: `导出失败：${toNianBoxError(caught).message}`, tone: 'error' });
    } finally {
      setExporting(false);
    }
  };

  const handlePick = async () => {
    setErrors([]);
    try {
      const picked = await pickJsonFile();
      if (!picked) return;
      const validation = parseBackup(picked.text);
      if (!validation.ok || !validation.backup) {
        setErrors(validation.errors);
        toast.push({ message: '导入已取消：备份文件校验未通过。', tone: 'error' });
        return;
      }
      if (validation.backup.ideas.length === 0 && validation.backup.projects.length === 0) {
        toast.push({ message: '这个备份文件里没有可导入的记录。', tone: 'info' });
        return;
      }
      setStrategy('skip');
      setImportSession({ fileName: picked.name, validation });
    } catch (caught) {
      const message = toNianBoxError(caught).message;
      setErrors([message]);
      toast.push({ message: `读取文件失败：${message}`, tone: 'error' });
    }
  };

  const confirmImport = async () => {
    if (!importSession?.validation.backup) return;
    setImporting(true);
    try {
      const report = await importBackup(importSession.validation.backup, {
        duplicateStrategy: strategy,
      });
      await reload();
      setImportSession(null);
      track('backup_imported');
      toast.push({
        message: report.warnings.length > 0 ? `${describeReport(report)}存在警告，请在下方查看。` : describeReport(report),
        tone: 'success',
      });
      setErrors(report.warnings);
    } catch (caught) {
      const message = toNianBoxError(caught).message;
      setErrors(message.split('\n'));
      toast.push({ message: `导入失败：${message}`, tone: 'error' });
    } finally {
      setImporting(false);
    }
  };

  const confirmClearAll = async () => {
    setClearing(true);
    try {
      await clearAllData();
      await reload();
      setConfirmClear(false);
      // 清空念头是重要的产品信号，如实记一笔（匿名统计与本机念头分开存储，互不影响）。
      track('data_cleared');
      setTelemetry(getTelemetryStatus());
      toast.push({ message: '本地数据已清空。', tone: 'info' });
    } catch (caught) {
      toast.push({ message: `清空失败：${toNianBoxError(caught).message}`, tone: 'error' });
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="nb-page">
      <div className="nb-page__head">
        <h1 className="nb-page__title">设置与数据</h1>
        <p className="nb-page__lead">数据保存在本机浏览器，随时可以导出备份。</p>
      </div>

      <div className="nb-notice">
        <p className="nb-notice__title">本地存储说明</p>
        <p>
          当前版本采用本地存储，记录保存在这台设备的当前浏览器中。清理浏览器数据或更换设备前，请先导出备份。
        </p>
      </div>

      <section className="nb-section" aria-labelledby="nb-settings-storage">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-settings-storage">
            当前数据
          </h2>
          <span className="nb-section__hint">仅统计本机数据</span>
        </div>
        <div className="nb-stat-grid">
          <div className="nb-stat">
            <span className="nb-stat__value">{counts.ideas}</span>
            <span className="nb-stat__label">念头</span>
          </div>
          <div className="nb-stat">
            <span className="nb-stat__value">{counts.projects}</span>
            <span className="nb-stat__label">创意项目</span>
          </div>
          <div className="nb-stat">
            <span className="nb-stat__value">{counts.pinned}</span>
            <span className="nb-stat__label">置顶念头</span>
          </div>
          <div className="nb-stat">
            <span className="nb-stat__value">{counts.deleted}</span>
            <span className="nb-stat__label">回收站记录</span>
          </div>
        </div>
      </section>

      <section className="nb-section" aria-labelledby="nb-settings-feedback">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-settings-feedback">
            意见反馈
          </h2>
        </div>
        <div className="nb-card nb-card--pad nb-stack">
          <p className="nb-kv">
            用着不顺手、想要什么功能、哪里出了错，都可以告诉我。
            反馈会先保存在这台设备上，再发送出去，发送失败也不会丢。
          </p>
          <div className="nb-actionbar">
            <Button
              variant="primary"
              icon="edit"
              onClick={() => {
                navigate(paths.feedback);
              }}
            >
              写一条反馈
            </Button>
          </div>
        </div>
      </section>

      <section className="nb-section" aria-labelledby="nb-settings-telemetry">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-settings-telemetry">
            匿名使用统计
          </h2>
          <span className="nb-section__hint">
            {telemetryConfigured ? '已连接统计服务' : '未连接统计服务'}
          </span>
        </div>
        <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
          <label className="nb-check">
            <input
              className="nb-check__input"
              type="checkbox"
              checked={telemetry.enabled}
              onChange={(event) => toggleTelemetry(event.target.checked)}
            />
            <span className="nb-check__body">
              <span className="nb-check__label">允许上报匿名使用统计</span>
              <span className="nb-check__hint">
                只上报「发生了什么」：事件名与来源、状态、进度、数量档位这类枚举值。
                <strong>不含念头正文、标题、标签或链接</strong>，也不含账号与个人信息，
                只有一个随机生成、可随时重置的设备标识。
              </span>
            </span>
          </label>

          <p className="nb-kv">
            {telemetryConfigured
              ? '本次构建已连接统计服务：事件会先留在本机，再批量上报；断网时下次打开自动补发。'
              : '本次构建没有配置统计服务，应用不会发出任何网络请求，统计只留在本机供你自己查看。'}
            {' · '}
            当前状态：{telemetry.enabled ? '允许上报' : '已关闭（不会上报任何数据）'}
            {' · '}
            待发送：{telemetry.queuedEvents} 条
          </p>

          <p className="nb-kv">
            设备标识：<code className="nb-code">{telemetry.installId}</code>
          </p>
          <p className="nb-kv">
            重置后，之后的数据无法与之前的数据关联；关闭统计会立刻清空待发送队列，关闭动作本身不上报。
          </p>

          <div className="nb-actionbar">
            <Button
              size="sm"
              variant="secondary"
              icon="refresh"
              onClick={() => {
                resetInstallId();
                setTelemetry(getTelemetryStatus());
                toast.push({
                  message: '设备标识已重置，之前的数据无法再与这台设备关联。',
                  tone: 'info',
                });
              }}
            >
              重置设备标识
            </Button>
          </div>
        </div>
      </section>

      {/* 开发者看板入口：仅当构建时注入 DEV_DASHBOARD=1 时才存在，普通用户看不到。 */}
      {devDashboardEnabled ? (
        <section className="nb-section" aria-labelledby="nb-settings-dev">
          <div className="nb-section__head">
            <h2 className="nb-section__title" id="nb-settings-dev">
              开发者
            </h2>
          </div>
          <div className="nb-card nb-card--pad nb-stack">
            <p className="nb-kv">
              看本机的使用情况、待发送队列与反馈记录；跨用户的运营数据在后端，需要读取凭据。
            </p>
            <div className="nb-actionbar">
              <Button
                variant="secondary"
                onClick={() => {
                  navigate(paths.dev);
                }}
              >
                打开开发者看板
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="nb-section" aria-labelledby="nb-settings-backup">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-settings-backup">
            备份与恢复
          </h2>
        </div>
        <div className="nb-card nb-card--pad nb-stack">
          <p className="nb-kv">
            导出文件为 JSON 格式，包含格式版本号、导出时间、全部念头与项目（含回收站记录），可以重新导入恢复。
          </p>
          <div className="nb-actionbar">
            <Button
              variant="primary"
              icon="download"
              disabled={exporting}
              onClick={() => {
                void handleExport();
              }}
            >
              {exporting ? '正在导出…' : '导出数据'}
            </Button>
            <Button
              variant="secondary"
              icon="upload"
              onClick={() => {
                void handlePick();
              }}
            >
              导入数据
            </Button>
            <Button variant="ghost" onClick={() => navigate(paths.trash)}>
              打开回收站
            </Button>
          </div>
          <p className="nb-kv">
            导入前会先校验文件格式，并让你选择重复记录的处理方式；校验不通过时不会改动任何现有数据。
          </p>
        </div>
      </section>

      {errors.length > 0 ? (
        <section className="nb-section" aria-labelledby="nb-settings-messages">
          <div className="nb-notice nb-notice--warn" role="status">
            <p className="nb-notice__title" id="nb-settings-messages">
              需要留意的信息
            </p>
            <ul className="nb-notice__list">
              {errors.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
            <div>
              <Button size="sm" variant="ghost" onClick={() => setErrors([])}>
                知道了
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="nb-section" aria-labelledby="nb-settings-danger">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-settings-danger">
            危险操作
          </h2>
        </div>
        <div className="nb-card nb-card--pad nb-stack nb-danger-zone">
          <p className="nb-kv">
            清空会删除这台设备上的全部念头与项目，且无法撤销。建议先导出备份。
          </p>
          <div className="nb-actionbar">
            <Button variant="danger" icon="trash" onClick={() => setConfirmClear(true)}>
              清空全部数据
            </Button>
          </div>
        </div>
      </section>

      <section className="nb-section" aria-labelledby="nb-settings-privacy">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-settings-privacy">
            隐私说明
          </h2>
        </div>
        <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
          <p className="nb-kv">不调用任何第三方 AI 接口，不需要登录，不采集个人信息（姓名、手机号、邮箱一律不要）。</p>
          <p className="nb-kv">
            会上报匿名使用统计，用来判断下一步该做什么：只有事件名与来源、状态、进度、数量档位这类枚举值，
            <strong>不含念头正文、标题、标签或链接</strong>。可以在上方一键关闭。
          </p>
          <p className="nb-kv">
            你的灵感内容始终留在本地浏览器里；反馈内容只有在你亲手点「提交反馈」之后才会离开这台设备。
          </p>
        </div>
      </section>

      {/* 与官网的对接：官网地址由构建环境变量注入，未配置时整块不渲染。 */}
      {officialSiteUrl ? (
        <section className="nb-section" aria-labelledby="nb-settings-site">
          <div className="nb-section__head">
            <h2 className="nb-section__title" id="nb-settings-site">
              关于念头盒
            </h2>
          </div>
          <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
            <p className="nb-kv">
              这里是念头盒的应用本体，记录只保存在这台设备上；官网用来介绍产品理念与后续计划。
            </p>
            <p className="nb-kv">
              <a
                className="nb-link"
                href={officialSiteUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="external" size={16} />
                打开官网首页
              </a>
            </p>
          </div>
        </section>
      ) : null}

      {/* 导入确认：先预览备份内容与冲突数量，再决定策略 */}
      <ConfirmDialog
        open={importSession !== null}
        title="确认导入这份备份？"
        confirmLabel="开始导入"
        busy={importing}
        description={
          backup ? (
            <>
              <p>
                文件：<strong>{importSession?.fileName}</strong>
                <br />
                导出时间：{formatExportedAt(backup.exportedAt)} · 格式版本 v{backup.version}
              </p>
              <p>
                包含 {backup.ideas.length} 条念头（其中回收站{' '}
                {backup.ideas.filter((idea) => idea.deletedAt !== null).length} 条）、
                {backup.projects.length} 个项目（其中回收站{' '}
                {backup.projects.filter((project) => project.deletedAt !== null).length} 个）。
              </p>
              <p>
                与本机重复的 ID：{conflicts.ideas} 条念头、{conflicts.projects} 个项目。
                现有数据不会被直接覆盖。
              </p>
              <SelectField
                label="重复记录处理方式"
                value={strategy}
                onChange={setStrategy}
                options={STRATEGY_OPTIONS}
              />
              {backup.counts.ideas !== backup.ideas.length ? (
                <p className="nb-kv">备份中的回收站记录会一并导入，不会丢失。</p>
              ) : null}
            </>
          ) : null
        }
        onCancel={() => setImportSession(null)}
        onConfirm={() => {
          void confirmImport();
        }}
      />

      <ConfirmDialog
        open={confirmClear}
        tone="danger"
        title="清空全部本地数据？"
        confirmLabel="确认清空"
        busy={clearing}
        description={
          <p>
            将永久删除本机上的 {counts.ideas} 条念头与 {counts.projects} 个项目（含回收站记录），
            此操作无法撤销，也无法通过导入找回。确定要继续吗？
          </p>
        }
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          void confirmClearAll();
        }}
      />
    </div>
  );
}
