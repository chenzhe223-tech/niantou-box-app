import { useEffect, useRef, type ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  title: string;
  /** 标题下的一句话说明，用来说明这个弹层会做什么、不会做什么。 */
  lead?: ReactNode;
  children: ReactNode;
  /** 底部操作区；不传则只有关闭按钮。 */
  footer?: ReactNode;
  onClose: () => void;
  /** 是否允许点击遮罩关闭（处理中的动作应设为 false，避免误触丢状态）。 */
  dismissOnBackdrop?: boolean;
  size?: 'md' | 'lg';
}

/**
 * 通用弹层：Esc 关闭、点击遮罩关闭、打开后把焦点移进面板。
 *
 * 与 ConfirmDialog 的区别是内容完全由调用方决定，用于「邮件预填」
 * 「交给 AI 工具」「生成灵感海报」这类需要展示较多内容与表单的场景。
 */
export function Dialog({
  open,
  title,
  lead,
  children,
  footer,
  onClose,
  dismissOnBackdrop = true,
  size = 'md',
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const element = previouslyFocused.current;
      if (element instanceof HTMLElement) element.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="nb-dialog" role="presentation" onClick={dismissOnBackdrop ? onClose : undefined}>
      <div
        ref={panelRef}
        className={size === 'lg' ? 'nb-dialog__panel nb-dialog__panel--lg' : 'nb-dialog__panel'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="nb-dialog__title">{title}</h2>
        {lead ? <p className="nb-dialog__lead">{lead}</p> : null}
        <div className="nb-dialog__body">{children}</div>
        <div className="nb-dialog__actions">{footer}</div>
      </div>
    </div>
  );
}
