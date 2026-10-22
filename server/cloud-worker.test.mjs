/**
 * 云端 Worker 的接口测试：不需要网络、不需要真实 D1、不需要任何密钥。
 *
 * 重点盯住三件事，因为它们是这一版新增的、出错代价最大的地方：
 *   1. 运维接口（/admin/*）在没有 ADMIN_TOKEN 时**必须整体不可用**，
 *      令牌不对时**必须一点账号数据都不回**；
 *   2. 重置链接一次性的语义不能被新的签发路径绕过（点第二次必须失败）；
 *   3. 重构公共签发函数之后，原本的邮件自助找回路径没有被改坏。
 *
 * 下面用的是一个只认识本文件里用到的那几条 SQL 的内存假 D1。
 * 遇到不认识的 SQL 会直接抛错 —— 这样 Worker 里一改查询语句，测试就会当场提醒，
 * 而不是悄悄用「什么都不匹配」的假实现把断言喂饱。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import worker, { imageConfig } from './cloud-worker.js';

/* -------------------------------------------------------------------------- */
/* 假 D1                                                                       */
/* -------------------------------------------------------------------------- */

const normalizeSql = (sql) => String(sql).replace(/\s+/g, ' ').trim();

/** 只实现 admin 搜索用到的 `%子串%` 这一种形状，`!` 为转义符，大小写不敏感。 */
function likeMatch(value, pattern) {
  const body = String(pattern).replace(/^%|%$/g, '').replace(/!(.)/g, '$1');
  return String(value).toLowerCase().includes(body.toLowerCase());
}

