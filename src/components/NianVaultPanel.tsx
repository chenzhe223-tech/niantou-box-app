import { useCallback, useEffect, useState } from 'react';

import { Button } from './Button';
import { getCloudToken } from '../services/cloud/cloudAuth';
import { cloudRequest, describeCloudError } from '../services/cloud/cloudClient';

interface VaultStatus {
  enabled: boolean;
  enabledAt: number | null;
  activationSeq: number | null;
  repositoryConfigured: boolean;
  githubCredentialConfigured: boolean;
  repository: string | null;
  jobs: Record<string, number>;
  recentJobs: Array<{
    operationId: string;
    entityId: string;
    status: string;
    errorCode: string;
    updatedAt: number;
  }>;
}

export function NianVaultPanel() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    const token = getCloudToken();
    if (!token) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await cloudRequest<VaultStatus>('/vault/status', { token, retries: 1 });
      setStatus(next);
      setError('');
    } catch (caught) {
      setError(describeCloudError(caught));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = async () => {
    const token = getCloudToken();
    if (!token || busy) return;
    const confirmed = window.confirm(
      '启用后只归档启用时间之后新建的念头。现有历史念头不会迁移，也不会被删除或覆盖。是否继续？',
    );
    if (!confirmed) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await cloudRequest<{ message?: string }>('/vault/enable', {
        method: 'POST',
        token,
        body: { confirm_no_backfill: true },
      });
      setNotice(result.message || 'NianVault 已启用。');
      await refresh();
    } catch (caught) {
      setError(describeCloudError(caught));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    setError('');
    try {
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const retryJob = async (operationId: string) => {
    const token = getCloudToken();
    if (!token || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await cloudRequest<{ archiveStatus?: string; ok?: boolean }>('/vault/retry', {
        method: 'POST',
        token,
        body: { operation_id: operationId },
      });
      setNotice(result.archiveStatus === 'archived' ? '归档已完成。' : '已处理重试请求，请刷新查看真实状态。');
      await refresh();
    } catch (caught) {
      setError(describeCloudError(caught));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const jobCount = (key: string) => status?.jobs?.[key] || 0;
  const jobLabels: Record<string, string> = {
    pending: '待处理',
    processing: '处理中',
    retrying: '自动重试',
    archived: '已归档',
    conflict: '版本冲突',
    failed: '失败',
  };
  const jobLabel = (value: string) => jobLabels[value] || value;

  return (
    <section className="nb-section" aria-labelledby="nb-nianvault-title">
      <div className="nb-section__head">
        <h2 className="nb-section__title" id="nb-nianvault-title">念头库 NianVault</h2>
        <span className="nb-section__hint">
          {loading ? '正在检查' : status?.enabled ? '已启用' : status ? '未启用' : '待配置'}
        </span>
      </div>
      <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
        <p className="nb-kv">
          把启用后新建的念头归档到你的私有 GitHub 仓库，并保留版本历史。念头盒仍是日常记录入口；
          NianVault 不会回填旧记录。
        </p>

        {status ? (
          <>
            <p className="nb-kv">
              仓库：<strong>{status.repository || '尚未配置'}</strong>
            </p>
            {!status.repositoryConfigured || !status.githubCredentialConfigured ? (
              <p className="nb-notice nb-notice--danger" role="status">
                私有仓库或服务端凭证尚未配置，暂时不能启用归档。
              </p>
            ) : null}
            {status.enabled ? (
              <>
                <p className="nb-kv">
                  归档队列：待处理 {jobCount('pending')} · 重试中 {jobCount('retrying')} ·
                  已归档 {jobCount('archived')} · 冲突 {jobCount('conflict')} · 失败 {jobCount('failed')}
                </p>
                <p className="nb-kv">
                  新建念头会自动进入归档队列；GitHub 暂时不可用时，念头仍保存在云端，系统会自动重试。
                </p>
                {status.recentJobs.length > 0 ? (
                  <div className="nb-stack nb-stack--tight">
                    <p className="nb-kv"><strong>最近归档任务</strong></p>
                    <ul className="nb-kvlist">
                      {status.recentJobs.map((job) => (
                        <li className="nb-kvlist__row" key={job.operationId}>
                          <span className="nb-kvlist__label">
                            {job.entityId.slice(-18)} · {jobLabel(job.status)}
                            {job.errorCode ? <small> · {job.errorCode}</small> : null}
                          </span>
                          {job.status === 'failed' || job.status === 'retrying' ? (
                            <Button variant="ghost" icon="refresh" disabled={busy} onClick={() => void retryJob(job.operationId)}>
                              重试
                            </Button>
                          ) : job.status === 'conflict' ? (
                            <span className="nb-kvlist__value">需人工检查</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="nb-kv">
                启用前会验证仓库为私有仓库，并确认服务端凭证已配置。启用动作不会迁移任何历史念头。
              </p>
            )}
          </>
        ) : null}

        {notice ? <p className="nb-notice" role="status">{notice}</p> : null}
        {error ? <p className="nb-notice nb-notice--danger" role="alert">{error}</p> : null}

        <div className="nb-actionbar">
          {status && !status.enabled ? (
            <Button variant="primary" icon="archive" disabled={busy || loading || !status.repositoryConfigured || !status.githubCredentialConfigured} onClick={() => void enable()}>
              {busy ? '正在启用…' : '启用 NianVault'}
            </Button>
          ) : null}
          <Button variant="secondary" icon="refresh" disabled={busy || loading} onClick={() => void retry()}>
            {loading || busy ? '正在检查…' : '刷新归档状态'}
          </Button>
        </div>
        {!status && !loading ? (
          <p className="nb-kv">
            若提示所有者账号或私有仓库尚未配置，需要先完成服务端部署配置；不会因此影响 NianBox 现有的记录和同步功能。
          </p>
        ) : null}
      </div>
    </section>
  );
}
