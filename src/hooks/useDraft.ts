import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_PREFIX = 'nianbox.draft.';

function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(key: string, value: string): void {
  try {
    if (value.trim() === '') {
      window.localStorage.removeItem(STORAGE_PREFIX + key);
    } else {
      window.localStorage.setItem(STORAGE_PREFIX + key, value);
    }
  } catch {
    // 隐私模式下 localStorage 可能不可用，草稿功能静默降级。
  }
}

export interface DraftState {
  value: string;
  setValue: (next: string) => void;
  /** 是否是从上次未保存内容中恢复出来的。 */
  restored: boolean;
  /** 主动放弃草稿（用户点了「丢弃」）。 */
  discard: () => void;
  /** 保存成功后清理草稿。 */
  clear: () => void;
}

/**
 * 未保存内容的本地草稿：刷新或误关页面后可以恢复，
 * 但正常保存时不会弹出任何确认框。
 */
export function useDraft(key: string): DraftState {
  const [value, setValueState] = useState('');
  const [restored, setRestored] = useState(false);
  const initialised = useRef(false);

  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    const stored = readDraft(key);
    if (stored.trim() !== '') {
      setValueState(stored);
      setRestored(true);
    }
  }, [key]);

  useEffect(() => {
    if (!initialised.current) return;
    const timer = window.setTimeout(() => writeDraft(key, value), 250);
    return () => window.clearTimeout(timer);
  }, [key, value]);

  const setValue = useCallback((next: string) => {
    setValueState(next);
  }, []);

  const discard = useCallback(() => {
    setValueState('');
    setRestored(false);
    writeDraft(key, '');
  }, [key]);

  const clear = useCallback(() => {
    setValueState('');
    setRestored(false);
    writeDraft(key, '');
  }, [key]);

  return { value, setValue, restored, discard, clear };
}
