/**
 * 官网对接测试。
 *
 * 应用与官网之间的约定只有一条：构建时注入 VITE_OFFICIAL_SITE_URL。
 * 这里验证三种情况都得到正确结果——已配置、未配置、配置了非法地址，
 * 确保不会出现「看起来能点、其实是假入口」的链接。
 */

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { getOfficialSiteUrl } from './app/siteConfig';

/** 在设置页渲染整个应用（使用真实的哈希路由与数据层）。 */
function renderSettings() {
  window.location.hash = '#/settings';
  return render(<App />);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('siteConfig：官网地址解析', () => {
  it('接受 http/https 绝对地址，并补齐结尾斜杠', () => {
    vi.stubEnv('VITE_OFFICIAL_SITE_URL', 'https://chenzhe223-tech.github.io/niantou-box');
    expect(getOfficialSiteUrl()).toBe('https://chenzhe223-tech.github.io/niantou-box/');
    vi.stubEnv('VITE_OFFICIAL_SITE_URL', 'https://chenzhe223-tech.github.io/niantou-box/');
    expect(getOfficialSiteUrl()).toBe('https://chenzhe223-tech.github.io/niantou-box/');
    vi.stubEnv('VITE_OFFICIAL_SITE_URL', '  http://localhost:4173/  ');
    expect(getOfficialSiteUrl()).toBe('http://localhost:4173/');
  });

  it('忽略空值、相对路径与伪协议', () => {
    for (const bad of ['', '   ', '/niantou-box/', 'niantou-box', 'javascript:alert(1)', '起点']) {
      vi.stubEnv('VITE_OFFICIAL_SITE_URL', bad);
      expect(getOfficialSiteUrl()).toBe('');
    }
  });
});

describe('设置页与官网的对接', () => {
  it('注入了官网地址时，设置页给出真实可点的官网链接', async () => {
    vi.stubEnv('VITE_OFFICIAL_SITE_URL', 'https://chenzhe223-tech.github.io/niantou-box/');
    renderSettings();

    expect(await screen.findByText('关于念头盒')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /打开官网首页/ });
    expect(link).toHaveAttribute('href', 'https://chenzhe223-tech.github.io/niantou-box/');
    // 外链必须新开标签页，并带上 noopener/noreferrer。
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('未注入官网地址时，不渲染任何指向官网的入口', async () => {
    vi.stubEnv('VITE_OFFICIAL_SITE_URL', '');
    renderSettings();

    await screen.findByRole('heading', { level: 1, name: '设置' });
    expect(screen.queryByText('关于念头盒')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /打开官网首页/ })).not.toBeInTheDocument();
  });

  it('注入了非法地址时同样不渲染，避免假入口', async () => {
    vi.stubEnv('VITE_OFFICIAL_SITE_URL', 'javascript:alert(1)');
    renderSettings();

    await screen.findByRole('heading', { level: 1, name: '设置' });
    expect(screen.queryByRole('link', { name: /打开官网首页/ })).not.toBeInTheDocument();
  });
});