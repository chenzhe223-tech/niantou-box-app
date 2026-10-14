/**
 * 念头盒 Service Worker。
 *
 * 设计原则：
 * 1. 只在同源、GET 请求上工作，绝不缓存或改写任何数据请求；
 * 2. 导航请求使用「网络优先 + 缓存兜底」，保证在线时总能拿到最新版本，
 *    不会出现因为缓存了旧资源导致应用打不开的情况；
 *    导航请求显式带 `cache: 'no-cache'`，向服务器做一次条件校验（通常是 304），
 *    这样新版本一发布，用户下一次刷新就能看到，而不用等浏览器 HTTP 缓存自然过期；
 * 3. 静态资源使用 stale-while-revalidate，命中缓存即可离线打开界面；
 * 4. 所有缓存操作都做了容错，安装失败也不会阻塞应用启动。
 *
 * 版本策略：改动缓存逻辑或需要让所有用户强制换新时，把 CACHE_VERSION 加一。
 * 旧缓存会在 activate 阶段被清理。
 */

const CACHE_VERSION = 'v4';
const CACHE_NAME = `nianbox-${CACHE_VERSION}`;

/** 使用相对地址，保证部署在 /<repo>/ 这类子路径下依然正确。 */
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 逐个添加：个别资源缺失不应让整个安装失败。
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (error) {
            console.warn('[NianBox SW] 预缓存跳过：', url, error);
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('nianbox-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

/** 是否处理这个请求：只处理同源 GET，跳过扩展协议与跨域接口。 */
function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return true;
}

/**
 * 是否是「应用外壳」地址（目录根或 index.html）。
 *
 * 只有外壳地址才允许写进 index.html 缓存。否则用浏览器打开 admin.html
 * （运营看板，同一域名下的独立页面）时，会把它的 HTML 覆盖到应用外壳缓存里，
 * 之后离线打开应用就会拿到看板页面。
 */
function isAppShellUrl(url) {
  const path = url.pathname;
  return path.endsWith('/') || path.endsWith('/index.html');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheableRequest(request)) return;

  // 页面导航：网络优先，离线时回退到缓存中的应用外壳。
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // `cache: 'no-cache'` 会强制向服务器做一次条件请求（命中 ETag 时返回 304），
          // 只丢掉浏览器的 HTTP 缓存、不影响离线能力，代价只有一次极小的校验。
          const response = await fetch(request, { cache: 'no-cache' });
          if (isAppShellUrl(new URL(request.url))) {
            const cache = await caches.open(CACHE_NAME);
            cache.put('./index.html', response.clone()).catch(() => undefined);
          }
          return response;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const cached =
            (await cache.match('./index.html')) ||
            (await cache.match('./')) ||
            (await cache.match(request));
          if (cached) return cached;
          return new Response('离线状态，且本地还没有缓存的应用界面。', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  // 静态资源：先返回缓存，同时后台更新。
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            cache.put(request, response.clone()).catch(() => undefined);
          }
          return response;
        })
        .catch(() => undefined);

      return cached || (await network) || Response.error();
    })(),
  );
});
