# 念头盒 NianBox · 运营数据接收端（Cloudflare Worker + D1）

这份目录里的东西，是**只有你自己部署一次**的后端：应用把匿名事件和用户反馈发到这里，
你在自己的浏览器里打开运营看板就能看到全部用户的汇总数据。

```
                 （只能写）                    （只能读）
  应用 / 用户 ──────────────▶ Worker ──────────────▶ 你（admin.html）
                X-NianBox-Key     + D1            Authorization: Bearer <ADMIN_TOKEN>
```

- 写入令牌 `INGEST_KEY` 会随应用一起发布，所以它**只能写**：拿到它的人最多能塞一条假事件，
  读不到任何数据。
- 读取令牌 `ADMIN_TOKEN` **只存在你自己手里**（只在 `admin.html` 的输入框里输入，
  或交给密码管理器），永远不会出现在前端产物里。

> **需要你亲手做的一步**
>
> 部署后端需要你自己的 Cloudflare 账号（我不能替你在你的账号里创建资源）。
> 下面的命令复制粘贴即可，全流程大约 10 分钟，免费额度足够个人使用
> （D1 免费档：每天 500 万行读 / 10 万行写，Worker 每天 10 万次请求）。
> 如果你更希望我来执行，把 Cloudflare 的 **Account ID** 和一枚
> **Workers + D1 权限的 API Token** 给我即可（用完请随时在 Cloudflare 后台吊销）。

---

## 一、准备

1. 有 Cloudflare 账号（免费注册：<https://dash.cloudflare.com/sign-up>）。
2. 本机有 Node.js 20 或更高版本（`node -v` 能看到版本号即可）。
3. 在仓库根目录（`niantou-box/`）执行下面的命令。

```powershell
# 安装 wrangler（Cloudflare 官方 CLI，只在部署时用到，不进应用依赖）
npm install -g wrangler
# 或者不想全局安装，就在每条命令前用 npx：
# npx wrangler@latest <子命令>

# 登录（会打开浏览器让你在 Cloudflare 页面点「允许」）
wrangler login
```

---

## 二、部署（复制粘贴即可）

### 1. 创建数据库

```powershell
wrangler d1 create nianbox-telemetry
```

命令会输出一段 `[[d1_databases]]` 配置和 `database_id`，**把它记下来**。

### 2. 写配置文件

把本目录下的 `wrangler.toml.example` 复制成仓库根目录的 `wrangler.toml`，
然后用上一步拿到的 `database_id` 替换里面的 `REPLACE_WITH_YOUR_DATABASE_ID`。

> `wrangler.toml` 里不含任何密钥，可以放心提交到仓库；
> 两个令牌走下面的 `secret put` 存进 Cloudflare，**不写进文件**。

### 3. 建表

```powershell
wrangler d1 execute nianbox-telemetry --remote --file=server/schema.sql
```

### 4. 设置两个令牌

生成两串随机值（**两串必须不同**）：

```powershell
# 写入令牌：会随应用发布，只能写
[Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Max 256 }))
# 读取令牌：只在你手里，能读全量数据
[Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Max 256 }))
```

分别存进 Cloudflare（命令会提示你粘贴，粘贴的内容不会进 shell 历史，也不会写进任何文件）：

```powershell
wrangler secret put INGEST_KEY --name nianbox-telemetry
wrangler secret put ADMIN_TOKEN --name nianbox-telemetry
```

> 时区可选：默认按**东八区**折算「一天」（和你平时看的日历一致）。
> 想改成别的，在 `wrangler.toml` 里加 `[vars]` `TZ_OFFSET_HOURS = "8"`。

### 5. 发布

```powershell
wrangler deploy --name nianbox-telemetry
```

成功后会打印一个地址，形如：

```
https://nianbox-telemetry.<你的子域>.workers.dev
```

接口地址就是再拼上 `/ingest`：

```
https://nianbox-telemetry.<你的子域>.workers.dev/ingest
```

---

## 三、让应用开始上报（在 GitHub 仓库里填三行）

打开 `chenzhe223-tech/niantou-box-app` →
**Settings → Secrets and variables → Actions → Variables → New repository variable**，
新建三个变量（**是 Variables，不是 Secrets**——它们会出现在前端产物里，本来就不是秘密）：

| Name | Value | 作用 |
| --- | --- | --- |
| `TELEMETRY_ENDPOINT` | `https://nianbox-telemetry.<你的子域>.workers.dev/ingest` | 事件与反馈发往哪里 |
| `TELEMETRY_KEY` | 第 4 步生成的第一个随机值（`INGEST_KEY`） | 写入令牌，只能写 |
| `DEV_DASHBOARD` | `1` | 在设置页显示「开发者看板」入口（本机数据看板） |

命令行等价写法：

