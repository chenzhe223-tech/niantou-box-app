/**
 * 品牌设计系统守护测试 —— 对应《NianBox 品牌视觉系统统一规范》。
 *
 * 把「规范」变成可执行的约束，避免后续新增页面时又写出相近但不一致的色值：
 *   1. 品牌固定色值必须与规范逐字一致（13 个基础色 + 品牌星形色）；
 *   2. 色值只允许出现在 global.css 的 :root（第 1 / 2 层变量）里，组件层不得硬编码；
 *   3. 组件层只能引用第 2 层 --nb-* 语义别名，不得直接引用第 1 层 --color-*；
 *   4. 禁用 color-mix()（部分微信内置浏览器内核不支持，会让半透明栏整体丢色）；
 *   5. 品牌星形必须是内联 / 独立 SVG，禁止用 Unicode 星形字符代替
 *      （那些字符在 iOS Safari 与微信内置浏览器里会落到系统 Emoji 字体上）；
 *   6. TS / TSX 源码里不允许出现裸色值。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * 去掉注释，只留下真正会被解析 / 渲染的代码。
 * 注意：CSS 里的通配选择器（`*`、`*::before`）不是注释，不能被误删，
 * 所以这里只删「块注释」和「// 行注释」，并且 `//` 前面不能是冒号，避免误伤 https://。
 */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const GLOBAL_CSS = () => read('src/styles/global.css');

/** global.css 的 :root 变量区（第 1、2 层定义）与其余（组件层）分开。 */
function splitCss() {
  const lines = GLOBAL_CSS().split(/\r?\n/);
  const end = lines.findIndex((line) => line.trim() === '}');
  if (end < 0) throw new Error('global.css 里找不到 :root 的结束大括号');
  return { variables: lines.slice(0, end + 1).join('\n'), components: lines.slice(end + 1).join('\n') };
}

/** 规范固定色值（用户给定的 13 个品牌色 + 品牌星形色），一字不改。 */
const BRAND_TOKENS: Record<string, string> = {
  '--color-brand': '#7759dd',
  '--color-brand-hover': '#6849cc',
  '--color-brand-soft': '#e7ddff',
  '--color-bg': '#f8f6f1',
  '--color-surface': '#fffefa',
  '--color-text': '#24221f',
  '--color-text-muted': '#77736d',
  '--color-border': '#dedbd3',
  '--color-mint': '#dff1df',
  '--color-yellow': '#f6e7a8',
  '--color-peach': '#f6d8c8',
  '--color-positive': '#538251',
  '--color-positive-soft': '#e4f2df',
  '--color-star': '#fff9e9',
};

/** 需要遍历的源码文件（不含测试文件本身）。 */
function sourceFiles(dir = 'src'): string[] {
  return (fs.readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' }) as string[])
    .map((rel) => `${dir}/${rel.split(path.sep).join('/')}`)
    .filter((rel) => /\.(ts|tsx|css)$/.test(rel) && !/\.test\.tsx?$/.test(rel));
}

describe('品牌色表', () => {
  it('14 个规范固定色值与规范逐字一致', () => {
    const css = GLOBAL_CSS();
    for (const [token, value] of Object.entries(BRAND_TOKENS)) {
      const found = css.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
      expect(found?.[1]?.trim().toLowerCase(), `${token} 的定义`).toBe(value);
    }
  });

  it('第 2 层 --nb-* 语义别名不写死色值（只引用第 1 层变量，或 rgba(var(--rgb-*), α)）', () => {
    const { variables } = splitCss();
    const aliases = variables.match(/--nb-[a-z0-9-]+\s*:\s*([^;]+);/gi) ?? [];
    expect(aliases.length).toBeGreaterThan(40);
    const literals = aliases.filter((entry) => /#[0-9a-f]{3,8}|rgba?\(\s*[0-9]/i.test(entry));
    expect(literals).toEqual([]);
  });
});

describe('颜色集中管理', () => {
  it('组件层没有任何裸色值（hex / rgb() / color-mix()）', () => {
    const { components } = splitCss();
    expect(components.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    // 允许 rgba(var(--rgb-*), α) 这种变量驱动透明度；禁止写死数字的 rgb() / rgba()。
    expect(components.match(/\brgba?\(\s*[0-9]/g) ?? []).toEqual([]);
    expect(stripComments(components)).not.toContain('color-mix(');
  });

  it('组件层不直接引用第 1 层 --color-*，只引用 --nb-* 语义别名', () => {
    const { components } = splitCss();
    const direct = components.match(/var\(\s*--color-[a-z0-9-]+/gi) ?? [];
    expect(direct).toEqual([]);
  });

  it('所有 var() 引用的变量都已定义，大括号配平', () => {
    const css = GLOBAL_CSS();
    const defined = new Set(
      (css.match(/--[a-z0-9-]+(?=\s*:)/gi) ?? []).map((name) => name.toLowerCase()),
    );
    const used = new Set((css.match(/var\(\s*(--[a-z0-9-]+)/gi) ?? []).map((m) => m.replace(/var\(\s*/i, '').toLowerCase()));
    const missing = [...used].filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
    const stripped = stripComments(css);
    expect((stripped.match(/{/g) ?? []).length).toBe((stripped.match(/}/g) ?? []).length);
  });

  it('TS / TSX 源码里没有裸色值', () => {
    const offenders = sourceFiles()
      .filter((rel) => /\.tsx?$/.test(rel))
      .flatMap((rel) => {
        const hits = read(rel).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
        return hits.map((hit) => `${rel}: ${hit}`);
      });
    expect(offenders).toEqual([]);
  });
});

describe('品牌图形', () => {
  it('品牌星形由 SVG 绘制，且不在代码 / 标记里使用 Unicode 星形字符', () => {
    const STARS = /[\u2726\u2727\u2731\u2733\u2734\u2739\u273a\u2605\u2606\u2b50]/;
    const targets = [...sourceFiles(), 'index.html', 'public/favicon.svg', 'public/manifest.webmanifest'];
    const offenders = targets.filter((rel) => STARS.test(stripComments(read(rel))));
    expect(offenders).toEqual([]);
  });

  it('BrandMark 导出品牌星形路径与缩放，favicon 与品牌紫保持一致', () => {
    const mark = read('src/components/BrandMark.tsx');
    expect(mark).toContain('BRAND_STAR_PATH');
    expect(mark).toContain('BRAND_STAR_SCALE');
    expect(mark).toContain('viewBox="0 0 96 96"');
    expect(mark).toMatch(/M48 5 57 35/);

    const favicon = read('public/favicon.svg');
    expect(favicon).toContain('viewBox="0 0 96 96"');
    expect(favicon.toLowerCase()).toContain('#7759dd');
    expect(favicon.toLowerCase()).toContain('#fff9e9');
    expect(favicon).toMatch(/M48 5 57 35/);

    // 应用顶栏的品牌标志必须走 BrandMark，而不是直接写字符或色块。
    expect(read('src/App.tsx')).toContain('<BrandMark');
  });
});
