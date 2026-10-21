/**
 * 用 Cloudflare REST API 一步部署念头盒的云端同步后端（不需要 wrangler、不需要子进程）。
 *
 * 本地用法（在仓库根目录）：
 *   $env:CF_API_TOKEN = "<Cloudflare API Token>"
 *   node server/deploy-cloud.mjs [--dry] [--sub=<workers.dev 子域>]
 *
 * CI 用法（.github/workflows/deploy-cloud.yml 自动调用）：
 *   同样从环境变量读令牌；加 --emit-result=<文件> 时把不含密钥的部署结果写进该文件，
 *   并输出机读行 NIANBOX_CLOUD_ENDPOINT=<地址>。
 *
 * 做的事（全部幂等，可重复跑）：
 *   1. 校验令牌、确定 account id；
 *   2. 确保 D1 数据库 nianbox-cloud 存在；
 *   3. 执行 server/cloud-schema.sql 建表；
 *   4. 上传 server/cloud-worker.js（绑定 D1）；
 *   5. 写入 IP_SALT（登录限流用的盐）以及可选的 AI / 图像 / 邮件凭据；
 *   6. 打开 workers.dev 路由，最后 GET /health 与 /capabilities 自检。
 *
 * 关于 AI / 邮件凭据（全部走 secret，绝不进前端产物、绝不写进仓库）：
 *   AI_BASE_URL / AI_API_KEY / AI_MODEL          自动分类与隐私抽象（OpenAI 兼容接口）
 *   AI_PROVIDER_LABEL                            展示给用户看的数据去向名称
 *   IMAGE_BASE_URL / IMAGE_API_KEY / IMAGE_MODEL 海报底图
 *   IMAGE_PROVIDER_LABEL                         展示给用户看的图像服务名称
 *   MAIL_API_BASE / MAIL_API_KEY / MAIL_FROM     服务端发信（Resend 兼容）
 *   ADMIN_TOKEN                                  运维令牌：/admin/* 用它换一次性密码重置链接
 * 一个都没配也没关系：接口会如实返回 configured:false，前端不会伪造成功。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.NO_PROXY = '*';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.ALL_PROXY;

const API = 'https://api.cloudflare.com/client/v4';
const SCRIPT = 'nianbox-cloud';
const DB_NAME = 'nianbox-cloud';
const COMPAT = '2024-11-01';
const TZ = '8';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const wantSub = (argv.find((a) => a.startsWith('--sub=')) || '').slice(6);
const emitResultPath = (argv.find((a) => a.startsWith('--emit-result=')) || '').slice(14);

const TOKEN = (process.env.CF_API_TOKEN || '').trim();
if (!TOKEN) throw new Error('缺少 CF_API_TOKEN 环境变量');
let accountId = (process.env.CF_ACCOUNT_ID || '').trim();

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.existsSync(path.join(ROOT, 'niantou-box', 'server', 'cloud-schema.sql'))
  ? path.join(ROOT, 'niantou-box')
  : ROOT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cf(method, url, body, attempt = 0) {
  const headers = { authorization: 'Bearer ' + TOKEN };
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url.startsWith('http') ? url : API + url, { method, headers, body: payload });
  } catch (e) {
    if (attempt < 4) {
      await sleep(3000);
      return cf(method, url, body, attempt + 1);
    }
    throw new Error(`网络失败 ${method} ${url}: ${e.message}`);
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok || (parsed && parsed.success === false)) {
    const detail =
      parsed?.errors?.map((x) => `${x.code} ${x.message}`).join('; ') || text.slice(0, 200);
    const err = new Error(`${method} ${url} -> HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return parsed ? parsed.result : text;
}

/** 把 schema.sql 拆成单条语句（去掉注释行），Cloudflare 的 /query 一次只吃一条。 */
function schemaStatements() {
  const raw = fs.readFileSync(path.join(SRC, 'server', 'cloud-schema.sql'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const SECRET_KEYS = [
  'AI_BASE_URL',
  'AI_API_KEY',
  'AI_MODEL',
  // 主模型额度不足 / 被限流时依次退让的备用模型（逗号或空格分隔，越靠前越优先）。
  // 放在这里是为了「配 glm-5.3 但账号没余额」不至于让整站 AI 变不可用。
  'AI_FALLBACK_MODELS',
  // 免费额度剩多少 / 什么时候到期这类运维注记，会原样出现在 /capabilities.aiNote
  // 并在设置页显示。免费包到期后上游只会静默 429、模型链自动降级，界面不说就没人知道。
  'AI_NOTE',
  'IMAGE_BASE_URL',
  'IMAGE_API_KEY',
  'IMAGE_MODEL',
  'IMAGE_FALLBACK_MODELS',
  'MAIL_API_BASE',
  'MAIL_API_KEY',
  'MAIL_FROM',
  // 这两个是可选的显示名与形状提示，但文档里写了就必须真的能设，
  // 否则「按文档配好了却完全不生效」是最难查的一类问题。
  'MAIL_FROM_NAME',
  'MAIL_PROVIDER',
  // 运维令牌：配了之后 /admin/users 与 /admin/password-reset 才可用；
  // 没配时这两个接口返回 503 ADMIN_TOKEN_NOT_CONFIGURED，绝不静默放行。
  'ADMIN_TOKEN',
];
const PLAIN_KEYS = ['AI_PROVIDER_LABEL', 'IMAGE_PROVIDER_LABEL', 'IMAGE_PROVIDER', 'PUBLIC_APP_URL'];
/** 排障开关：设成 1 时 500 响应会带上内部错误摘要（不含请求体）。 */
const DEBUG_DETAIL = (process.env.NIANBOX_DEBUG_DETAIL || '').trim();

async function main() {
  const verify = await cf('GET', '/user/tokens/verify');
  console.log('1. 令牌校验：', verify.status ?? 'ok');

  if (!accountId) {
    const accounts = await cf('GET', '/accounts?per_page=50');
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('这枚令牌看不到任何 Cloudflare 账号，请换一枚带 Workers / D1 权限的令牌。');
    }
    if (accounts.length > 1) {
      for (const a of accounts) console.log(`     - ${a.name}  ${a.id}`);
      throw new Error('账号不止一个，请设置 CF_ACCOUNT_ID 指定要部署到哪个账号。');
    }
    accountId = accounts[0].id;
    console.log('   账号：', accounts[0].name, accountId);
  } else {
    console.log('   账号：', accountId);
  }

  let dbId = '';
  const list = await cf('GET', `/accounts/${accountId}/d1/database?per_page=100`);
  const found = (Array.isArray(list) ? list : []).find((d) => d.name === DB_NAME);
  if (found) {
    dbId = found.uuid;
    console.log('2. D1 数据库已存在：', DB_NAME, dbId);
  } else if (dry) {
    console.log('2. (--dry) 需要新建 D1 数据库：', DB_NAME);
  } else {
    const created = await cf('POST', `/accounts/${accountId}/d1/database`, { name: DB_NAME });
    dbId = created.uuid;
    console.log('2. D1 数据库已创建：', DB_NAME, dbId);
  }

  if (dry) {
    console.log('\n(--dry) 到此为止，没有做任何修改。');
    return;
  }

  for (const sql of schemaStatements()) {
    await cf('POST', `/accounts/${accountId}/d1/database/${dbId}/query`, { sql });
  }
  const check = await cf('POST', `/accounts/${accountId}/d1/database/${dbId}/query`, {
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','sessions','ideas','projects','user_state','meta','password_reset_tokens')",
  });
  const tables = (check?.[0]?.results || []).map((r) => r.name).sort();
  console.log('3. 建表完成，现有表：', tables.join(', ') || '(空)');
  for (const required of ['users', 'sessions', 'ideas', 'projects', 'password_reset_tokens']) {
    if (!tables.includes(required)) throw new Error(`建表没有生效：缺少 ${required}`);
  }

  const main = fs.readFileSync(path.join(SRC, 'server', 'cloud-worker.js'), 'utf8');
  const metadata = {
    main_module: 'cloud-worker.js',
    compatibility_date: COMPAT,
    bindings: [
      { type: 'd1', name: 'DB', id: dbId },
      { type: 'plain_text', name: 'TZ_OFFSET_HOURS', text: TZ },
      ...PLAIN_KEYS.filter((key) => (process.env[key] || '').trim()).map((key) => ({
        type: 'plain_text',
        name: key,
        text: process.env[key].trim(),
      })),
      ...(DEBUG_DETAIL ? [{ type: 'plain_text', name: 'DEBUG_DETAIL', text: DEBUG_DETAIL }] : []),
    ],
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(
    'cloud-worker.js',
    new Blob([main], { type: 'application/javascript+module' }),
    'cloud-worker.js',
  );
  const uploaded = await cf('PUT', `/accounts/${accountId}/workers/scripts/${SCRIPT}`, form);
  console.log('4. Worker 已上传：', SCRIPT, '修改时间', uploaded?.modified_on ?? '');

  const ipSalt = (process.env.NIANBOX_IP_SALT || '').trim() || crypto.randomBytes(24).toString('base64url');
  await cf('PUT', `/accounts/${accountId}/workers/scripts/${SCRIPT}/secrets`, {
    name: 'IP_SALT',
    text: ipSalt,
    type: 'secret_text',
  });
  console.log('5. 密钥已写入：IP_SALT');

  // Cloudflare Workers AI REST API 的根地址由已确定的账号 ID 自动拼出，
  // 用户只需配置 IMAGE_PROVIDER=cloudflare 与 IMAGE_API_KEY，不必再复制账号 ID 到另一个 secret。
  if (
    (process.env.IMAGE_PROVIDER || '').trim().toLowerCase() === 'cloudflare' &&
    !(process.env.IMAGE_BASE_URL || '').trim()
  ) {
    process.env.IMAGE_BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
  }

  const configured = [];
  for (const key of SECRET_KEYS) {
    const value = (process.env[key] || '').trim();
    if (!value) continue;
    await cf('PUT', `/accounts/${accountId}/workers/scripts/${SCRIPT}/secrets`, {
      name: key,
      text: value,
      type: 'secret_text',
    });
    configured.push(key);
  }
  console.log(
    '   AI / 邮件凭据：',
    configured.length > 0 ? configured.join(', ') : '(未提供 —— 相关接口会如实返回 configured:false)',
  );

  let subdomain = '';
  const sub = await cf('GET', `/accounts/${accountId}/workers/subdomain`);
  subdomain = sub?.subdomain || '';
  if (!subdomain) {
    const wanted = wantSub || `nianbox-${crypto.randomBytes(3).toString('hex')}`;
    await cf('PUT', `/accounts/${accountId}/workers/subdomain`, { subdomain: wanted });
    subdomain = wanted;
    console.log('6. 已注册 workers.dev 子域：', subdomain);
  } else {
    console.log('6. workers.dev 子域：', subdomain);
  }
  await cf('POST', `/accounts/${accountId}/workers/scripts/${SCRIPT}/subdomain`, {
    enabled: true,
    previews_enabled: false,
  });

  const base = `https://${SCRIPT}.${subdomain}.workers.dev`;

  let health = '';
  for (let i = 0; i < 10; i += 1) {
    try {
      const r = await fetch(`${base}/health`);
      health = `HTTP ${r.status} ${(await r.text()).slice(0, 80)}`;
      if (r.ok) break;
    } catch (e) {
      health = `等待中：${e.message}`;
    }
    await sleep(4000);
  }
  console.log('7. /health <-', health);

  let caps = '';
  try {
    const r = await fetch(`${base}/capabilities`);
    caps = `HTTP ${r.status} ${(await r.text()).slice(0, 300)}`;
  } catch (e) {
    caps = `失败：${e.message}`;
  }
  console.log('8. /capabilities <-', caps);

  const out = {
    deployedAt: new Date().toISOString(),
    accountId,
    databaseId: dbId,
    base,
    endpoint: base,
  };
  if (emitResultPath) {
    fs.writeFileSync(path.resolve(emitResultPath), JSON.stringify(out, null, 2));
    console.log('\nNIANBOX_CLOUD_ENDPOINT=' + base);
  }
  console.log('\n================ 云端后端部署完成 ================');
  console.log('接口地址：', base);
  console.log('插入到前端的方式：仓库变量 CLOUD_ENDPOINT = ' + base);
}

await main();
