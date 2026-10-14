/**
 * 极简哈希路由。
 *
 * 选择哈希路由的原因：GitHub Pages 是静态托管，刷新子路径时不会做服务端重写。
 * 使用 `#/inbox` 这类地址可以保证「刷新后路由依然正常」，无需 404.html 兜底。
 */

export type Route =
  | { name: 'home' }
  | { name: 'inbox' }
  | { name: 'idea'; id: string }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'trash' }
  | { name: 'settings' };

export const paths = {
  home: '#/',
  inbox: '#/inbox',
  idea: (id: string) => `#/idea/${encodeURIComponent(id)}`,
  projects: '#/projects',
  project: (id: string) => `#/project/${encodeURIComponent(id)}`,
  trash: '#/trash',
  settings: '#/settings',
} as const;

export function parseHash(hash: string): Route {
  const cleaned = hash.replace(/^#/, '').replace(/^\/+/, '');
  const segments = cleaned.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) return { name: 'home' };

  const [first, second] = segments;
  switch (first) {
    case 'inbox':
      return { name: 'inbox' };
    case 'projects':
      if (second) return { name: 'project', id: decodeURIComponent(second) };
      return { name: 'projects' };
    case 'project':
      return second ? { name: 'project', id: decodeURIComponent(second) } : { name: 'projects' };
    case 'idea':
      return second ? { name: 'idea', id: decodeURIComponent(second) } : { name: 'inbox' };
    case 'trash':
      return { name: 'trash' };
    case 'settings':
      return { name: 'settings' };
    default:
      // 未知地址回到首页，避免出现白屏。
      return { name: 'home' };
  }
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return paths.home;
    case 'inbox':
      return paths.inbox;
    case 'idea':
      return paths.idea(route.id);
    case 'projects':
      return paths.projects;
    case 'project':
      return paths.project(route.id);
    case 'trash':
      return paths.trash;
    case 'settings':
      return paths.settings;
  }
}
