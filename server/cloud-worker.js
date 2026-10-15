/**
 * 念头盒 NianBox —— 云端同步 / AI 能力后端（Cloudflare Worker + D1，零依赖）。
 *
 * 与 telemetry-worker.js 的分工：
 *   * telemetry-worker.js  收匿名事件与用户主动提交的反馈，供开发者看运营数据；
 *   * cloud-worker.js（本文件）放账号与用户自己的念头 / 项目，供多终端同步。
 * 两者数据库物理隔离：运营看板的读取令牌读不到任何念头内容。
 *
 * 接口一览
 * --------
 *   GET  /health                     健康检查
 *   GET  /capabilities               AI / 邮件服务是否已配置（客户端据此决定要不要把内容发出来）
 *   POST /auth/register              邮箱 + 口令注册，返回令牌
 *   POST /auth/login                 登录，返回令牌
 *   POST /auth/logout                注销当前令牌
 *   GET  /auth/me                    当前账号 + 已登录设备
 *   POST /auth/password              修改口令（改完其它设备令牌全部失效）
 *   POST /auth/password/forgot       请求邮箱密码重置链接
 *   POST /auth/password/reset        使用一次性令牌设置新密码
 *   GET  /sync/pull?since=<cursor>   增量拉取（不带 since = 全量快照）
 *   POST /sync/push                  批量提交本地变更
 *   POST /capture                    官网快速记录：直接落进个人收件箱
 *   POST /ai/classify                自动分类（未配置模型时返回 configured:false）
 *   POST /ai/abstract                把念头抽象成主题 / 情绪 / 隐喻 / 视觉元素（含隐私检查）
 *   POST /ai/poster                  生成海报底图（未配置图像服务时返回 configured:false）
 *   POST /mail/send                  服务端发信（未配置邮件服务时返回 configured:false）
 *
 * 安全约定
 * --------
 * 1. 身份只来自 Authorization 头，**从不**从请求体里读 user_id；每条 SQL 都带 user_id 条件。
 * 2. 口令用 PBKDF2-SHA256 派生后存储，令牌只存 SHA-256 摘要 —— 数据库泄露也无法直接登录。
 * 3. 所有密钥（AI / 图像 / 邮件）都走 Worker secret，绝不进前端产物或公开仓库。
 * 4. 日志只记「调用了什么接口、成功与否」，不记内容。
 * 5. 未配置的外部服务一律明确返回 configured:false，绝不伪造成功。
 */

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/** 单次请求体上限：一次迁移最多几百条念头，超过一定是异常请求。 */
const MAX_BODY_BYTES = 1024 * 1024;
/** 单次 push 的最大操作数，客户端会分片。 */
const MAX_OPS_PER_PUSH = 200;
const MAX_TEXT_CHARS = 4000;
const MAX_TITLE_CHARS = 200;

/**
 * Cloudflare Workers 的 WebCrypto 对 PBKDF2 迭代次数有上限（超过 100000 直接抛错），
 * 这里取满上限值。派生值里带上了迭代次数，将来上限放宽只需改这一个常量，
 * 老用户的存量口令仍然能按记录里的迭代次数校验通过。
 */
const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** 剩余有效期低于这个值时自动续期，避免用户「用着用着被登出」。 */
const SESSION_RENEW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 20;

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 12;

const IDEA_CATEGORIES = ['life', 'app', 'skill', 'web', 'other'];
const IDEA_STATUSES = ['inbox', 'research', 'ready', 'building', 'done', 'paused'];
const PRODUCT_FORMS = ['app', 'website', 'miniprogram', 'skill', 'other'];
const PROJECT_PROGRESSES = ['preparing', 'building', 'testing', 'released', 'paused'];

/* -------------------------------------------------------------------------- */
/* 外部服务：服务商标识与默认值                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 智谱 GLM / CogView（BigModel 开放平台）。
 *
 * 它的 v4 接口就是 OpenAI 兼容形状，`Authorization: Bearer <API Key>` 直接可用，
 * 所以 Worker 里不需要 SDK、也不需要自己签 JWT：配一个 key 就能同时用上
 * 对话模型（glm-*）和图像模型（cogview-*）。
 */
const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
/**
 * 默认模型刻意选「免费也能跑通」的两个：
 * glm-5.3 与 cogview-4 需要账号里有余额，只填一把 key 时会直接 429；
 * 而 glm-4-flash 与 cogview-3-flash 在免费账号上就能返回真实结果。
 * 充值之后想换回 glm-5.3 / cogview-4，只改 AI_MODEL / IMAGE_MODEL 两个变量即可。
 */
export const ZHIPU_DEFAULT_CHAT_MODEL = 'glm-4-flash';
export const ZHIPU_DEFAULT_IMAGE_MODEL = 'cogview-3-flash';

/**
 * 服务商展示名兜底。
 * 为什么要在服务端兜：PLAIN 变量（*_PROVIDER_LABEL）没有写进部署流程时，
 * 一次重新部署就会把绑定删掉，界面上「数据发给了谁」会变成空白 —— 那不是缺一行配置，
 * 而是隐私提示失真。所以按服务商给默认名，缺变量也不会静默留空。
 */
const PROVIDER_LABELS = { zhipu: '智谱 GLM', openai: 'OpenAI 兼容服务' };
const IMAGE_PROVIDER_LABELS = { zhipu: '智谱 CogView', openai: 'OpenAI 兼容图像服务' };

/**
 * 图片尺寸必须按服务商分别映射：OpenAI 的 1024x1365 智谱不认，
 * 而智谱的 3:4 要写 768x1344。只写死一套，总有一家会在 400 上挂掉。
 */
const IMAGE_SIZES = {
  zhipu: { '1:1': '1024x1024', '3:4': '768x1344', '4:3': '1344x768', '16:9': '1440x720' },
  openai: { '1:1': '1024x1024', '3:4': '1024x1365', '4:3': '1365x1024', '16:9': '1792x1024' },
};

/** 图像提示词上限：智谱 CogView 要求不超过 1024 字符。 */
const MAX_IMAGE_PROMPT_CHARS = 1024;

/** 默认每人每天最多生成几张海报底图（<= 0 表示不限制）。这里刷的是真钱，所以默认设上限。 */
const DEFAULT_IMAGE_DAILY_LIMIT = 30;

/** 单张底图落回 Worker 的字节上限：防止一次把几十兆塞进响应体。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (request.method === 'GET' && path === '/health') {
        return json({ ok: true, service: 'nianbox-cloud', version: 1 });
      }
      if (request.method === 'GET' && path === '/capabilities') {
        return json(capabilities(env));
      }

      if (request.method === 'POST' && path === '/auth/register') {
        return await handleRegister(request, env);
      }
      if (request.method === 'POST' && path === '/auth/login') {
        return await handleLogin(request, env);
      }
      if (request.method === 'POST' && path === '/auth/logout') {
        return await handleLogout(request, env);
      }
      if (request.method === 'GET' && path === '/auth/me') {
        return await handleMe(request, env);
      }
      if (request.method === 'POST' && path === '/auth/password') {
        return await handlePassword(request, env);
      }
      if (request.method === 'POST' && path === '/auth/password/forgot') {
        return await handlePasswordResetRequest(request, env);
      }
      if (request.method === 'POST' && path === '/auth/password/reset') {
        return await handlePasswordReset(request, env);
      }

      if (request.method === 'GET' && path === '/sync/pull') {
        return await handlePull(url, request, env);
      }
      if (request.method === 'POST' && path === '/sync/push') {
        return await handlePush(request, env);
      }
      if (request.method === 'POST' && path === '/capture') {
        return await handleCapture(request, env);
      }

      if (request.method === 'POST' && path === '/ai/classify') {
        return await handleClassify(request, env);
      }
      if (request.method === 'POST' && path === '/ai/abstract') {
        return await handleAbstract(request, env);
      }
      if (request.method === 'POST' && path === '/ai/poster') {
        return await handlePoster(request, env);
      }
      if (request.method === 'POST' && path === '/mail/send') {
        return await handleMail(request, env);
      }

      return json({ error: '没有这个接口。' }, 404);
    } catch (error) {
      // 绝不把请求体写进日志：只记一行不含内容的错误摘要。
      console.error(
        'nianbox cloud error:',
        error && error.message ? error.message : String(error),
      );
      if (error instanceof HttpError) {
        return json({ error: error.message, code: error.code }, error.status);
      }
      // 默认不回传内部细节；只有显式打开 DEBUG_DETAIL 时（排障用）才带上，
      // 且绝不包含请求体内容。
      return json(
        {
          error: '服务内部错误，请稍后重试。',
          ...(env.DEBUG_DETAIL === '1'
            ? { detail: error && error.message ? String(error.message).slice(0, 300) : String(error).slice(0, 300) }
            : {}),
        },
        500,
      );
    }
  },
};

/* -------------------------------------------------------------------------- */
/* 基础工具                                                                    */
/* -------------------------------------------------------------------------- */

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
  }
}

