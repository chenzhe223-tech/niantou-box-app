/**
 * GitHub 念头库连接与项目归档。
 *
 * 仓库地址保存在当前浏览器；精细化 PAT 仅放在 sessionStorage，
 * 不上传到念头盒后端、不进入备份文件，关闭浏览器会话后需重新授权。
 */
import type { Idea } from '../types/idea';
import type { Project } from '../types/project';

const SETTINGS_KEY = 'nianbox.github-idea-library.settings.v1';
const TOKEN_KEY = 'nianbox.github-idea-library.token.v1';

export interface GitHubLibrarySettings {
  owner: string;
  repo: string;
  repositoryUrl: string;
  branch: string;
}

export type GitHubPlatform = 'ChatGPT' | 'Codex' | 'WorkBuddy';

export interface GitHubLibraryPushResult {
  repositoryUrl: string;
  branch: string;
  path: string;
  fileUrl: string;
  prompts: Record<GitHubPlatform, string>;
}

interface GitHubRepositoryResponse {
  default_branch?: unknown;
  full_name?: unknown;
  private?: unknown;
}

interface GitHubContentsResponse {
  sha?: unknown;
  html_url?: unknown;
}

function storageGet(storageName: 'localStorage' | 'sessionStorage', key: string): string | null {
  try {
    return window[storageName].getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storageName: 'localStorage' | 'sessionStorage', key: string, value: string): void {
  try {
    window[storageName].setItem(key, value);
  } catch {
    throw new Error('浏览器未允许保存 GitHub 连接信息，请检查隐私模式或存储权限。');
  }
}

export function parseGitHubRepositoryUrl(value: string): { owner: string; repo: string; repositoryUrl: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入有效的 GitHub 仓库地址，例如 https://github.com/用户名/念头库。');
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('当前仅支持 github.com 上的仓库地址。');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) {
    throw new Error('请输入仓库主页地址，不要填文件地址或个人主页地址。');
  }
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  if (!/^[a-zA-Z0-9-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..') {
    throw new Error('这个仓库地址的格式不正确，请检查用户名与仓库名。');
  }
  return { owner, repo, repositoryUrl: `https://github.com/${owner}/${repo}` };
}

export function getGitHubLibrarySettings(): GitHubLibrarySettings | null {
  const raw = storageGet('localStorage', SETTINGS_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GitHubLibrarySettings>;
    if (
      typeof value.owner !== 'string' ||
      typeof value.repo !== 'string' ||
      typeof value.repositoryUrl !== 'string' ||
      typeof value.branch !== 'string'
    ) return null;
    return {
      owner: value.owner,
      repo: value.repo,
      repositoryUrl: value.repositoryUrl,
      branch: value.branch,
    };
  } catch {
    return null;
  }
}

export function hasGitHubLibrarySessionToken(): boolean {
  return Boolean(storageGet('sessionStorage', TOKEN_KEY));
}

export function isGitHubLibraryConnected(): boolean {
  return Boolean(getGitHubLibrarySettings() && hasGitHubLibrarySessionToken());
}

export function disconnectGitHubLibrary(): void {
  try {
    window.localStorage.removeItem(SETTINGS_KEY);
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Disconnect is best effort; the feature remains disabled if session storage is blocked.
  }
}

function getTokenOrThrow(): string {
  const token = storageGet('sessionStorage', TOKEN_KEY);
  if (!token) throw new Error('GitHub 授权已过期或当前会话没有授权，请到「设置 → GitHub 念头库」重新关联。');
  return token;
}

function authHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function readApiError(response: Response): Promise<string> {
  try {
    const data = await response.json() as { message?: unknown };
    if (typeof data.message === 'string') return data.message;
  } catch {
    // Use the HTTP status below.
  }
  return `GitHub 返回 HTTP ${response.status}`;
}

/** 验证仓库访问权限。地址持久化，token 仅保留在当前浏览器会话中。 */
export async function connectGitHubLibrary(
  repositoryUrl: string,
  token: string,
  requestedBranch = '',
): Promise<GitHubLibrarySettings> {
  const parsed = parseGitHubRepositoryUrl(repositoryUrl);
  if (!token.trim()) throw new Error('请粘贴一个仅授予目标仓库 Contents 读写权限的 fine-grained token。');
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    { headers: authHeaders(token.trim()) },
  );
  if (!response.ok) {
    if (response.status === 401) throw new Error('GitHub token 无效或已过期，请重新检查。');
    if (response.status === 403) throw new Error('GitHub 拒绝访问：请检查 token 是否已授权该仓库以及是否有 Contents 读写权限。');
    if (response.status === 404) throw new Error('未找到仓库或当前 token 无权访问；私有仓库也会在权限不足时返回 404。');
    throw new Error(`验证 GitHub 仓库失败：${await readApiError(response)}`);
  }
  const data = await response.json() as GitHubRepositoryResponse;
  const defaultBranch = typeof data.default_branch === 'string' ? data.default_branch : 'main';
  const branch = requestedBranch.trim() || defaultBranch;
  const settings: GitHubLibrarySettings = { ...parsed, branch };
  storageSet('localStorage', SETTINGS_KEY, JSON.stringify(settings));
  storageSet('sessionStorage', TOKEN_KEY, token.trim());
  return settings;
}

function safeSlug(value: string): string {
  const slug = value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'nianbox-project';
}

