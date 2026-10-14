-- 念头盒 NianBox —— 运营数据表结构（Cloudflare D1 / SQLite 方言）。
--
-- 设计原则：
-- 1. 只存「发生了什么」，不存念头内容。events 表里没有正文、标题、标签字段，
--    因为前端也不会发（发送前会被 analytics.ts 的参数白名单丢掉）；
-- 2. feedback 表存用户亲手写的反馈，这是用户主动提交的，不是采集来的；
-- 3. 设备标识是随机 UUID，可以随时在应用里重置，重置后无法与之前关联。
--
-- 建表命令：
--   npx wrangler d1 execute nianbox-telemetry --remote --file=server/schema.sql

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 统计日（按 TZ_OFFSET_HOURS 折算过的日期，便于按「你所在时区的一天」看数据）
  day TEXT NOT NULL,
  -- 事件发生时间（毫秒时间戳）
  at INTEGER NOT NULL,
  -- 事件名，只会是前端 EVENT_NAMES 里登记过的那几个
  name TEXT NOT NULL,
  -- 枚举参数（JSON 文本），例如 {"source":"home","status":"ready"}
  props TEXT NOT NULL DEFAULT '{}',
  install_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  app TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  display TEXT NOT NULL DEFAULT '',
  viewport TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_events_day ON events (day);
CREATE INDEX IF NOT EXISTS idx_events_name ON events (name);
CREATE INDEX IF NOT EXISTS idx_events_install ON events (install_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  message TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  -- 可选的诊断信息（JSON 文本）：只有用户主动勾选时才有值。
  -- 内容只有版本 / 平台 / 界面语言 / 念头数量 / 项目数量。
  diagnostics TEXT,
  install_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_feedback_day ON feedback (day);
CREATE INDEX IF NOT EXISTS idx_feedback_kind ON feedback (kind);
