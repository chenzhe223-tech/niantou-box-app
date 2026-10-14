# 念头盒 NianBox

> 把每一个念头，留给未来的创造。

念头盒（NianBox / Idea Inbox）是一个轻量的个人灵感捕捉工具。它要解决的不是「记笔记」，而是 `发现问题 → 随手记录 → 逐步整理 → 验证想法 → 转化为产品 → 发布作品` 这条链路中最容易断裂的第一步：**把念头先留下来**。

---

## 一、产品是什么

生活中经常冒出一些实际问题：停车场明明知道位置却总是找不到空位、社区旧书没有合适去处、某个重复操作想写个自动化工具。这些念头往往来自生活、工作、旅行或产品体验，但大部分因为没有及时记录就消失了；即便记下来，也散落在收藏夹、备忘录和各种聊天记录里。

念头盒希望成为一个长期积累创意的入口：

- **打开就能写**，不需要先想标题、选文件夹、挑分类。
- **不评价创意好坏**，不成熟的想法也值得保存。
- **数据默认只存在本机浏览器**，不上传服务器、不需要登录、不收费。
- **公开的是应用本身，而不是你写的灵感**。

名字里的「盒」指的是那个随手放东西、以后要用时能找到的地方。列表在没有任何标题的时候，会用正文的第一句作为**显示标题**，但绝不会改写你输入的原文。

---

## 二、第一版实现了哪些功能

### 1. 首页 · 随手记

- 首屏就是输入框，打开即可输入，不需要先跳转。
- 多行文本输入，支持手机原生键盘、粘贴、长文本。
- 分类是可跳过选项：生活问题 / App·产品创意 / Skill·自动化 / 网站·小程序 / 其他，默认不选。
- 主要按钮「记下这个念头」，保存成功后提示「收好了，这个念头不会轻易丢失。」。
- **只有数据库真的写入成功才会提示成功**；写入失败会保留输入内容并给出真实错误。
- 内容为空时不会创建记录，提示「先写下一句话，再收进念头盒。」。
- 未保存内容会留一份本地草稿，刷新后可一键恢复或丢弃（正常保存不会弹出任何打扰性确认框）。
- 保存后清空输入、更新记录总数、把新内容放进「最近的念头」。

### 2. 念头收件箱

- 集中展示全部念头，默认按最近更新时间倒序（同时保留创建时间，编辑不会丢失原始创建时间）。
- 每条展示正文摘要、创建时间、分类、当前状态、置顶标记，以及可选的来源项目名。
- 支持关键词搜索（正文、标题、备注、标签，英文不区分大小写）、分类筛选（含「未分类」）、状态筛选、只看置顶；多个条件可叠加。
- 支持置顶 / 取消置顶、编辑、删除、进入完整详情。
- 删除前必须确认；删除是软删除，会进入回收站。
- 空状态友好引导：「这里还没有念头。留意生活中的小问题，它们可能是下一个作品的起点。」；搜索无结果时提示「没有找到匹配的念头。」。

### 3. 念头详情与编辑

- 默认只显示最必要的字段，其余字段收在「完善这个念头」可展开区域中。
- 字段：标题（可选）、正文（必填，原样保留）、分类、状态、标签（多个）、置顶、备注/补充思考、解决的问题、目标用户、潜在产品形态（App / 网站 / 小程序 / Skill / 其他）、项目链接（GitHub 仓库、已发布网页等 URL）。
- 状态固定六种：待整理、值得研究、准备开发、开发中、已完成、暂缓；默认「待整理」。
- 编辑真正写入 IndexedDB，刷新后保留；编辑不会改变记录 ID 与创建时间。
- 长文本、特殊字符、中文、Emoji 与 URL 均按原文处理。

### 4. 创意项目库

- 可以把一条念头「升级为创意项目」，升级后保留指向原始念头的链接。
- 项目字段：项目名称、需要解决的问题、目标用户、核心功能、产品形态、当前进度、GitHub 仓库 URL、已发布网址。
- 进度：准备中、开发中、打磨中、已发布、暂缓。
- 念头状态会随升级推进到「准备开发」，并记录来源项目；项目详情页可一键跳回原始念头。
- 第一版**不做**看板协作、工时管理、团队账号等复杂功能。

### 5. 回收站

- 软删除的念头与项目集中在这里，可恢复或永久删除。
- 永久删除念头时，会一并处理其关联项目，不留悬空引用。

### 6. 设置与数据

