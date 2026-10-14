import { useEffect, useState } from 'react';

/** 返回一个按需刷新的时间戳，用于「刚刚 / 3 分钟前」这类相对时间展示。 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}
