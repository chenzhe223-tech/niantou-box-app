import { paths } from '../app/routes';
import { formatRelative } from '../app/format';
import {
  categoryLabel,
  contentExcerpt,
  displayTitle,
  type Idea,
} from '../types/idea';
import { Badge, PinnedBadge, StatusBadge } from './Badge';
import { Button } from './Button';

export interface IdeaCardProps {
  idea: Idea;
  /** 相对时间基准，避免列表渲染过程中反复取当前时间。 */
  now?: number;
  /** 已升级为项目时显示项目名称。 */
  projectName?: string | null;
  /** 演示用的自定义动作，例如从详情页返回列表后高亮。 */
  onOpen: () => void;
  onTogglePin: (idea: Idea) => void;
  onRequestDelete: (idea: Idea) => void;
  /**
   * 直接为这条念头生成图片（PRD 4.1 要求的「每条念头的操作区域」入口）。
   * 可选：不传就不显示这个按钮，避免影响还没接入生图的调用点。
   */
  onGeneratePoster?: (idea: Idea) => void;
  busy?: boolean;
  /**
   * 这条记录是否还没同步到云端（登录后仍留在本机待同步队列里）。
   * 为 true 时在元信息里显示「仅本地」，让用户一眼看出哪几条还没上传。
   */
  pending?: boolean;
  /** 是否处于多选模式（显示复选框）。 */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (idea: Idea) => void;
}

/**
 * 收件箱与首页共用的念头卡片。
 * 只展示最关键的信息（标题/摘要、时间、分类、状态、置顶），不堆叠标签与图标。
 */
export function IdeaCard({
  idea,
  now,
  projectName,
  onOpen,
  onTogglePin,
  onRequestDelete,
  onGeneratePoster,
  busy = false,
  pending = false,
  selectable = false,
  selected = false,
  onToggleSelect,
}: IdeaCardProps) {
  const title = displayTitle(idea);
  const excerpt = contentExcerpt(idea);
  const category = categoryLabel(idea.category);
  const className = [
    'nb-idea',
    idea.pinned ? 'nb-idea--pinned' : null,
    selected ? 'nb-idea--selected' : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className={className}>
      {selectable ? (
        <label className="nb-idea__check">
          <input
            type="checkbox"
            className="nb-idea__checkbox"
            checked={selected}
            onChange={() => onToggleSelect?.(idea)}
          />
          <span className="nb-visually-hidden">
            {selected ? '取消选择' : '选择'}
            {title}
          </span>
        </label>
      ) : null}

      <a
        className="nb-idea__link"
        href={paths.idea(idea.id)}
        onClick={(event) => {
          event.preventDefault();
          // 多选模式下点卡片是「选/取消选」，不跳转，避免误触打断批量操作。
          if (selectable) {
            onToggleSelect?.(idea);
            return;
          }
          onOpen();
        }}
      >
        <span className="nb-idea__title">{title}</span>
        {excerpt && excerpt !== title ? (
          <span className="nb-idea__excerpt">{excerpt}</span>
        ) : null}
      </a>

      <div className="nb-idea__meta">
        <span>{formatRelative(idea.createdAt, now)}</span>
        <span>{category ?? '未分类'}</span>
        <StatusBadge status={idea.status} />
        {idea.pinned ? <PinnedBadge /> : null}
        {projectName ? <Badge tone="outline">项目：{projectName}</Badge> : null}
        {pending ? <Badge tone="pending">仅本地</Badge> : null}
      </div>

      <div className="nb-idea__foot">
        <span className="nb-idea__actions">
          {onGeneratePoster ? (
            <Button
              size="sm"
              variant="ghost"
              icon="image"
              disabled={busy}
              onClick={() => onGeneratePoster(idea)}
            >
              生成图片
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon="pin"
            disabled={busy}
            onClick={() => onTogglePin(idea)}
          >
            {idea.pinned ? '取消置顶' : '置顶'}
          </Button>
          <Button size="sm" variant="ghost" icon="edit" disabled={busy} onClick={onOpen}>
            编辑
          </Button>
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon="trash"
          disabled={busy}
          onClick={() => onRequestDelete(idea)}
        >
          删除
        </Button>
      </div>
    </li>
  );
}