- 本地存储说明、当前数据统计（念头数、项目数、置顶数、回收站记录数）。
- 一键导出 JSON 备份、导入 JSON 备份、清空全部本地数据（需二次确认）。
- 隐私说明：不调用第三方 AI 接口、不登录、不采集个人信息、无分析脚本与追踪代码。

### 7. PWA 与离线

- Web App Manifest（名称、短名称、主题色、192/512 图标、maskable 图标）与 Service Worker。
- 静态资源预缓存 + 导航请求网络优先：**在线时总能拿到最新版本**，离线时已缓存界面仍能打开，本地数据依然可读可编辑。
- Service Worker 只在生产构建中注册，开发环境保持干净；注册失败不影响应用启动。

---

## 三、技术栈

| 方面 | 选择 |
| --- | --- |
| 界面 | React 19 + TypeScript（`strict`，开启 `noUnusedLocals` / `noUnusedParameters`） |
| 构建 | Vite 8（rolldown） |
| 样式 | 单一设计系统 `src/styles/global.css`（CSS 变量统一颜色、圆角、间距、字体、按钮高度） |
| 数据 | IndexedDB（浏览器原生），封装在 `src/services/` 中，界面与数据模型分离 |
| 路由 | 哈希路由（`#/inbox` 这类地址），部署在静态托管的子路径下刷新不会 404 |
| PWA | 手写 Manifest 与 Service Worker，无第三方 PWA 插件 |
| 测试 | Vitest 5 + @testing-library/react + jsdom + fake-indexeddb |
| 部署 | GitHub Actions + GitHub Pages（官方 Pages 发布方式） |

没有引入后端、数据库服务、用户系统或任何 AI API；生产依赖只有 `react` 与 `react-dom`。

### 目录结构

```
niantou-box/
├─ .github/workflows/deploy.yml   # 构建、测试并发布到 GitHub Pages
├─ public/                        # Manifest、Service Worker、图标、favicon
├─ scripts/
│  ├─ generate-icons.mjs          # 用 Node 内置模块生成 PNG 图标（无外部依赖）
│  └─ verify-site-integration.mjs # 官网对接自检（加载官网真实 script.js + 探测线上状态）
├─ src/
│  ├─ app/        # 路由解析、格式化、全局数据 Provider、官网对接配置
│  ├─ components/ # 通用组件（按钮、字段、卡片、对话框、Toast、状态页…）
│  ├─ hooks/      # useHashRoute / useDraft / useNow
│  ├─ pages/      # 首页、收件箱、详情、项目库、项目详情、回收站、设置
│  ├─ services/   # IndexedDB、存储、查询、备份导入导出、文件传输
│  ├─ styles/     # 全局设计系统
│  ├─ test/       # 测试环境初始化
│  └─ types/      # 念头 / 项目 / 备份文件类型定义
├─ index.html
├─ vite.config.ts
└─ vitest.config.ts
```

---

## 四、本地开发

### 环境要求

- **Node.js ≥ 22.18**（见下文说明；推荐 Node 24 LTS）
- **pnpm 11**（`package.json` 的 `packageManager`/`engines` 按此约束；使用 npm/yarn 也可以，但锁文件是 `pnpm-lock.yaml`）

### 安装与启动

```bash
pnpm install
pnpm dev
```

开发服务器默认监听 `http://localhost:5173/`，默认 Base 路径为 `/`，刷新任意哈希路由都不会 404。

### 关于 `--configLoader native`

`package.json` 中的脚本都带了 `--configLoader native`（Vite 官方 CLI 选项，官方标注为 experimental）。原因：

> Vite 8 默认会用 rolldown **打包**配置文件（`vite.config.ts`），而这条路径在 Windows 上会调用一次 `exec("net use")` 来探测网络驱动器映射。在禁止派生进程的环境里，这一步会抛出 `spawn EPERM` 导致构建/测试无法启动。改用 `native` 后由 Node 原生加载配置文件，绕开这一步，行为与 `bundle` 一致。

本地 macOS / Linux / 普通 Windows 环境**去掉这个参数也能正常工作**；保留它是为了让脚本在受限环境中同样可运行。原生加载 `.ts` 配置文件依赖 Node 的类型剥离能力，这也是 Node 版本要求 ≥ 22.18 的原因。如果你的环境低于该版本，把脚本里的 `--configLoader native` 去掉即可。

---

## 五、生产构建

```bash
pnpm build          # 等价于 tsc --noEmit && vite build
pnpm preview        # 本地预览构建产物
```

