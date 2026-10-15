/**
 * 云端同步：登录、注册、退出、设备列表、旧数据迁移。
 *
 * 这个页面是「数据只在这台设备上」和「多终端共用一份数据」之间的开关。
 * 界面上写的每一句话都必须与实际行为一致：
 * - 没构建云端地址 → 明确说本次构建没有配置，不要说「登录失败」；
 * - 登录只是把本机数据推上去，不会删本机任何东西；
 * - 退出登录只清账号，本机数据照旧保留。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '../app/format';
import { paths } from '../app/routes';
import { Button } from '../components/Button';
import { StatusBadge } from '../components/Badge';
import { TextField } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { useCloudSync } from '../hooks/useCloudSync';
import { track } from '../services/analytics';
import { describeCloudConfig } from '../services/cloud/cloudConfig';
import { describeCloudError } from '../services/cloud/cloudClient';
import {
  cloudLogin,
  cloudLogout,
  cloudRegister,
  fetchMe,
  type CloudMe,
} from '../services/cloud/cloudAuth';
import {
  migrateLocalData,
  onSignedOut,
  onSignedIn,
  refreshCapabilities,
  syncNow,
  type MigrationReport,
} from '../services/cloud/cloudSync';
import {
  deliverSiteDraft,
  readSiteDraft,
  type SiteDraft,
} from '../services/cloud/siteCapture';

function deviceName(label: string): string {
  return label.trim() || '未知设备';
}

export function CloudPage({ navigate }: { navigate: (hash: string) => void }) {
  const sync = useCloudSync();
  const toast = useToast();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<CloudMe | null>(null);
  const [migrating, setMigrating] = useState(false);
  // 官网在未登录时收下的那句话：会在登录后自动补交，这里同时给一个手动重试的入口。
  const [siteDraft, setSiteDraft] = useState<SiteDraft | null>(() => readSiteDraft());
  const [delivering, setDelivering] = useState(false);

  const endpoint = describeCloudConfig();
  const signedIn = sync.signedIn;

  const loadMe = useCallback(async () => {
    try {
      setMe(await fetchMe());
    } catch {
      // 设备列表拉不到不影响主流程：状态栏已经会显示真实原因。
      setMe(null);
    }
  }, []);

  useEffect(() => {
    if (!sync.configured || !signedIn) {
      setMe(null);
      return;
    }
    void loadMe();
  }, [sync.configured, signedIn, loadMe]);

  useEffect(() => {
    // 登录状态变化时重新看一眼草稿：自动补交成功后这里会变成空。
    setSiteDraft(readSiteDraft());
  }, [signedIn]);

  const handleDeliverSiteDraft = async () => {
    if (delivering) return;
    setDelivering(true);
    try {
      const result = await deliverSiteDraft();
      setSiteDraft(readSiteDraft());
      toast.push({
        message: result.message || '这句话还留在本机，稍后可以再试一次。',
        tone: result.status === 'sent' ? 'success' : result.status === 'failed' ? 'error' : 'info',
      });
    } finally {
      setDelivering(false);
    }
  };

  const canSubmit = useMemo(
    () => email.trim() !== '' && password.length >= 8 && !busy,
    [email, password, busy],
  );

  const handleSubmit = async () => {
    if (busy) return;
    if (email.trim() === '') {
      setError('请先填写邮箱。');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 位字符。');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        await cloudRegister({ email: email.trim(), password, displayName: displayName.trim() });
        track('cloud_signup', { source: 'cloud' });
      } else {
        await cloudLogin(email.trim(), password);
        track('cloud_signin', { source: 'cloud' });
      }
      setPassword('');
      await onSignedIn();
      await loadMe();
      toast.push({ message: '登录成功，正在把这台设备上的念头同步到云端。', tone: 'success' });
    } catch (caught) {
      const message = describeCloudError(caught);
      setError(message);
      toast.push({ message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await cloudLogout();
      onSignedOut();
      track('cloud_signout', { source: 'cloud' });
      setMe(null);
      toast.push({ message: '已退出登录，本机数据仍然保留。', tone: 'info' });
    } finally {
      setBusy(false);
    }
  };

  const handleMigrate = async () => {
    if (migrating) return;
    setMigrating(true);
    try {
      const report: MigrationReport = await migrateLocalData();
      track('cloud_migrated', { source: 'cloud' });
      await loadMe();
      toast.push({
        message:
          report.failed > 0
            ? `已推送 ${report.pushed} 条，还有 ${report.failed} 条没传上去，联网后会自动重试。`
            : `已把本机 ${report.ideas} 条念头、${report.projects} 个项目同步到云端。`,
        tone: report.failed > 0 ? 'info' : 'success',
      });
    } catch (caught) {
      toast.push({ message: describeCloudError(caught), tone: 'error' });
    } finally {
      setMigrating(false);
    }
  };

  const handleSyncNow = async () => {
    setBusy(true);
    try {
      const ok = await syncNow('manual');
      track('cloud_sync_result', { source: 'cloud', sync: ok ? 'idle' : sync.phase });
      await loadMe();
      if (ok) toast.push({ message: '已同步。', tone: 'success' });
      else toast.push({ message: sync.message || '这次没有同步成功，改动仍保存在本机。', tone: 'info' });
    } catch (caught) {
      toast.push({ message: describeCloudError(caught), tone: 'error' });
    } finally {
      setBusy(false);
      void refreshCapabilities();
    }
  };

  /* ---------------------------------------------------------------- 状态栏 */

  const statusTone = sync.phase === 'idle' ? 'done' : sync.phase === 'error' ? 'danger' : 'info';
  const statusLabel = !sync.configured
    ? '未配置云端'
    : !sync.signedIn
      ? '未登录'
      : sync.phase === 'idle'
        ? '已同步'
        : sync.phase === 'syncing'
          ? '同步中'
          : sync.phase === 'pending'
            ? '有未上传的改动'
            : sync.phase === 'offline'
              ? '离线'
              : '同步出错';

  const statusTag =
    statusTone === 'done' ? (
      <StatusBadge status="done" />
    ) : (
      <span className={statusTone === 'danger' ? 'nb-chip nb-chip--danger' : 'nb-chip'}>
        {statusLabel}
      </span>
    );

  return (
    <div className="nb-page">
      <div className="nb-backbar">
        <button type="button" className="nb-backbar__back" onClick={() => navigate(paths.settings)}>
          <Icon name="back" size={18} />
          设置
        </button>
      </div>

      <div className="nb-page__head">
        <h1 className="nb-page__title">云端同步</h1>
        <p className="nb-page__lead">
          登录同一个账号，电脑、手机、iPhone 和微信里看到的都是同一份念头。
        </p>
      </div>

      <div className="nb-notice">
        <p className="nb-notice__title">
          当前状态：{statusLabel} {sync.pendingCount > 0 ? `· 待上传 ${sync.pendingCount} 条` : ''}
        </p>
        <p>{sync.message || '正在读取同步状态…'}</p>
        {sync.configured ? (
          <p className="nb-kv">
            云端地址：<code className="nb-code">{endpoint}</code>
          </p>
        ) : null}
        {sync.lastError && sync.phase === 'error' ? (
          <p className="nb-kv">最近一次失败：{sync.lastError}</p>
        ) : null}
      </div>

      {siteDraft ? (
        <section className="nb-section" aria-labelledby="nb-cloud-site-draft">
          <div className="nb-section__head">
            <h2 className="nb-section__title" id="nb-cloud-site-draft">
              官网里还没交上来的一句话
            </h2>
          </div>
          <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
            <p className="nb-kv">
              正文：<strong>{siteDraft.content}</strong>
            </p>
            <p className="nb-kv">
              {signedIn
                ? '这句话已经在登录后自动交过一次了。如果它还在这里，说明当时没有提交成功，可以再交一次（同一条不会重复）。'
                : '登录之后它会自动跟着交到你的收件箱，不需要重新写一遍。'}
            </p>
            <div className="nb-actionbar">
              <Button
                variant="primary"
                icon="upload"
                disabled={delivering || !signedIn || !sync.configured}
                onClick={() => void handleDeliverSiteDraft()}
              >
                {delivering ? '正在交上去…' : '现在交到收件箱'}
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {!sync.configured ? (
        <section className="nb-section">
          <div className="nb-card nb-card--pad nb-stack">
            <p className="nb-kv">
              这个构建没有注入云端地址（VITE_CLOUD_ENDPOINT），所以应用不会发出任何网络请求，
              记录只保存在这台设备上。部署时配置该变量即可启用同步。
            </p>
            <p className="nb-kv">
              在此之前，用下面的「导出数据 / 导入数据」在设备之间搬运记录是最稳妥的方式。
            </p>
            <div className="nb-actionbar">
              <Button variant="secondary" icon="download" onClick={() => navigate(paths.settings)}>
                去导出 / 导入
              </Button>
            </div>
          </div>
        </section>
      ) : signedIn ? (
        <>
          <section className="nb-section" aria-labelledby="nb-cloud-account">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-cloud-account">
                账号
              </h2>
              <span className="nb-section__hint">{statusTag}</span>
            </div>
            <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
              <p className="nb-kv">
                已登录：<strong>{sync.user?.displayName || sync.user?.email || '（未取到账号信息）'}</strong>
              </p>
              {me ? (
                <p className="nb-kv">
                  云端已有 <strong>{me.counts.ideas}</strong> 条念头、
                  <strong>{me.counts.projects}</strong> 个项目
                  {me.lastSyncAt > 0 ? ` · 最近同步 ${formatDateTime(me.lastSyncAt)}` : ''}
                </p>
              ) : null}

              <div className="nb-actionbar">
                <Button variant="primary" icon="refresh" disabled={busy} onClick={() => void handleSyncNow()}>
                  立即同步
                </Button>
                <Button
                  variant="secondary"
                  icon="upload"
                  disabled={migrating}
                  onClick={() => void handleMigrate()}
                >
                  {migrating ? '正在上传…' : '上传这台设备的数据'}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void handleLogout()}>
                  退出登录
                </Button>
              </div>
              <p className="nb-kv">
                「上传这台设备的数据」会把本机全部念头与项目推到云端（同一条记录以更新时间较新的为准）。
                退出登录不会删除本机数据。
              </p>
            </div>
          </section>

          <section className="nb-section" aria-labelledby="nb-cloud-devices">
            <div className="nb-section__head">
              <h2 className="nb-section__title" id="nb-cloud-devices">
                已登录的设备
              </h2>
            </div>
            <div className="nb-card nb-card--pad nb-stack">
              {me && me.devices.length > 0 ? (
                <ul className="nb-kvlist">
                  {me.devices.map((device, index) => (
                    <li className="nb-kvlist__row" key={`${device.label}-${device.createdAt}-${index}`}>
                      <span className="nb-kvlist__label">{deviceName(device.label)}</span>
                      <span className="nb-kvlist__value">
                        {device.lastSeenAt > 0 ? formatDateTime(device.lastSeenAt) : '尚未同步'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="nb-kv">暂时读不到设备列表，稍后在「立即同步」之后再回来看。</p>
              )}
              <p className="nb-kv">
                换手机或重装浏览器后，用同一个账号登录，念头会自动回到收件箱。
              </p>
            </div>
          </section>
        </>
      ) : (
        <section className="nb-section" aria-labelledby="nb-cloud-auth">
          <div className="nb-section__head">
            <h2 className="nb-section__title" id="nb-cloud-auth">
              {mode === 'login' ? '登录' : '创建账号'}
            </h2>
          </div>
          <form
            className="nb-card nb-card--pad nb-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
            noValidate
          >
            <p className="nb-kv">
              账号只用来区分「这是谁的数据」，因此只需要邮箱和密码，不要姓名、手机号。
              登录后，念头会在这台设备与云端之间双向同步。
            </p>

            <TextField
              label="邮箱"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(value) => {
                setEmail(value);
                if (error) setError(null);
              }}
              placeholder="name@example.com"
            />

            {mode === 'register' ? (
              <TextField
                label="怎么称呼你（可选）"
                value={displayName}
                onChange={setDisplayName}
                autoComplete="nickname"
                placeholder="只用于显示"
              />
            ) : null}

            <TextField
              label="密码"
              type="text"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(value) => {
                setPassword(value);
                if (error) setError(null);
              }}
              hint="至少 8 位。密码只用于登录，不会出现在任何链接或统计里。"
            />

            {error ? (
              <p className="nb-notice nb-notice--danger" role="alert">
                {error}
              </p>
            ) : null}

            <div className="nb-actionbar">
              <Button type="submit" variant="primary" icon="check" disabled={!canSubmit}>
                {busy ? '正在处理…' : mode === 'login' ? '登录并同步' : '创建账号'}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setMode(mode === 'login' ? 'register' : 'login');
                  setError(null);
                }}
              >
                {mode === 'login' ? '还没有账号？创建一个' : '已经有账号？去登录'}
              </Button>
            </div>
          </form>
        </section>
      )}

      <section className="nb-section" aria-labelledby="nb-cloud-services">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-cloud-services">
            服务状态
          </h2>
          <span className="nb-section__hint">由服务端如实返回</span>
        </div>
        <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
          <ul className="nb-kvlist">
            <li className="nb-kvlist__row">
              <span className="nb-kvlist__label">云端数据同步</span>
              <span className="nb-kvlist__value">{sync.configured ? '已接入' : '未配置'}</span>
            </li>
            <li className="nb-kvlist__row">
              <span className="nb-kvlist__label">AI 自动分类</span>
              <span className="nb-kvlist__value">
                {sync.capabilities.classify
                  ? `已接入${sync.capabilities.aiProvider ? `（${sync.capabilities.aiProvider}）` : ''}`
                  : '未配置（暂时按关键词判断）'}
              </span>
            </li>
            <li className="nb-kvlist__row">
              <span className="nb-kvlist__label">海报图像生成</span>
              <span className="nb-kvlist__value">
                {sync.capabilities.image
                  ? `已接入${sync.capabilities.imageProvider ? `（${sync.capabilities.imageProvider}）` : ''}`
                  : '未配置（改用本机绘制的品牌模板）'}
              </span>
            </li>
            <li className="nb-kvlist__row">
              <span className="nb-kvlist__label">服务端邮件发送</span>
              <span className="nb-kvlist__value">
                {sync.capabilities.mail ? '已接入' : '未配置（改用邮件应用预填）'}
              </span>
            </li>
          </ul>
          <div className="nb-actionbar">
            <Button size="sm" variant="secondary" icon="refresh" onClick={() => void refreshCapabilities()}>
              重新检测
            </Button>
          </div>
        </div>
      </section>

      <section className="nb-section" aria-labelledby="nb-cloud-privacy">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-cloud-privacy">
            同步的边界
          </h2>
        </div>
        <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
          <p className="nb-kv">
            登录之后，念头与项目会在本机与云端各存一份：断网时照常记录，联网后自动上传，
            本机没传上去的内容在列表里会标注「仅本地」。
          </p>
          <p className="nb-kv">
            服务端在每次读写时都会校验令牌，别人拿不到你的数据；
            不同账号之间的数据互相隔离，客户端传的任何用户标识都不被信任。
          </p>
          <p className="nb-kv">
            不登录也能继续用，只是数据只在这台设备上。任何时候都可以导出 JSON 备份。
          </p>
        </div>
      </section>
    </div>
  );
}
