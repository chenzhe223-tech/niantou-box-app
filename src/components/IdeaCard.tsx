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
  busy?: boolean;
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
  busy = false,
}: IdeaCardProps) {
  const title = displayTitle(idea);
  const excerpt = contentExcerpt(idea);
  const category = categoryLabel(idea.category);

  return (
    <li className={idea.pinned ? 'nb-idea nb-idea--pinned' : 'nb-idea'}>
      <a
        className="nb-idea__link"
        href={paths.idea(idea.id)}
        onClick={(event) => {
          event.preventDefault();
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
      </div>

      <div className="nb-idea__foot">
        <span className="nb-idea__actions">
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
