/**
 * 手机软键盘顶起的高度 —— 用来让输入框和按钮不被键盘挡住。
 *
 * 做法只有一件事：把「窗口高度 - 可视区高度 - 可视区偏移」写成 CSS 变量
 * `--nb-keyboard`，并在键盘明显弹起时给 <html> 打上 data-nb-keyboard="open"。
 * 具体留多少下边距、要不要收起底部导航，都在 global.css 里决定。
 *
 * 只读取尺寸，不读取内容；浏览器没有 visualViewport 时（桌面端大多数情况）
 * 直接不注册，行为与改动前完全一致。
 */

import { useEffect } from 'react';

/** 键盘高度超过这个值才认为是「键盘弹起」，避免地址栏收缩被误判。 */
const KEYBOARD_THRESHOLD = 80;

export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = typeof window === 'undefined' ? undefined : window.visualViewport;
    if (!viewport) return;

    const root = document.documentElement;

    const update = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      root.style.setProperty('--nb-keyboard', `${Math.round(inset)}px`);
      if (inset > KEYBOARD_THRESHOLD) {
        root.dataset.nbKeyboard = 'open';
      } else {
        delete root.dataset.nbKeyboard;
      }
    };

    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--nb-keyboard');
      delete root.dataset.nbKeyboard;
    };
  }, []);
}
