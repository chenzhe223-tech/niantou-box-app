/**
 * 把一键部署的结果写回 GitHub 仓库变量（CI 里由 .github/workflows/deploy-telemetry.yml 调用）。
 * 零依赖，只用 Node 内置 fetch —— 不需要 jq、不需要 curl、不需要本地安装任何东西。
 *
 *   node server/write-repo-vars.mjs <deploy-result.json> [--dry]
 *
 * 环境变量：
 *   GH_TOKEN           写仓库变量用的令牌（工作流里是 secrets.GITHUB_TOKEN）
 *   GITHUB_REPOSITORY  owner/repo（Actions 自动注入；本地测试时手动给）
 *   DEV_DASHBOARD      可选，原样写进同名变量（1 = 打开应用内开发者看板入口）
 *
 * 只写「只能写」的令牌，读取令牌从不经过这里（它只存在你自己的 GitHub secret 与 Worker 密钥里）。
 */

process.env.NO_PROXY = '*';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.ALL_PROXY;

import fs from 'node:fs';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const resultPath = argv.find((a) => !a.startsWith('--'));
if (!resultPath) throw new Error('用法：node server/write-repo-vars.mjs <deploy-result.json> [--dry]');

const token = (process.env.GH_TOKEN || '').trim();
if (!token) throw new Error('缺少 GH_TOKEN 环境变量');
const repo = (process.env.GITHUB_REPOSITORY || '').trim();
if (!repo.includes('/')) throw new Error('缺少 GITHUB_REPOSITORY（形如 owner/repo）');

const API = `https://api.github.com/repos/${repo}/actions/variables`;
const headers = {
  authorization: 'Bearer ' + token,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
  'user-agent': 'nianbox-write-vars',
  'x-github-api-version': '2022-11-28',
};

async function call(method, url, body, attempt = 0) {
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 2500));
      return call(method, url, body, attempt + 1);
    }
    throw new Error(`网络失败 ${method} ${url}: ${e.message}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, ok: res.ok, json, text };
}

async function setVariable(name, value) {
  if (dry) {
    const probe = await call('GET', `${API}/${name}`);
    console.log(`[--dry] ${name}：读取当前值 -> HTTP ${probe.status}（200=已存在且可读，404=不存在或没有读权限）`);
    return true;
  }
  // 先按「已存在」更新，404 再按「新建」提交；这样不依赖「读变量」的权限。
  const patched = await call('PATCH', `${API}/${name}`, { value });
  if (patched.ok) {
    console.log(`已更新仓库变量：${name}`);
    return true;
  }
  if (patched.status !== 404) {
    console.log(`更新 ${name} 失败：HTTP ${patched.status} ${patched.text.slice(0, 160)}`);
  }
  const created = await call('POST', API, { name, value });
  if (created.ok) {
    console.log(`已新建仓库变量：${name}`);
    return true;
  }
  console.log(`创建 ${name} 失败：HTTP ${created.status} ${created.text.slice(0, 160)}`);
  return false;
}

async function main() {
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const endpoint = String(result.endpoint || '').trim();
  const ingestKey = String(result.ingestKey || '').trim();
  if (!endpoint.startsWith('http') || ingestKey.length < 16) {
    throw new Error('部署结果文件里缺少接口地址或写入令牌，请先跑 server/deploy-telemetry.mjs。');
  }

  const jobs = [
    ['TELEMETRY_ENDPOINT', endpoint],
    ['TELEMETRY_KEY', ingestKey],
  ];
  const devDashboard = (process.env.DEV_DASHBOARD || '').trim();
  if (devDashboard) jobs.push(['DEV_DASHBOARD', devDashboard]);

  let allOk = true;
  for (const [name, value] of jobs) {
    const ok = await setVariable(name, value);
    if (!ok) allOk = false;
  }

  console.log('');
  console.log('接口地址：' + endpoint);
  console.log('写入令牌（本来就会随应用发布到公开产物里，因此不是秘密）：' + ingestKey);

  if (!allOk) {
    console.log('');
    console.log('::warning::上面有变量没能自动写入。请在仓库 Settings → Secrets and variables →');
    console.log(`::warning::Actions → Variables 里手动新建同名变量，值用上面刚打印的两行；`);
    console.log('::warning::或者用命令行：gh variable set TELEMETRY_ENDPOINT --repo ' + repo + ' --body "' + endpoint + '"');
    process.exitCode = 1;
  }
}

await main();
