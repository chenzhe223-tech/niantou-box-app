/**
 * 设置：云端同步状态、存储说明、数据导出、数据导入、清空全部数据，
 * 以及「意见反馈」入口与「匿名使用统计」开关。
 *
 * 隐私边界（必须与代码实际行为一致，不允许写成更宽松的说法）：
 * - 未登录：念头与项目只在这台设备的当前浏览器里读写，不上传；
 *   已登录：同一份记录在本机与云端各保存一份，服务端按令牌校验归属，
 *   账号之间互相隔离，界面必须如实说清楚「现在数据放在哪」；
 * - 匿名使用统计只上报事件名与枚举参数（来源、状态、进度、数量档位），
 *   不含任何内容字段，可一键关闭，关闭即停止上报并清空待发送队列；
 * - 意见反馈只有用户亲手点「提交反馈」之后才离开设备；
 * - AI 分类 / 抽象 / 图像、邮件发送这些会把内容发出去的能力，
 *   一律按服务端返回的能力与厂商名如实告知，未配置就说未配置。
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
import { useCloudSync } from '../hooks/useCloudSync';
import { describeSyncPhase } from '../services/cloud/cloudSync';
import {
  getTelemetryStatus,
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
  const sync = useCloudSync();
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

  /**
   * 把「哪些内容会离开这台设备」按服务端返回的真实能力写出来。
   * 没有配置就说没有配置，绝不为了让文案好看而写成已经接入。
   */
  const aiDisclosure = (() => {
    const parts: string[] = [];
    // 服务名后面带上真实模型名，用户能核对到底哪个模型看到了自己的内容。
    const providerLabel = (provider: string, model: string, fallback: string) => {
      const name = provider || fallback;
      return model ? `${name} / ${model}` : name;
    };
    if (sync.capabilities.classify) {
      parts.push(
        `保存后自动分类会把念头正文发给服务端的文本模型（${providerLabel(
          sync.capabilities.aiProvider,
          sync.capabilities.aiModel,
          '服务端配置的服务商',
        )}）`,
      );
    } else {
      parts.push('自动分类目前只按关键词判断，没有接入第三方文本模型');
    }
    if (sync.capabilities.abstract) {
      parts.push(
        `灵感海报的「抽象」步骤会把内容发给文本模型（${providerLabel(
          sync.capabilities.aiProvider,
          sync.capabilities.aiModel,
          '服务端配置的服务商',
        )}）`,
      );
    }
    // 主模型额度不足时会自动退到后面的模型。这件事必须写出来：
    // 否则「我明明配了 glm-5.3」和「日志里跑的是 glm-4-flash」就对不上了。
    const chain = sync.capabilities.aiModels;
    if (sync.capabilities.classify && chain.length > 1) {
      parts.push(`文本模型链：${chain.join(' → ')}，前面的额度不足或被限流时自动退到下一个`);
    }
    // 服务端填的运维注记（免费额度还剩多少、什么时候到期）原样带出来：
    // 免费包用完时上游只会静默 429、链自动降级，界面不说就没人会发现。
    if (sync.capabilities.aiNote) {
      parts.push(`模型额度：${sync.capabilities.aiNote}`);
    }
    parts.push(
      sync.capabilities.image
        ? `图像由 ${providerLabel(
            sync.capabilities.imageProvider,
            sync.capabilities.imageModel,
            '服务端配置的图像服务',
          )} 生成，默认只发送抽象后的主题与意象，不发送念头原文`
        : '图像生成尚未配置，海报只在本机绘制，不会生成假的 AI 图片',
    );
    parts.push(
      sync.capabilities.mail
        ? `邮件由服务端发送（${
            sync.capabilities.mailProvider || '服务端配置的邮件服务'
          }${sync.capabilities.mailFrom ? `，发件地址 ${sync.capabilities.mailFrom}` : ''}），只有服务端确认成功才算发出`
        : '邮件还没配置服务端发送，只会预填到你的邮件应用里，由你自己确认发送',
    );
    parts.push(
      sync.capabilities.passwordReset
        ? '忘记密码可以走邮箱重置链接，服务端只保存令牌的哈希，用过一次就失效'
        : '邮箱找回密码暂不可用，需要服务端先配好邮件服务',
    );
    return `${parts.join('；')}。`;
  })();

  return (
    <div className="nb-page">
      <div className="nb-page__head">
        <h1 className="nb-page__title">设置与数据</h1>
        <p className="nb-page__lead">
          {sync.signedIn
            ? '本机保存一份，登录的云端账号里也保存一份，随时可以导出备份。'
            : sync.configured
              ? '数据先保存在本机浏览器；登录云端账号后，手机和电脑可以共用同一份念头。'
              : '数据保存在本机浏览器，随时可以导出备份。'}
        </p>
      </div>

      <div className="nb-notice">
        <p className="nb-notice__title">{sync.signedIn ? '数据保存位置' : '本地存储说明'}</p>
        {sync.signedIn ? (
          <p>
            记录同时保存在这台设备的浏览器和你的云端账号里：服务端按登录令牌校验归属，账号之间互相隔离。
            清理浏览器数据前仍建议先导出备份。
          </p>
        ) : (
          <p>
            当前版本采用本地存储，记录保存在这台设备的当前浏览器中。清理浏览器数据或更换设备前，请先导出备份。
          </p>
        )}
      </div>

      <section className="nb-section" aria-labelledby="nb-settings-cloud">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-settings-cloud">
            云端同步
          </h2>
          <span className="nb-section__hint">
            {sync.signedIn
              ? `云端 ${sync.remoteCounts.ideas} 条念头 · ${sync.remoteCounts.projects} 个项目`
              : '未登录'}
          </span>
        </div>
        <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
          <p className="nb-kv">{describeSyncPhase(sync)}</p>
          {sync.user ? <p className="nb-kv">当前账号：{sync.user.email}</p> : null}
          {sync.signedIn && sync.pendingCount > 0 ? (
            <p className="nb-kv">还有 {sync.pendingCount} 项改动只在本机，联网后会自动上传。</p>
          ) : null}
          <div className="nb-actionbar">
            <Button
              variant={sync.signedIn ? 'secondary' : 'primary'}
              onClick={() => navigate(paths.cloud)}
            >
              {sync.signedIn ? '管理云端同步' : '登录 / 注册云端账号'}
            </Button>
          </div>
          <p className="nb-kv">
            同一账号在电脑、手机、iPhone PWA 和微信浏览器里看到的是同一份念头；
            未登录时依然可以离线记录，登录后自动把本机已有数据迁移上去。
          </p>
        </div>
      </section>

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

      {telemetryConfigured ? (
        <section className="nb-section" aria-labelledby="nb-settings-telemetry">
          <div className="nb-section__head">
            <h2 className="nb-section__title" id="nb-settings-telemetry">帮助改进念头盒</h2>
            <span className="nb-section__hint">可选</span>
          </div>
          <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
            <label className="nb-check">
              <input className="nb-check__input" type="checkbox" checked={telemetry.enabled}
                onChange={(event) => toggleTelemetry(event.target.checked)} />
              <span className="nb-check__body">
                <span className="nb-check__label">允许发送匿名功能使用统计</span>
                <span className="nb-check__hint">
                  仅用于了解功能使用情况，不会发送念头正文、标题、标签、项目链接或账号信息。你可以随时关闭。
                </span>
              </span>
            </label>
            <p className="nb-kv" role="status">
              {telemetry.enabled ? '匿名统计已开启。' : '匿名统计已关闭，不会继续发送使用统计。'}
            </p>
          </div>
        </section>
      ) : null}

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
          <p className="nb-kv">
            {sync.signedIn
              ? '只有登录云端账号时才会用到邮箱（作为账号标识），不收集姓名和手机号。'
              : '不需要登录，也不采集个人信息（姓名、手机号、邮箱一律不要）。'}
          </p>
          <p className="nb-kv">
            会上报匿名使用统计，用来判断下一步该做什么：只有事件名与来源、状态、进度、数量档位这类枚举值，
            <strong>不含念头正文、标题、标签或链接</strong>。可以在上方一键关闭。
          </p>
          <p className="nb-kv">
            {sync.signedIn
              ? '你的灵感内容保存在本机与你自己的云端账号里，服务端按令牌校验归属，不会用于其它用途。'
              : '你的灵感内容只保存在本地浏览器里。'}
            反馈内容只有在你亲手点「提交反馈」之后才会离开这台设备。
          </p>
          <p className="nb-kv">
            {aiDisclosure}
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
              {sync.signedIn
                ? '这里是念头盒的应用本体，记录在本机与你的云端账号各保存一份；官网用来介绍产品理念与后续计划。'
                : '这里是念头盒的应用本体，记录只保存在这台设备上；官网用来介绍产品理念与后续计划。'}
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