function corsHeaders() {
  return {
    // 官网与应用处在不同源，二者都要能直接调这套 API；
    // 鉴权走 Authorization 头而不是 Cookie，因此开启通配来源不会带来 CSRF 风险。
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
    vary: 'origin',
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError(413, '请求内容过大，请分批次同步。', 'TOO_LARGE');
  }
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') {
      throw new HttpError(400, '请求格式不正确。', 'BAD_JSON');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '请求格式不正确。', 'BAD_JSON');
  }
}

function str(value, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function oneOf(value, allowed, fallback = null) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function hostOf(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 服务商识别：显式配置优先，其次看域名，最后按 OpenAI 兼容处理。
 * 显式配置的意义是：即使换成自建代理（域名不认识），也能走对参数分支。
 *
 * 例外：只给了一把 key、既没给地址也没给服务商时，按本项目的默认选择（智谱 GLM）处理。
 * 否则「只填 AI_API_KEY」会算成未配置——那是最容易踩的坑，配置文档里写的就是这条路。
 * 判断依据只有 key 本身，不会凭空造出一个地址发给别的服务商。
 */
export function resolveProvider(explicit, baseUrl, apiKey) {
  const hint = String(explicit || '').trim().toLowerCase();
  if (hint) return hint;
  const host = hostOf(baseUrl);
  if (host.endsWith('bigmodel.cn')) return 'zhipu';
  if (host.endsWith('openai.com') || host.endsWith('azure.com') || host.endsWith('deepseek.com')) {
    return 'openai';
  }
  if (!host && String(apiKey || '').trim()) return 'zhipu';
  return 'openai';
}

/**
 * 温度夹紧到 (0, 1]。
 *
 * 智谱的对话接口要求 temperature 落在 (0, 1]，传 0 会直接 400；
 * 而「分类」这种任务天然的取值就是 0。这里统一抬到 0.01，
 * 既保住了确定性，又不会因为一个参数把整条链路打挂。
 */
export function clampTemperature(value, fallback = 0.2) {
  const n = Number(value);
  const base = Number.isFinite(n) ? n : Number(fallback);
  if (!Number.isFinite(base)) return 0.2;
  return Math.min(Math.max(base, 0.01), 1);
}

/**
 * 宽松 JSON 解析：模型偶尔会把 JSON 裹进 ```json 围栏，或在前后多写一句话。
 * 直接 JSON.parse 失败就整条作废，代价太大。
 */
export function parseJsonLoose(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* 继续往下找 */
  }
  const fenced = raw.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(fenced);
  } catch {
    /* 继续往下找 */
  }
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(fenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** 从服务商的错误响应里抠出一句人话（用于排障日志，不含任何密钥）。 */
export function upstreamMessage(text) {
  const raw = String(text || '');
  const parsed = parseJsonLoose(raw);
  const candidate =
    (parsed && parsed.error && (parsed.error.message || parsed.error.msg)) ||
    (parsed && (parsed.message || parsed.msg)) ||
    '';
  if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 200);
  return raw.slice(0, 200);
}

/** 统一的日志摘要：错误码 + 服务商原话，正好卡在 detail 列的长度里。 */
function errorDetail(error) {
  if (!error) return 'error';
  const code = error.code || (error.name === 'AbortError' ? 'timeout' : 'error');
  const extra = error.upstream ? ` ${error.upstream}` : '';
  return `${code}${extra}`.slice(0, 200);
}

/** 只在排障开关打开时回传一句内部细节，方便「模型名写错了」这类问题自证。 */
function debugExtra(env, error) {
  if (env.DEBUG_DETAIL !== '1') return {};
  const detail = error && error.upstream ? error.upstream : errorDetail(error);
  return { detail: String(detail).slice(0, 200) };
}

/** Workers 里没有 Buffer，手工分块 base64，避免大图把调用栈撑爆。 */
export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 海报底图尺寸：服务商不认识的比例退回 1:1，绝不发出一个必然 400 的尺寸。 */
export function posterSizeFor(provider, aspect) {
  const table = IMAGE_SIZES[provider] || IMAGE_SIZES.openai;
  return table[aspect] || table['1:1'];
}

function nowMs() {
  return Date.now();
}

function dayKey(at, offsetHours = 8) {
  return new Date(at + offsetHours * 3600 * 1000).toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* 密码学：随机数、摘要、PBKDF2                                                  */
/* -------------------------------------------------------------------------- */

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomToken(bytes = 32) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = fromBase64Url(parts[2]);
  const expected = fromBase64Url(parts[3]);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      expected.length * 8,
    ),
  );
  if (bits.length !== expected.length) return false;
  // 定长比较，避免通过耗时差异猜口令。
  let diff = 0;
  for (let i = 0; i < bits.length; i += 1) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* 会话                                                                        */
/* -------------------------------------------------------------------------- */

