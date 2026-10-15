/**
 * 念头详情与编辑。
 *
 * 设计取舍：
 * - 高频字段（标题、正文、分类、状态、标签）直接显示；
 * - 其余字段（备注、问题、目标用户、产品形态、项目链接）收进「完善这个念头」；
 * - 编辑采用显式保存：只有点了「保存修改」才写入数据库，避免误触丢失正文；
 *   未保存的修改会给出明确提示，可以一键撤销回数据库里的内容。
 */

import { useMemo, useState } from 'react';
import { useAppData } from '../app/AppDataProvider';
import { formatDateTime } from '../app/format';
import { paths } from '../app/routes';
import { AiToolDialog } from '../components/AiToolDialog';
import { Badge, CategoryBadge, StatusBadge } from '../components/Badge';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { SelectField, TagInputField, TextArea, TextField } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { isIdeaPending, useCloudSync } from '../hooks/useCloudSync';
import { classifyIdea, trackClassifyOutcome } from '../services/aiClassify';
import {
  setIdeaPinned,
  softDeleteIdea,
  toNianBoxError,
  updateIdea,
  upgradeIdeaToProject,
} from '../services/storage';
import {
  IDEA_CATEGORIES,
  IDEA_STATUSES,
  PRODUCT_FORMS,
  displayTitle,
  hasSavableContent,
  type Idea,
  type IdeaCategory,
  type IdeaCategorySource,
  type IdeaStatus,
  type ProductForm,
} from '../types/idea';

type CategoryChoice = IdeaCategory | 'none';
type ProductFormChoice = ProductForm | 'none';

interface FormState {
  title: string;
  content: string;
  category: CategoryChoice;
  status: IdeaStatus;
  tags: string[];
  notes: string;
  problem: string;
  targetUsers: string;
  productForm: ProductFormChoice;
  projectUrl: string;
}

function toFormState(idea: Idea): FormState {
  return {
    title: idea.title,
    content: idea.content,
    category: idea.category ?? 'none',
    status: idea.status,
    tags: [...idea.tags],
    notes: idea.notes,
    problem: idea.problem,
    targetUsers: idea.targetUsers,
    productForm: idea.productForm ?? 'none',
    projectUrl: idea.projectUrl,
  };
}

const CATEGORY_OPTIONS: ReadonlyArray<{ value: CategoryChoice; label: string }> = [
  { value: 'none', label: '未分类' },
  ...IDEA_CATEGORIES.map((item) => ({ value: item.value, label: item.label })),
];

const STATUS_OPTIONS: ReadonlyArray<{ value: IdeaStatus; label: string }> = IDEA_STATUSES.map(
  (item) => ({ value: item.value, label: item.label }),
);

const PRODUCT_FORM_OPTIONS: ReadonlyArray<{ value: ProductFormChoice; label: string }> = [
  { value: 'none', label: '暂未确定' },
  ...PRODUCT_FORMS.map((item) => ({ value: item.value, label: item.label })),
];

/**
 * 分类结果是谁给的，必须如实写出来。
 * 关键词匹配的规则结果不允许被说成「AI 分类」。
 */
function categorySourceText(source: IdeaCategorySource | null): string {
  if (source === 'ai') return '当前分类来自 AI 判断，可以改，也可以重新分类。';
  if (source === 'rules') return '当前分类是按关键词判断的（暂未接入模型），可以改，也可以重新分类。';
  if (source === 'manual') return '当前分类是你手动选的，自动分类不会覆盖它。';
  return '还没有分类。登录云端账号后，保存时会自动试着判断一次。';
}

