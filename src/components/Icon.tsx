import type { ReactNode } from 'react';

export type IconName =
  | 'home'
  | 'inbox'
  | 'box'
  | 'gear'
  | 'search'
  | 'pin'
  | 'trash'
  | 'edit'
  | 'back'
  | 'plus'
  | 'download'
  | 'upload'
  | 'check'
  | 'close'
  | 'refresh'
  | 'external'
  | 'sparkle'
  | 'chevron'
  | 'archive';

const ICONS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M3.5 10.6 12 3.8l8.5 6.8" />
      <path d="M5.8 9.6V20h12.4V9.6" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 12.8h4.2l1.5 2.7h5.6l1.5-2.7h4.2" />
      <path d="M5.6 5.2h12.8l2.1 7.6V19H3.5v-6.2z" />
    </>
  ),
  box: (
    <>
      <path d="M12 3.4 20.4 8v8L12 20.6 3.6 16V8z" />
      <path d="M3.6 8 12 12.6 20.4 8" />
      <path d="M12 12.6V20.6" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.6v2.2M12 18.2v2.2M4.8 7.8l1.9 1.1M17.3 15.1l1.9 1.1M4.8 16.2l1.9-1.1M17.3 8.9l1.9-1.1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.6 15.6 4.2 4.2" />
    </>
  ),
  pin: (
    <>
      <path d="M12 13.8V20" />
      <path d="M8 4.4h8l-1.1 5.2 2.6 2.6H6.5l2.6-2.6z" />
    </>
  ),
  trash: (
    <>
      <path d="M4.8 6.8h14.4" />
      <path d="M9.4 6.8V4.6h5.2v2.2" />
      <path d="M6.6 6.8 7.4 20h9.2l.8-13.2" />
      <path d="M10.4 10.4v6M13.6 10.4v6" />
    </>
  ),
  edit: (
    <>
      <path d="M5 19h3.2L19 8.2 15.8 5 5 15.8z" />
      <path d="M14.4 6.4 17.6 9.6" />
    </>
  ),
  back: (
    <>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5.5v13M5.5 12h13" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.5v10" />
      <path d="m7.8 10.6 4.2 4.2 4.2-4.2" />
      <path d="M4.8 19.5h14.4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 14.8V4.6" />
      <path d="m7.8 8.8 4.2-4.2 4.2 4.2" />
      <path d="M4.8 19.5h14.4" />
    </>
  ),
  check: (
    <>
      <path d="m5.5 12.6 4.4 4.4 8.6-9.4" />
    </>
  ),
  close: (
    <>
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </>
  ),
  refresh: (
    <>
      <path d="M19 12a7 7 0 1 1-2.3-5.2" />
      <path d="M19 4.6v3.6h-3.6" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.8h5.2V10" />
      <path d="M19.2 4.8 12 12" />
      <path d="M17.6 14.2V19H5V6.4h4.8" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 4.2 13.4 9l4.8 1.4-4.8 1.4L12 16.6l-1.4-4.8L5.8 10.4 10.6 9z" />
      <path d="M18.4 16.4l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z" />
    </>
  ),
  chevron: (
    <>
      <path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
    </>
  ),
  archive: (
    <>
      <path d="M4.4 6.4h15.2v3.2H4.4z" />
      <path d="M5.6 9.6V19h12.8V9.6" />
      <path d="M10 13h4" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** 传入后会作为无障碍名称（title）渲染，否则图标对辅助技术隐藏。 */
  label?: string;
}

export function Icon({ name, size = 20, className, label }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {label ? <title>{label}</title> : null}
      {ICONS[name]}
    </svg>
  );
}
