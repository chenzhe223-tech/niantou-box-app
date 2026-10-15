-- 念头盒 NianBox —— 云端同步与 AI 能力的表结构（Cloudflare D1 / SQLite 方言）。
--
-- 与运营数据表（schema.sql）**刻意分开**：
--   * nianbox-telemetry 只存匿名事件与用户主动提交的反馈，不含任何念头内容；
--   * nianbox-cloud（本文件）存账号与用户自己的念头 / 项目数据。
-- 两张库物理隔离，运营看板的读取令牌永远读不到用户的私人念头。
--
-- 设计要点：
-- 1. 每张用户数据表都以 user_id 作为复合主键的第一列，
--    所有查询都必须带 user_id，从根上避免「越权读到别人的数据」；
-- 2. 念头本体以 JSON 文档（doc）整体存放，字段演进不需要改表结构；
-- 3. seq 是服务端全局单调序号，客户端用它做增量拉取游标；
-- 4. 口令只存 PBKDF2-SHA256 派生值，登录令牌只存 SHA-256 摘要 —— 数据库
--    即使被读到，也无法还原出口令或可用令牌。
--
-- 建表命令（由 server/deploy-cloud.mjs 自动执行，通常不需要手动跑）：
--   npx wrangler d1 execute nianbox-cloud --remote --file=server/cloud-schema.sql

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  -- 统一小写去空格的邮箱，登录标识
  email TEXT NOT NULL UNIQUE,
  -- 格式：pbkdf2$<iterations>$<salt-b64url>$<hash-b64url>
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  -- sha256(原始令牌) 的十六进制摘要；原始令牌只存在于用户设备上
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  -- 设备自述标签（例如 ios-pwa / wechat），仅用于「已登录设备」列表
  label TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS ideas (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  doc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  seq INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_ideas_seq ON ideas (user_id, seq);

CREATE TABLE IF NOT EXISTS projects (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  doc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  seq INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_projects_seq ON projects (user_id, seq);

-- 每个用户独立的同步游标：即使全局 seq 被其他用户推高，
-- 单用户拉取时也不会出现「跳号丢数据」。
CREATE TABLE IF NOT EXISTS user_state (
  user_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER NOT NULL DEFAULT 0,
  idea_count INTEGER NOT NULL DEFAULT 0,
  project_count INTEGER NOT NULL DEFAULT 0
);

-- 永久删除的墓碑。
--
-- 为什么必须有这张表：永久删除会把 ideas / projects 里的行整条删掉，
-- 其他设备做增量拉取时「什么都拉不到」，那条记录就永远留在别人的回收站之外、
-- 却在列表里继续存在。有了墓碑，删除事件本身也能作为一条带 seq 的记录被拉到。
-- 墓碑里只有「实体 + ID」，不含任何念头内容。
CREATE TABLE IF NOT EXISTS tombstones (
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, entity, id)
);

CREATE INDEX IF NOT EXISTS idx_tombstones_seq ON tombstones (user_id, seq);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Single-use password reset tokens; only SHA-256 hashes are stored.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens (user_id);

CREATE TABLE IF NOT EXISTS login_throttle (
  -- sha256(IP + 服务端盐)，不落明文 IP
  ip_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- AI / 邮件调用留痕：只记「调用了什么、成功与否」，不记内容。
CREATE TABLE IF NOT EXISTS service_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_service_log_user ON service_log (user_id, at);

INSERT OR IGNORE INTO meta (key, value) VALUES ('seq', '0');
