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
  | { name: 'settings' }
  | { name: 'feedback' }
  | { name: 'cloud' }
  | { name: 'poster'; id: string }
  | { name: 'posterTool' }
  | { name: 'works' }
  | { name: 'dev' };

export const paths = {
  home: '#/',
  inbox: '#/inbox',
  idea: (id: string) => `#/idea/${encodeURIComponent(id)}`,
  projects: '#/projects',
  project: (id: string) => `#/project/${encodeURIComponent(id)}`,
  trash: '#/trash',
  settings: '#/settings',
  feedback: '#/feedback',
  cloud: '#/cloud',
  poster: (id: string) => `#/poster/${encodeURIComponent(id)}`,
  posterTool: '#/poster',
  works: '#/works',
  dev: '#/dev',
} as const;

export function parseHash(hash: string): Route {
  // Ignore transient query parameters embedded in hash routes, such as password-reset tokens.
  const rawPath = hash.replace(/^#/, '').split('?')[0] ?? '';
  const cleaned = rawPath.replace(/^\/+/, '');
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
    case 'poster':
      // 带 ID 时针对某一条念头生成海报；不带 ID 时进入海报工具页（可从里面再选念头）。
      return second
        ? { name: 'poster', id: decodeURIComponent(second) }
        : { name: 'posterTool' };
    case 'trash':
      return { name: 'trash' };
    case 'settings':
      return { name: 'settings' };
    case 'cloud':
      return { name: 'cloud' };
    case 'feedback':
      return { name: 'feedback' };
    case 'works':
      return { name: 'works' };
    case 'dev':
      return { name: 'dev' };
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
    case 'poster':
      return paths.poster(route.id);
    case 'posterTool':
      return paths.posterTool;
    case 'projects':
      return paths.projects;
    case 'project':
      return paths.project(route.id);
    case 'trash':
      return paths.trash;
    case 'settings':
      return paths.settings;
    case 'cloud':
      return paths.cloud;
    case 'feedback':
      return paths.feedback;
    case 'works':
      return paths.works;
    case 'dev':
      return paths.dev;
  }
}