async function authenticate(request, env) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new HttpError(401, '请先登录。', 'UNAUTHENTICATED');

  const tokenHash = await sha256Hex(match[1].trim());
  const at = nowMs();
  const row = await env.DB.prepare(
    `SELECT s.user_id AS userId, s.expires_at AS expiresAt, s.token_hash AS tokenHash,
            u.email AS email, u.display_name AS displayName, u.created_at AS createdAt
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first();

  if (!row) throw new HttpError(401, '登录已失效，请重新登录。', 'UNAUTHENTICATED');
  if (num(row.expiresAt) <= at) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    throw new HttpError(401, '登录已过期，请重新登录。', 'SESSION_EXPIRED');
  }

  if (num(row.expiresAt) - at < SESSION_RENEW_MS) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?')
      .bind(at + SESSION_TTL_MS, at, tokenHash)
      .run();
  } else {
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
      .bind(at, tokenHash)
      .run();
  }

  return {
    id: row.userId,
    email: row.email,
    displayName: row.displayName || '',
    createdAt: num(row.createdAt),
  };
}

async function issueSession(env, userId, label) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const at = nowMs();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, label) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(tokenHash, userId, at, at + SESSION_TTL_MS, at, str(label, 40))
    .run();

  // 会话数量封顶：超出时清掉最早过期的那些（用户换设备后不会无限增长）。
  await env.DB.prepare(
    `DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN (
       SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`,
  )
    .bind(userId, userId, MAX_SESSIONS_PER_USER)
    .run();

  return token;
}

/* -------------------------------------------------------------------------- */
/* 登录限流（按 IP 摘要，不落明文 IP）                                          */
/* -------------------------------------------------------------------------- */

async function assertLoginAllowed(request, env) {
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown';
  const ipHash = await sha256Hex(`${env.IP_SALT || 'nianbox'}:${ip}`);
  const at = nowMs();
  const row = await env.DB.prepare(
    'SELECT window_start AS windowStart, attempts FROM login_throttle WHERE ip_hash = ?',
  )
    .bind(ipHash)
    .first();

  if (!row || at - num(row.windowStart) > LOGIN_WINDOW_MS) {
    await env.DB.prepare(
      'INSERT INTO login_throttle (ip_hash, window_start, attempts) VALUES (?, ?, 1) ' +
        'ON CONFLICT(ip_hash) DO UPDATE SET window_start = ?, attempts = 1',
    )
      .bind(ipHash, at, at)
      .run();
    return ipHash;
  }

  if (num(row.attempts) >= LOGIN_MAX_ATTEMPTS) {
    const waitMinutes = Math.ceil((LOGIN_WINDOW_MS - (at - num(row.windowStart))) / 60000);
    throw new HttpError(429, `尝试次数过多，请 ${waitMinutes} 分钟后再试。`, 'RATE_LIMITED');
  }

  await env.DB.prepare('UPDATE login_throttle SET attempts = attempts + 1 WHERE ip_hash = ?')
    .bind(ipHash)
    .run();
  return ipHash;
}

async function clearLoginThrottle(ipHash, env) {
  await env.DB.prepare('DELETE FROM login_throttle WHERE ip_hash = ?').bind(ipHash).run();
}

/* -------------------------------------------------------------------------- */
/* 领域对象规范化（与前端 storage.ts 的规则保持一致）                            */
/* -------------------------------------------------------------------------- */

function normalizeIdea(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const createdAt = num(source.createdAt, nowMs());
  const updatedAt = Math.max(num(source.updatedAt, createdAt), createdAt);
  return {
    id: str(source.id, 120),
    title: str(source.title, MAX_TITLE_CHARS),
    content: str(source.content, MAX_TEXT_CHARS),
    category: oneOf(source.category, IDEA_CATEGORIES, null),
    status: oneOf(source.status, IDEA_STATUSES, 'inbox'),
    tags: Array.isArray(source.tags)
      ? source.tags
          .filter((tag) => typeof tag === 'string' && tag.trim() !== '')
          .slice(0, 30)
          .map((tag) => tag.trim().slice(0, 40))
      : [],
    pinned: source.pinned === true,
    notes: str(source.notes),
    problem: str(source.problem),
    targetUsers: str(source.targetUsers),
    productForm: oneOf(source.productForm, PRODUCT_FORMS, null),
    projectUrl: str(source.projectUrl, 500),
    projectId: typeof source.projectId === 'string' && source.projectId ? str(source.projectId, 120) : null,
    createdAt,
    updatedAt,
    deletedAt: source.deletedAt === null || source.deletedAt === undefined ? null : num(source.deletedAt, updatedAt),
    // AI 分类来源：ai / rules / manual / null（尚未分类）。
    categorySource:
      source.categorySource === 'ai' || source.categorySource === 'rules' || source.categorySource === 'manual'
        ? source.categorySource
        : null,
  };
}

function normalizeProject(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const createdAt = num(source.createdAt, nowMs());
  const updatedAt = Math.max(num(source.updatedAt, createdAt), createdAt);
  return {
    id: str(source.id, 120),
    ideaId: str(source.ideaId, 120),
    name: str(source.name, MAX_TITLE_CHARS),
    problem: str(source.problem),
    targetUsers: str(source.targetUsers),
    features: str(source.features),
    productForm: oneOf(source.productForm, PRODUCT_FORMS, null),
    progress: oneOf(source.progress, PROJECT_PROGRESSES, 'preparing'),
    repoUrl: str(source.repoUrl, 500),
    liveUrl: str(source.liveUrl, 500),
    createdAt,
    updatedAt,
    deletedAt: source.deletedAt === null || source.deletedAt === undefined ? null : num(source.deletedAt, updatedAt),
  };
}

/* -------------------------------------------------------------------------- */
/* 全局单调序号                                                                */
/* -------------------------------------------------------------------------- */

async function allocateSeq(env, count) {
  const size = Math.max(1, count);
  const row = await env.DB.prepare(
    "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT) WHERE key = 'seq' RETURNING value",
  )
    .bind(size)
    .first();
  if (row && row.value !== undefined) return Number(row.value);
  // 兜底：极少数环境下不支持 RETURNING，退化为「先读后写」。
  const current = await env.DB.prepare("SELECT value FROM meta WHERE key = 'seq'").first();
  const next = num(current && current.value ? Number(current.value) : 0) + size;
  await env.DB.prepare("UPDATE meta SET value = ? WHERE key = 'seq'").bind(String(next)).run();
  return next;
}

async function currentSeq(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'seq'").first();
  return row && row.value !== undefined ? Number(row.value) : 0;
}

/* -------------------------------------------------------------------------- */
/* 认证接口                                                                    */
/* -------------------------------------------------------------------------- */

function normalizeEmail(value) {
  return str(value, 200).trim().toLowerCase();
}

function assertPassword(password) {
  const value = typeof password === 'string' ? password : '';
  if (value.length < 8) {
    throw new HttpError(400, '口令至少 8 位，建议用一句只有你记得的话。', 'WEAK_PASSWORD');
  }
  if (value.length > 200) {
    throw new HttpError(400, '口令太长了，请控制在 200 字以内。', 'WEAK_PASSWORD');
  }
  return value;
}

function assertEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    throw new HttpError(400, '请填一个可用的邮箱地址。', 'BAD_EMAIL');
  }
  return email;
}

async function handleRegister(request, env) {
  const body = await readJson(request);
  const email = assertEmail(normalizeEmail(body.email));
  const password = assertPassword(body.password);
  const ipHash = await assertLoginAllowed(request, env);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    throw new HttpError(409, '这个邮箱已经注册过了，直接登录即可。', 'EMAIL_TAKEN');
  }

  const at = nowMs();
  const userId = `u_${randomToken(12)}`;
  const passwordHash = await hashPassword(password);
  await env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(userId, email, passwordHash, str(body.displayName, 60), at, at)
    .run();
  await env.DB.prepare('INSERT OR IGNORE INTO user_state (user_id, last_seq) VALUES (?, 0)')
    .bind(userId)
    .run();

  const token = await issueSession(env, userId, body.deviceLabel);
  await clearLoginThrottle(ipHash, env);
  const seq = await currentSeq(env);
  return json({ token, user: { id: userId, email, displayName: str(body.displayName, 60) }, cursor: seq, full: false });
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const ipHash = await assertLoginAllowed(request, env);

  const user = await env.DB.prepare(
    'SELECT id, email, display_name AS displayName, password_hash AS passwordHash FROM users WHERE email = ?',
  )
    .bind(email)
    .first();

  // 邮箱不存在与口令错误返回同一句话，避免被用来枚举已注册邮箱。
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new HttpError(401, '邮箱或口令不正确。', 'BAD_CREDENTIALS');
  }

  const token = await issueSession(env, user.id, body.deviceLabel);
  await clearLoginThrottle(ipHash, env);
  const seq = await currentSeq(env);
  return json({
    token,
    user: { id: user.id, email: user.email, displayName: user.displayName || '' },
    cursor: seq,
    full: false,
  });
}


async function handlePasswordResetRequest(request, env) {
  const body = await readJson(request);
  const email = assertEmail(normalizeEmail(body.email));
  await assertLoginAllowed(request, env);

  const cfg = mailConfig(env);
  if (!cfg.ready) {
    throw new HttpError(503, '密码找回邮件服务尚未配置，请联系念头盒维护者。', 'PASSWORD_RESET_NOT_CONFIGURED');
  }

  // Do not disclose whether an email address is registered.
  const message = '如果该邮箱已注册且邮件服务可用，我们会发送密码重置链接。请检查收件箱和垃圾邮件。';
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?')
    .bind(email).first();
  if (!user) return json({ requested: true, message });

  const now = nowMs();
  await env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at <= ?')
    .bind(user.id, now).run();
  const rawToken = randomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  await env.DB.prepare(
    'INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).bind(tokenHash, user.id, now, now + 30 * 60 * 1000).run();

  try {
    const base = String(env.PUBLIC_APP_URL || 'https://chenzhe223-tech.github.io/niantou-box-app/').trim();
    const resetUrl = new URL(base);
    resetUrl.hash = '/cloud?reset=' + encodeURIComponent(rawToken);
    const result = await sendMail(env, {
      to: user.email,
      subject: '【念头盒 NianBox】重置登录密码',
      text: [
        '你好，', '',
        '我们收到了念头盒账号的密码重置请求。',
        '请在 30 分钟内打开下面的链接设置新密码：', '',
        resetUrl.toString(), '',
        '此链接只能使用一次。如果不是你本人操作，请忽略这封邮件。',
      ].join('\n'),
    });
    // 发不出去就把令牌删掉：宁可让用户重新申请，也不要留一个他以为已经发出去的链接。
    if (!result.sent) throw new Error('mail-provider-error');
    await logService(env, user.id, 'password-reset', true, 'email-sent');
  } catch {
    await env.DB.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?').bind(tokenHash).run();
    await logService(env, user.id, 'password-reset', false, 'email-failed');
    // Keep the response generic; never expose account existence or provider details.
  }
  return json({ requested: true, message });
}

async function handlePasswordReset(request, env) {
  const body = await readJson(request);
  const token = str(body.token, 200).trim();
  const password = assertPassword(body.password);
  if (!token) throw new HttpError(400, '重置链接无效或已过期，请重新申请。', 'RESET_TOKEN_INVALID');

  const now = nowMs();
  const tokenHash = await sha256Hex(token);
  const reset = await env.DB.prepare(
    'SELECT user_id AS userId FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?',
  ).bind(tokenHash, now).first();
  if (!reset || typeof reset.userId !== 'string' || !reset.userId) {
    throw new HttpError(400, '重置链接无效或已过期，请重新申请。', 'RESET_TOKEN_INVALID');
  }

  // Consume the single-use token conditionally; concurrent use cannot reset twice.
  const consumed = await env.DB.prepare(
    'DELETE FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?',
  ).bind(tokenHash, now).run();
  if (Number(consumed?.meta?.changes ?? 0) !== 1) {
    throw new HttpError(400, '重置链接无效或已过期，请重新申请。', 'RESET_TOKEN_INVALID');
  }

  const passwordHash = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(passwordHash, nowMs(), reset.userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(reset.userId),
    env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(reset.userId),
  ]);
  return json({ ok: true });
}

async function handleLogout(request, env) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await sha256Hex(match[1].trim()))
      .run();
  }
  return json({ ok: true });
}

async function handleMe(request, env) {
  const user = await authenticate(request, env);
  const devices = await env.DB.prepare(
    'SELECT label, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 20',
  )
    .bind(user.id)
    .all();
  const state = await env.DB.prepare('SELECT last_seq AS lastSeq, last_sync_at AS lastSyncAt FROM user_state WHERE user_id = ?')
    .bind(user.id)
    .first();
  const counts = await countRecords(env, user.id);
  return json({
    user,
    devices: (devices.results || []).map((row) => ({
      label: row.label || '',
      createdAt: num(row.createdAt),
      lastSeenAt: num(row.lastSeenAt),
      expiresAt: num(row.expiresAt),
    })),
    cursor: state && state.lastSeq !== undefined ? Number(state.lastSeq) : await currentSeq(env),
    lastSyncAt: num(state && state.lastSyncAt),
    counts,
  });
}

async function handlePassword(request, env) {
  const user = await authenticate(request, env);
  const body = await readJson(request);
  const row = await env.DB.prepare('SELECT password_hash AS passwordHash FROM users WHERE id = ?')
    .bind(user.id)
    .first();
  if (!row || !(await verifyPassword(typeof body.currentPassword === 'string' ? body.currentPassword : '', row.passwordHash))) {
    throw new HttpError(401, '当前口令不正确。', 'BAD_CREDENTIALS');
  }
  const next = assertPassword(body.newPassword);
  const at = nowMs();
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(next), at, user.id)
    .run();
  // 改口令即登出所有设备（包括当前这台），用户重新登录一次即可。
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
  return json({ ok: true, reauthRequired: true });
}

/* -------------------------------------------------------------------------- */
/* 同步：拉取                                                                  */
/* -------------------------------------------------------------------------- */

async function countRecords(env, userId) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM ideas WHERE user_id = ? AND deleted_at IS NULL) AS ideas,
       (SELECT COUNT(*) FROM projects WHERE user_id = ? AND deleted_at IS NULL) AS projects`,
  )
    .bind(userId, userId)
    .first();
  return { ideas: num(row && row.ideas), projects: num(row && row.projects) };
}