构建产物在 `dist/`。部署到子路径时需要显式指定 Base：

```bash
# Windows PowerShell
$env:BASE_PATH="/niantou-box/"; pnpm build

# macOS / Linux
BASE_PATH=/niantou-box/ pnpm build
```

`vite.config.ts` 读取 `BASE_PATH` 环境变量作为 `base`，默认 `/`。**不要硬编码某个 GitHub 用户名**：部署路径由仓库名动态决定。

构建后 `dist/` 中的 JS、CSS、图标、Manifest 与 Service Worker 都会带上正确的子路径前缀。

---

## 六、自动化测试

```bash
pnpm test           # 运行全部用例（vitest run）
pnpm test:watch     # 监听模式
pnpm typecheck      # 仅做 TypeScript 类型检查
pnpm verify         # 类型检查 + 全部测试 + 生产构建（提交前推荐跑一遍）
pnpm verify:site    # 官网对接自检：加载官网真实的 script.js 验证对接契约，并探测线上当前状态
```

测试共 **77** 个用例，分为五个文件：

| 文件 | 用例数 | 覆盖内容 |
| --- | ---: | --- |
| `src/services/storage.test.ts` | 33 | 创建/更新/持久化（重开数据库模拟刷新）、标签规范化、默认值与非法值回落、唯一 ID、长文本+Emoji+中文+URL、置顶排序与落库、软删除/恢复/永久删除/清空回收站、关键词搜索（正文/标题/备注/标签，英文不区分大小写）、分类（含未分类）、状态、只看置顶、筛选叠加、计数、变更订阅、项目升级与关联完整性 |
| `src/services/backup.test.ts` | 22 | 导出统计与文件名（本地日期）、序列化→解析往返、导出→清空→重新导入完整恢复、空内容与非法 JSON 拒绝、非念头盒文件拒绝、版本号校验、必填字段校验、重复 ID 检测、非法枚举值回落与警告、孤儿项目跳过、ISO 字符串与毫秒时间戳兼容、三种重复策略（skip/overwrite/duplicate）、导入不清空既有数据、失败导入不改动任何数据 |
| `src/App.test.tsx` | 14 | 页面级流程：首屏文案、真实写库、成功提示、空内容拦截、刷新后仍在、搜索筛选与无结果、删除二次确认与取消、详情原样显示、编辑持久化且保 ID/创建时间、不存在的念头、升级项目并保持关联、导出下载（文件名与 JSON 内容）、本地存储说明文案、IndexedDB 不可用时的错误状态与重试 |
| `src/App.console.test.tsx` | 3 | 控制台干净度：主流程与空状态/无效路由下 `console.error`/`console.warn` 均为空，且没有未捕获错误或未处理的 Promise 拒绝 |
| `src/App.site.test.tsx` | 5 | 官网对接：`getOfficialSiteUrl()` 只接受 http/https 绝对地址并补齐结尾斜杠，空串 / 纯空白 / 相对路径 / 裸域名 / `javascript:` 伪协议一律视为未配置；设置页在注入官网地址时渲染「关于念头盒」入口（校验 `href`、`target="_blank"`、`rel` 含 `noopener` 与 `noreferrer`），未注入或地址非法时整块不渲染 |

> 说明：测试在 jsdom 中运行，使用 `fake-indexeddb` 提供真实行为的 IndexedDB 实现，因此断言的是「确实写进了数据库」。测试用 worker 线程池而非子进程，在受限环境中同样可运行。

> `pnpm verify:site` 不是单元测试：它会真实访问线上官网地址（默认 `https://chenzhe223-tech.github.io/niantou-box/`），把官网的 `script.js` 放进 jsdom 里跑，断言「切到 `live` 后」所有 `[data-app-link]` 都指向应用地址，并报告官网当前的对接状态与应用是否已经部署。未部署的应用地址只会被标记为「待完成」，不会判为失败（退出码仍为 0）；只有真实的对接错误才会让脚本失败。可以用 `SITE_URL=` / `APP_URL=` 覆盖默认地址。

---

## 七、GitHub Pages 部署方法

仓库中已包含 `.github/workflows/deploy.yml`，流程为：

