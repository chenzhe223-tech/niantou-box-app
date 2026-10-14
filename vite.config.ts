import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * GitHub Pages 部署在子路径（例如 https://<user>.github.io/niantou-box/）下，
 * 因此 base 必须可配置，绝不能硬编码某个用户名。
 *
 * - 本地开发 / 预览：默认 '/'
 * - GitHub Actions 部署：BASE_PATH=/<仓库名>/
 */
const basePath = process.env.BASE_PATH?.trim() || '/';

export default defineConfig({
  base: basePath,
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
