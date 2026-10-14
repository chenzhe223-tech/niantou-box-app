import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Icon, type IconName } from './Icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  block?: boolean;
  icon?: IconName;
  children?: ReactNode;
  /**
   * React 19 中函数组件可以直接接收 ref，
   * 这里显式声明并透传，方便对话框等场景把焦点放到按钮上。
   */
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  icon,
  className,
  children,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  const classes = [
    'nb-btn',
    `nb-btn--${variant}`,
    size === 'sm' ? 'nb-btn--sm' : null,
    block ? 'nb-btn--block' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export interface IconLinkProps {
  href: string;
  icon: IconName;
  label: string;
  className?: string;
  external?: boolean;
  onClick?: () => void;
}

/** 带无障碍名称的图标链接（用于外链与图标按钮式跳转）。 */
export function IconLink({ href, icon, label, className, external, onClick }: IconLinkProps) {
  return (
    <a
      className={['nb-icon-link', className].filter(Boolean).join(' ')}
      href={href}
      title={label}
      aria-label={label}
      onClick={onClick}
      {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
    >
      <Icon name={icon} size={18} />
    </a>
  );
}