```powershell
gh variable set TELEMETRY_ENDPOINT --repo chenzhe223-tech/niantou-box-app --body "https://nianbox-telemetry.<你的子域>.workers.dev/ingest"
gh variable set TELEMETRY_KEY --repo chenzhe223-tech/niantou-box-app --body "<INGEST_KEY>"
gh variable set DEV_DASHBOARD --repo chenzhe223-tech/niantou-box-app --body "1"
```

填完回到仓库的 **Actions → 部署到 GitHub Pages → Run workflow** 手动跑一次，
或者随便提交一次代码触发构建。构建日志里会打印一行
`匿名统计已接入：https://...`，说明注入成功。

> **三个变量都留空也可以**：此时应用完全不发出任何网络请求，统计与反馈只留在用户本机
> （这是默认的安全状态）。以后想开就在这填，想关就删掉再重新构建一次。

---

## 四、看数据

### 方式 A：运营看板（推荐）

应用发布后，看板在应用同一个域名下：
`https://chenzhe223-tech.github.io/niantou-box-app/admin.html`

1. 打开页面，填入后端地址 `https://nianbox-telemetry.<你的子域>.workers.dev`
   和读取令牌（`ADMIN_TOKEN`），点「查看数据」。
2. 令牌只存在**这个标签页的 sessionStorage** 里，关掉标签页就没了；
   后端地址存在 localStorage，下次不用重填。
3. 页面本身不发任何请求，你必须主动点按钮才会去读数据。

### 方式 B：命令行

```powershell
$base = "https://nianbox-telemetry.<你的子域>.workers.dev"
$token = "<ADMIN_TOKEN>"

# 健康检查（不需要令牌）
curl.exe "$base/health"

# 最近 30 天汇总（JSON）
curl.exe -H "Authorization: Bearer $token" "$base/report?days=30"
```

### 方式 C：直接查数据库

```powershell
wrangler d1 execute nianbox-telemetry --remote --command "SELECT * FROM feedback ORDER BY at DESC LIMIT 20"
```

---

## 五、接口契约

### `POST /ingest`

请求头：`X-NianBox-Key: <INGEST_KEY>`、`Content-Type: application/json`

```json
{
  "v": 1,
  "installId": "8f0a...（随机 UUID，可在应用里重置）",
  "sessionId": "3c1b...（每次打开页面重新生成）",
  "context": {
    "app": "a1b2c3d",
    "platform": "wechat | ios | android | macos | windows | linux | other",
    "display": "standalone | browser",
    "viewport": "narrow | medium | wide | unknown",
    "lang": "zh-CN"
  },
  "events": [{ "n": "idea_created", "t": 1760000000000, "p": { "source": "home" } }],
  "feedback": [
    {
      "id": "feedback_...",
      "kind": "bug | suggestion | praise | other",
      "message": "用户亲手写的内容",
      "contact": "可选",
      "diagnostics": { "app": "...", "platform": "...", "lang": "...", "ideas": 12, "projects": 3 },
      "at": 1760000000000
    }
  ]
}
```

返回：`{"ok":true,"events":1,"feedback":0}`

限制：请求体 ≤ 256 KB、单批事件 ≤ 300 条、单批反馈 ≤ 20 条、反馈正文 ≤ 2000 字。
反馈按 `id` 去重（`ON CONFLICT DO UPDATE`），所以用户断网后反复重试不会产生重复记录。

### `GET /report?days=30`

请求头：`Authorization: Bearer <ADMIN_TOKEN>`（`days` 取 1–365，默认 30）

返回 `admin.html` 直接可渲染的 JSON：`totals`（事件数 / 设备数 / 会话数 / 今日活跃 /
7 日活跃 / 反馈条数）、`daily`（逐日，已补齐没有数据的日期）、`events`（事件分布）、
`platforms`、`versions`、`feedback`（最近 200 条）。

### `GET /health`

返回 `{"ok":true}`，用来确认 Worker 活着。

---

## 六、采集到的到底是什么（事件清单）

事件名与参数都在应用侧有白名单（`src/services/analytics.ts` 的 `EVENT_NAMES` /
`PROP_SCHEMA`），后端这里再过滤一遍（`ALLOWED_PROPS`），
**念头正文、标题、标签、分类、链接这些字段在结构上就不可能被存进来**。

| 事件名 | 含义 | 允许的参数 |
| --- | --- | --- |
| `app_open` | 打开应用 | — |
| `idea_created` | 记下念头 | `source`, `bucket` |
| `idea_updated` | 编辑念头 | `bucket` |
| `idea_status_changed` | 念头状态变更 | `status` |
| `idea_pinned` | 置顶 / 取消置顶 | `state` |
| `idea_deleted` | 移到回收站 | `source` |
| `idea_restored` | 从回收站恢复 | — |
| `idea_purged` | 永久删除 | — |
| `idea_upgraded` | 升级为创意项目 | `progress` |
| `project_updated` | 更新项目 | `progress` |
| `search_used` | 用了搜索（**不发关键词**） | `source` |
| `backup_exported` | 导出备份 | `result` |
| `backup_imported` | 导入备份 | `result` |
| `data_cleared` | 清空本机数据 | — |
| `feedback_opened` | 打开反馈页 | `source` |
| `feedback_submitted` | 提交反馈 | `kind`, `result` |
| `telemetry_changed` | 切换匿名统计开关 | `state` |

