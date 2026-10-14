/**
 * 用 Cloudflare REST API 一次性部署念头盒的运营数据接收端（不需要 wrangler、不需要子进程）。
 *
 * 本地用法（在仓库根目录）：
 *   $env:CF_API_TOKEN = "<Cloudflare API Token>"
 *   $env:CF_ACCOUNT_ID = "<Account ID>"          # 可省略，只有一个账号时自动推断
 *   $env:NIANBOX_ADMIN_TOKEN = "<你自己定的读取令牌，32 位以上随机串>"
 *   node server/deploy-telemetry.mjs [--dry] [--sub=<workers.dev 子域>]
 *
 * GitHub Actions 用法（.github/workflows/deploy-telemetry.yml 会自动调用，不需要你跑命令）：
 *   环境变量同上，另加 --emit-result=<文件> 时不再打印任何密钥，结果写进该文件，
 *   并额外输出 NIANBOX_TELEMETRY_ENDPOINT= / NIANBOX_TELEMETRY_KEY= 两行机读结果。
 *
 * 做的事（全部幂等，可以重复跑）：
 *   1. 校验令牌，确定 account id；
 *   2. 确保 D1 数据库 nianbox-telemetry 存在；
 *   3. 执行 server/schema.sql 建表；
 *   4. 上传 Worker 脚本（绑定 D1 + TZ_OFFSET_HOURS）；
 *   5. 写入两个密钥：INGEST_KEY（只能写）、ADMIN_TOKEN（只能读）；
 *   6. 打开 workers.dev 子域路由，最后 GET /health 验证。
 *
 * 密钥来源（都从环境变量取，缺了才现场生成）：
 *   NIANBOX_INGEST_KEY   只能写的令牌；重复部署时传同一个值，已发布的应用才不会断线。
 *   NIANBOX_ADMIN_TOKEN  只能读的令牌；用 --require-admin-token 时缺失直接报错（CI 用，
 *                        避免生成一个无法安全打印的令牌）。
 *
 * 结束时打印：接口地址、写入令牌、读取令牌（--emit-result 模式下不打印后者）。
 * 令牌从不落盘；只有显式加 --save 时才会写到 work/telemetry-deploy.json（默认不写）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.NO_PROXY = '*';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.ALL_PROXY;

const API = 'https://api.cloudflare.com/client/v4';
const SCRIPT = 'nianbox-telemetry';
const DB_NAME = 'nianbox-telemetry';
const COMPAT = '2024-11-01';
const TZ = '8';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const save = argv.includes('--save');
const wantSub = (argv.find((a) => a.startsWith('--sub=')) || '').slice(6);
/** 机读结果落盘路径（CI 用；给了它就不再往日志里打任何「只能读」的令牌）。 */
const emitResultPath = (argv.find((a) => a.startsWith('--emit-result=')) || '').slice(14);
/** CI 用：没有现成的读取令牌就报错退出，绝不生成一个用户看不到的令牌。 */
const requireAdminToken = argv.includes('--require-admin-token');

const TOKEN = (process.env.CF_API_TOKEN || '').trim();
if (!TOKEN) throw new Error('缺少 CF_API_TOKEN 环境变量');
let accountId = (process.env.CF_ACCOUNT_ID || '').trim();

