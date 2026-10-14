/**
 * 「官网 ↔ 应用」对接自检（需要联网，默认在 CI 中不执行）。
 *
 * 检查四件事：
 *   1. 官网的对接契约是否完好：加载了 app-config.js / script.js，
 *      页面上存在 [data-app-link] 入口点；
 *   2. 用真实的 script.js 在 jsdom 里跑一遍：把 app-config.js 的 appStatus
 *      改成 live 并填入 appUrl 之后，所有入口点是否真的指向应用地址；
 *   3. 应用地址（默认 <官网>/app/）是否已经可以访问，且它的 JS / CSS /
 *      图标 / manifest / Service Worker 都能取回，并确认部署的就是念头盒；
 *   4. 当前官网配置的实际状态（已对接 / 仍待对接）。
 *
 * 用法：
 *   node scripts/verify-site-integration.mjs
 *   SITE_URL=https://x.github.io/y/ APP_URL=https://x.github.io/y/app/ node scripts/verify-site-integration.mjs
 */

import { JSDOM } from 'jsdom';

const SITE_URL = (process.env.SITE_URL || 'https://chenzhe223-tech.github.io/niantou-box/').replace(/\/?$/, '/');
const APP_URL = (process.env.APP_URL || SITE_URL + 'app/').replace(/\/?$/, '/');

const lines = [];
const failures = [];
const pending = [];

function ok(label, extra) {
  lines.push('OK    ' + label.padEnd(34) + (extra ? '  ' + extra : ''));
}
function fail(label, detail) {
  lines.push('FAIL  ' + label.padEnd(34) + '  ' + detail);
  failures.push(label + '：' + detail);
}
function wait(label, detail) {
  lines.push('待完成 ' + label.padEnd(34) + '  ' + detail);
  pending.push(label);
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  const text = await response.text();
  return { status: response.status, type: response.headers.get('content-type') || '', text };
}

