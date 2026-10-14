import { Icon } from './Icon';
import {
  categoryLabel,
  statusLabel,
  statusTone,
  type IdeaCategory,
  type IdeaStatus,
} from '../types/idea';

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: string;
  className?: string;
}) {
  return <span className={['nb-badge', `nb-badge--${tone}`, className].filter(Boolean).join(' ')}>{children}</span>;
}

export function StatusBadge({ status }: { status: IdeaStatus }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}

export function CategoryBadge({ category }: { category: IdeaCategory | null }) {
  const label = categoryLabel(category);
  if (!label) return <Badge tone="muted">未分类</Badge>;
  return <Badge tone="outline">{label}</Badge>;
}

export function PinnedBadge() {
  return (
    <Badge tone="pinned">
      <Icon name="pin" size={12} />
      已置顶
    </Badge>
  );
}
