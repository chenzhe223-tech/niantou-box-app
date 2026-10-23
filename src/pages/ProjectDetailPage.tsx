/**
 * 项目详情：补充项目名称、问题、目标用户、核心功能、产品形态、进度与外链。
 * 始终显示关联的原始念头，方便回看最初的灵感。
 */

import { useMemo, useState } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { formatDateTime } from '../app/format';
import { paths } from '../app/routes';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { SelectField, TextArea, TextField } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { copyText } from '../services/aiTools';
import {
  isGitHubLibraryConnected,
  pushProjectToGitHubLibrary,
  type GitHubLibraryPushResult,
  type GitHubPlatform,
} from '../services/githubIdeaLibrary';
import { softDeleteProject, toNianBoxError, updateProject } from '../services/storage';
import { PRODUCT_FORMS, displayTitle, type ProductForm } from '../types/idea';
import { PROJECT_PROGRESSES, progressLabel, type Project, type ProjectProgress } from '../types/project';

type ProductFormChoice = ProductForm | 'none';

interface FormState {
  name: string;
  problem: string;
  targetUsers: string;
  features: string;
  productForm: ProductFormChoice;
  progress: ProjectProgress;
  repoUrl: string;
  liveUrl: string;
}

function toFormState(project: Project): FormState {
  return {
    name: project.name,
    problem: project.problem,
    targetUsers: project.targetUsers,
    features: project.features,
    productForm: project.productForm ?? 'none',
    progress: project.progress,
    repoUrl: project.repoUrl,
    liveUrl: project.liveUrl,
  };
}

const PRODUCT_FORM_OPTIONS: ReadonlyArray<{ value: ProductFormChoice; label: string }> = [
  { value: 'none', label: '暂未确定' },
  ...PRODUCT_FORMS.map((item) => ({ value: item.value, label: item.label })),
];

const PROGRESS_OPTIONS: ReadonlyArray<{ value: ProjectProgress; label: string }> =
  PROJECT_PROGRESSES.map((item) => ({ value: item.value, label: item.label }));

