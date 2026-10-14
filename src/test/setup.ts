/**
 * Vitest 全局配置：
 * - 使用 fake-indexeddb 在 Node 环境中模拟真实的 IndexedDB；
 * - 每个用例开始前重置数据库与 localStorage，避免用例之间互相影响；
 * - 用例结束后卸载已渲染的 React 树。
 */

import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { closeDatabase, deleteDatabase } from '../services/idb';

// jsdom 未实现 window.scrollTo，这里用空实现替代，避免出现无意义的报错。
if (typeof window !== 'undefined') {
  window.scrollTo = () => undefined;
}

beforeEach(async () => {
  await closeDatabase();
  await deleteDatabase();
  try {
    window.localStorage.clear();
  } catch {
    // 忽略隐私模式下的异常。
  }
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
});
