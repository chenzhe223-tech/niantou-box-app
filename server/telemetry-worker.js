/**
 * 念头盒 NianBox —— 运营数据接收端（Cloudflare Worker + D1，零依赖）。
 *
 * 两个接口，一个给应用写，一个给你自己读：
 *
 *   POST /ingest       应用调用。请求头 X-NianBox-Key 必须等于 INGEST_KEY。
 *                      请求体是应用里 analytics.ts 组装的那份 v1 载荷。
 *   GET  /report       你看的。请求头 Authorization: Bearer <ADMIN_TOKEN>。
 *                      返回 public/admin.html 直接能渲染的汇总 JSON。
 *
 * 为什么分成两个令牌：
 * - INGEST_KEY 会进前端产物，所以它只能写、不能读：拿着它最多能塞进一条
 *   假事件，拿不到任何别人的数据；
 * - ADMIN_TOKEN 只在你自己手里（只填在 admin.html 的输入框里，或存在密码
 *   管理器里），它能读全量数据，所以永远不进前端产物。
 *
 * 部署步骤见 server/README.md；建表 SQL 见 server/schema.sql。
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (request.method === 'POST' && (path === '/ingest' || path === '/')) {
        return await handleIngest(request, env);
      }
      if (request.method === 'GET' && (path === '/report' || path === '/report/')) {
        return await handleReport(url, request, env);
      }
      if (request.method === 'GET' && path === '/health') {
        return json({ ok: true }, 200);
      }
      return json({ error: '没有这个接口。' }, 404);
    } catch (error) {
      // 出错也绝不把用户数据写进日志：这里只记一条不带内容的错误信息。
      console.error('nianbox telemetry error:', error && error.message ? error.message : error);
      return json({ error: '服务内部错误。' }, 500);
    }
  },
};

/* -------------------------------------------------------------------------- */
/* 通用工具                                                                    */
/* -------------------------------------------------------------------------- */

/** 单次请求体上限：正常批次只有几十条，超过这个大小一定不是应用发出的。 */
const MAX_BODY_BYTES = 256 * 1024;
/** 单批最多接受多少条事件（应用侧 MAX_BATCH 是 40，留足余量）。 */
const MAX_EVENTS_PER_BATCH = 300;
/** 反馈正文上限，与前端 FEEDBACK_MESSAGE_MAX 保持一致。 */
const MAX_FEEDBACK_CHARS = 2000;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-NianBox-Key, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders()),
  });
}

/** 时区偏移（小时）：默认按东八区折算「一天」，与你平时看的日历一致。 */
function tzOffsetHours(env) {
  const raw = Number(env && env.TZ_OFFSET_HOURS);
  return Number.isFinite(raw) ? raw : 8;
}

/** 把毫秒时间戳折算成该时区下的 YYYY-MM-DD。 */
function dayKey(at, offsetHours) {
  return new Date(at + offsetHours * 3600 * 1000).toISOString().slice(0, 10);
}

function clampText(value, max) {
  if (typeof value !== 'string') return '';
  return value.slice(0, max);
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 只在白名单里的枚举参数才会入库，二次防御：即使前端白名单被改坏也不存内容。
 * 'render' = 作品是 AI 生成还是本机绘制（work_saved 事件用），同样是枚举值。
 */
const ALLOWED_PROPS = ['source', 'status', 'progress', 'bucket', 'kind', 'result', 'state', 'render'];

function sanitizeProps(props) {
  const source = asPlainObject(props);
  const output = {};
  for (const key of ALLOWED_PROPS) {
    const value = source[key];
    if (typeof value === 'string' && value.length <= 32) output[key] = value;
  }
  return output;
}

async function readJsonBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw Object.assign(new Error('请求体过大。'), { status: 413 });
  }
  return JSON.parse(raw);
}

/* -------------------------------------------------------------------------- */
/* 写入：POST /ingest                                                          */
/* -------------------------------------------------------------------------- */