export function IdeaDetailPage({
  ideaId,
  navigate,
}: {
  ideaId: string;
  navigate: (hash: string) => void;
}) {
  const { ideas, projects } = useAppData();
  const toast = useToast();
  const sync = useCloudSync();
  const idea = useMemo(
    () => ideas.find((item) => item.id === ideaId) ?? null,
    [ideas, ideaId],
  );

  const [form, setForm] = useState<FormState | null>(() => (idea ? toFormState(idea) : null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const linkedProject = useMemo(
    () => (idea ? projects.find((project) => project.ideaId === idea.id) ?? null : null),
    [projects, idea],
  );

  if (!idea) {
    return (
      <div className="nb-page">
        <EmptyState
          icon="search"
          title="这条念头不存在。"
          description="它可能已经被永久删除，或者链接不完整。"
          action={
            <Button variant="primary" onClick={() => navigate(paths.inbox)}>
              回到收件箱
            </Button>
          }
        />
      </div>
    );
  }

  // idea 必定存在，这里的兜底只为了避免类型收窄带来的空判断。
  const current = form ?? toFormState(idea);
  const stored = toFormState(idea);
  const dirty = JSON.stringify(current) !== JSON.stringify(stored);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...(previous ?? stored), [key]: value }));
    if (key === 'content') setContentError(null);
  };

  const handleSave = async () => {
    if (saving) return;
    if (!hasSavableContent(current.content)) {
      setContentError('正文不能为空，念头需要至少一句话。');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const patch = {
        title: current.title,
        content: current.content,
        category: current.category === 'none' ? null : current.category,
        status: current.status,
        tags: current.tags,
        notes: current.notes,
        problem: current.problem,
        targetUsers: current.targetUsers,
        productForm: current.productForm === 'none' ? null : current.productForm,
        projectUrl: current.projectUrl,
      };
      /**
       * 用户亲手改过分类，就把来源标成「手动」：
       * 这样之后的自动分类不会悄悄覆盖他的选择（除非他点「重新分类」）。
       * 分类没动过的记录不写 categorySource，避免把 AI 的结果误标成手动。
       */
      if (current.category !== stored.category) {
        await updateIdea(idea.id, { ...patch, categorySource: 'manual' });
      } else {
        await updateIdea(idea.id, patch);
      }
      toast.push({ message: '修改已保存。', tone: 'success' });
    } catch (caught) {
      const message = toNianBoxError(caught).message;
      setError(message);
      toast.push({ message: `保存失败：${message}`, tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleTogglePin = async () => {
    try {
      await setIdeaPinned(idea.id, !idea.pinned);
      toast.push({ message: idea.pinned ? '已取消置顶。' : '已置顶。', tone: 'info' });
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await softDeleteIdea(idea.id);
      toast.push({ message: '已移到回收站，可随时恢复。', tone: 'info' });
      setPendingDelete(false);
      navigate(paths.inbox);
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  const handleUpgrade = async () => {
    try {
      const result = await upgradeIdeaToProject(idea.id);
      toast.push({ message: '已升级为创意项目，可以开始补充项目信息了。', tone: 'success' });
      navigate(paths.project(result.project.id));
    } catch (caught) {
      toast.push({ message: toNianBoxError(caught).message, tone: 'error' });
    }
  };

  /**
   * 用户主动点「重新分类」：即使他之前手动选过分类，也按他的意愿覆盖一次。
   * 分类失败不影响念头本身，这里只如实说明结果。
   */
  const handleReclassify = async () => {
    if (classifying) return;
    setClassifying(true);
    try {
      const outcome = await classifyIdea(idea.id, { force: true });
      trackClassifyOutcome(outcome, 'detail');
      toast.push({
        message: outcome.message,
        tone: outcome.status === 'applied' ? 'success' : outcome.status === 'failed' ? 'error' : 'info',
      });
    } finally {
      setClassifying(false);
    }
  };

  return (
    <div className="nb-page">
      <div className="nb-backbar">
        <button type="button" className="nb-backbar__back" onClick={() => navigate(paths.inbox)}>
          <Icon name="back" size={18} />
          收件箱
        </button>
        <span className="nb-backbar__aside">
          <Button
            size="sm"
            variant="ghost"
            icon="pin"
            onClick={() => {
              void handleTogglePin();
            }}
          >
            {idea.pinned ? '取消置顶' : '置顶'}
          </Button>
        </span>
      </div>

      <div className="nb-detail__head">
        <h1 className="nb-detail__title">{displayTitle(idea)}</h1>
        <div className="nb-badges nb-detail__badges">
          <StatusBadge status={idea.status} />
          <CategoryBadge category={idea.category} />
          {isIdeaPending(sync, idea.id) ? <Badge tone="pending">仅本地</Badge> : null}
          {linkedProject ? (
            <a className="nb-link" href={paths.project(linkedProject.id)}>
              <Icon name="box" size={14} />
              关联项目：{linkedProject.name}
            </a>
          ) : null}
        </div>
        <dl className="nb-meta">
          <div className="nb-meta__item">
            <dt className="nb-meta__label">创建时间</dt>
            <dd className="nb-meta__value">{formatDateTime(idea.createdAt)}</dd>
          </div>
          <div className="nb-meta__item">
            <dt className="nb-meta__label">最后更新</dt>
            <dd className="nb-meta__value">{formatDateTime(idea.updatedAt)}</dd>
          </div>
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
          label="标题（可选）"
          value={current.title}
          onChange={(value) => update('title', value)}
          placeholder="先不写也行，列表会用正文首句作为显示标题"
          hint="标题只用于列表展示，不会修改你写的正文。"
        />

        <TextArea
          label="正文"
          value={current.content}
          onChange={(value) => update('content', value)}
          rows={8}
          error={contentError}
          hint={`原始内容会完整保留，当前共 ${current.content.trim().length} 个字符。`}
        />

        <div className="nb-form__grid nb-form__grid--two">
          <SelectField
            label="分类"
            value={current.category}
            onChange={(value) => update('category', value)}
            options={CATEGORY_OPTIONS}
          />
          <SelectField
            label="状态"
            value={current.status}
            onChange={(value) => update('status', value)}
            options={STATUS_OPTIONS}
          />
        </div>

        <TagInputField
          label="标签"
          tags={current.tags}
          onChange={(tags) => update('tags', tags)}
          hint="按回车确认一个标签，例如「停车」「效率」。"
        />

        <details className="nb-disclosure">
          <summary className="nb-disclosure__summary">
            <span>
              完善这个念头
              <span className="nb-disclosure__hint">（备注、问题、目标用户、产品形态、项目链接）</span>
            </span>
            <span className="nb-disclosure__chevron" aria-hidden="true">
              <Icon name="chevron" size={18} />
            </span>
          </summary>
          <div className="nb-disclosure__body">
            <TextArea
              label="备注 / 补充思考"
              value={current.notes}
              onChange={(value) => update('notes', value)}
              rows={3}
              placeholder="任何未成形的补充想法都可以先写在这里"
            />
            <TextArea
              label="解决的问题"
              value={current.problem}
              onChange={(value) => update('problem', value)}
              rows={3}
              placeholder="这个念头想解决什么具体问题？"
            />
            <TextField
              label="目标用户"
              value={current.targetUsers}
              onChange={(value) => update('targetUsers', value)}
              placeholder="例如：经常在城市里找车位的通勤族"
            />
            <SelectField
              label="潜在产品形态"
              value={current.productForm}
              onChange={(value) => update('productForm', value)}
              options={PRODUCT_FORM_OPTIONS}
            />
            <TextField
              label="项目链接"
              type="url"
              inputMode="url"
              value={current.projectUrl}
              onChange={(value) => update('projectUrl', value)}
              placeholder="https://github.com/..."
              hint="可以保存 GitHub 仓库或已发布网页的地址。"
            />
          </div>
        </details>

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
              setContentError(null);
              setError(null);
            }}
          >
            撤销修改
          </Button>
          {dirty ? <span className="nb-kv">有未保存的修改</span> : null}
        </div>

        <div className="nb-actionbar">
          {linkedProject ? (
            <Button
              variant="secondary"
              icon="box"
              onClick={() => navigate(paths.project(linkedProject.id))}
            >
              查看关联项目
            </Button>
          ) : (
            <Button
              variant="secondary"
              icon="sparkle"
              onClick={() => {
                void handleUpgrade();
              }}
            >
              升级为创意项目
            </Button>
          )}
          <Button variant="ghost" icon="trash" onClick={() => setPendingDelete(true)}>
            删除
          </Button>
        </div>
      </form>

      <section className="nb-section" aria-labelledby="nb-detail-ai">
        <div className="nb-section__head">
          <h2 className="nb-section__title" id="nb-detail-ai">
            AI 与灵感流转
          </h2>
        </div>
        <div className="nb-card nb-card--pad nb-stack nb-stack--tight">
          <p className="nb-kv">{categorySourceText(idea.categorySource)}</p>
          <div className="nb-actionbar">
            <Button
              size="sm"
              variant="secondary"
              icon="refresh"
              disabled={classifying}
              onClick={() => {
                void handleReclassify();
              }}
            >
              {classifying ? '正在分类…' : '重新分类'}
            </Button>
            <Button size="sm" variant="secondary" icon="sparkle" onClick={() => setAiOpen(true)}>
              交给 AI 工具
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="download"
              onClick={() => navigate(paths.poster(idea.id))}
            >
              生成灵感海报
            </Button>
          </div>
          <p className="nb-kv">
            交给 AI 工具时提示词里会带上念头原文，发送前可以逐字检查并修改；
            灵感海报会先把念头抽象成主题与意象，默认不把原文交给图像模型。
          </p>
        </div>
      </section>

      <AiToolDialog
        open={aiOpen}
        ideas={[idea]}
        source="idea_detail"
        onClose={() => setAiOpen(false)}
      />

      <ConfirmDialog
        open={pendingDelete}
        tone="danger"
        title="删除这条念头？"
        confirmLabel="移到回收站"
        busy={deleting}
        description={
          <p>「{displayTitle(idea)}」会被移到回收站，之后仍可以恢复。未保存的修改也会一起丢弃。</p>
        }
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => {
          void handleDelete();
        }}
      />
    </div>
  );
}
