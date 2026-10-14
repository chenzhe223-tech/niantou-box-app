/**
 * 应用入口。
 *
 * 注意：Service Worker 只在生产构建中注册，开发环境保持干净；
 * 注册失败不会影响应用启动（离线能力降级，但记录依然可用）。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('找不到挂载节点 #root，页面结构可能已损坏。');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL || '/';
    void navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .catch((error: unknown) => {
        // 离线能力不可用不影响核心功能，这里只做提示。
        console.warn('Service Worker 注册失败，离线访问可能不可用。', error);
      });
  });
}