1. 检出代码（`actions/checkout`）；
2. 安装 pnpm 与 Node 24（`pnpm/action-setup` + `actions/setup-node`，启用 pnpm 缓存）；
3. 安装依赖（`pnpm install --frozen-lockfile`）；
4. 类型检查（`pnpm typecheck`）；
5. 运行自动化测试（`pnpm test`）；
6. 生产构建（`pnpm build`，注入 `BASE_PATH=/${{ github.event.repository.name }}/` 与 `VITE_OFFICIAL_SITE_URL`，后者的默认值与覆盖方式见第 10.2 节）；
7. 校验构建产物里确实带有官网地址（在 `dist/assets` 里 `grep` 一下）：不通过只打一条 `::warning::`，**不会**阻断发布——因为这个入口是可选的；
8. 配置 Pages（`actions/configure-pages`）→ 上传产物（`actions/upload-pages-artifact`，路径 `dist`）→ 发布（`actions/deploy-pages`）。

**第 4、5、6 步任意一步失败，构建任务即失败，部署任务不会执行**，因此不会把构建失败的版本发布出去。

工作流使用官方 Pages 发布方式（OIDC + `pages: write` / `id-token: write`），**不需要在仓库里配置任何令牌或密钥**。

触发条件：推送到 `main` 分支，或在仓库的 Actions 页面手动触发（`workflow_dispatch`）。

> **如果应用与官网在同一个仓库**（官网占站点根目录、应用源码放在 `app/` 子目录），请改用交付物 `deploy.yml` 替换本文件：它会在一次运行里先构建应用（注入 `BASE_PATH` 与 `VITE_OFFICIAL_SITE_URL`），再把官网文件与应用产物组装成同一个站点发布，从而同时上线官网（`/`）与应用（`/app/`）。上面这份单应用工作流适用于**应用单独占用一个仓库**的情况。两种形态的取舍见第十节。

---

## 八、如何设置正确的 Pages 发布来源

工作流第一次跑之前，需要手动确认发布来源（这一步只能由仓库管理员在网页上完成）：

1. 打开仓库页面 → **Settings** → 左侧 **Pages**；
2. 在 **Build and deployment** → **Source** 中选择 **GitHub Actions**（不是 "Deploy from a branch"）；
3. 回到 **Actions** 标签页，等待（或重新运行）名为「部署到 GitHub Pages」的工作流；
4. 首次运行会创建 `github-pages` 环境，若出现审批提示，点击 **Review deployments** → **Approve**。

如果你的默认分支不是 `main`，请修改 `.github/workflows/deploy.yml` 中 `on.push.branches` 的值。

---

## 九、如何获取公开访问网址

部署成功后，地址遵循 GitHub Pages 的固定格式：

```
https://<你的 GitHub 用户名>.github.io/<仓库名>/
```

按本仓库建议的仓库名 `niantou-box`，地址形如：

```
https://<你的 GitHub 用户名>.github.io/niantou-box/
```

其中用户名与仓库名必须填写你自己的真实值——工作流通过 `github.event.repository.name` 动态取仓库名，所以**无论仓库叫什么名字，Base 路径都会自动匹配**，不需要改代码。

官网落地页已经部署在 `https://chenzhe223-tech.github.io/niantou-box/`（HTTP 200）。

**应用（本体）也已经上线并完成对接**：采用**方案 B（独立仓库 `chenzhe223-tech/niantou-box-app`）**，
线上地址 `https://chenzhe223-tech.github.io/niantou-box-app/`（HTTP 200，Actions 构建 + 发布流程全绿）。
官网的 `app-config.js` 已切换为 `appStatus: "live"`、`appUrl` 指向该地址，官网入口按钮文案为「打开念头盒 ↗」，
点击后新标签页打开应用。线上实测结果见第十五节。

两种形态对应的应用地址（供参考，本项目采用的是下面第二种）：

- **方案 A（官网与应用同一个仓库、同一个站点）**：应用地址为 `https://chenzhe223-tech.github.io/niantou-box/app/`。
- **方案 B（应用独立仓库、独立地址；本项目采用）**：应用地址为 `https://<你的用户名>.github.io/<应用仓库名>/`，例如 `https://chenzhe223-tech.github.io/niantou-box-app/`。

两种形态的取舍见第十节，方案 B 的完整操作步骤见交付物 `方案B-应用独立部署-念头盒NianBox.md`。

获取准确地址的两个位置：

1. Actions 里构建任务的产物名（Artifact）与部署任务的输出 `page_url`；
2. 仓库 **Settings → Pages** 顶部显示的 "Your site is live at …"。