const RECORD_COLUMNS = 'id, doc, updated_at AS updatedAt, seq';

function parseDoc(row) {
  try {
    return JSON.parse(row.doc);
  } catch {
    return null;
  }
}

async function handlePull(url, request, env) {
  const user = await authenticate(request, env);
  const rawSince = url.searchParams.get('since');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 1000, 1), 2000);

  /*
   * 快照边界：先取一次「当前全局序号」作为上界，再按 seq <= 上界 查询。
   * 否则会出现这样一种漏数据：SELECT 返回的是此刻的行，随后另一台设备写入
   * 新行并拿到更大的 seq，而本函数结束时读到的是「包含那条新行」的当前序号；
   * 客户端把游标推到这个序号，就再也拉不到那条记录了。
   */
  const boundary = await currentSeq(env);

  if (rawSince === null || rawSince === '') {
    // 全量快照：新设备 / 重装后的第一次同步。
    const ideas = await env.DB.prepare(
      `SELECT ${RECORD_COLUMNS} FROM ideas WHERE user_id = ? AND seq <= ? ORDER BY seq ASC LIMIT ?`,
    )
      .bind(user.id, boundary, limit)
      .all();
    const projects = await env.DB.prepare(
      `SELECT ${RECORD_COLUMNS} FROM projects WHERE user_id = ? AND seq <= ? ORDER BY seq ASC LIMIT ?`,
    )
      .bind(user.id, boundary, limit)
      .all();
    const tombstones = await env.DB.prepare(
      'SELECT entity, id FROM tombstones WHERE user_id = ? AND seq <= ? ORDER BY seq ASC LIMIT ?',
    )
      .bind(user.id, boundary, limit)
      .all();
    const cursor = boundary;
    const truncated = (ideas.results || []).length >= limit || (projects.results || []).length >= limit;
    await env.DB.prepare(
      'INSERT INTO user_state (user_id, last_seq, last_sync_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET last_seq = ?, last_sync_at = ?',
    )
      .bind(user.id, cursor, nowMs(), cursor, nowMs())
      .run();
    return json({
      full: true,
      cursor,
      truncated,
      ideas: (ideas.results || []).map((row) => ({ ...(parseDoc(row) || {}), seq: num(row.seq), serverUpdatedAt: num(row.updatedAt) })).filter((x) => x.id),
      projects: (projects.results || []).map((row) => ({ ...(parseDoc(row) || {}), seq: num(row.seq), serverUpdatedAt: num(row.updatedAt) })).filter((x) => x.id),
      purged: (tombstones.results || []).map((row) => ({ entity: row.entity === 'project' ? 'project' : 'idea', id: row.id })),
    });
  }

  const since = Number(rawSince);
  if (!Number.isFinite(since) || since < 0) {
    throw new HttpError(400, '同步游标不正确。', 'BAD_CURSOR');
  }

  const ideas = await env.DB.prepare(
    `SELECT ${RECORD_COLUMNS} FROM ideas WHERE user_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?`,
  )
    .bind(user.id, since, boundary, limit)
    .all();
  const projects = await env.DB.prepare(
    `SELECT ${RECORD_COLUMNS} FROM projects WHERE user_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?`,
  )
    .bind(user.id, since, boundary, limit)
    .all();
  const tombstones = await env.DB.prepare(
    'SELECT entity, id FROM tombstones WHERE user_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?',
  )
    .bind(user.id, since, boundary, limit)
    .all();

  const rows = [...(ideas.results || []), ...(projects.results || [])];
  const maxSeq = rows.reduce((max, row) => Math.max(max, num(row.seq)), since);
  // 拉到上限说明还有积压，游标只推进到本批最大序号，下次继续。
  const truncated = (ideas.results || []).length >= limit || (projects.results || []).length >= limit;
  const cursor = truncated ? maxSeq : boundary;

  await env.DB.prepare(
    'INSERT INTO user_state (user_id, last_seq, last_sync_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET last_seq = ?, last_sync_at = ?',
  )
    .bind(user.id, cursor, nowMs(), cursor, nowMs())
    .run();

  return json({
    full: false,
    cursor,
    truncated,
    ideas: (ideas.results || []).map((row) => ({ ...(parseDoc(row) || {}), seq: num(row.seq), serverUpdatedAt: num(row.updatedAt) })).filter((x) => x.id),
    projects: (projects.results || []).map((row) => ({ ...(parseDoc(row) || {}), seq: num(row.seq), serverUpdatedAt: num(row.updatedAt) })).filter((x) => x.id),
    purged: (tombstones.results || []).map((row) => ({ entity: row.entity === 'project' ? 'project' : 'idea', id: row.id })),
  });
}

/* -------------------------------------------------------------------------- */
/* 同步：推送                                                                  */
/* -------------------------------------------------------------------------- */

async function selectRecord(env, table, userId, id) {
  const row = await env.DB.prepare(
    `SELECT ${RECORD_COLUMNS} FROM ${table} WHERE user_id = ? AND id = ?`,
  )
    .bind(userId, id)
    .first();
  return row || null;
}

