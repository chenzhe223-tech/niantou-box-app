import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    /**
     * 说明：使用 worker_threads 而不是 child_process fork。
     * 这样测试运行时不需要再派生新的子进程，在受限环境（无法 fork）
     * 与普通本地/CI 环境下都能稳定工作。
     */
    pool: 'threads',
    fileParallelism: false,
  },
});