> 上表里的方案 B 地址已经在线上验证过（HTTP 200、入口页与全部资源可取回，Actions 运行全绿）；方案 A 的 `/app/` 形态本项目没有实际部署。

---

## 十、与官网（落地页）对接

念头盒有相互独立的两部分，既可以各自部署，也可以放在同一个站点的不同子路径下：

- **官网（落地页）**：介绍产品理念的静态页面，位于站点根目录（`index.html` / `styles.css` / `script.js` / `app-config.js`）。
- **应用（本体）**：本仓库这部分代码，构建产物 `dist/`，部署在 `/app/` 子路径下。

两边只通过**一条约定**对接，并且**地址都不写死在源码里**。

### 1. 官网 → 应用：`app-config.js`

官网根目录的 `app-config.js` 暴露一个冻结对象：

```js
window.NIANBOX_CONFIG = Object.freeze({
  appUrl: "https://<你的用户名>.github.io/niantou-box/app/",
  appLabel: "打开念头盒 ↗",
  appStatus: "live" // 应用真正可访问之后才改成 "live"
});
```

官网的 `script.js` 会读取它，并处理页面上所有带 `data-app-link` 的元素（顶部导航按钮与页脚入口各一处）：

- `appStatus === "live"` 且 `appUrl` 非空：入口指向 `appUrl`，新标签页打开（`target="_blank"` 且 `rel="noopener noreferrer"`），文案变为 `appLabel`；
- 否则：入口回退到页面锚点 `#capture`，文案显示 `appLabel`（默认「应用即将到来」）。

也就是说：**在应用真正可访问之前，官网不会出现指向空地址的假按钮** —— 只要让 `appStatus` 保持 `"coming-soon"` 即可。

### 2. 应用 → 官网：构建变量 `VITE_OFFICIAL_SITE_URL`

应用的设置页提供「关于念头盒」入口（链接文案「打开官网首页」）指回官网。地址**在构建时注入**，不写死在源码里：

```bash
# Windows PowerShell
$env:BASE_PATH="/niantou-box/app/"; $env:VITE_OFFICIAL_SITE_URL="https://<你的用户名>.github.io/niantou-box/"; pnpm build

# macOS / Linux
BASE_PATH=/niantou-box/app/ VITE_OFFICIAL_SITE_URL=https://<你的用户名>.github.io/niantou-box/ pnpm build
```

- 只接受 `http` / `https` 绝对地址，并自动补齐结尾 `/`；空串、纯空白、相对路径（如 `/niantou-box/`）、裸域名（如 `niantou-box`）、`javascript:` 这类伪协议都会被当作「未配置」忽略。
- 未注入（或地址非法）时，设置页**不渲染**「关于念头盒」整块 —— 不会出现点不动的假链接。

**本仓库自带的工作流已经帮你注入好了**：`.github/workflows/deploy.yml` 里有一个 `OFFICIAL_SITE_URL`（默认 `https://chenzhe223-tech.github.io/niantou-box/`），构建时会作为 `VITE_OFFICIAL_SITE_URL` 传进去；构建后还会检查产物里有没有这个地址（没有则打一条 `::warning::`）。

- 官网换地址 → 改工作流里的 `OFFICIAL_SITE_URL`；
- 想在不改代码的前提下覆盖 → 在**应用仓库**的 `Settings → Secrets and variables → Actions → Variables` 里新建变量 `OFFICIAL_SITE_URL`，它会优先于默认值；
- 明确不想显示这个入口 → 把它设为空串。

### 3. 对接自检：`pnpm verify:site`

`scripts/verify-site-integration.mjs` 会加载官网**真实的 `script.js`** 在 jsdom 中执行，断言上述契约（入口点数量、`href`、`target`、`rel`、文案），并同时探测线上状态（官网首页、应用入口是否已部署、资源是否可取回、应用 bundle 是否注入了官网地址）。**未部署的应用只记为「待完成」，不算失败。**

### 4. 两种部署形态

- **同仓库、同站点（推荐）**：官网在站点根目录，应用源码放在 `app/` 子目录，一次部署同时上线两者（官网在 `/`，应用在 `/app/`）。对应工作流见交付物 `deploy.yml`（放置为 `.github/workflows/deploy.yml`）。
- **各自独立部署**：官网与应用分属两个仓库、两个地址。此时应用侧照常用 `VITE_OFFICIAL_SITE_URL` 指回官网，官网侧只把 `app-config.js` 的 `appUrl` 改成应用的真实地址即可，**应用代码一行都不用改**。
  具体做法：把本仓库的内容（`package.json` 在仓库根目录，即「仓库根 = 应用根」）推到一个**新仓库**，用本仓库自带的 `.github/workflows/deploy.yml` 发布；官网侧只需改 `app-config.js` 里的 `appUrl`。这一套交付物里已经备好：应用仓库压缩包 `nianbox-app-repo.zip`、官网侧配置 `app-config.方案B.js`、逐步说明 `方案B-应用独立部署-念头盒NianBox.md`。