function createDb() {
  const tables = {
    users: [],
    sessions: [],
    user_state: [],
    password_reset_tokens: [],
    service_log: [],
    login_throttle: [],
    meta: [{ key: 'seq', value: '0' }],
  };

  const dropWhere = (table, predicate) => {
    const before = tables[table].length;
    tables[table] = tables[table].filter((row) => !predicate(row));
    return before - tables[table].length;
  };

  /** admin 账号列表的投影：与 Worker 里的 SELECT 别名严格对应。 */
  const adminProjection = (user) => {
    const state = tables.user_state.find((row) => row.user_id === user.id) || {};
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      ideaCount: state.idea_count === undefined ? 0 : state.idea_count,
      projectCount: state.project_count === undefined ? 0 : state.project_count,
      lastSyncAt: state.last_sync_at === undefined ? 0 : state.last_sync_at,
    };
  };

  async function execute(rawSql, params) {
    const sql = normalizeSql(rawSql);
    const p = params;

    if (sql === "SELECT value FROM meta WHERE key = 'seq'") {
      const row = tables.meta.find((item) => item.key === 'seq');
      return { rows: row ? [{ value: row.value }] : [], changes: 0 };
    }

    /* ---- users ---- */
    if (sql === 'SELECT id FROM users WHERE email = ?') {
      return { rows: tables.users.filter((u) => u.email === p[0]).map((u) => ({ id: u.id })), changes: 0 };
    }
    if (sql === 'SELECT id, email FROM users WHERE email = ?') {
      return {
        rows: tables.users.filter((u) => u.email === p[0]).map((u) => ({ id: u.id, email: u.email })),
        changes: 0,
      };
    }
    if (sql === 'SELECT id, email FROM users WHERE id = ?') {
      return {
        rows: tables.users.filter((u) => u.id === p[0]).map((u) => ({ id: u.id, email: u.email })),
        changes: 0,
      };
    }
    if (sql === 'SELECT password_hash AS passwordHash FROM users WHERE id = ?') {
      return {
        rows: tables.users.filter((u) => u.id === p[0]).map((u) => ({ passwordHash: u.password_hash })),
        changes: 0,
      };
    }
    if (sql.includes('display_name AS displayName, password_hash AS passwordHash FROM users WHERE email = ?')) {
      return {
        rows: tables.users
          .filter((u) => u.email === p[0])
          .map((u) => ({
            id: u.id,
            email: u.email,
            displayName: u.display_name,
            passwordHash: u.password_hash,
          })),
        changes: 0,
      };
    }
    if (sql.startsWith('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')) {
      let changes = 0;
      for (const user of tables.users) {
        if (user.id !== p[2]) continue;
        user.password_hash = p[0];
        user.updated_at = p[1];
        changes += 1;
      }
      return { rows: [], changes };
    }

    /* ---- admin 账号列表 ---- */
    if (sql.includes('FROM users u LEFT JOIN user_state s ON s.user_id = u.id')) {
      if (sql.includes('WHERE u.email LIKE ? ESCAPE')) {
        return {
          rows: tables.users.filter((u) => likeMatch(u.email, p[0])).slice(0, p[1]).map(adminProjection),
          changes: 0,
        };
      }
      if (sql.includes('WHERE u.id = ?')) {
        return { rows: tables.users.filter((u) => u.id === p[0]).slice(0, 1).map(adminProjection), changes: 0 };
      }
      return { rows: tables.users.slice(0, p[0]).map(adminProjection), changes: 0 };
    }

    /* ---- password_reset_tokens ---- */
    if (sql === 'INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)') {
      tables.password_reset_tokens.push({
        token_hash: p[0],
        user_id: p[1],
        created_at: p[2],
        expires_at: p[3],
      });
      return { rows: [], changes: 1 };
    }
    if (sql === 'DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at <= ?') {
      return {
        rows: [],
        changes: dropWhere('password_reset_tokens', (r) => r.user_id === p[0] || r.expires_at <= p[1]),
      };
    }
    if (sql === 'DELETE FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?') {
      return {
        rows: [],
        changes: dropWhere('password_reset_tokens', (r) => r.token_hash === p[0] && r.expires_at > p[1]),
      };
    }
    if (sql === 'DELETE FROM password_reset_tokens WHERE token_hash = ?') {
      return { rows: [], changes: dropWhere('password_reset_tokens', (r) => r.token_hash === p[0]) };
    }
    if (sql === 'DELETE FROM password_reset_tokens WHERE user_id = ?') {
      return { rows: [], changes: dropWhere('password_reset_tokens', (r) => r.user_id === p[0]) };
    }
    if (sql === 'SELECT user_id AS userId FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?') {
      return {
        rows: tables.password_reset_tokens
          .filter((r) => r.token_hash === p[0] && r.expires_at > p[1])
          .map((r) => ({ userId: r.user_id })),
        changes: 0,
      };
    }

    /* ---- sessions ---- */
    if (sql === 'SELECT s.user_id AS userId, s.expires_at AS expiresAt, s.token_hash AS tokenHash, u.email AS email, u.display_name AS displayName, u.created_at AS createdAt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?') {
      const session = tables.sessions.find((row) => row.token_hash === p[0]);
      const user = session ? tables.users.find((row) => row.id === session.user_id) : null;
      return {
        rows: session && user ? [{
          userId: session.user_id,
          expiresAt: session.expires_at,
          tokenHash: session.token_hash,
          email: user.email,
          displayName: user.display_name,
          createdAt: user.created_at,
        }] : [],
        changes: 0,
      };
    }
    if (sql === 'UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?') {
      let changes = 0;
      for (const row of tables.sessions) {
        if (row.token_hash !== p[1]) continue;
        row.last_seen_at = p[0];
        changes += 1;
      }
      return { rows: [], changes };
    }
    if (sql.startsWith('INSERT INTO sessions')) {
      tables.sessions.push({
        token_hash: p[0],
        user_id: p[1],
        created_at: p[2],
        expires_at: p[3],
        last_seen_at: p[4],
        label: p[5],
      });
      return { rows: [], changes: 1 };
    }
    if (sql === 'DELETE FROM sessions WHERE user_id = ?') {
      return { rows: [], changes: dropWhere('sessions', (r) => r.user_id === p[0]) };
    }
    if (sql.startsWith('DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN')) {
      // 会话数封顶逻辑：测试里不模拟淘汰顺序，不影响断言。
      return { rows: [], changes: 0 };
    }

    /* ---- login_throttle ---- */
    if (sql.startsWith('INSERT INTO login_throttle')) {
      const existing = tables.login_throttle.find((r) => r.ip_hash === p[0]);
      if (existing) {
        existing.window_start = p[2];
        existing.attempts = 1;
      } else {
        tables.login_throttle.push({ ip_hash: p[0], window_start: p[1], attempts: 1 });
      }
      return { rows: [], changes: 1 };
    }
    if (sql === 'SELECT window_start AS windowStart, attempts FROM login_throttle WHERE ip_hash = ?') {
      return {
        rows: tables.login_throttle
          .filter((r) => r.ip_hash === p[0])
          .map((r) => ({ windowStart: r.window_start, attempts: r.attempts })),
        changes: 0,
      };
    }
    if (sql.startsWith('UPDATE login_throttle SET attempts = attempts + 1')) {
      let changes = 0;
      for (const row of tables.login_throttle) {
        if (row.ip_hash === p[0]) {
          row.attempts += 1;
          changes += 1;
        }
      }
      return { rows: [], changes };
    }
    if (sql === 'DELETE FROM login_throttle WHERE ip_hash = ?') {
      return { rows: [], changes: dropWhere('login_throttle', (r) => r.ip_hash === p[0]) };
    }

    /* ---- service_log ---- */
    if (sql === "SELECT COUNT(*) AS count FROM service_log WHERE user_id = ? AND day = ? AND kind = 'idea-analysis'") {
      return {
        rows: [{
          count: tables.service_log.filter((row) =>
            row.user_id === p[0] && row.day === p[1] && row.kind === 'idea-analysis',
          ).length,
        }],
        changes: 0,
      };
    }
    if (sql === "SELECT COUNT(*) AS count FROM service_log WHERE user_id = ? AND day = ? AND kind = 'topic-directions'") {
      return {
        rows: [{ count: tables.service_log.filter((row) => row.user_id === p[0] && row.day === p[1] && row.kind === 'topic-directions').length }],
        changes: 0,
      };
    }
    if (sql.startsWith('INSERT INTO service_log')) {
      tables.service_log.push({
        id: p[0],
        user_id: p[1],
        day: p[2],
        at: p[3],
        kind: p[4],
        ok: p[5],
        detail: p[6],
      });
      return { rows: [], changes: 1 };
    }

    throw new Error('假 D1 不认识这条 SQL，请同步更新测试：' + sql);
  }

  function prepare(sql) {
    const state = { sql, params: [] };
    const api = {
      bind(...params) {
        state.params = params;
        return api;
      },
      first: async () => (await execute(state.sql, state.params)).rows[0] ?? null,
      all: async () => ({ results: (await execute(state.sql, state.params)).rows, success: true, meta: {} }),
      run: async () => ({ success: true, meta: { changes: (await execute(state.sql, state.params)).changes } }),
      _state: state,
    };
    return api;
  }

  const DB = {
    prepare,
    async batch(statements) {
      const out = [];
      for (const statement of statements) {
        const result = await execute(statement._state.sql, statement._state.params);
        out.push({ success: true, meta: { changes: result.changes } });
      }
      return out;
    },
  };

  return { DB, tables };
}