async function handlePush(request, env) {
  const user = await authenticate(request, env);
  const body = await readJson(request);
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (ops.length === 0) {
    return json({ cursor: await currentSeq(env), results: [] });
  }
  if (ops.length > MAX_OPS_PER_PUSH) {
    throw new HttpError(413, `一次最多提交 ${MAX_OPS_PER_PUSH} 条变更，请分片。`, 'TOO_MANY_OPS');
  }

  const results = [];
  const writes = [];

  /*
   * 先算清楚这次要占多少个序号。
   *
   * upsert 一条占一个；purge 一条不但自己占一个，还要给「连带删除的项目」
   * 各占一个墓碑序号。如果只按 ops.length 分配，序号可能被两个不同的写入
   * 复用，而序号重复会让增量拉取漏记录，所以这里先把连带删除的项目查出来，
   * 按真实需要量一次性分配。
   */
  const linkedProjects = new Map();
  let needed = 0;
  for (const raw of ops) {
    if (!raw) continue;
    const isPurge = raw.op === 'purge';
    const isIdea = raw.entity !== 'project';
    const id = str(raw.id, 120);
    needed += 1;
    if (isPurge && isIdea && id) {
      const linked = await env.DB.prepare(
        `SELECT id FROM projects WHERE user_id = ? AND json_extract(doc, '$.ideaId') = ?`,
      )
        .bind(user.id, id)
        .all();
      const ids = (linked.results || []).map((row) => row.id).filter(Boolean);
      linkedProjects.set(id, ids);
      needed += ids.length;
    }
  }

  let seq = await allocateSeq(env, needed);

  for (const raw of ops) {
    const entity = raw && raw.entity === 'project' ? 'project' : 'idea';
    const table = entity === 'project' ? 'projects' : 'ideas';
    const id = str(raw && raw.id, 120);
    const op = raw && raw.op === 'purge' ? 'purge' : 'upsert';

    if (!id) {
      results.push({ entity, id: '', status: 'rejected', reason: 'missing-id' });
      continue;
    }

    if (op === 'purge') {
      const rowSeq = seq;
      seq -= 1;
      writes.push(env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ? AND id = ?`).bind(user.id, id));
      // 墓碑：即使记录本体已经不在了，这次删除也必须能被别的设备拉到。
      // 因此无论原来是否存在，都写一条墓碑（已存在则覆盖成新的 seq）。
      writes.push(
        env.DB.prepare(
          `INSERT INTO tombstones (user_id, entity, id, seq, at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id, entity, id) DO UPDATE SET seq = excluded.seq, at = excluded.at`,
        ).bind(user.id, entity, id, rowSeq, nowMs()),
      );
      if (entity === 'idea') {
        // 关联项目不能悬空：永久删除念头时一并清掉它的项目，并各自留下墓碑。
        for (const projectId of linkedProjects.get(id) || []) {
          const linkedSeq = seq;
          seq -= 1;
          writes.push(
            env.DB.prepare('DELETE FROM projects WHERE user_id = ? AND id = ?').bind(
              user.id,
              projectId,
            ),
          );
          writes.push(
            env.DB.prepare(
              `INSERT INTO tombstones (user_id, entity, id, seq, at) VALUES (?, 'project', ?, ?, ?)
                 ON CONFLICT(user_id, entity, id) DO UPDATE SET seq = excluded.seq, at = excluded.at`,
            ).bind(user.id, projectId, linkedSeq, nowMs()),
          );
        }
      }
      results.push({ entity, id, status: 'applied', seq: rowSeq });
      continue;
    }

    const doc = entity === 'project' ? normalizeProject(raw.doc) : normalizeIdea(raw.doc);
    if (!doc.id) {
      results.push({ entity, id, status: 'rejected', reason: 'invalid-doc' });
      continue;
    }
    if (entity === 'project' && !doc.ideaId) {
      results.push({ entity, id, status: 'rejected', reason: 'missing-idea-id' });
      continue;
    }

    const existing = await selectRecord(env, table, user.id, id);
    if (existing && num(existing.updatedAt) > doc.updatedAt) {
      // 服务端更新，客户端这份是基于旧数据的修改：退回服务端版本，由客户端覆盖本地。
      const serverDoc = parseDoc(existing);
      results.push({
        entity,
        id,
        status: 'rejected',
        reason: 'stale',
        doc: serverDoc,
        serverUpdatedAt: num(existing.updatedAt),
      });
      continue;
    }
    if (existing && num(existing.updatedAt) === doc.updatedAt && num(existing.seq) > 0) {
      // 时间戳相同：内容也相同才算「重复提交」，幂等跳过；
      // 内容不同（例如两台设备在同一毫秒各改了一次）就照常写入，最后写入者胜出。
      if (existing.doc === JSON.stringify(doc)) {
        results.push({ entity, id, status: 'applied', reason: 'noop' });
        continue;
      }
    }

    const rowSeq = seq;
    seq -= 1;
    writes.push(
      env.DB.prepare(
        `INSERT INTO ${table} (user_id, id, doc, updated_at, deleted_at, seq) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at, seq = excluded.seq`,
      ).bind(
        user.id,
        doc.id,
        JSON.stringify(doc),
        doc.updatedAt,
        doc.deletedAt === null ? null : doc.deletedAt,
        rowSeq,
      ),
    );
    results.push({ entity, id, status: 'applied', seq: rowSeq });
  }

  if (writes.length > 0) {
    await env.DB.batch(writes);
  }

  const cursor = await currentSeq(env);
  await env.DB.prepare(
    'INSERT INTO user_state (user_id, last_seq, last_sync_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET last_sync_at = ?',
  )
    .bind(user.id, cursor, nowMs(), nowMs())
    .run();

  return json({ cursor, results });
}

/* -------------------------------------------------------------------------- */
/* 官网快速记录                                                                */
/* -------------------------------------------------------------------------- */

async function handleCapture(request, env) {
  const user = await authenticate(request, env);
  const body = await readJson(request);
  const content = str(body.content, MAX_TEXT_CHARS * 2);
  if (!content.trim()) {
    throw new HttpError(400, '请先写下一句话。', 'EMPTY_CONTENT');
  }

  // 幂等：客户端可以用同一个 id 重试（网络超时、弱网重发），
  // 服务端发现这条记录已经存在就直接回原记录，不会再造一条重复的念头。
  const requestedId = str(body.id, 120).trim();
  if (requestedId) {
    const existing = await selectRecord(env, 'ideas', user.id, requestedId);
    if (existing) {
      const doc = parseDoc(existing) || {};
      return json({
        ok: true,
        duplicate: true,
        idea: { ...doc, seq: num(existing.seq), serverUpdatedAt: num(existing.updatedAt) },
        cursor: num(existing.seq),
        source: str(body.source, 40) || 'website',
      });
    }
  }

  const at = nowMs();
  const idea = normalizeIdea({
    id: requestedId || `idea_${crypto.randomUUID()}`,
    title: '',
    content,
    category: null,
    status: 'inbox',
    tags: [],
    pinned: false,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    categorySource: null,
  });

  if (!idea.id) {
    throw new HttpError(400, '这条念头的编号不正确。', 'BAD_ID');
  }

  const seq = await allocateSeq(env, 1);
  try {
    await env.DB.prepare(
      'INSERT INTO ideas (user_id, id, doc, updated_at, deleted_at, seq) VALUES (?, ?, ?, ?, NULL, ?)',
    )
      .bind(user.id, idea.id, JSON.stringify(idea), idea.updatedAt, seq)
      .run();
  } catch (error) {
    // 并发重试时可能刚好撞上唯一键：当作幂等成功返回已有记录。
    const raced = await selectRecord(env, 'ideas', user.id, idea.id);
    if (!raced) throw error;
    const doc = parseDoc(raced) || {};
    return json({
      ok: true,
      duplicate: true,
      idea: { ...doc, seq: num(raced.seq), serverUpdatedAt: num(raced.updatedAt) },
      cursor: num(raced.seq),
      source: str(body.source, 40) || 'website',
    });
  }

  return json({ ok: true, idea: { ...idea, seq, serverUpdatedAt: idea.updatedAt }, cursor: seq, source: str(body.source, 40) || 'website' });
}

/* -------------------------------------------------------------------------- */
/* AI：配置探测 / 分类 / 抽象                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 对话模型配置（自动分类 / 隐私抽象）。
 *
 * 配了 AI_PROVIDER=zhipu 之后只需要两样东西：AI_API_KEY 和（可选的）AI_MODEL。
 * 地址与模型名都有服务商默认值兜底，少写一个变量不会变成「静默不可用」。
 */
export function aiConfig(env) {
  const source = env || {};
  const explicitBase = (source.AI_BASE_URL || '').trim();
  const apiKey = (source.AI_API_KEY || '').trim();
  const provider = resolveProvider(source.AI_PROVIDER, explicitBase, apiKey);
  const baseUrl = (explicitBase || (provider === 'zhipu' ? ZHIPU_BASE_URL : '')).replace(/\/+$/, '');
  const fallbackModel = provider === 'zhipu' && apiKey ? ZHIPU_DEFAULT_CHAT_MODEL : '';
  const model = (source.AI_MODEL || fallbackModel).trim();
  return { baseUrl, apiKey, model, provider, ready: Boolean(baseUrl && apiKey && model) };
}

/** 图像模型配置。同一个智谱 key 直接覆盖 CogView，不必再配第二把钥匙。 */
export function imageConfig(env) {
  const source = env || {};
  const explicitBase = (source.IMAGE_BASE_URL || source.AI_BASE_URL || '').trim();
  const apiKey = (source.IMAGE_API_KEY || source.AI_API_KEY || '').trim();
  const provider = resolveProvider(
    source.IMAGE_PROVIDER || source.AI_PROVIDER,
    explicitBase,
    apiKey,
  );
  const baseUrl = (explicitBase || (provider === 'zhipu' ? ZHIPU_BASE_URL : '')).replace(/\/+$/, '');
  const fallbackModel = provider === 'zhipu' && apiKey ? ZHIPU_DEFAULT_IMAGE_MODEL : '';
  const model = (source.IMAGE_MODEL || fallbackModel).trim();
  return { baseUrl, apiKey, model, provider, ready: Boolean(baseUrl && apiKey && model) };
}

/**
 * 邮件服务商：Resend / SendGrid / Mailgun / Brevo / 自建（默认按 Resend 的形状发）。
 *
 * 为什么额外收一个 Brevo：Resend 与 SendGrid 都要求先验证**自有域名**，
 * 而 Brevo 允许只验证一个**发件邮箱**就能给任意收件人发信。对还没有域名的
 * 个人开发者来说，这是唯一能在十分钟内把「邮件找回密码」真正点亮的路径。
 */
export function resolveMailProvider(explicit, baseUrl) {
  const hint = String(explicit || '').trim().toLowerCase();
  if (hint) return hint;
  const host = hostOf(baseUrl);
  if (host.includes('sendgrid')) return 'sendgrid';
  if (host.includes('mailgun')) return 'mailgun';
  if (host.includes('brevo') || host.includes('sendinblue')) return 'brevo';
  return 'resend';
}

export function mailConfig(env) {
  const source = env || {};
  const baseUrl = (source.MAIL_API_BASE || '').trim().replace(/\/+$/, '');
  const apiKey = (source.MAIL_API_KEY || '').trim();
  const from = (source.MAIL_FROM || '').trim();
  const fromName = (source.MAIL_FROM_NAME || '').trim();
  const provider = resolveMailProvider(source.MAIL_PROVIDER, baseUrl);
  return { baseUrl, apiKey, from, fromName, provider, ready: Boolean(baseUrl && apiKey && from) };
}

export function capabilities(env) {
  const ai = aiConfig(env);
  const image = imageConfig(env);
  const mail = mailConfig(env);
  return {
    version: 1,
    classify: ai.ready,
    abstract: ai.ready,
    image: image.ready,
    mail: mail.ready,
    passwordReset: mail.ready,
    // 供前端展示「数据会发给谁」：显式标签 > 服务商默认名 > 域名。
    aiProvider: ai.ready
      ? str(env.AI_PROVIDER_LABEL, 60) || PROVIDER_LABELS[ai.provider] || hostOf(ai.baseUrl)
      : '',
    imageProvider: image.ready
      ? str(env.IMAGE_PROVIDER_LABEL, 60) ||
        IMAGE_PROVIDER_LABELS[image.provider] ||
        hostOf(image.baseUrl)
      : '',
    // 模型名不是密钥，回显出来是为了让「到底接的哪个模型」可以自证。
    aiModel: ai.ready ? ai.model : '',
    imageModel: image.ready ? image.model : '',
    // 邮件服务商回显一个名字，方便运维时确认走的是哪条通道。
    mailProvider: mail.ready ? mail.provider : '',
  };
}

async function logService(env, userId, kind, ok, detail) {
  try {
    await env.DB.prepare(
      'INSERT INTO service_log (id, user_id, day, at, kind, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(`s_${crypto.randomUUID()}`, userId, dayKey(nowMs(), num(env.TZ_OFFSET_HOURS, 8)), nowMs(), kind, ok ? 1 : 0, str(detail, 80))
      .run();
  } catch {
    // 留痕失败绝不影响主流程。
  }
}

/** 发一次对话补全请求，返回原始结果（不抛错，交给调用方决定怎么退让）。 */
async function requestChat(env, cfg, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new HttpError(504, 'AI 服务响应超时。', 'AI_TIMEOUT');
    }
    throw new HttpError(502, 'AI 服务连接失败。', 'AI_NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调一次 OpenAI 兼容的对话补全接口（智谱 GLM 走的就是这条）。
 *
 * 只把必要的文本发出去，且不落任何日志。
 *
 * 关于「能力探测」：不同服务商对 response_format / thinking 这些可选参数的支持并不齐，
 * 参数被拒时会返回 400。这里按「从最完整到最朴素」的顺序退让，而不是一遇到 400 就判失败——
 * 否则换个模型就要改代码。
 */
export async function callChat(env, messages, options = {}) {
  const cfg = aiConfig(env);
  if (!cfg.ready) throw new HttpError(503, 'AI 服务尚未配置。', 'AI_NOT_CONFIGURED');

  const base = {
    model: cfg.model,
    messages,
    temperature: clampTemperature(options.temperature, 0.2),
    max_tokens: options.maxTokens ?? 600,
  };
  const shapes = [];
  const withJson = options.json ? { ...base, response_format: { type: 'json_object' } } : base;
  if (cfg.provider === 'zhipu' && options.json) {
    // 分类是短任务，关掉思考链能省一半时间与额度；被拒就自动退回普通调用。
    shapes.push({ ...withJson, thinking: { type: 'disabled' } });
  }
  shapes.push(withJson);
  if (options.json) shapes.push(base);

  const timeoutMs = options.timeoutMs || 25_000;
  let last = { ok: false, status: 0, text: '' };
  for (let i = 0; i < shapes.length; i += 1) {
    last = await requestChat(env, cfg, shapes[i], timeoutMs);
    if (last.ok) break;
    const canRetry = i < shapes.length - 1 && (last.status === 400 || last.status === 422);
    if (!canRetry) break;
  }

  if (!last.ok) {
    const error = new HttpError(502, `AI 服务返回错误（HTTP ${last.status}）。`, 'AI_UPSTREAM');
    error.upstream = upstreamMessage(last.text);
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(last.text);
  } catch {
    throw new HttpError(502, 'AI 服务返回了无法解析的内容。', 'AI_UPSTREAM');
  }
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    const error = new HttpError(502, 'AI 服务没有返回内容。', 'AI_UPSTREAM');
    error.upstream = upstreamMessage(last.text);
    throw error;
  }
  return content;
}

const CATEGORY_LABELS = {
  life: '生活问题',
  app: 'App / 产品创意',
  skill: 'Skill / 自动化',
  web: '网站 / 小程序',
  other: '其他',
};

const CATEGORY_RULES = [
  {
    category: 'skill',
    words: ['skill', '自动化', '脚本', '定时', '批处理', 'workflow', '机器人', 'agent', '工作流', '爬虫', 'rpa'],
  },
  {
    category: 'web',
    words: ['网站', '网页', '小程序', '前端', '后端', 'landing', '官网', 'h5', '后台管理', 'cms', '博客', '域名', 'seo'],
  },
  {
    category: 'app',
    words: ['app', '应用', '产品', '功能', '交互', '界面', 'ui', 'ux', '客户端', '订阅', '付费', '盈利', '用户增长', '商业模式'],
  },
  {
    category: 'life',
    words: ['生活', '通勤', '做饭', '睡眠', '健身', '家务', '收纳', '记账', '孩子', '家人', '打扫', '宠物', '买菜', '健康', '情绪'],
  },
];

/** 规则分类：AI 未配置时的兜底，完全在服务端本地完成，不调用任何外部服务。 */
export function classifyByRules(text) {
  const haystack = String(text || '').toLowerCase();
  let best = { category: 'other', score: 0 };
  for (const rule of CATEGORY_RULES) {
    let score = 0;
    for (const word of rule.words) {
      if (haystack.includes(word.toLowerCase())) score += word.length >= 3 ? 2 : 1;
    }
    if (score > best.score) best = { category: rule.category, score };
  }
  return best.category;
}

async function handleClassify(request, env) {
  const user = await authenticate(request, env);
  const body = await readJson(request);
  const content = str(body.content, MAX_TEXT_CHARS);
  if (!content.trim()) throw new HttpError(400, '内容为空。', 'EMPTY_CONTENT');

  if (!aiConfig(env).ready) {
    return json({
      configured: false,
      category: classifyByRules(content),
      label: CATEGORY_LABELS[classifyByRules(content)],
      source: 'rules',
      message: '服务端尚未配置 AI 模型，已用本地关键词规则完成分类。',
    });
  }

  try {
    const raw = await callChat(
      env,
      [
        {
          role: 'system',
          content:
            '你是念头分类助手。把用户的想法归到且仅归到以下五类之一，只输出 JSON：' +
            '{"category":"life|app|skill|web|other"}。' +
            'life=生活问题，app=App/产品创意，skill=Skill/自动化，web=网站/小程序，other=其他。不要解释。',
        },
        { role: 'user', content: content.slice(0, 2000) },
      ],
      { json: true, maxTokens: 60, temperature: 0 },
    );
    // 模型不一定老实只吐 JSON（可能带围栏、带一句话），先宽松解析，再退到关键词。
    const parsed = parseJsonLoose(raw);
    let category = parsed && typeof parsed.category === 'string' ? parsed.category : null;
    if (!IDEA_CATEGORIES.includes(category)) {
      const match = String(raw).match(/life|app|skill|web|other/);
      category = match ? match[0] : null;
    }
    const finalCategory = oneOf(category, IDEA_CATEGORIES, classifyByRules(content));
    await logService(env, user.id, 'classify', true, finalCategory);
    return json({
      configured: true,
      category: finalCategory,
      label: CATEGORY_LABELS[finalCategory],
      source: category ? 'ai' : 'rules',
    });
  } catch (error) {
    await logService(env, user.id, 'classify', false, errorDetail(error));
    // 分类失败绝不影响保存：退回规则分类，并如实标注来源。
    const fallback = classifyByRules(content);
    return json({
      configured: true,
      category: fallback,
      label: CATEGORY_LABELS[fallback],
      source: 'rules',
      message: 'AI 分类暂时不可用，已用本地关键词规则兜底。',
      ...debugExtra(env, error),
    });
  }
}

const META_PROMPT = `你在帮用户把一条私人灵感抽象成「可以公开分享的海报素材」。
严格要求：
1. 只输出 JSON，字段为 theme（6 字以内的主题词）、mood、metaphor（一句不超过 20 字的隐喻画面）、visuals（可画出来的视觉元素，名词短语）。
   mood 与 visuals 都必须是非空数组：mood 给 3 个情绪词，visuals 给 5 个视觉元素，禁止留空数组、禁止写 null。
2. 绝对不要出现原始文字里的专有名词、人名、公司名、产品名、网址、邮箱、电话、@ 昵称、地点。
3. 不要复述原句，只提炼气质。
4. 全部用中文，风格轻盈、有创造力。`;

/** 本地抽象：AI 未配置时也能出海报，且完全不出本机。 */
export function abstractLocally(text) {
  const category = classifyByRules(text);
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  const moodMap = {
    life: ['温暖', '松弛', '想被照顾'],
    app: ['轻快', '跃跃欲试', '有点顽皮'],
    skill: ['利落', '安静高效', '秩序感'],
    web: ['开阔', '明亮', '流动'],
    other: ['好奇', '轻盈', '一点点野'],
  };
  const metaphorMap = {
    life: '把琐碎的日子折成一只会浮起来的小纸船',
    app: '一颗正在冒芽的种子，壳上有一扇小门',
    skill: '一条安静运转的流水线，齿轮都是糖果做的',
    web: '一张会自己展开的地图，边角在发光',
    other: '一团正在成形的云，还没决定要做成什么',
  };
  const visualMap = {
    life: ['纸船', '暖阳', '窗台的植物', '一杯还冒着热气的水', '柔软的毛线'],
    app: ['冒芽的种子', '圆角方框', '半开的门', '糖果色齿轮', '小小的手势箭头'],
    skill: ['齿轮', '格子纸', '卡住的滑轨', '柔和的光带', '排队的小圆点'],
    web: ['展开的地图', '发光的边角', '漂浮的窗口', '折线', '轻盈的网格'],
    other: ['未成形的云', '漂浮的碎片', '一颗星', '渐变的雾', '半透明的圆'],
  };
  return {
    theme: {
      life: '生活里的小口子',
      app: '一颗新种子',
      skill: '让机器替我做',
      web: '打开一扇窗',
      other: '还没定形的念头',
    }[category],
    mood: moodMap[category],
    metaphor: metaphorMap[category],
    visuals: visualMap[category],
    category,
    // 长度只做「是否够长到值得」的判断，不参与输出。
    length: trimmed.length,
  };
}

const PII_PATTERNS = [
  /[\w.+-]+@[\w-]+\.[\w.]+/g, // 邮箱
  /https?:\/\/[^\s，。；、]+/g, // 网址
  /(?:\+?86[-\s]?)?1[3-9]\d{9}/g, // 手机号
  /@[A-Za-z0-9_-]{2,}/g, // 社交账号
];

/**
 * 隐私检查：确保抽象结果里没有夹带原文里的可识别信息，
 * 也没有大段照抄原文（照抄等于把私人念头直接贴到海报上）。
 */
export function privacyCheck(abstraction, original) {
  const blob = [
    abstraction.theme,
    ...(abstraction.mood || []),
    abstraction.metaphor,
    ...(abstraction.visuals || []),
  ]
    .filter((item) => typeof item === 'string')
    .join(' ');

  const violations = [];
  for (const pattern of PII_PATTERNS) {
    const hits = blob.match(pattern);
    if (hits && hits.length > 0) violations.push(`包含可识别信息：${hits[0].slice(0, 12)}`);
  }

  const source = String(original || '');
  const window = 12;
  for (let i = 0; i + window <= source.length && i < 400; i += 1) {
    const chunk = source.slice(i, i + window).replace(/\s+/g, '');
    if (chunk.length < window) break;
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(chunk)) continue;
    if (blob.replace(/\s+/g, '').includes(chunk)) {
      violations.push('抽象结果里出现了原文片段');
      break;
    }
  }

  return { safe: violations.length === 0, violations };
}

async function handleAbstract(request, env) {
  const user = await authenticate(request, env);
  const body = await readJson(request);
  const content = str(body.content, MAX_TEXT_CHARS);
  if (!content.trim()) throw new HttpError(400, '内容为空。', 'EMPTY_CONTENT');

  if (!aiConfig(env).ready) {
    const abstraction = abstractLocally(content);
    const check = privacyCheck(abstraction, content);
    return json({
      configured: false,
      source: 'local',
      service: '本机规则（内容没有离开你的账号）',
      abstraction,
      privacy: check,
    });
  }

  const provider = capabilities(env).aiProvider;
  try {
    const raw = await callChat(
      env,
      [
        { role: 'system', content: META_PROMPT },
        { role: 'user', content: content.slice(0, 2000) },
      ],
      { json: true, maxTokens: 400, temperature: 0.7 },
    );
    const parsed = parseJsonLoose(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new HttpError(502, '抽象结果无法解析。', 'AI_UPSTREAM');
    }
    const abstraction = {
      theme: str(parsed.theme, 40),
      mood: Array.isArray(parsed.mood) ? parsed.mood.filter((x) => typeof x === 'string').slice(0, 5) : [],
      metaphor: str(parsed.metaphor, 120),
      visuals: Array.isArray(parsed.visuals)
        ? parsed.visuals.filter((x) => typeof x === 'string').slice(0, 8)
        : [],
    };
    const check = privacyCheck(abstraction, content);
    await logService(env, user.id, 'abstract', check.safe, provider);
    if (!check.safe) {
      return json(
        {
          configured: true,
          source: 'ai',
          service: provider,
          abstraction,
          privacy: check,
          error: '抽象结果未通过隐私检查，已停止生成海报。',
        },
        422,
      );
    }
    return json({ configured: true, source: 'ai', service: provider, abstraction, privacy: check });
  } catch (error) {
    await logService(env, user.id, 'abstract', false, errorDetail(error));
    const abstraction = abstractLocally(content);
    const check = privacyCheck(abstraction, content);
    return json({
      configured: true,
      source: 'local',
      service: '本机规则（AI 暂时不可用）',
      abstraction,
      privacy: check,
      message: 'AI 抽象暂时不可用，已改用本机规则，内容没有离开你的账号。',
      ...debugExtra(env, error),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* AI：海报底图                                                                */
/* -------------------------------------------------------------------------- */

const POSTER_STYLES = ['brand', 'dream', 'toy3d', 'minimal', 'journal', 'future'];

const STYLE_PROMPTS = {
  brand: 'NianBox brand poster: soft paper-white background, violet abstract glow, one large elegant geometric star motif, generous negative space, flat vector illustration',
  dream: 'dreamy floating poster: pastel violet and mint mist, translucent orbs drifting upward, weightless, soft focus, no text',
  toy3d: 'playful 3D clay render: glossy soft shapes, cute rounded objects, candy colors on warm paper background, studio light, no text',
  minimal: 'minimal art poster: one bold simple shape, two-color palette of violet and warm paper white, lots of empty space, swiss design, no text',
  journal: 'hand-drawn inspiration journal: soft crayon and gouache texture, wobbly lines, warm yellow and peach, paper grain, no text',
  future: 'futuristic imagination: glowing violet gradient field, thin luminous rings, quiet sci-fi calm, dark to violet, no text',
};

async function handlePoster(request, env) {
  const user = await authenticate(request, env);
  const body = await readJson(request);
  const style = oneOf(body.style, POSTER_STYLES, 'brand');
  const aspect = oneOf(body.aspect, ['3:4', '1:1'], '3:4');
  const abstraction = body.abstraction && typeof body.abstraction === 'object' ? body.abstraction : null;

  if (!abstraction) {
    throw new HttpError(400, '缺少抽象结果，请先生成主题。', 'MISSING_ABSTRACTION');
  }

  // 服务端再检查一次：即使客户端被绕过，也绝不把原文喂给图像模型。
  const check = privacyCheck(abstraction, str(body.original, MAX_TEXT_CHARS));
  if (!check.safe) {
    return json({ configured: true, generated: false, privacy: check, error: '未通过隐私检查，已停止生成。' }, 422);
  }

  const cfg = imageConfig(env);
  if (!cfg.ready) {
    return json({
      configured: false,
      generated: false,
      style,
      aspect,
      message: '服务端尚未配置图像生成服务，不会生成任何图片。可以在应用里使用本地品牌模板海报。',
    });
  }

  // 生成图片是真金白银：每天给一个上限，防止密钥被刷爆。
  const quota = await imageQuota(env, user.id);
  if (quota.limit > 0 && quota.used >= quota.limit) {
    return json(
      {
        configured: true,
        generated: false,
        quota,
        error: `今天的海报额度已经用完了（每天 ${quota.limit} 张），明天再来。`,
      },
      429,
    );
  }

  // 只用抽象结果拼提示词，并明确要求无文字。
  const prompt = [
    STYLE_PROMPTS[style],
    `theme: ${abstraction.theme}`,
    `mood: ${(abstraction.mood || []).join(', ')}`,
    `motif: ${abstraction.metaphor}`,
    `elements: ${(abstraction.visuals || []).join(', ')}`,
    'strictly no text, no letters, no watermark, no signature',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_IMAGE_PROMPT_CHARS);

  const image = await generateImage(env, cfg, { prompt, aspect });
  if (!image.ok) {
    await logService(env, user.id, 'poster', false, image.detail);
    return json({ configured: true, generated: false, error: image.error, ...debugExtra(env, { upstream: image.detail }) }, 502);
  }

  await logService(env, user.id, 'poster', true, style);
  return json({
    configured: true,
    generated: true,
    style,
    aspect,
    provider: capabilities(env).imageProvider,
    // 统一回传 data: URL：服务商给的临时链接会过期，而且跨域取回来做下载/分享会被浏览器拦。
    base64: image.dataUrl,
    url: image.remoteUrl,
    prompt,
    privacy: check,
    quota: { used: quota.used + 1, limit: quota.limit },
  });
}

/** 今天已经成功生成过几张底图。 */
async function imageQuota(env, userId) {
  const configured = Number(env.AI_IMAGE_DAILY_LIMIT);
  const limit = Number.isFinite(configured) ? configured : DEFAULT_IMAGE_DAILY_LIMIT;
  const day = dayKey(nowMs(), num(env.TZ_OFFSET_HOURS, 8));
  let used = 0;
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM service_log WHERE user_id = ? AND day = ? AND kind = 'poster' AND ok = 1",
    )
      .bind(userId, day)
      .first();
    used = num(row && row.n);
  } catch {
    // 数不出来时不拦人：宁可少一层保护，也不要让正常用户生成不了。
    used = 0;
  }
  return { used, limit };
}

/**
 * 真正调一次图像接口。返回 { ok, dataUrl, remoteUrl, error, detail }。
 *
 * 两处服务商差异都在这里抹平：
 *   1. 尺寸按服务商映射（智谱不认 1024x1365）；
 *   2. 智谱只给一个临时 URL，OpenAI 给 base64 —— 统一在服务端落成 data: URL 再回前端，
 *      这样「下载」和「系统分享」在 iOS / 微信里都能正常工作。
 */
async function generateImage(env, cfg, { prompt, aspect }) {
  const size = posterSizeFor(cfg.provider, aspect);
  const full = { model: cfg.model, prompt, size, n: 1 };
  const shapes =
    cfg.provider === 'zhipu'
      ? [{ ...full, watermark_enabled: false }, full, { model: cfg.model, prompt }]
      : [{ ...full, response_format: 'b64_json' }, full];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    let text = '';
    let ok = false;
    let status = 0;
    for (let i = 0; i < shapes.length; i += 1) {
      const res = await fetch(`${cfg.baseUrl}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(shapes[i]),
        signal: controller.signal,
      });
      status = res.status;
      ok = res.ok;
      text = await res.text();
      if (ok) break;
      // 只对「参数不被支持」退让；鉴权、余额、限流这类错误重试没有意义。
      const canRetry = i < shapes.length - 1 && status === 400;
      if (!canRetry) break;
    }
    if (!ok) {
      return {
        ok: false,
        error: `图像服务返回错误（HTTP ${status}）。`,
        detail: `http-${status} ${upstreamMessage(text)}`.slice(0, 200),
      };
    }

    const parsed = parseJsonLoose(text);
    const first = parsed && Array.isArray(parsed.data) ? parsed.data[0] : null;
    const inline = first ? first.b64_json || first.b64 || '' : '';
    const remoteUrl = first && typeof first.url === 'string' ? first.url : '';
    if (!inline && !remoteUrl) {
      return { ok: false, error: '图像服务没有返回图片。', detail: 'empty-image-payload' };
    }

    let base64 = typeof inline === 'string' ? inline : '';
    let mime = typeof first?.mime_type === 'string' && first.mime_type ? first.mime_type : 'image/png';
    if (!base64 && remoteUrl) {
      const download = await fetch(remoteUrl);
      if (!download.ok) {
        return {
          ok: false,
          error: '图片生成成功，但从图像服务取回时失败，请再试一次。',
          detail: `download-${download.status}`,
        };
      }
      const bytes = new Uint8Array(await download.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        return { ok: false, error: '图片文件异常，已停止返回。', detail: `bytes-${bytes.length}` };
      }
      const type = download.headers.get('content-type') || '';
      if (type.startsWith('image/')) mime = type.split(';')[0];
      base64 = bytesToBase64(bytes);
    }
    if (!base64) return { ok: false, error: '图像服务没有返回图片。', detail: 'empty-bytes' };

    return {
      ok: true,
      // 已经是 data: 前缀就原样返回，前端两种写法都认。
      dataUrl: base64.startsWith('data:') ? base64 : `data:${mime};base64,${base64}`,
      remoteUrl,
    };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? '图像服务响应超时，请稍后重试。' : '图像服务连接失败，请稍后重试。',
      detail: aborted ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* 邮件                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 各邮件服务商的请求形状。
 *
 * 差异只在信封结构上：Resend 说 `to: [...]`，SendGrid 说
 * `personalizations[0].to[0].email`，Mailgun 用表单编码 + Basic，
 * Brevo 用 `api-key` 头 + `sender/to/textContent`。
 * 适配器只做这一层翻译，失败一律如实上报，绝不把「我没配好」包装成「已发送」。
 */
export function buildMailRequest(cfg, { to, subject, text }) {
  const from = cfg.fromName ? `${cfg.fromName} <${cfg.from}>` : cfg.from;
  if (cfg.provider === 'sendgrid') {
    return {
      url: `${cfg.baseUrl}/v3/mail/send`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: cfg.from, ...(cfg.fromName ? { name: cfg.fromName } : {}) },
        subject,
        content: [{ type: 'text/plain', value: text }],
      }),
    };
  }
  if (cfg.provider === 'mailgun') {
    const form = new URLSearchParams();
    form.set('from', from);
    form.set('to', to);
    form.set('subject', subject);
    form.set('text', text);
    return {
      url: `${cfg.baseUrl}/messages`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Mailgun 用 Basic：用户名固定 api，口令就是私钥。
        authorization: `Basic ${btoa(`api:${cfg.apiKey}`)}`,
      },
      body: form.toString(),
    };
  }
  if (cfg.provider === 'brevo') {
    // Brevo 把密钥放在 api-key 头（不是 Bearer），正文是 sender/to/textContent。
    return {
      url: `${cfg.baseUrl}/v3/smtp/email`,
      headers: { 'content-type': 'application/json', 'api-key': cfg.apiKey },
      body: JSON.stringify({
        sender: { email: cfg.from, ...(cfg.fromName ? { name: cfg.fromName } : {}) },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
    };
  }
  // 默认：Resend 形状，自建中转也按这个收。
  return {
    url: `${cfg.baseUrl}/emails`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ from, to: [to], subject, text }),
  };
}