> 小结：换用户名、换仓库名、把应用单独部署到另一个仓库，都**不需要改动应用源代码**；需要跟着改的只有官网侧的 `app-config.js` 与构建命令里的环境变量。

---

## 十一、数据本地保存的特点

- 所有念头与项目保存在**当前设备、当前浏览器**的 IndexedDB 数据库中（库名 `nianbox`）。
- 不登录、不上传、不写公开仓库里的 JSON 或静态文件、不调用任何公开 API。
- 因此：
  - 清理浏览器数据、使用隐私/无痕模式、卸载浏览器、重置系统，都会造成数据丢失；
  - 换设备、换浏览器看不到原来的记录；
  - 不同浏览器（Chrome / Safari / Edge）之间各自独立。
- 设置页也明确写明了这段话：「当前版本采用本地存储，记录保存在这台设备的当前浏览器中。清理浏览器数据或更换设备前，请先导出备份。」

---

## 十二、如何导出与恢复数据

### 导出

**设置 → 备份与恢复 → 导出数据**，会下载一个 JSON 文件：

```
nianbox-backup-YYYY-MM-DD.json
```

文件包含格式标识、格式版本号、导出时间、应用版本、数量统计，以及**全部念头与创意项目（含回收站中的记录）**与它们的关联信息、时间戳和状态字段。

### 导入（恢复）

**设置 → 备份与恢复 → 导入数据**，选择之前导出的 JSON 文件：

1. 先做校验：文件格式、数据结构、必填字段、日期字段、记录 ID、状态与分类的合法值；**校验不通过不会改动任何现有数据**；
2. 弹出确认框，显示备份的导出时间、版本、记录数量，以及**与本机重复的 ID 数量**；
3. 选择重复记录的处理方式：
   - 保留现有数据，跳过相同 ID（默认，推荐）；
   - 用备份中的记录覆盖相同 ID；
   - 把相同 ID 的记录作为新记录导入（生成新 ID，不覆盖也不丢弃）；
4. 导入完成后给出结果统计；若有单条记录的警告（例如项目关联的念头缺失），会列在设置页中。

导入**不会**先清空现有数据。若要彻底重来，请先导出备份，再使用「清空全部数据」。

> 建议：任何一次清理浏览器数据、更换设备或升级系统之前，先导出一份备份。

---

## 十三、跨设备同步暂未实现

**第一版不提供任何形式的云同步或跨设备同步。** 没有登录、没有服务器、没有后端，记录只存在于写入它的那台设备的那个浏览器里。

如果你在多台设备上使用，目前只能通过「导出 → 传输文件 → 导入」的方式手动合并。需要说明的是，导入的重复 ID 处理策略是**按 ID 去重**，同一台设备之外新产生的内容会作为新记录导入，不会自动做字段级合并。

---

## 十四、已知限制与后续规划

### 已知限制

1. **无跨设备同步**：第一版只有本地存储，且不打算用「假的同步」来充数。
2. **无账号体系**：不做登录，因此也无法做到服务端的数据找回。
3. **数据丢失风险**：数据生命周期完全跟随浏览器；清空浏览器数据即丢失（备份是唯一的保险）。
4. **Service Worker 只在生产构建注册**：开发环境不注册 SW，避免缓存干扰调试。
5. **离线能力有边界**：仅保证「已经缓存过的应用界面 + 已有本地数据」可用；第一次访问必须联网。应用界面使用网络优先策略，保证在线时不会卡在旧版本。
6. **PWA 安装方式因浏览器而异**：桌面 Chrome/Edge 有安装入口，iOS Safari 需要用「添加到主屏幕」，部分浏览器不提供安装能力。应用不会做无意义的自定义安装弹窗。
7. **未做真机验证**：本项目在受限环境中开发，浏览器自动化工具（如 Playwright）不可用，因此**没有进行真实 iOS / Android 设备或真实浏览器视口的验证**。响应式布局、安全区域、软键盘行为等只经过代码层面的设计与静态检查（详见第十五节），请以真机实测结果为准。
8. **暂无导入导出以外的数据迁移手段**：没有 CSV 或 Markdown 导出。