// ── 1. 官网契约 ────────────────────────────────────────────────
lines.push('── 官网 ' + SITE_URL + ' ──');
let indexHtml;
let scriptJs;
let liveConfig = null;
try {
  const index = await fetchText(SITE_URL);
  const script = await fetchText(SITE_URL + 'script.js');
  const config = await fetchText(SITE_URL + 'app-config.js');
  indexHtml = index.text;
  scriptJs = script.text;

  if (index.status !== 200) fail('官网首页可访问', 'HTTP ' + index.status);
  else ok('官网首页可访问', 'HTTP 200');

  if (script.status !== 200) fail('script.js 可访问', 'HTTP ' + script.status);
  else ok('script.js 可访问', 'HTTP 200');

  if (config.status !== 200) fail('app-config.js 可访问', 'HTTP ' + config.status);
  else {
    ok('app-config.js 可访问', 'HTTP 200');
    const m = config.text.match(/window\.NIANBOX_CONFIG\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
    if (!m) fail('app-config.js 契约结构', '没有找到 window.NIANBOX_CONFIG = Object.freeze({...})');
    else {
      const body = m[1];
      const read = (key) => {
        const km = body.match(new RegExp(key + '\\s*:\\s*("([^"]*)"|([^,}\\n]*))'));
        if (!km) return null;
        return km[2] !== undefined ? km[2] : (km[3] || '').trim();
      };
      liveConfig = { appUrl: read('appUrl'), appLabel: read('appLabel'), appStatus: read('appStatus') };
      const shapeOk = liveConfig.appUrl !== null && liveConfig.appLabel !== null && liveConfig.appStatus !== null;
      if (shapeOk) ok('app-config.js 契约结构', JSON.stringify(liveConfig));
      else fail('app-config.js 契约结构', '缺少 appUrl / appLabel / appStatus 字段之一');
    }
  }

  if (!indexHtml.includes('app-config.js') || !indexHtml.includes('script.js')) {
    fail('官网已加载对接脚本', 'index.html 里缺少 app-config.js 或 script.js');
  } else ok('官网已加载对接脚本', 'app-config.js + script.js');

  const slots = (indexHtml.match(/data-app-link/g) || []).length;
  if (slots > 0) ok('官网存在应用入口点', slots + ' 处 [data-app-link]');
  else fail('官网存在应用入口点', '没有找到 data-app-link');
} catch (error) {
  fail('读取官网', String(error && error.message ? error.message : error));
}

// ── 2. 用真实的 script.js 验证「切到 live 之后」的行为 ──────────
lines.push('── 对接行为（用官网真实的 script.js 在 jsdom 中执行）──');

function runScript(config) {
  const dom = new JSDOM(indexHtml, { url: SITE_URL, runScripts: 'outside-only' });
  dom.window.NIANBOX_CONFIG = Object.freeze(config);
  dom.window.eval(scriptJs);
  const links = [...dom.window.document.querySelectorAll('[data-app-link]')];
  return {
    links: links.map((link) => ({
      href: link.getAttribute('href'),
      target: link.getAttribute('target'),
      rel: link.getAttribute('rel'),
      text: (link.textContent || '').trim(),
    })),
  };
}

if (indexHtml && scriptJs) {
  const appLabel = '打开念头盒 ↗';
  const { links } = runScript({ appUrl: APP_URL, appLabel, appStatus: 'live' });
  const bad = links.filter(
    (link) =>
      link.href !== APP_URL ||
      link.target !== '_blank' ||
      !(link.rel || '').includes('noopener') ||
      !(link.rel || '').includes('noreferrer'),
  );
  if (links.length === 0) fail('入口点指向应用地址', '没有找到 [data-app-link]');
  else if (bad.length === 0) ok('入口点指向应用地址', links.length + ' 处 -> ' + APP_URL);
  else fail('入口点指向应用地址', JSON.stringify(bad[0]));

  const labelsOk = links.every((link) => link.text === appLabel);
  if (labelsOk) ok('入口点按钮文案', appLabel);
  else fail('入口点按钮文案', JSON.stringify(links.map((l) => l.text)));

  // 同时报告线上当前的真实状态。
  if (liveConfig) {
    const current = runScript(liveConfig).links;
    const isLive = liveConfig.appStatus === 'live' && Boolean(liveConfig.appUrl);
    if (isLive) {
      const connected = current.every((link) => link.href === liveConfig.appUrl);
      if (connected) ok('官网当前状态', '已对接 -> ' + liveConfig.appUrl);
      else fail('官网当前状态', 'appStatus=live 但入口点没有全部指向 ' + liveConfig.appUrl);
    } else {
      wait('官网当前状态', '尚未对接（appStatus=' + liveConfig.appStatus + '，入口点仍指向 #capture）');
    }
  }
} else {
  fail('对接行为', '缺少 index.html 或 script.js，无法执行');
}

// ── 3. 应用地址 ────────────────────────────────────────────────
lines.push('── 应用 ' + APP_URL + ' ──');
try {
  const appIndex = await fetchText(APP_URL);
  if (appIndex.status === 404) {
    wait('应用已部署', 'HTTP 404：应用还没有发布到这个地址');
  } else if (appIndex.status !== 200) {
    fail('应用已部署', 'HTTP ' + appIndex.status);
  } else {
    ok('应用已部署', 'HTTP 200，' + appIndex.text.length + ' 字节');

    const isNianBox = appIndex.text.includes('念头盒');
    if (isNianBox) ok('部署内容确为念头盒', 'title/描述包含「念头盒」');
    else fail('部署内容确为念头盒', '首页里没有找到「念头盒」字样');

    const refs = [...appIndex.text.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((url) => url.startsWith('/') && !url.endsWith('/'));
    for (const ref of refs) {
      const r = await fetch(ref.startsWith('http') ? ref : new URL(ref, APP_URL).toString());
      if (r.status === 200) ok('应用资源', ref + '  HTTP 200');
      else fail('应用资源', ref + '  HTTP ' + r.status);
    }

    for (const extra of ['manifest.webmanifest', 'sw.js']) {
      const r = await fetch(APP_URL + extra);
      if (r.status === 200) ok('应用资源', extra + '  HTTP 200');
      else fail('应用资源', extra + '  HTTP ' + r.status);
    }

    const bundleText = await (async () => {
      const jsRefs = refs.filter((ref) => ref.endsWith('.js'));
      let text = '';
      for (const ref of jsRefs) text += await (await fetch(new URL(ref, APP_URL).toString())).text();
      return text;
    })();
    if (bundleText.includes(SITE_URL)) ok('应用到官网的回链', '构建时注入了 ' + SITE_URL);
    else wait('应用到官网的回链', '构建时未注入官网地址（设置页不会显示官网入口）');
  }
} catch (error) {
  fail('检查应用地址', String(error && error.message ? error.message : error));
}

console.log(lines.join('\n'));
console.log('\n失败 ' + failures.length + ' 项，待完成 ' + pending.length + ' 项。');
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(' - ' + f);
  process.exitCode = 1;
}