参数取值都是枚举（`source` / `status` / `progress` / `bucket` 档位 / `kind` / `result` / `state`），
除时间戳外没有自由文本；数量只上报**档位**（`1`、`2-5`、`6-20`、`21-100`、`100+`），
不报精确条数。

---

## 七、常用查询（对你判断下一步做什么最有用）

```powershell
# 1) 有多少人在用：按天看活跃设备
wrangler d1 execute nianbox-telemetry --remote --command "SELECT day, COUNT(DISTINCT install_id) AS devices, COUNT(*) AS events FROM events GROUP BY day ORDER BY day DESC LIMIT 30"

# 2) 新增用户趋势：每台设备第一次出现的那天
wrangler d1 execute nianbox-telemetry --remote --command "SELECT first_day, COUNT(*) AS new_devices FROM (SELECT install_id, MIN(day) AS first_day FROM events GROUP BY install_id) GROUP BY first_day ORDER BY first_day DESC LIMIT 30"

# 3) 功能使用分布（哪些功能真的被用）
wrangler d1 execute nianbox-telemetry --remote --command "SELECT name, COUNT(*) AS count, COUNT(DISTINCT install_id) AS devices FROM events GROUP BY name ORDER BY count DESC"

# 4) 卡在哪一步：念头状态 / 项目进度分布
wrangler d1 execute nianbox-telemetry --remote --command "SELECT props, COUNT(*) AS count FROM events WHERE name = 'idea_status_changed' GROUP BY props ORDER BY count DESC"

# 5) 平台分布（决定优先适配哪个端）
wrangler d1 execute nianbox-telemetry --remote --command "SELECT platform, COUNT(DISTINCT install_id) AS devices FROM events GROUP BY platform ORDER BY devices DESC"

# 6) 用户反馈（按时间倒序）
wrangler d1 execute nianbox-telemetry --remote --command "SELECT datetime(at/1000,'unixepoch','+8 hours') AS at_local, kind, message, contact FROM feedback ORDER BY at DESC LIMIT 50"

# 7) 周报：本周每天的事件量与活跃设备
wrangler d1 execute nianbox-telemetry --remote --command "SELECT day, COUNT(DISTINCT install_id) AS devices, COUNT(*) AS events FROM events WHERE day >= date('now','-6 days','+8 hours') GROUP BY day ORDER BY day"
```

---

## 八、换别的后端（可选）

接口只有两个，契约在第五节写清楚了，所以任何能收 POST、能按令牌返回 JSON 的后端都能用。
`schema.sql` 是 SQLite 方言，搬到 Postgres / Supabase 只需要把
`INTEGER PRIMARY KEY AUTOINCREMENT` 换成 `BIGSERIAL PRIMARY KEY`，
`TEXT` / `INTEGER` 保持不变即可，其余查询逻辑一致。

不管换到哪，规则不变：**前端只拿「只能写入」的钥匙，读取凭据永不进产物。**

---

## 九、排查

| 现象 | 原因与处理 |
| --- | --- |
| 构建日志提示「产物里没有找到统计接口地址」 | 仓库 Variables 名字写错了，必须是 `TELEMETRY_ENDPOINT` / `TELEMETRY_KEY` / `DEV_DASHBOARD`。 |
| 看板提示 401 | 读取令牌不对，或 `Authorization` 里少了 `Bearer `。 |
| 看板提示 500 且说没绑数据库 | 第 3 步建表没执行，或 `wrangler.toml` 的 `database_id` 不对。 |
| 数据一直是 0 | 先看应用侧：设置页 →「开发者看板」→ 采集状态是否显示「已配置」；再看待发送队列是不是卡着（断网时会留队，下次打开自动补发）。 |
| 想临时停掉统计 | 删掉仓库变量 `TELEMETRY_ENDPOINT` 重新构建即可（不删旧数据，只是不再上报）。 |

---

## 十、隐私边界（会写进交付说明，请保持）

1. 不采集念头正文、标题、标签、分类、链接、搜索关键词；
2. 不采集 IP（Worker 不记录、不写入）、不写 Cookie、不做浏览器指纹；
3. 设备标识是随机 UUID，用户可在应用里一键重置，重置后无法与之前关联；
4. 用户可在设置页一键关闭匿名统计；关闭时立即清空待发送队列，之后一个字节都不发；
5. 反馈内容由用户亲手填写并主动点「提交」才会发送；「附带诊断信息」默认不勾选。