### 后续规划（未实现，仅作为方向）

- 使用 AI 辅助整理念头（聚类、补全、生成项目草案）——需要用户明确授权与隐私方案；
- 创意项目与 GitHub 仓库的联动（同步 issues、展示进度）；
- 可选的端到端加密同步，让多设备使用不再依赖手动导入导出；
- 更丰富的数据出口（Markdown / CSV）；
- 真实浏览器端到端测试（Playwright）接入 CI。

> README 只描述已经实现的功能，未实现的能力一律列在本节，不会写成"即将推出"的按钮。

---

## 十五、本次开发实际执行的验证

以下结论都来自**真实执行**的命令，不是设计意图：

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm typecheck` | 通过，0 错误 |
| 自动化测试 | `pnpm test` | 5 个文件 / 77 个用例全部通过 |
| 生产构建（根路径） | `pnpm build` | 成功（`dist/index.html` + 1 CSS + 1 JS） |
| 生产构建（子路径） | `BASE_PATH=/niantou-box/ pnpm build` | 成功，产物资源路径均带 `/niantou-box/` 前缀 |
| 子路径静态托管自检 | 本地静态服务器（不做 SPA 兜底）托管 `dist/` | 21 项全部 200/404 符合预期：入口页、JS、CSS、favicon、Manifest、3 个图标、Service Worker、SW 预缓存清单；不存在的路径确实返回 404 |
| 对接构建（同时注入官网地址，方案 A 形态） | `BASE_PATH=/niantou-box/app/ VITE_OFFICIAL_SITE_URL=… pnpm build` | 成功，51 个模块；产物中可检出官网地址，源码变量名 `VITE_OFFICIAL_SITE_URL` 残留为 0（说明已注入） |
| 对接构建（应用独立地址，方案 B 形态） | `BASE_PATH=/niantou-box-app/ VITE_OFFICIAL_SITE_URL=… pnpm build` | 成功，51 个模块（`index-*.css` 22.9 kB、`index-*.js` 296.6 kB / gzip 89.4 kB）；`dist/index.html` 的 5 处资源引用**全部**带 `/niantou-box-app/` 前缀；产物中可检出官网地址，源码变量名残留为 0 |
| 方案 B 独立仓库静态托管自检 | 本地静态服务器（严格 404）托管 `BASE_PATH=/niantou-box-app/` 的 `dist/` | 25 项全部通过、0 失败：入口与 5 项资源、PWA 清单与图标、`sw.js` 及 9 项预缓存全部 200；不存在的路径确实返回 404 |
| 方案 B 端到端预览自检（本地同时托管官网 + 独立地址应用） | `pnpm verify:site`（对着本机预览，应用配置取自 `app-config.方案B.js`） | 失败 0 项、待完成 0 项：官网 6 项 OK、对接行为 3 项 OK（2 处入口均指向应用地址、文案「打开念头盒 ↗」）、应用 10 项 OK（应用可达、确为念头盒、5 项资源 + manifest + `sw.js` 全 200、**回链已注入**） |
| 同一站点「官网 + 应用」组装自检 | 本地静态服务器（严格 404）托管组装后的 `_site/` | 29 项检查全部通过、0 失败：官网 5 个文件 200、`appStatus=live` 生效、应用 `/app/` 入口及其 5 个资源、3 个 PWA 图标、`sw.js` 与 9 项预缓存全部 200；不存在的路径确实 404 |
| 组装语义检查 | 复现工作流的 `rsync` 排除 + `cp -r dist/. _site/app/` | 通过：官网文件保留在根、应用在 `/app/`，而 `.github/`、`node_modules/`、应用的 `src/` 与 `package.json` 均**未**被复制进站点 |
| 官网对接自检（本地预览） | `pnpm verify:site` | 通过（0 失败）：官网 `script.js` 契约在 jsdom 中验证通过（2 处入口点、`href`/`target`/`rel`/文案全部符合） |
| **线上发布后**：官网对接自检 | `SITE_URL=https://chenzhe223-tech.github.io/niantou-box/ APP_URL=https://chenzhe223-tech.github.io/niantou-box-app/ pnpm verify:site` | **失败 0 项、待完成 0 项**：官网 6 项 OK、对接行为 3 项 OK（2 处入口均指向应用地址、文案「打开念头盒 ↗」、状态「已对接」）、应用 10 项 OK（应用可达、确为念头盒、5 项资源 + manifest + `sw.js` 全 200、回链已注入） |
| **线上发布后**：应用静态资源实测 | Node `fetch` 逐一取回 `https://chenzhe223-tech.github.io/niantou-box-app/` | 22 项全通过、0 失败：入口页（标题含「念头盒」）、5 项资源、PWA 清单 + 3 个图标、`sw.js` 与 9 项预缓存全部 200；不存在的路径确实 404；构建产物里带 `/niantou-box-app/` 前缀 |
| **线上发布后**：应用真实功能冒烟测试 | 把**线上那份 JS 产物**放进 jsdom 执行，驱动一次真实操作（写下念头 → 提交 → 查库 → 切换页面） | 18 项全通过、0 失败：首屏与空状态正常、按钮是 `type=submit`、输入被 React 接收并写草稿、保存后出现成功提示、输入框清空、草稿被清理、记录出现在「最近的念头」、**IndexedDB 库 `nianbox` / 表 `ideas` 中确有该记录**、切到收件箱后记录仍在、运行期 0 未捕获异常 |
| **线上发布后**：仓库与本地逐字节比对 | Node `fetch` 取回远端 59 个 blob，与本地交付包逐个 sha256 比对 | **59/59 逐字节一致，0 差异**（提交 `db8b64bb`） |
| 线上状态核实（2026-10-14，对接后） | Node `fetch` 访问官网与应用 | 官网 `app-config.js` 为 `appStatus: "live"`、`appUrl` 指向应用地址、`appLabel` 为「打开念头盒 ↗」；应用站 HTTP 200；两个仓库最新 Actions 运行均 `success` |