/* -------------------------------------------------------------------------- */
/* 夹具                                                                        */
/* -------------------------------------------------------------------------- */

/** 按 Worker 里的存储格式自己算一遍 PBKDF2，顺带验证「格式没被改坏」。 */
async function pbkdf2Hash(password, iterations = 100_000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256),
  );
  const b64u = (bytes) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `pbkdf2$${iterations}$${b64u(salt)}$${b64u(bits)}`;
}

const ADMIN_TOKEN = 'admin-token-for-tests-1234567890';
const ALICE_EMAIL = 'alice@example.com';
const ALICE_PASSWORD = 'alice-old-password';
const ALICE_ID = 'u_alice000000000000';
const HOUR_MS = 60 * 60 * 1000;

async function seedAlice(db, password = ALICE_PASSWORD) {
  db.tables.users.push({
    id: ALICE_ID,
    email: ALICE_EMAIL,
    password_hash: await pbkdf2Hash(password),
    display_name: 'Alice',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  });
  db.tables.user_state.push({
    user_id: ALICE_ID,
    last_seq: 7,
    last_sync_at: 1_700_000_900_000,
    idea_count: 3,
    project_count: 1,
  });
}

function makeEnv(db, overrides = {}) {
  return {
    DB: db.DB,
    ADMIN_TOKEN,
    IP_SALT: 'test-salt',
    TZ_OFFSET_HOURS: '8',
    PUBLIC_APP_URL: 'https://app.example.com/',
    ...overrides,
  };
}

function call(path, { method = 'GET', token, body, env } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request('https://cloud.example.com' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return worker.fetch(request, env);
}

async function callJson(path, options) {
  const response = await call(path, options);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, raw: text };
}

/* -------------------------------------------------------------------------- */
/* 运维令牌                                                                    */
/* -------------------------------------------------------------------------- */