/**
 * 服务端发一封纯文本邮件。
 *
 * 返回 { configured, sent, id, error, detail } —— 调用方据此如实告诉用户，
 * 永远不会出现「返回成功但其实没发出去」。
 */
export async function sendMail(env, { to, subject, text }) {
  const cfg = mailConfig(env);
  if (!cfg.ready) {
    return { configured: false, sent: false, error: '邮件服务尚未配置。', detail: 'not-configured' };
  }
  const request = buildMailRequest(cfg, { to, subject, text });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      return {
        configured: true,
        sent: false,
        error: `邮件服务返回错误（HTTP ${res.status}）。`,
        detail: `http-${res.status} ${upstreamMessage(raw)}`.slice(0, 200),
      };
    }
    const parsed = parseJsonLoose(raw);
    const id =
      (parsed && (parsed.id || parsed.message_id || parsed.messageId)) ||
      res.headers.get('x-message-id') ||
      '';
    return { configured: true, sent: true, id: String(id || ''), detail: 'sent' };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return {
      configured: true,
      sent: false,
      error: aborted ? '邮件服务响应超时，请稍后重试。' : '邮件服务连接失败，请稍后重试。',
      detail: aborted ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function handleMail(request, env) {
  const user = await authenticate(request, env);
  const body = await readJson(request);
  const to = str(body.to, 200).trim();
  const subject = str(body.subject, 200);
  const text = str(body.text, 20000);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new HttpError(400, '收件邮箱不正确。', 'BAD_RECIPIENT');
  }
  if (!text.trim()) throw new HttpError(400, '邮件正文为空。', 'EMPTY_BODY');

  const result = await sendMail(env, { to, subject, text });
  if (!result.configured) {
    return json({
      configured: false,
      sent: false,
      message: '服务端尚未配置邮件服务，请用你的邮件应用确认并发送。',
    });
  }
  if (!result.sent) {
    await logService(env, user.id, 'mail', false, result.detail);
    return json(
      { configured: true, sent: false, error: result.error, ...debugExtra(env, { upstream: result.detail }) },
      502,
    );
  }
  await logService(env, user.id, 'mail', true, 'sent');
  return json({ configured: true, sent: true, id: result.id });
}