const ROOT = path.resolve(import.meta.dirname, '..');
// 两种运行位置都支持：本地工作区（<ROOT>/niantou-box/server/…）与仓库根（<ROOT>/server/…）。
const SRC = fs.existsSync(path.join(ROOT, 'niantou-box', 'server', 'schema.sql'))
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
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（例如 HTML 错误页） */
  }
  if (!res.ok || (json && json.success === false)) {
    const detail = json?.errors?.map((x) => `${x.code} ${x.message}`).join('; ') || text.slice(0, 200);
    const err = new Error(`${method} ${url} -> HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return json ? json.result : text;
}

function newToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 把 schema.sql 拆成单条语句（去掉注释行），Cloudflare 的 /query 一次只吃一条。 */
function schemaStatements() {
  const raw = fs.readFileSync(path.join(SRC, 'server', 'schema.sql'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  // 1) 令牌与账号
  const verify = await cf('GET', '/user/tokens/verify');
  console.log('1. 令牌校验：', verify.status ?? 'ok');

  if (!accountId) {
    const accounts = await cf('GET', '/accounts?per_page=50');
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('这枚令牌看不到任何 Cloudflare 账号，请换一枚带 Workers / D1 权限的令牌。');
    }
    if (accounts.length > 1) {
      console.log('   发现多个账号：');
      for (const a of accounts) console.log(`     - ${a.name}  ${a.id}`);
      throw new Error('账号不止一个，请设置 CF_ACCOUNT_ID 指定要部署到哪个账号。');
    }
    accountId = accounts[0].id;
    console.log('   账号：', accounts[0].name, accountId);
  } else {
    console.log('   账号：', accountId);
  }

  // 2) D1 数据库
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

  // 3) 建表
  const stmts = schemaStatements();
  for (const sql of stmts) {
    await cf('POST', `/accounts/${accountId}/d1/database/${dbId}/query`, { sql });
  }
  const check = await cf('POST', `/accounts/${accountId}/d1/database/${dbId}/query`, {
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('events','feedback')",
  });
  const tables = (check?.[0]?.results || []).map((r) => r.name).sort();
  console.log('3. 建表完成，现有表：', tables.join(', ') || '(空)');
  if (!tables.includes('events') || !tables.includes('feedback')) {
    throw new Error('建表没有生效，请检查 server/schema.sql。');
  }

  // 4) 上传 Worker
  const main = fs.readFileSync(path.join(SRC, 'server', 'telemetry-worker.js'), 'utf8');
  const metadata = {
    main_module: 'telemetry-worker.js',
    compatibility_date: COMPAT,
    bindings: [
      { type: 'd1', name: 'DB', id: dbId },
      { type: 'plain_text', name: 'TZ_OFFSET_HOURS', text: TZ },
    ],
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(
    'telemetry-worker.js',
    new Blob([main], { type: 'application/javascript+module' }),
    'telemetry-worker.js',
  );
  const uploaded = await cf('PUT', `/accounts/${accountId}/workers/scripts/${SCRIPT}`, form);
  console.log('4. Worker 已上传：', SCRIPT, '修改时间', uploaded?.modified_on ?? '');

  // 5) 两枚密钥（都从环境变量取，没有就现场生成）
  const ingestKey = (process.env.NIANBOX_INGEST_KEY || '').trim() || newToken();
  let adminToken = (process.env.NIANBOX_ADMIN_TOKEN || '').trim();
  if (!adminToken) {
    if (requireAdminToken) {
      throw new Error(
        '缺少 NIANBOX_ADMIN_TOKEN：这是只应该由你本人保管的「读取令牌」。' +
          '请在 GitHub 仓库里把它设成 Actions secret 后再重跑，不要让它出现在日志里。',
      );
    }
    adminToken = newToken();
  }
  for (const [name, text] of [
    ['INGEST_KEY', ingestKey],
    ['ADMIN_TOKEN', adminToken],
  ]) {
    await cf('PUT', `/accounts/${accountId}/workers/scripts/${SCRIPT}/secrets`, {
      name,
      text,
      type: 'secret_text',
    });
    console.log(`5. 密钥已写入：${name}（${text.length} 字符）`);
  }

  // 6) workers.dev 子域
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
  const endpoint = `${base}/ingest`;

  // 7) 健康检查（workers.dev 生效有时要几秒）
  let health = null;
  for (let i = 0; i < 10; i += 1) {
    try {
      const r = await fetch(`${base}/health`);
      const t = await r.text();
      health = `HTTP ${r.status} ${t.slice(0, 80)}`;
      if (r.ok) break;
    } catch (e) {
      health = `等待中：${e.message}`;
    }
    await sleep(4000);
  }
  console.log('7. /health <-', health);

  // 8) 用写入令牌打一次真实请求，确认整条链路通
  let ingest = '未测试';
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-NianBox-Key': ingestKey },
      body: JSON.stringify({
        v: 1,
        installId: 'setup-check',
        sessionId: 'setup-check',
        context: { app: 'setup', platform: 'other', display: 'browser', viewport: 'unknown', lang: 'zh-CN' },
        events: [],
        feedback: [],
      }),
    });
    ingest = `HTTP ${r.status} ${(await r.text()).slice(0, 80)}`;
  } catch (e) {
    ingest = `失败：${e.message}`;
  }
  console.log('8. /ingest <-', ingest);

  const out = {
    deployedAt: new Date().toISOString(),
    accountId,
    databaseId: dbId,
    endpoint,
    base,
    ingestKey,
    adminToken,
    adminConsole: 'https://chenzhe223-tech.github.io/niantou-box-app/admin.html',
  };
  if (emitResultPath) {
    // CI：只把「能写」的令牌交出去，供工作流写进仓库变量；读取令牌永不落盘、永不进日志。
    fs.writeFileSync(path.resolve(emitResultPath), JSON.stringify({ ...out, adminToken: undefined }, null, 2));
    console.log('\nNIANBOX_TELEMETRY_ENDPOINT=' + endpoint);
    console.log('NIANBOX_TELEMETRY_KEY=' + ingestKey);
  }
  if (save) {
    fs.writeFileSync(path.join(ROOT, 'work', 'telemetry-deploy.json'), JSON.stringify(out, null, 2));
    console.log('\n（--save）已写入 work/telemetry-deploy.json（含令牌，切勿提交）');
  }
  console.log('\n================ 部署完成 ================');
  console.log('接口地址（写给应用）：', endpoint);
  console.log('写入令牌（随应用发布，只能写）：', ingestKey);
  if (emitResultPath) {
    console.log('读取令牌（只给你，能读全量）：不打印（就是你刚填进仓库 secret 的那一串）。');
  } else {
    console.log('读取令牌（只给你，能读全量）：', adminToken);
  }
  console.log('运营看板：', out.adminConsole);
  if (!emitResultPath) {
    console.log('\n把下面两行填进仓库 Variables，或直接重跑 deploy-telemetry 工作流让它自动写入：');
    console.log(`  TELEMETRY_ENDPOINT = ${endpoint}`);
    console.log(`  TELEMETRY_KEY      = ${ingestKey}`);
  }
}

await main();
