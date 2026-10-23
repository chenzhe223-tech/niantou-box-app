import { useState } from 'react';
import { Button } from './Button';
import { TextField } from './Fields';
import { useToast } from './Toast';
import {
  connectGitHubLibrary,
  disconnectGitHubLibrary,
  getGitHubLibrarySettings,
  hasGitHubLibrarySessionToken,
  type GitHubLibrarySettings,
} from '../services/githubIdeaLibrary';

export function GitHubLibrarySettingsPanel() {
  const [settings, setSettings] = useState<GitHubLibrarySettings | null>(() => getGitHubLibrarySettings());
  const [repositoryUrl, setRepositoryUrl] = useState(() => getGitHubLibrarySettings()?.repositoryUrl ?? '');
  const [branch, setBranch] = useState(() => getGitHubLibrarySettings()?.branch ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(() => hasGitHubLibrarySessionToken());
  const toast = useToast();

  const handleConnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await connectGitHubLibrary(repositoryUrl, token, branch);
      setSettings(saved);
      setRepositoryUrl(saved.repositoryUrl);
      setBranch(saved.branch);
      setToken('');
      setConnected(true);
      toast.push({ message: 'GitHub 念头库已关联，项目现在可以一键归档。', tone: 'success' });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '关联 GitHub 失败，请检查地址与权限。';
      setError(message);
      toast.push({ message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = () => {
    disconnectGitHubLibrary();
    setSettings(null);
    setRepositoryUrl('');
    setBranch('');
    setToken('');
    setConnected(false);
    setError(null);
    toast.push({ message: '已解除当前浏览器中的 GitHub 念头库关联。', tone: 'info' });
  };

  return (
    <section className="nb-section" aria-labelledby="nb-settings-github-library">
      <div className="nb-section__head">
        <h2 className="nb-section__title" id="nb-settings-github-library">GitHub 念头库</h2>
        <span className="nb-section__hint">{connected ? '本次浏览器会话已授权' : settings ? '地址已保存，等待授权' : '可选关联'}</span>
      </div>
      <div className="nb-card nb-card--pad nb-stack">
        <p className="nb-kv">
          关联你自己的 GitHub 仓库。念头升级为项目后，可以把原始念头、项目目标、核心功能和 ChatGPT / Codex / WorkBuddy 启动指令一并写入仓库。
        </p>
        {settings && connected ? (
          <div className="nb-notice">
            <p className="nb-notice__title">已关联的念头库</p>
            <p><a className="nb-link" href={settings.repositoryUrl} target="_blank" rel="noreferrer noopener">{settings.repositoryUrl}</a></p>
            <p className="nb-kv">目标分支：{settings.branch}。授权仅存在当前浏览器会话中，未存入念头盒服务器或备份文件。</p>
          </div>
        ) : null}
        <TextField
          label="GitHub 念头库地址"
          value={repositoryUrl}
          onChange={setRepositoryUrl}
          placeholder="https://github.com/你的用户名/念头库"
          type="url"
          inputMode="url"
          autoComplete="url"
          hint="建议先在 GitHub 创建一个专门存放想法与项目需求的仓库。公开或私有仓库均可。"
        />
        <TextField
          label="目标分支（可选）"
          value={branch}
          onChange={setBranch}
          placeholder="留空时自动使用仓库默认分支"
          hint="例如 main；留空即可自动识别。"
        />
        <TextField
          label="GitHub Fine-grained token"
          value={token}
          onChange={setToken}
          placeholder="粘贴只授权此仓库的访问令牌"
          type="password"
          autoComplete="off"
          hint="权限只需目标仓库的 Contents: Read and write。令牌只留在当前浏览器会话，不会上传到念头盒服务器；关闭浏览器会话后需重新授权。"
        />
        <p className="nb-kv">
          还没有令牌？前往 <a className="nb-link" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer noopener">GitHub Fine-grained tokens</a> 创建一个，并在 Repository access 中只选这一个念头库。
        </p>
        {error ? <p className="nb-notice nb-notice--danger" role="alert">{error}</p> : null}
        <div className="nb-actionbar">
          <Button variant="primary" icon="github" disabled={busy || !repositoryUrl.trim() || !token.trim()} onClick={() => void handleConnect()}>
            {busy ? '正在验证仓库…' : '一键关联并验证'}
          </Button>
          {settings ? <Button variant="ghost" onClick={handleDisconnect}>解除关联</Button> : null}
        </div>
        <p className="nb-kv">
          一次归档会在你的仓库中新建或更新 <code>projects/日期/项目名称/README.md</code>，不会自动公开仓库，也不会修改项目代码仓库。
        </p>
      </div>
    </section>
  );
}