**没有执行**（受环境限制，不做任何声称）：

- 真实浏览器渲染与视口测试（Playwright / Chromium 在当前环境不可用；上面的功能冒烟测试跑在 jsdom 上，
  它能验证应用逻辑、数据读写与 DOM 结构，但**不能**替代真实浏览器的渲染、布局与滚动表现）；
- iOS / Android / 鸿蒙真机验证；
- Service Worker 的离线能力在真实浏览器中的表现（jsdom 不提供 Service Worker）；
- 方案 A（同一站点 `/app/`）形态的实际部署（本项目采用方案 B，方案 A 只做了本地组装自检）。

**已经执行**（应用本体部分）：GitHub Actions 的真实构建 + 测试 + Pages 发布（run 61 全绿）、方案 B 应用线上访问、
官网 `app-config.js` 切换为 `live` 并完成对接，以及上表中「线上发布后」的 4 项线上实测。

---

## 十六、常见问题

**Q：直接双击 `dist/index.html` 打开可以吗？**
不建议。PWA 的 Manifest 与 Service Worker 需要 HTTP(S) 环境，而且 `file://` 下的 IndexedDB 行为在不同浏览器里并不一致。请用 `pnpm preview` 或任意静态服务器访问。

**Q：数据存在哪里？能直接看到吗？**
存在浏览器的 IndexedDB（库名 `nianbox`，包含 `ideas` / `projects` / `meta` 三个对象仓库）。开发者工具的 Application → IndexedDB 可以看到。想稳妥地备份，请使用设置页的「导出数据」。

**Q：为什么不把数据同步到云端？**
第一版有意保持"零后端"：不登录、不收集、不上传，公开的只是应用代码。云同步要么需要账号体系，要么会引入未经说明的数据上报，两者都不符合第一版的定位。

**Q：`pnpm build` 报 `spawn EPERM` 怎么办？**
确认脚本里带了 `--configLoader native`，并且 Node 版本 ≥ 22.18。详见第四节的说明。

**Q：官网和应用是什么关系？我该改哪里？**
官网是介绍页，应用是本体，可以放同一个站点（官网在根、应用在 `/app/`），也可以各自独立部署，两者只通过一条约定对接。规则、构建变量与自检命令见第十节。一句话：**应用源码不用改**，只需改官网侧的 `app-config.js`，以及构建时注入的 `VITE_OFFICIAL_SITE_URL`。

**Q：为什么设置页有时看不到「打开官网首页」这个入口？**
因为该入口只在构建时注入了合法的 `VITE_OFFICIAL_SITE_URL`（http/https 绝对地址）才会出现。没有注入时不渲染，避免出现点不动的假链接——这是刻意行为，不是 bug。
