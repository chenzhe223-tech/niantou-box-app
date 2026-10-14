import { useCallback, useSyncExternalStore } from 'react';
import { parseHash, type Route } from '../app/routes';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function getSnapshot(): string {
  return window.location.hash || '#/';
}

/** 订阅当前哈希路由，并提供跳转方法。 */
export function useHashRoute(): { route: Route; navigate: (hash: string) => void } {
  const hash = useSyncExternalStore(subscribe, getSnapshot, () => '#/');
  const route = parseHash(hash);

  const navigate = useCallback((next: string) => {
    if (window.location.hash === next) return;
    window.location.hash = next;
    // 切换页面时回到顶部，避免长列表滚动位置错乱。
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  return { route, navigate };
}
