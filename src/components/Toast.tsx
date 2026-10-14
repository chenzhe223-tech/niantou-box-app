import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastInput {
  message: string;
  tone?: ToastTone;
  /** 毫秒；0 表示需要用户手动关闭。 */
  duration?: number;
}

interface ToastItem extends Required<Omit<ToastInput, 'duration'>> {
  id: number;
  duration: number;
}

interface ToastContextValue {
  push: (input: ToastInput | string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (input: ToastInput | string) => {
      const payload: ToastInput = typeof input === 'string' ? { message: input } : input;
      const item: ToastItem = {
        id: nextId.current++,
        message: payload.message,
        tone: payload.tone ?? 'info',
        duration: payload.duration ?? (payload.tone === 'error' ? 6000 : 3200),
      };
      setToasts((current) => [...current.slice(-2), item]);
      if (item.duration > 0) {
        const timer = window.setTimeout(() => dismiss(item.id), item.duration);
        timers.current.set(item.id, timer);
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const timerMap = timers.current;
    return () => {
      for (const timer of timerMap.values()) window.clearTimeout(timer);
      timerMap.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="nb-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`nb-toast nb-toast--${toast.tone}`}>
            <span className="nb-toast__icon" aria-hidden="true">
              {toast.tone === 'success' ? <Icon name="check" size={16} /> : null}
              {toast.tone === 'error' ? <Icon name="close" size={16} /> : null}
              {toast.tone === 'info' ? <Icon name="sparkle" size={16} /> : null}
            </span>
            <span className="nb-toast__text">{toast.message}</span>
            <button
              type="button"
              className="nb-toast__close"
              onClick={() => dismiss(toast.id)}
              aria-label="关闭提示"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }
  return context;
}