async function handleIngest(request, env) {
  const expected = env && env.INGEST_KEY ? String(env.INGEST_KEY) : '';
  const provided = request.headers.get('X-NianBox-Key') || '';
  if (expected && provided !== expected) {
    return json({ error: '写入令牌不正确。' }, 401);
  }
  if (!env || !env.DB) {
    return json({ error: '后端还没绑定数据库，请先按 server/README.md 建表。' }, 500);
  }

  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    return json({ error: '请求体不是合法的 JSON。' }, 400);
  }

  const body = asPlainObject(payload);
  const context = asPlainObject(body.context);
  const installId = clampText(body.installId, 64) || 'unknown';
  const sessionId = clampText(body.sessionId, 64) || 'unknown';
  const offset = tzOffsetHours(env);

  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_BATCH) : [];
  const feedback = Array.isArray(body.feedback) ? body.feedback.slice(0, 20) : [];

  const statements = [];

  for (const item of events) {
    const event = asPlainObject(item);
    const name = clampText(event.n, 48);
    if (!name) continue;
    const at = Number.isFinite(Number(event.t)) ? Number(event.t) : Date.now();
    statements.push(
      env.DB.prepare(
        'INSERT INTO events (day, at, name, props, install_id, session_id, app, platform, display, viewport, lang)' +
          ' VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)',
      ).bind(
        dayKey(at, offset),
        at,
        name,
        JSON.stringify(sanitizeProps(event.p)),
        installId,
        sessionId,
        clampText(context.app, 24),
        clampText(context.platform, 16),
        clampText(context.display, 16),
        clampText(context.viewport, 16),
        clampText(context.lang, 16),
      ),
    );
  }

  for (const item of feedback) {
    const record = asPlainObject(item);
    const message = clampText(record.message, MAX_FEEDBACK_CHARS).trim();
    if (!message) continue;
    const id = clampText(record.id, 80) || `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const at = Number.isFinite(Number(record.at)) ? Number(record.at) : Date.now();
    const diagnostics = record.diagnostics ? JSON.stringify(record.diagnostics) : null;

    // 用户可能反复点提交同一条反馈（比如断网重试），用 id 去重而不是产生重复记录。
    statements.push(
      env.DB.prepare(
        'INSERT INTO feedback (id, day, at, kind, message, contact, diagnostics, install_id)' +
          ' VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)' +
          ' ON CONFLICT(id) DO UPDATE SET message = ?5, contact = ?6, diagnostics = ?7',
      ).bind(
        id,
        dayKey(at, offset),
        at,
        clampText(record.kind, 16) || 'other',
        message,
        clampText(record.contact, 120),
        diagnostics,
        installId,
      ),
    );
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  return json({ ok: true, events: events.length, feedback: feedback.length }, 200);
}

/* -------------------------------------------------------------------------- */
/* 读取：GET /report                                                           */
/* -------------------------------------------------------------------------- */

async function handleReport(url, request, env) {
  const adminToken = env && env.ADMIN_TOKEN ? String(env.ADMIN_TOKEN) : '';
  const header = request.headers.get('Authorization') || '';
  const provided = header.replace(/^Bearer\s+/i, '').trim();

  if (!adminToken) {
    return json({ error: '后端还没设置 ADMIN_TOKEN，无法读取运营数据。' }, 500);
  }
  if (provided !== adminToken) {
    return json({ error: '读取令牌不正确。' }, 401);
  }
  if (!env || !env.DB) {
    return json({ error: '后端还没绑定数据库。' }, 500);
  }

  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
  const offset = tzOffsetHours(env);
  const now = Date.now();
  const today = dayKey(now, offset);
  const from = dayKey(now - (days - 1) * 86400 * 1000, offset);
  const weekAgo = dayKey(now - 6 * 86400 * 1000, offset);

  const [daily, events, platforms, versions, totals, activeToday, active7d, feedbackCount, feedbackRows] =
    await env.DB.batch([
      env.DB.prepare(
        'SELECT day, COUNT(*) AS events, COUNT(DISTINCT install_id) AS devices FROM events' +
          ' WHERE day >= ?1 GROUP BY day ORDER BY day',
      ).bind(from),
      env.DB.prepare(
        'SELECT name, COUNT(*) AS count, COUNT(DISTINCT install_id) AS devices FROM events' +
          ' WHERE day >= ?1 GROUP BY name ORDER BY count DESC',
      ).bind(from),
      env.DB.prepare(
        'SELECT platform, COUNT(DISTINCT install_id) AS count FROM events' +
          ' WHERE day >= ?1 GROUP BY platform ORDER BY count DESC',
      ).bind(from),
      env.DB.prepare(
        'SELECT app, COUNT(DISTINCT install_id) AS count FROM events' +
          ' WHERE day >= ?1 GROUP BY app ORDER BY count DESC',
      ).bind(from),
      env.DB.prepare(
        'SELECT COUNT(*) AS events, COUNT(DISTINCT install_id) AS devices, COUNT(DISTINCT session_id) AS sessions' +
          ' FROM events WHERE day >= ?1',
      ).bind(from),
      env.DB.prepare('SELECT COUNT(DISTINCT install_id) AS count FROM events WHERE day = ?1').bind(today),
      env.DB.prepare('SELECT COUNT(DISTINCT install_id) AS count FROM events WHERE day >= ?1').bind(weekAgo),
      env.DB.prepare('SELECT COUNT(*) AS count FROM feedback WHERE day >= ?1').bind(from),
      env.DB.prepare(
        'SELECT id, kind, message, contact, diagnostics, at FROM feedback' +
          ' WHERE day >= ?1 ORDER BY at DESC LIMIT 200',
      ).bind(from),
    ]);

  const scalar = (result, key) => {
    const row = result && Array.isArray(result.results) ? result.results[0] : null;
    return row ? Number(row[key]) || 0 : 0;
  };

  // 补齐没有数据的日期，前端柱状图才不会缺格子。
  const byDay = new Map((daily.results || []).map((row) => [row.day, row]));
  const dailyFilled = [];
  for (let offsetDay = days - 1; offsetDay >= 0; offsetDay -= 1) {
    const day = dayKey(now - offsetDay * 86400 * 1000, offset);
    const row = byDay.get(day);
    dailyFilled.push({
      day,
      events: row ? Number(row.events) || 0 : 0,
      devices: row ? Number(row.devices) || 0 : 0,
    });
  }

  return json({
    generatedAt: new Date(now).toISOString(),
    range: {
      days,
      from: `${from}T00:00:00.000Z`,
      to: `${today}T23:59:59.999Z`,
      timezoneOffsetHours: offset,
    },
    totals: {
      events: scalar(totals, 'events'),
      devices: scalar(totals, 'devices'),
      sessions: scalar(totals, 'sessions'),
      activeToday: scalar(activeToday, 'count'),
      active7d: scalar(active7d, 'count'),
      feedback: scalar(feedbackCount, 'count'),
    },
    daily: dailyFilled,
    events: (events.results || []).map((row) => ({
      name: row.name,
      count: Number(row.count) || 0,
      devices: Number(row.devices) || 0,
    })),
    platforms: (platforms.results || []).map((row) => ({
      platform: row.platform || 'other',
      count: Number(row.count) || 0,
    })),
    versions: (versions.results || []).map((row) => ({
      app: row.app || 'dev',
      count: Number(row.count) || 0,
    })),
    feedback: (feedbackRows.results || []).map((row) => ({
      id: row.id,
      kind: row.kind,
      message: row.message,
      contact: row.contact,
      diagnostics: row.diagnostics ? safeParse(row.diagnostics) : null,
      at: Number(row.at) || 0,
    })),
  }, 200);
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}
