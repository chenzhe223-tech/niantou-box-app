import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon = 'sparkle', title, description, action }: EmptyStateProps) {
  return (
    <div className="nb-empty">
      <span className="nb-empty__icon" aria-hidden="true">
        <Icon name={icon} size={28} />
      </span>
      <p className="nb-empty__title">{title}</p>
      {description ? <p className="nb-empty__description">{description}</p> : null}
      {action ? <div className="nb-empty__action">{action}</div> : null}
    </div>
  );
}