export function ProjectDetailPage({
  projectId,
  navigate,
}: {
  projectId: string;
  navigate: (hash: string) => void;
}) {
  const { ideas, projects } = useAppData();
  const toast = useToast();

  const project = useMemo(
    () => projects.find((item) => item.id === projectId) ?? null,
    [projects, projectId],
  );
  const sourceIdea = useMemo(
    () => (project ? ideas.find((idea) => idea.id === project.ideaId) ?? null : null),
    [ideas, project],
  );

  const [form, setForm] = useState<FormState | null>(() => (project ? toFormState(project) : null));
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pushingToLibrary, setPushingToLibrary] = useState(false);
  const [libraryResult, setLibraryResult] = useState<GitHubLibraryPushResult | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [promptPlatform, setPromptPlatform] = useState<GitHubPlatform>('Codex');

  if (!project) {
    return (
      <div className="nb-page">
        <EmptyState
          icon="box"
          title="这个项目不存在。"
          description="它可能已经被永久删除，或者链接不完整。"
          action={
            <Button variant="primary" onClick={() => navigate(paths.projects)}>
              回到项目库
            </Button>
          }
        />
      </div>
    );
  }

  const stored = toFormState(project);
  const current = form ?? stored;
  const dirty = JSON.stringify(current) !== JSON.stringify(stored);

  const handleSaveToGitHubLibrary = async () => {
    if (pushingToLibrary) return;
    if (!sourceIdea) {
      setLibraryError('关联的原始念头不存在，暂时无法生成完整项目说明。');
      return;
    }
    if (!isGitHubLibraryConnected()) {
      toast.push({ message: '请先在设置中关联 GitHub 念头库，并完成本次浏览器会话授权。', tone: 'info' });
      navigate(paths.settings);
      return;
    }
    setPushingToLibrary(true);
    setLibraryError(null);
    try {
      const payload: Project = {
        ...project,
        name: current.name.trim() || project.name,
        problem: current.problem,
        targetUsers: current.targetUsers,
        features: current.features,
        productForm: current.productForm === 'none' ? null : current.productForm,
        progress: current.progress,
        repoUrl: current.repoUrl,
        liveUrl: current.liveUrl,
      };
      const result = await pushProjectToGitHubLibrary(payload, sourceIdea);
      setLibraryResult(result);
      toast.push({ message: '项目需求已写入 GitHub 念头库，并生成了三种平台的启动指令。', tone: 'success' });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '写入 GitHub 失败，请检查连接与仓库权限。';
      setLibraryError(message);
      toast.push({ message, tone: 'error' });
    } finally {
      setPushingToLibrary(false);
    }
  };

  const handleCopyPlatformPrompt = async () => {
    if (!libraryResult) return;
    const ok = await copyText(libraryResult.prompts[promptPlatform]);
    toast.push(ok
      ? { message: `${promptPlatform} 启动指令已复制。打开对应平台粘贴即可。`, tone: 'success' }
      : { message: '复制没有成功，请选中下方指令手动复制。', tone: 'error' });
  };

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...(previous ?? stored), [key]: value }));
    if (key === 'name') setNameError(null);
  };

  const handleSave = async () => {
    if (saving) return;
    if (current.name.trim() === '') {
      setNameError('项目需要一个名称，方便在项目库里辨认。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateProject(project.id, {
        name: current.name.trim(),
        problem: current.problem,
        targetUsers: current.targetUsers,
        features: current.features,
        productForm: current.productForm === 'none' ? null : current.productForm,
        progress: current.progress,
        repoUrl: current.repoUrl,
        liveUrl: current.liveUrl,
      });
      toast.push({ message: '项目信息已保存。', tone: 'success' });
    } catch (caught) {
      const message = toNianBoxError(caught).message;
      setError(message);
      toast.push({ message: `保存失败：${message}`, tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await softDeleteProject(project.id);
      toast.push({ message: '项目已移到回收站。', tone: 'info' });
      setPendingDelete(false);
      navigate(paths.projects);
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="nb-page">
      <div className="nb-backbar">
        <button type="button" className="nb-backbar__back" onClick={() => navigate(paths.projects)}>
          <Icon name="back" size={18} />
          项目库
        </button>
        <Badge tone="ready">{progressLabel(project.progress)}</Badge>
      </div>

      <div className="nb-detail__head">
        <h1 className="nb-detail__title">{project.name || '未命名项目'}</h1>
        <dl className="nb-meta">
          <div className="nb-meta__item">
            <dt className="nb-meta__label">创建时间</dt>
            <dd className="nb-meta__value">{formatDateTime(project.createdAt)}</dd>
          </div>
          <div className="nb-meta__item">
            <dt className="nb-meta__label">最后更新</dt>
            <dd className="nb-meta__value">{formatDateTime(project.updatedAt)}</dd>
          </div>
          {sourceIdea ? (
            <div className="nb-meta__item">
              <dt className="nb-meta__label">原始念头</dt>
              <dd className="nb-meta__value">
                <button
                  type="button"
                  className="nb-link nb-link--button"
                  onClick={() => navigate(paths.idea(sourceIdea.id))}
                >
                  {displayTitle(sourceIdea)}
                </button>
              </dd>
            </div>
          ) : (
            <div className="nb-meta__item">
              <dt className="nb-meta__label">原始念头</dt>
              <dd className="nb-meta__value">已被永久删除</dd>
            </div>
          )}
          {project.repoUrl || project.liveUrl ? (
            <div className="nb-meta__item">
              <dt className="nb-meta__label">相关链接</dt>
              <dd className="nb-meta__value">
                {project.repoUrl ? (
                  <a className="nb-link" href={project.repoUrl} target="_blank" rel="noreferrer noopener">
                    <Icon name="external" size={14} />
                    代码仓库
                  </a>
                ) : null}
                {project.repoUrl && project.liveUrl ? ' · ' : null}
                {project.liveUrl ? (
                  <a className="nb-link" href={project.liveUrl} target="_blank" rel="noreferrer noopener">
                    <Icon name="external" size={14} />
                    已发布网址
                  </a>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      <form
        className="nb-card nb-card--pad nb-form nb-detail__form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSave();
        }}
        noValidate
      >
        <TextField
          label="项目名称"
          value={current.name}
          onChange={(value) => update('name', value)}
          error={nameError}
          placeholder="例如：车位雷达"
        />
        <TextArea
          label="需要解决的问题"
          value={current.problem}
          onChange={(value) => update('problem', value)}
          rows={3}
          placeholder="这个项目要解决什么具体问题？"
        />
        <TextField
          label="目标用户"
          value={current.targetUsers}
          onChange={(value) => update('targetUsers', value)}
          placeholder="谁会真正用得上它？"
        />
        <TextArea
          label="核心功能"
          value={current.features}
          onChange={(value) => update('features', value)}
          rows={4}
          placeholder="一行一个功能点，例如：&#10;- 进入停车场后记录车位编号&#10;- 离场时一键导航回车位"
        />
        <div className="nb-form__grid nb-form__grid--two">
          <SelectField
            label="产品形态"
            value={current.productForm}
            onChange={(value) => update('productForm', value)}
            options={PRODUCT_FORM_OPTIONS}
          />
          <SelectField
            label="当前进度"
            value={current.progress}
            onChange={(value) => update('progress', value)}
            options={PROGRESS_OPTIONS}
          />
        </div>
        <TextField
          label="GitHub 仓库 URL"
          type="url"
          inputMode="url"
          value={current.repoUrl}
          onChange={(value) => update('repoUrl', value)}
          placeholder="https://github.com/你的用户名/仓库名"
        />
        <TextField
          label="已发布网址"
          type="url"
          inputMode="url"
          value={current.liveUrl}
          onChange={(value) => update('liveUrl', value)}
          placeholder="https://"
        />

        {error ? (
          <p className="nb-notice nb-notice--danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className="nb-actionbar">
          <Button type="submit" variant="primary" icon="check" disabled={saving || !dirty}>
            {saving ? '正在保存…' : dirty ? '保存修改' : '已保存'}
          </Button>
          <Button
            variant="ghost"
            disabled={saving || !dirty}
            onClick={() => {
              setForm(stored);
              setNameError(null);
              setError(null);
            }}
          >
            撤销修改
          </Button>
          {dirty ? <span className="nb-kv">有未保存的修改</span> : null}
        </div>

        <div className="nb-actionbar">
          <Button
            variant="secondary"
            icon="external"
            disabled={pushingToLibrary}
            onClick={() => void handleSaveToGitHubLibrary()}
          >
            {pushingToLibrary ? '正在存入 GitHub…' : '存入 GitHub 念头库'}
          </Button>
          <Button variant="ghost" icon="trash" onClick={() => setPendingDelete(true)}>
            删除项目
          </Button>
        </div>
      </form>

      {libraryError ? <p className="nb-notice nb-notice--danger" role="alert">{libraryError}</p> : null}

      {libraryResult ? (
        <section className="nb-section" aria-labelledby="nb-project-github-result">
          <div className="nb-section__head">
            <h2 className="nb-section__title" id="nb-project-github-result">已存入 GitHub 念头库</h2>
          </div>
          <div className="nb-card nb-card--pad nb-stack">
            <p className="nb-kv">归档位置：<a className="nb-link" href={libraryResult.fileUrl} target="_blank" rel="noreferrer noopener">{libraryResult.path}</a></p>
            <p className="nb-kv">以下指令会告诉对应 AI 平台读取此项目说明，再继续开发。私有仓库仍需在对应平台配置 GitHub 读取权限。</p>
            <div className="nb-work-filters" role="group" aria-label="选择 AI 平台启动指令">
              {(['ChatGPT', 'Codex', 'WorkBuddy'] as GitHubPlatform[]).map((platform) => (
                <button
                  key={platform}
                  type="button"
                  className={promptPlatform === platform ? 'nb-chip nb-chip--active' : 'nb-chip'}
                  aria-pressed={promptPlatform === platform}
                  onClick={() => setPromptPlatform(platform)}
                >
                  {platform}
                </button>
              ))}
            </div>
            <pre className="nb-github-library__prompt">{libraryResult.prompts[promptPlatform]}</pre>
            <div className="nb-actionbar">
              <Button variant="primary" icon="upload" onClick={() => void handleCopyPlatformPrompt()}>复制 {promptPlatform} 启动指令</Button>
              <a className="nb-link" href={libraryResult.fileUrl} target="_blank" rel="noreferrer noopener">查看 GitHub 文件 <Icon name="external" size={14} /></a>
            </div>
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={pendingDelete}
        tone="danger"
        title="删除这个项目？"
        confirmLabel="移到回收站"
        busy={deleting}
        description={
          <p>
            项目「{project.name || '未命名项目'}」会被移到回收站，原始念头不受影响，之后仍可以恢复。
          </p>
        }
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => {
          void handleDelete();
        }}
      />
    </div>
  );
}