function dateFolder(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

const fence = String.fromCharCode(96).repeat(3);

function fenced(value: string): string {
  return value.trim() || '（暂未填写）';
}

export function buildPlatformPrompts(
  repositoryUrl: string,
  path: string,
  projectName: string,
  branch = 'main',
): Record<GitHubPlatform, string> {
  const branchPath = encodeURIComponent(branch);
  const filePath = path.split('/').map(encodeURIComponent).join('/');
  const target = `${repositoryUrl}/blob/${branchPath}/${filePath}`;
  const shared = `请先读取 GitHub 念头库中的项目说明文件：${target}\n\n以文件中记载的原始念头、问题、目标用户、功能范围和产品形态为准，不要臆造用户没有提供的需求。先检查当前代码与运行状态，再制定最小可验证实现；保留现有可用能力，完成后运行测试、构建和必要的线上验收。若你当前没有该 GitHub 仓库的读取权限，请明确提示我连接仓库或提供文件，不要假装已经读过。`;
  return {
    ChatGPT: `请协助我启动「${projectName}」项目。\n\n${shared}\n\n请先给出可执行的实施方案，再按任务推进；每个结论都要基于仓库实际内容与验证结果。`,
    Codex: `在当前工作区启动「${projectName}」开发。\n\n${shared}\n\n请直接检查并修改工作区代码，持续完成实现、测试、构建与修复；除非存在安全、权限或不可逆操作风险，否则不要每一步都暂停请示。最后汇报改动文件、测试结果、部署状态和未解决项。`,
    WorkBuddy: `请把「${projectName}」作为持续执行的开发任务。\n\n${shared}\n\n请依据真实项目状态连续推进代码实现、测试、部署和最终验收，不要在每个步骤完成后中断等待确认；遇到缺少权限或外部配置时，只指出确切阻塞点，并继续完成其余可做事项。`,
  };
}

/** 为已升级的念头生成规范项目说明，并写入用户自己的 GitHub 念头库。 */
export async function pushProjectToGitHubLibrary(
  project: Project,
  idea: Idea,
): Promise<GitHubLibraryPushResult> {
  const settings = getGitHubLibrarySettings();
  if (!settings) throw new Error('请先到「设置 → GitHub 念头库」关联仓库地址。');
  const token = getTokenOrThrow();
  const folder = `projects/${dateFolder(project.createdAt)}/${safeSlug(project.name)}-${project.id.slice(-6)}`;
  const path = `${folder}/README.md`;
  const prompts = buildPlatformPrompts(settings.repositoryUrl, path, project.name, settings.branch);

  const markdown = [
    `# ${project.name || '未命名项目'}`,
    '',
    '> 由念头盒自动归档。这里是项目需求的长期来源；代码仓库地址与线上地址可在下方补充。',
    '',
    '## 项目概览',
    '',
    `- 项目 ID：${project.id}`,
    `- 原始念头 ID：${idea.id}`,
    `- 创建时间：${new Date(project.createdAt).toISOString()}`,
    `- 当前进度：${project.progress}`,
    `- 产品形态：${project.productForm ?? '待确定'}`,
    `- 代码仓库：${project.repoUrl || '待填写'}`,
    `- 已发布网址：${project.liveUrl || '待填写'}`,
    '',
    '## 原始念头（保留原文）',
    '',
    fenced(idea.content),
    '',
    '## 要解决的问题',
    '',
    fenced(project.problem),
    '',
    '## 目标用户',
    '',
    fenced(project.targetUsers),
    '',
    '## 核心功能',
    '',
    fenced(project.features),
    '',
    '## 补充信息',
    '',
    `- 分类：${idea.category ?? '待分类'}`,
    `- 标签：${idea.tags.join('、') || '无'}`,
    `- 念头备注：${idea.notes || '无'}`,
    `- 产品形态：${project.productForm ?? idea.productForm ?? '待确定'}`,
    '',
    '## 跨平台启动开发指令',
    '',
    '### ChatGPT',
    '',
    `${fence}text`,
    prompts.ChatGPT,
    fence,
    '',
    '### Codex',
    '',
    `${fence}text`,
    prompts.Codex,
    fence,
    '',
    '### WorkBuddy',
    '',
    `${fence}text`,
    prompts.WorkBuddy,
    fence,
    '',
  ].join('\n');

  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/contents/${encodedPath}`;
  const headers = authHeaders(token);
  let existingSha: string | undefined;
  const current = await fetch(`${apiUrl}?ref=${encodeURIComponent(settings.branch)}`, { headers });
  if (current.ok) {
    const content = await current.json() as GitHubContentsResponse;
    if (typeof content.sha === 'string') existingSha = content.sha;
  } else if (current.status !== 404) {
    throw new Error(`读取 GitHub 念头库失败：${await readApiError(current)}`);
  }

  const response = await fetch(apiUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `NianBox: archive project ${project.name || project.id}`,
      content: utf8Base64(markdown),
      branch: settings.branch,
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('GitHub token 无效或已过期，请重新关联。');
    if (response.status === 403) throw new Error('GitHub 不允许写入：请确认 token 对目标仓库有 Contents: Read and write 权限。');
    if (response.status === 409) throw new Error('仓库刚刚发生并发修改，请重新点击「存入 GitHub 念头库」。');
    throw new Error(`项目没有写入 GitHub：${await readApiError(response)}`);
  }
  const saved = await response.json() as { content?: GitHubContentsResponse; commit?: { html_url?: unknown } };
  const fileUrl =
    typeof saved.content?.html_url === 'string'
      ? saved.content.html_url
      : `${settings.repositoryUrl}/blob/${encodeURIComponent(settings.branch)}/${encodedPath}`;
  return { repositoryUrl: settings.repositoryUrl, branch: settings.branch, path, fileUrl, prompts };
}