describe('Cloudflare Workers AI 生图配置', () => {
  it('使用独立 IMAGE_* 配置，默认 FLUX.1 schnell，且不覆盖 DeepSeek 文本配置', () => {
    const cfg = imageConfig({
      AI_BASE_URL: 'https://api.deepseek.com',
      AI_API_KEY: 'deepseek-test-key',
      AI_MODEL: 'deepseek-flash',
      IMAGE_PROVIDER: 'cloudflare',
      IMAGE_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/test-account/ai/run',
      IMAGE_API_KEY: 'cloudflare-test-token',
    });
    expect(cfg.provider).toBe('cloudflare');
    expect(cfg.model).toBe('@cf/black-forest-labs/flux-1-schnell');
    expect(cfg.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai/run');
    expect(cfg.apiKey).toBe('cloudflare-test-token');
    expect(cfg.ready).toBe(true);
  });

  it('未提供 Cloudflare 图像 token 时如实标记为未配置', () => {
    const cfg = imageConfig({
      IMAGE_PROVIDER: 'cloudflare',
      IMAGE_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/test-account/ai/run',
    });
    expect(cfg.ready).toBe(false);
  });
});

describe('运维接口的令牌校验', () => {
  it('没有配置 ADMIN_TOKEN 时接口整体不可用（503），不返回任何账号数据', async () => {
    const db = createDb();
    await seedAlice(db);
    const env = makeEnv(db, { ADMIN_TOKEN: '' });

    const users = await callJson('/admin/users', { env });
    expect(users.status).toBe(503);
    expect(users.body.code).toBe('ADMIN_TOKEN_NOT_CONFIGURED');
    expect(users.raw).not.toContain(ALICE_EMAIL);

    const reset = await callJson('/admin/password-reset', {
      method: 'POST',
      body: { email: ALICE_EMAIL },
      env,
    });
    expect(reset.status).toBe(503);
    expect(reset.body.code).toBe('ADMIN_TOKEN_NOT_CONFIGURED');
    expect(db.tables.password_reset_tokens).toHaveLength(0);
  });

  it('缺 Authorization 头 → 401，响应体里没有任何账号信息', async () => {
    const db = createDb();
    await seedAlice(db);

    const { status, raw } = await callJson('/admin/users', { env: makeEnv(db) });
    expect(status).toBe(401);
    expect(raw).not.toContain(ALICE_EMAIL);
    expect(raw).not.toContain(ALICE_ID);
  });

  it('令牌不对 → 403，且同样不回任何账号数据', async () => {
    const db = createDb();
    await seedAlice(db);

    const { status, raw } = await callJson('/admin/users', {
      token: 'wrong-token',
      env: makeEnv(db),
    });
    expect(status).toBe(403);
    expect(raw).not.toContain(ALICE_EMAIL);
    expect(raw).not.toContain(ALICE_ID);
  });

  it('长度相同但内容不同的令牌一样被拒（定长比较不能变成「长度对就行」）', async () => {
    const db = createDb();
    await seedAlice(db);

    const sameLength = 'X'.repeat(ADMIN_TOKEN.length);
    const { status } = await callJson('/admin/users', { token: sameLength, env: makeEnv(db) });
    expect(status).toBe(403);
  });

  it('未配置邮件服务时 /capabilities 仍然如实回 configured:false（不受运维令牌影响）', async () => {
    const db = createDb();
    const { status, body } = await callJson('/capabilities', { env: makeEnv(db) });
    expect(status).toBe(200);
    expect(body.mail).toBe(false);
    expect(body.passwordReset).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* GET /admin/users                                                            */
/* -------------------------------------------------------------------------- */

describe('GET /admin/users', () => {
  it('正确令牌能列出账号，且不回显口令哈希与会话令牌', async () => {
    const db = createDb();
    await seedAlice(db);

    const { status, body, raw } = await callJson('/admin/users', { token: ADMIN_TOKEN, env: makeEnv(db) });
    expect(status).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      id: ALICE_ID,
      email: ALICE_EMAIL,
      displayName: 'Alice',
      ideaCount: 3,
      projectCount: 1,
      lastSyncAt: 1_700_000_900_000,
    });
    expect(raw).not.toContain('pbkdf2$');
    expect(raw.toLowerCase()).not.toContain('passwordhash');
    expect(raw.toLowerCase()).not.toContain('token_hash');
  });

  it('按邮箱片段搜索能命中', async () => {
    const db = createDb();
    await seedAlice(db);

    const hit = await callJson('/admin/users?q=ALICE@EXAMPLE', { token: ADMIN_TOKEN, env: makeEnv(db) });
    expect(hit.status).toBe(200);
    expect(hit.body.users.map((u) => u.id)).toEqual([ALICE_ID]);

    const miss = await callJson('/admin/users?q=nobody', { token: ADMIN_TOKEN, env: makeEnv(db) });
    expect(miss.body.users).toHaveLength(0);
  });

  it('按用户 ID 精确命中', async () => {
    const db = createDb();
    await seedAlice(db);

    const { body } = await callJson('/admin/users?q=' + ALICE_ID, { token: ADMIN_TOKEN, env: makeEnv(db) });
    expect(body.users.map((u) => u.id)).toEqual([ALICE_ID]);
  });

  it('搜索里的 % 与 _ 被当成普通字符（不会变成通配符搜出无关账号）', async () => {
    const db = createDb();
    await seedAlice(db);
    db.tables.users.push({
      id: 'u_bob000000000000000',
      email: 'bob@example.com',
      password_hash: 'pbkdf2$1$x$y',
      display_name: 'Bob',
      created_at: 1,
      updated_at: 1,
    });

    const wildcard = await callJson('/admin/users?q=%25', { token: ADMIN_TOKEN, env: makeEnv(db) });
    expect(wildcard.body.users).toHaveLength(0);

    const underscore = await callJson('/admin/users?q=_', { token: ADMIN_TOKEN, env: makeEnv(db) });
    expect(underscore.body.users).toHaveLength(0);
  });

  it('limit 超过上限时被夹到 100，不会按用户传的值无限拉取', async () => {
    const db = createDb();
    await seedAlice(db);
    const { status } = await callJson('/admin/users?limit=100000', { token: ADMIN_TOKEN, env: makeEnv(db) });
    expect(status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* POST /admin/password-reset                                                  */
/* -------------------------------------------------------------------------- */

describe('POST /admin/password-reset', () => {
  it('用邮箱签发链接，链接里的令牌能真的改密码，且只能用一次', async () => {
    const db = createDb();
    await seedAlice(db);
    const env = makeEnv(db);

    const issued = await callJson('/admin/password-reset', {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { email: ALICE_EMAIL },
      env,
    });
    expect(issued.status).toBe(200);
    expect(issued.body.ok).toBe(true);
    expect(issued.body.email).toBe(ALICE_EMAIL);
    expect(issued.body.resetUrl.startsWith('https://app.example.com/')).toBe(true);

    const token = new URL(issued.body.resetUrl).hash.split('reset=')[1];
    expect(token).toBeTruthy();
    // 库里只应有摘要，不应出现原始令牌。
    expect(db.tables.password_reset_tokens).toHaveLength(1);
    expect(JSON.stringify(db.tables.password_reset_tokens)).not.toContain(token);

    const first = await callJson('/auth/password/reset', {
      method: 'POST',
      body: { token, password: 'brand-new-password' },
      env,
    });
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);

    // 同一个令牌第二次必须失败。
    const second = await callJson('/auth/password/reset', {
      method: 'POST',
      body: { token, password: 'another-password-1' },
      env,
    });
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('RESET_TOKEN_INVALID');

    // 新口令能登录，旧口令不能。
    const good = await callJson('/auth/login', {
      method: 'POST',
      body: { email: ALICE_EMAIL, password: 'brand-new-password' },
      env,
    });
    expect(good.status).toBe(200);
    expect(good.body.token).toBeTruthy();

    const bad = await callJson('/auth/login', {
      method: 'POST',
      body: { email: ALICE_EMAIL, password: ALICE_PASSWORD },
      env,
    });
    expect(bad.status).toBe(401);
  });

  it('也可以用用户 ID 签发', async () => {
    const db = createDb();
    await seedAlice(db);
    const { status, body } = await callJson('/admin/password-reset', {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { userId: ALICE_ID },
      env: makeEnv(db),
    });
    expect(status).toBe(200);
    expect(body.email).toBe(ALICE_EMAIL);
  });

  it('同一账号重复签发时旧链接作废（库里只留最后一次）', async () => {
    const db = createDb();
    await seedAlice(db);
    const env = makeEnv(db);

    const first = await callJson('/admin/password-reset', {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { email: ALICE_EMAIL },
      env,
    });
    const second = await callJson('/admin/password-reset', {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { email: ALICE_EMAIL },
      env,
    });
    expect(db.tables.password_reset_tokens).toHaveLength(1);

    const oldToken = new URL(first.body.resetUrl).hash.split('reset=')[1];
    const stale = await callJson('/auth/password/reset', {
      method: 'POST',
      body: { token: oldToken, password: 'password-from-old-link' },
      env,
    });
    expect(stale.status).toBe(400);

    const fresh = new URL(second.body.resetUrl).hash.split('reset=')[1];
    const ok = await callJson('/auth/password/reset', {
      method: 'POST',
      body: { token: fresh, password: 'password-from-new-link' },
      env,
    });
    expect(ok.status).toBe(200);
  });

  it('账号不存在 → 404，不签发任何令牌', async () => {
    const db = createDb();
    await seedAlice(db);
    const { status, body } = await callJson('/admin/password-reset', {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { email: 'nobody@example.com' },
      env: makeEnv(db),
    });
    expect(status).toBe(404);
    expect(body.code).toBe('USER_NOT_FOUND');
    expect(db.tables.password_reset_tokens).toHaveLength(0);
  });

  it('邮箱与用户 ID 都没给 → 400', async () => {
    const db = createDb();
    await seedAlice(db);
    const { status, body } = await callJson('/admin/password-reset', {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: {},
      env: makeEnv(db),
    });
    expect(status).toBe(400);
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('令牌不对时不会签发（403）', async () => {
    const db = createDb();
    await seedAlice(db);
    const { status } = await callJson('/admin/password-reset', {
      method: 'POST',
      token: 'nope',
      body: { email: ALICE_EMAIL },
      env: makeEnv(db),
    });
    expect(status).toBe(403);
    expect(db.tables.password_reset_tokens).toHaveLength(0);
  });

  it('重置成功后其它设备上的会话全部失效', async () => {
    const db = createDb();
    await seedAlice(db);
    const env = makeEnv(db);
    db.tables.sessions.push({
      token_hash: 'deadbeef',
      user_id: ALICE_ID,
      created_at: 1,
      expires_at: Date.now() + HOUR_MS,
      last_seen_at: 1,
      label: 'iphone',
    });

    const issued = await callJson('/admin/password-reset', {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { email: ALICE_EMAIL },
      env,
    });
    const token = new URL(issued.body.resetUrl).hash.split('reset=')[1];
    await callJson('/auth/password/reset', {
      method: 'POST',
      body: { token, password: 'after-reset-password' },
      env,
    });
    expect(db.tables.sessions).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 邮件自助找回：回归                                                           */
/* -------------------------------------------------------------------------- */

describe('邮件自助找回路径没有被重构改坏', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未配置邮件服务时仍返回 503，不伪造成功', async () => {
    const db = createDb();
    await seedAlice(db);
    const { status, body } = await callJson('/auth/password/forgot', {
      method: 'POST',
      body: { email: ALICE_EMAIL },
      env: makeEnv(db),
    });
    expect(status).toBe(503);
    expect(body.code).toBe('PASSWORD_RESET_NOT_CONFIGURED');
    expect(db.tables.password_reset_tokens).toHaveLength(0);
  });

  it('配置了邮件服务后照常发信，邮件里的链接同样能改密码', async () => {
    const db = createDb();
    await seedAlice(db);
    const env = makeEnv(db, {
      MAIL_API_BASE: 'https://api.brevo.com',
      MAIL_API_KEY: 'brevo-key',
      MAIL_FROM: 'noreply@example.com',
      MAIL_PROVIDER: 'brevo',
    });

    const sent = [];
    vi.stubGlobal('fetch', async (url, init) => {
      sent.push({ url: String(url), body: String(init && init.body) });
      return new Response(JSON.stringify({ messageId: 'm-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const requested = await callJson('/auth/password/forgot', {
      method: 'POST',
      body: { email: ALICE_EMAIL },
      env,
    });
    expect(requested.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://api.brevo.com/v3/smtp/email');

    const token = /reset=([A-Za-z0-9_-]+)/.exec(sent[0].body)?.[1];
    expect(token).toBeTruthy();

    const done = await callJson('/auth/password/reset', {
      method: 'POST',
      body: { token, password: 'reset-via-email-1' },
      env,
    });
    expect(done.status).toBe(200);
    expect(db.tables.password_reset_tokens).toHaveLength(0);
  });

  it('发信失败时不会留下一个「以为发出去了」的链接', async () => {
    const db = createDb();
    await seedAlice(db);
    const env = makeEnv(db, {
      MAIL_API_BASE: 'https://api.brevo.com',
      MAIL_API_KEY: 'brevo-key',
      MAIL_FROM: 'noreply@example.com',
      MAIL_PROVIDER: 'brevo',
    });

    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });

    const requested = await callJson('/auth/password/forgot', {
      method: 'POST',
      body: { email: ALICE_EMAIL },
      env,
    });
    expect(requested.status).toBe(200);
    expect(db.tables.password_reset_tokens).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 边界                                                                        */
/* -------------------------------------------------------------------------- */

describe('边界', () => {
  it('/admin/* 只认指定方法，GET /admin/password-reset 仍然 404', async () => {
    const db = createDb();
    const { status } = await callJson('/admin/password-reset', { token: ADMIN_TOKEN, env: makeEnv(db) });
    expect(status).toBe(404);
  });

  it('过期的重置令牌不能用', async () => {
    const db = createDb();
    await seedAlice(db);
    // 直接塞一条已过期的摘要，模拟「链接放了太久」。
    const rawToken = 'expired-token-value';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
    const tokenHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    db.tables.password_reset_tokens.push({
      token_hash: tokenHash,
      user_id: ALICE_ID,
      created_at: Date.now() - 2 * HOUR_MS,
      expires_at: Date.now() - HOUR_MS,
    });

    const { status, body } = await callJson('/auth/password/reset', {
      method: 'POST',
      body: { token: rawToken, password: 'whatever-password' },
      env: makeEnv(db),
    });
    expect(status).toBe(400);
    expect(body.code).toBe('RESET_TOKEN_INVALID');
  });
});


/* -------------------------------------------------------------------------- */
/* AI 念头分析：鉴权、模型调用与隐私边界                                        */
/* -------------------------------------------------------------------------- */

describe('POST /ai/analyze', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未登录时拒绝分析，不调用上游模型', async () => {
    const db = createDb();
    const env = makeEnv(db, {
      AI_PROVIDER: 'openai',
      AI_BASE_URL: 'https://api.example.com/v1',
      AI_API_KEY: 'test-key',
      AI_MODEL: 'test-model',
    });
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const result = await callJson('/ai/analyze', {
      method: 'POST',
      body: { content: '帮普通人把点子变成 App' },
      env,
    });
    expect(result.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('需要有效会话；AI 未配置时不伪造分析结果', async () => {
    const db = createDb();
    await seedAlice(db);
    const env = makeEnv(db);
    const login = await callJson('/auth/login', {
      method: 'POST',
      body: { email: ALICE_EMAIL, password: ALICE_PASSWORD },
      env,
    });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();

    const result = await callJson('/ai/analyze', {
      method: 'POST',
      token: login.body.token,
      body: { content: '帮普通人把点子变成 App' },
      env,
    });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('AI_NOT_CONFIGURED');
    expect(result.body.analysis).toBeUndefined();
  });

  it('超过每日分析上限时返回 429，且不再调用模型', async () => {
    const db = createDb();
    await seedAlice(db);
    const env = makeEnv(db, {
      AI_PROVIDER: 'openai',
      AI_BASE_URL: 'https://api.example.com/v1',
      AI_API_KEY: 'test-key',
      AI_MODEL: 'test-model',
    });
    const login = await callJson('/auth/login', {
      method: 'POST',
      body: { email: ALICE_EMAIL, password: ALICE_PASSWORD },
      env,
    });
    expect(login.status).toBe(200);
    const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (let index = 0; index < 10; index += 1) {
      db.tables.service_log.push({
        id: 'analysis-' + index,
        user_id: ALICE_ID,
        day: today,
        at: Date.now(),
        kind: 'idea-analysis',
        ok: 1,
        detail: 'ok',
      });
    }
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const result = await callJson('/ai/analyze', {
      method: 'POST',
      token: login.body.token,
      body: { content: '帮普通人把点子变成 App' },
      env,
    });
    expect(result.status).toBe(429);
    expect(result.body.code).toBe('AI_ANALYSIS_QUOTA');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('不把原始念头写进 service_log，且返回三种完整方案', async () => {
    const db = createDb();
    await seedAlice(db);
    const env = makeEnv(db, {
      AI_PROVIDER: 'openai',
      AI_BASE_URL: 'https://api.example.com/v1',
      AI_API_KEY: 'test-key',
      AI_MODEL: 'test-model',
    });
    const login = await callJson('/auth/login', {
      method: 'POST',
      body: { email: ALICE_EMAIL, password: ALICE_PASSWORD },
      env,
    });
    expect(login.status).toBe(200);

    const payload = {
      summary: '为非程序员提供从想法到原型的清晰路径。',
      problem: '不知道如何开始实现自己的念头。',
      targetUsers: ['没有编程经验的人'],
      assumptions: ['用户愿意按步骤完成小任务'],
      validation: ['先访谈目标用户'],
      risks: ['真实需求尚未验证'],
      plans: [
        { id: 'free', name: '免费验证版', goal: '验证需求', architecture: '人工访谈与可点击原型', costEstimate: '估算：0-100 元，不含人工', timeline: '估算：3-5 天', tasks: ['制作原型'], acceptance: ['完成 5 次用户访谈'], tradeoffs: '人工投入较多' },
        { id: 'low_cost', name: '最低成本实用版', goal: '跑通核心闭环', architecture: 'GitHub Pages + Cloudflare Worker', costEstimate: '估算：按免费额度起步', timeline: '估算：2-4 周', tasks: ['实现核心流程'], acceptance: ['完成一次端到端测试'], tradeoffs: '需要管理 API 用量' },
        { id: 'commercial', name: '商业化版本', goal: '支持持续运营', architecture: '账号权限、成本监控与配额', costEstimate: '需按实际用量核算', timeline: '估算：6-12 周', tasks: ['建立监控与告警'], acceptance: ['权限隔离测试通过'], tradeoffs: '运维成本更高' },
      ],
      nextStep: '先找 3 位目标用户做访谈。',
      trendQueries: ['AI 创作工具'],
      skillQueries: ['AI app builder'],
    };
    const rawIdea = '私人念头内容-不应进入日志';
    const upstream = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', upstream);

    const result = await callJson('/ai/analyze', {
      method: 'POST',
      token: login.body.token,
      body: { title: '想法助手', content: rawIdea },
      env,
    });
    expect(result.status).toBe(200);
    expect(result.body.analysis.plans).toHaveLength(3);
    expect(result.body.analysis.plans.map((plan) => plan.id)).toEqual(['free', 'low_cost', 'commercial']);
    expect(JSON.stringify(db.tables.service_log)).not.toContain(rawIdea);
    expect(JSON.stringify(db.tables.service_log)).not.toContain('想法助手');
  });
});


/* -------------------------------------------------------------------------- */
/* DAVYLAB 选题方向：鉴权、配额与结构校验                                       */
/* -------------------------------------------------------------------------- */

describe('POST /ai/topic-directions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未登录时拒绝请求，不调用上游模型', async () => {
    const db = createDb();
    const env = makeEnv(db, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://api.example.com/v1', AI_API_KEY: 'test-key', AI_MODEL: 'test-model' });
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const result = await callJson('/ai/topic-directions', { method: 'POST', body: { input: '普通人如何用 AI 做产品' }, env });
    expect(result.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('AI 未配置时明确返回 503，不伪造方向', async () => {
    const db = createDb();
    await seedAlice(db);
    const env = makeEnv(db);
    const login = await callJson('/auth/login', { method: 'POST', body: { email: ALICE_EMAIL, password: ALICE_PASSWORD }, env });
    const result = await callJson('/ai/topic-directions', { method: 'POST', token: login.body.token, body: { input: '普通人如何用 AI 做产品' }, env });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('AI_NOT_CONFIGURED');
    expect(result.body.directions).toBeUndefined();
  });

  it('返回结构化的真实方向并且不将原始念头写入服务日志', async () => {
    const db = createDb();
    await seedAlice(db);
    const env = makeEnv(db, { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://api.example.com/v1', AI_API_KEY: 'test-key', AI_MODEL: 'test-model' });
    const login = await callJson('/auth/login', { method: 'POST', body: { email: ALICE_EMAIL, password: ALICE_PASSWORD }, env });
    const directions = [1, 2, 3, 4].map((n) => ({
      title: '选题方向 ' + n, shortLabel: '方向' + n, angle: '清楚的核心观点 ' + n,
      audience: '希望用 AI 提升效率的普通读者', why: '能帮助读者解决具体问题',
      outline: ['真实问题', '分析原因', '可执行方法'], format: '深度文章', visual: '编辑风格封面与示意图',
    }));
    const rawIdea = '用户私有创作念头-不应进入日志';
    const upstream = vi.fn(async (_url, init) => {
      const requestBody = JSON.parse(init.body);
      expect(requestBody.messages.some((message) => String(message.content).includes(rawIdea))).toBe(true);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ directions }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', upstream);
    const result = await callJson('/ai/topic-directions', { method: 'POST', token: login.body.token, body: { input: rawIdea }, env });
    expect(result.status).toBe(200);
    expect(result.body.configured).toBe(true);
    expect(result.body.directions).toHaveLength(4);
    expect(result.body.directions[0].outline).toHaveLength(3);
    expect(JSON.stringify(db.tables.service_log)).not.toContain(rawIdea);
    expect(JSON.stringify(db.tables.service_log)).not.toContain('选题方向 1');
  });
});
