# 云端能力配置：AI 分类 / AI 生图 / 邮件与找回密码

这份文档只讲**服务端需要配置什么**，以及**怎么确认配置真的生效**。

原则（写进代码里，改文档也不会改它）：

1. 所有密钥只写进 Cloudflare Worker 的 **Secret**，绝不进前端产物、绝不进仓库、绝不进日志。
2. 没配置的能力接口会如实返回 `configured:false`，前端显示「未配置」，**不会伪造成功状态**。
3. 前端 `GET /capabilities` 只能看到「有没有配」「配的是哪家、哪个模型」，**看不到任何密钥**。

---

## 一、一张表看懂要配什么

| 能力 | 必需变量 | 可选变量 | 不配会怎样 |
| --- | --- | --- | --- |
| AI 自动分类 | `AI_API_KEY` | `AI_BASE_URL`、`AI_MODEL`、`AI_FALLBACK_MODELS`、`AI_PROVIDER_LABEL` | 收件箱里显示「未接入文本模型」，分类回退到本地关键词规则 |
| 隐私抽象（海报第一步） | 复用 `AI_API_KEY` | 同上 | 海报的抽象步骤不可用，生成按钮会明说原因 |
| AI 生图（海报底图） | 复用 `AI_API_KEY` | `IMAGE_BASE_URL`、`IMAGE_API_KEY`、`IMAGE_MODEL`、`IMAGE_FALLBACK_MODELS`、`IMAGE_PROVIDER_LABEL`、`AI_IMAGE_DAILY_LIMIT` | 海报只在本机绘制，不生成假的 AI 图片 |
| 邮件发送（念头发邮件） | `MAIL_API_BASE`、`MAIL_API_KEY`、`MAIL_FROM` | `MAIL_PROVIDER`、`MAIL_FROM_NAME` | 退化为 `mailto:` 预填，由用户在自己的邮件应用里确认发送（界面会写明这不是「已发送」） |
| 邮箱找回密码 | 同「邮件发送」 | | `POST /auth/password/forgot` 返回 `PASSWORD_RESET_NOT_CONFIGURED`，界面提示联系维护者 |

> 只配一个智谱 API Key，就能同时点亮「AI 分类 + 隐私抽象 + AI 生图」三项。

### 免费档 vs 充值档（这份项目当前用的是免费档）

智谱账号里**没有余额**时，只有两个模型能返回真实结果，其余一律 429「余额不足或无可用资源包」：

| 用途 | 免费档可用 | 充值后可用 | 实测 |
| --- | --- | --- | --- |
| 文本（分类 / 抽象） | `glm-4-flash` | `glm-5.3`、`glm-4.6`、`glm-4-plus` | 免费档 HTTP 200，充值档 HTTP 429 |
| 图像（海报底图） | `cogview-3-flash` | `cogview-4-250304` | 免费档 HTTP 200 并返回图片，充值档 HTTP 429 |

所以默认值就取这两个免费可用的模型 —— 只填一把 key 也能真的跑通。
充值之后想换回更强的模型，改两个变量即可（不用改代码）：

```powershell
$env:AI_MODEL    = "glm-5.3"
$env:IMAGE_MODEL = "cogview-4"
```

### 模型退让链：配了 glm-5.3，也不会因为「还没充值」就整站不可用

`AI_MODEL` 只是链上的**第一个**。上游用「额度不足 / 被限流 / 模型已经下线」拒绝时，
服务端会自动退到下一个模型，而不是让「保存后自动分类」整个坏掉：

| 变量 | 含义 | 线上当前值 |
| --- | --- | --- |
| `AI_MODEL` | 主文本模型 | `glm-5.3` |
| `AI_FALLBACK_MODELS` | 备用文本模型（逗号 / 空格分隔，越靠前越优先） | `glm-4-flash` |
| `IMAGE_MODEL` | 主图像模型 | `cogview-4` |
| `IMAGE_FALLBACK_MODELS` | 备用图像模型 | `cogview-3-flash` |

- 链尾会自动补上免费档模型（`glm-4-flash` / `cogview-3-flash`），并且**自动去重**；
  所以只写 `AI_MODEL=glm-5.3` 也是安全的。
- 鉴权失败（401 / 403）**不会**换模型重试 —— 换一个也一样失败，只会把真问题藏起来。
  参数写错（400 且与模型名无关）同理，如实抛错更好查。
- `GET /capabilities` 会回显整条链（`aiModels` / `imageModels`），分类与生图的响应里还会带上
  **实际作答 / 实际出图**的模型名（`model` 字段）：配的是 5.3、跑的是 flash，一眼看得见。
- 因此**充值当天不需要改任何配置**：账号一有余额，下一次调用就直接落在 `glm-5.3` 上。

> 免费档的 CogView 会在图片右下角打「AI 生成」水印。海报在返回前端后会统一裁掉底部一小条、
> 补上品牌紫页脚（星形 + 「念头盒 NianBox」），所以分享出去的海报是干净的、品牌一致的。

---

## 二、接入智谱 GLM（AI 分类 / 隐私抽象）

1. 打开智谱 AI 开放平台 <https://bigmodel.cn>，注册并完成实名认证。
2. 在「API Keys」页面新建一个密钥（形如 `xxxxxxxx.yyyyyyyy`，**只在创建时完整显示一次**）。
3. 在「模型」页面确认你的账号能调用目标模型，把模型名填进 `AI_MODEL`。
   没充值时请填 `glm-4-flash`（默认值就是它）；充值后再改成 `glm-5.3`。

写入 Worker 的三个值：

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | 智谱的 API Key | **唯一必需项** |
| `AI_BASE_URL` | 留空即 `https://open.bigmodel.cn/api/paas/v4` | 只有换服务商才需要填 |
| `AI_MODEL` | 默认 `glm-4-flash` | 账号里叫什么就填什么，写错时接口会把上游原话带回来 |
| `AI_PROVIDER` | 留空自动判断（`zhipu` / `openai`） | 用自建代理、域名认不出来时才需要显式指定 |
| `AI_PROVIDER_LABEL` | 例如 `智谱 AI（GLM）` | 纯展示，会出现在设置页的隐私说明里 |

也就是说：**只填 `AI_API_KEY` 一项就能工作**。地址与模型名会按智谱的默认值补齐；
如果你给了别的 `AI_BASE_URL`，就以你给的地址为准，不会被默认值顶掉。

代码对智谱做了这些适配（不用手动配）：

- 智谱不接受 `temperature: 0`，服务端会自动抬到 `0.01`；
- 先尝试「结构化输出」的完整参数，上游返回 400/422 时自动降级成朴素请求，而不是直接失败；
- 模型返回的 ```json 围栏、前后废话都会被容错解析成 JSON；
- 分类失败**不影响保存**：念头先落库，分类结果后到；用户可以手动改分类或重新分类。

---

## 三、接入 AI 生图（隐私海报底图）

默认复用智谱同一把钥匙（CogView），因此 `AI_API_KEY` 配好后，`/capabilities` 里的 `image` 会直接变成 `true`。

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `IMAGE_BASE_URL` | 留空即跟随 `AI_BASE_URL` | 换图像服务商时才填（OpenAI 兼容接口） |
| `IMAGE_API_KEY` | 留空即复用 `AI_API_KEY` | 例如换成 OpenAI 图像接口时单独填 |
| `IMAGE_MODEL` | 默认 `cogview-3-flash` | 智谱图像模型名（充值后可换成 `cogview-4-250304`） |
| `IMAGE_PROVIDER_LABEL` | 例如 `智谱 CogView` | 展示用 |
| `AI_IMAGE_DAILY_LIMIT` | 默认 `30` | 每个人每天成功生成海报底图的上限（`0` 或负数 = 不限制） |

隐私处理是默认行为，不是选项：

1. 先把念头**抽象**成主题 / 情绪 / 隐喻 / 视觉元素，只把抽象结果发给图像模型；
2. 原始念头正文、个人信息、私人项目名、敏感细节**不会**进入图像模型的请求；
3. 抽象结果会再过一遍隐私检查，判定不安全就**停止生成**并说明原因；
4. 图像优先生成无文字或少文字的图，底部的品牌页脚（星形 + 「念头盒 NianBox」）由**前端**叠加：
   星形取自 `BrandMark` 的同一段 SVG 路径，六种风格收尾一致，同时盖住服务商水印；
5. 生成结果会被服务端下载后转成 `data:` 回传，避免临时链接过期、iOS / 微信跨域取图失败。

配额保护：同一个用户每天成功生成海报的次数有上限（默认 30 次），超出时接口明确拒绝，不会静默烧钱。

---

## 四、接入邮件服务与「找回密码」

只支持「一个 HTTP 接口 + 一个 API Key」的发信服务，不需要 SMTP。四种形状自动识别：

| `MAIL_PROVIDER` | 适用服务 | 请求形状 |
| --- | --- | --- |
| `resend`（默认） | Resend | `POST {MAIL_API_BASE}/emails`，`Authorization: Bearer` |
| `sendgrid` | SendGrid | `POST {MAIL_API_BASE}/v3/mail/send` |
| `mailgun` | Mailgun | `POST {MAIL_API_BASE}/v3/{domain}/messages`，表单编码 |
| `brevo` | Brevo（原 Sendinblue） | `POST {MAIL_API_BASE}/v3/smtp/email`，`api-key` 头 |

### 没有自己的域名？先用 Brevo

Resend 和 SendGrid 都必须先验证**自有域名**才能给任意收件人发信；**Brevo 只要求验证一个发件邮箱**（单发件人认证，免费额度每天 300 封），是还没买域名时唯一能在十分钟内真正点亮「找回密码」的选项。

1. 注册 <https://www.brevo.com>；
2. Senders & IP → Senders → 添加并**点邮件里的链接完成验证**一个发件邮箱；
3. SMTP & API → API Keys → 新建一枚 key；
4. 写入下面三个变量：

| 变量 | 值 |
| --- | --- |
| `MAIL_API_BASE` | `https://api.brevo.com` |
| `MAIL_API_KEY` | Brevo 的 API Key |
| `MAIL_FROM` | 你刚验证过的那个邮箱地址 |
| `MAIL_PROVIDER` | 可留空（看到 `brevo` 域名会自动用 brevo 形状） |

### 既没有域名、也收不到国际短信？用自建中转（信从你自己的邮箱发出）

`MAIL_PROVIDER` 留空、或者填一个不认识的值时，服务端按**最朴素的形状**发信：

```
POST {MAIL_API_BASE}
Authorization: Bearer {MAIL_API_KEY}
{"from":"显示名 <地址>","to":["收件人"],"subject":"...","text":"..."}
```

任何能收下这个 JSON 的 HTTPS 端点都能当邮件后端，包括一个挂在你自己 Google 账号下的 Apps Script：

1. 打开 <https://script.google.com> → 新建项目 → 把下面的脚本贴进去；
2. 把脚本里的 `SECRET` 改成一串你自己的随机字符串（这是防止别人拿这个网址发信的共享口令）；
3. 「部署」→ 新建部署 → 类型选「Web 应用」→ 执行身份「我」→ 访问权限「任何人」→ 部署，
   复制拿到的 `/exec` 网址；
4. 写入这四个变量：

| 变量 | 值 |
| --- | --- |
| `MAIL_API_BASE` | `<那个 /exec 网址>?secret=<你写的 SECRET>` |
| `MAIL_API_KEY` | 随便填一个非空值（形状需要它非空，Apps Script 不校验） |
| `MAIL_FROM` | 你的 Gmail 地址 |
| `MAIL_PROVIDER` | 留空 |

```javascript
// Google Apps Script：把 NianBox 发来的 JSON 用你自己的 Gmail 发出去。
const SECRET = '换成你自己的随机字符串';

function doPost(e) {
  if (e.parameter.secret !== SECRET) throw new Error('forbidden');
  const body = JSON.parse(e.postData.contents);
  MailApp.sendEmail(body.to, body.subject, body.text, {
    from: body.from,
    name: 'NianBox',
    replyTo: body.from,
  });
  return ContentService.createTextOutput(JSON.stringify({ id: 'apps-script' })).setMimeType(
    ContentService.MimeType.JSON,
  );
}
```

> 这条路同样是「上游真的成功才算已发送」，只是上游换成了 Google；免费 Gmail 账号大约每天 100 封。
> 以后买了域名，只要把这四个变量换成 Resend 的三个值，**代码一行都不用改**。

### 有自己的域名：推荐 Resend（对个人开发者最省事，有免费额度）

1. 注册 <https://resend.com> 并创建一个 API Key。
2. 在 Resend 里添加并**验证**一个发信域名（DNS 里加几条记录）。用未验证的域名发信会被上游拒绝。
3. 写入下面三个变量：

| 变量 | 值 |
| --- | --- |
| `MAIL_API_BASE` | `https://api.resend.com` |
| `MAIL_API_KEY` | Resend 的 API Key |
| `MAIL_FROM` | `NianBox <no-reply@你的已验证域名>` |
| `MAIL_PROVIDER` | 留空自动判断（识别到 resend 就用 resend 形状） |

> `MAIL_FROM` 可以写成 `显示名 <地址>` 的形式；也可以把它只写成地址、另外用 `MAIL_FROM_NAME` 指定显示名，两者等价。

配好之后：

- `POST /mail/send` 走服务端真实发信，**只有上游返回成功才算成功**（响应里带 `sent:true` 和邮件 id）；
- `POST /auth/password/forgot` 才会真正发出重置邮件，`/capabilities` 里的 `passwordReset` 变成 `true`；
- 重置令牌只保存**哈希**，一次性使用、有过期时间，用过即失效，改完密码其它设备的登录令牌全部失效。

> ⚠️ 找回密码依赖账号邮箱。如果注册时邮箱写错了（例如把 `gmail.com` 写成 `gmail.cm`），重置邮件永远收不到，任何发信服务都救不了。上线前请先核对一遍账号邮箱。

---

## 五、怎么把值写进去

### 方式 A：本地一条命令（最快，立刻生效）

```powershell
cd niantou-box
$env:CF_API_TOKEN  = "<Cloudflare API Token>"
$env:CF_ACCOUNT_ID = "<账号 ID>"
$env:AI_API_KEY    = "<智谱 API Key>"
# 需要就再加：
# $env:AI_MODEL   = "glm-5.3"
# $env:MAIL_API_BASE = "https://api.resend.com"
# $env:MAIL_API_KEY  = "<Resend API Key>"
# $env:MAIL_FROM     = "NianBox <no-reply@example.com>"
node server/deploy-cloud.mjs
```

脚本是幂等的：会重新上传 Worker、写入你给了值的密钥、保留其它已有密钥，最后自动跑 `/health` 和 `/capabilities` 自检。

### 方式 B：写进 GitHub 仓库 Secrets（让 CI 部署也带上）

仓库 `chenzhe223-tech/niantou-box-app` → Settings → Secrets and variables → Actions → New repository secret，逐个添加：

```
AI_API_KEY / AI_MODEL / AI_BASE_URL / AI_PROVIDER_LABEL
IMAGE_API_KEY / IMAGE_MODEL / IMAGE_BASE_URL / IMAGE_PROVIDER_LABEL
MAIL_API_BASE / MAIL_API_KEY / MAIL_FROM
MAIL_PROVIDER / MAIL_FROM_NAME   （可选）
```

之后每次改动 `server/**` 推送到 `main`，`.github/workflows/deploy-cloud.yml` 会自动重新部署并带上这些密钥。

> 只走方式 A、不写仓库 Secrets 也可以正常工作：CI 部署不会删除 Worker 上已有的密钥。

---

## 六、怎么确认真的生效

```powershell
# 1) 看能力开关（不需要登录，不返回任何密钥）
curl https://nianbox-cloud.chenzhe223.workers.dev/capabilities

# 期望（配好 GLM 之后）：
# {"version":1,"classify":true,"abstract":true,"image":true,
#  "mail":false,"passwordReset":false,
#  "aiProvider":"智谱 AI（GLM）","imageProvider":"智谱 CogView",
#  "aiModel":"glm-4-flash","imageModel":"cogview-3-flash","mailProvider":""}
# 智谱免费档的真实返回：classify / abstract / image 三项都是 true，mail 相关仍是 false。
```

2. 打开应用 → 设置页 → 「你的内容会去哪里」这一段会写出**真实的**服务商与模型名；没配的会写明没配。
3. 登录后随手记一条新念头，等几秒刷新，看它的分类是不是模型给的（不再是本地关键词的结果）。
4. 邮箱找回密码：在登录页点「忘记密码」，填账号邮箱。已配置时会提示已发送；未配置时会明确说服务未配置。
5. 海报：选中一条念头 → 生成灵感海报，能出图 = 图像服务通了；报错会带上游原话，不会给假图。

排障时可以设 `$env:NIANBOX_DEBUG_DETAIL = "1"` 再跑一次部署，它会给 Worker 加上 `DEBUG_DETAIL` 绑定；此后 500 响应会带内部错误摘要和上游原话（**不含**请求正文），定位完把这个变量去掉重新部署即可关闭。

---

## 七、安全边界（保持住这些，别为了省事绕过）

- 密钥只存在于 Worker Secret 和 GitHub Secrets 里，前端拿不到，仓库里搜不到；
- 所有私人数据接口都必须带登录令牌，并且由服务端校验数据归属，用户之间互相隔离；
- 发给模型前允许用户检查内容（分类/抽象/生图都只拿必要的最小信息）；
- 网络失败、超时、重复提交都会被处理，**原始念头不会因为 AI 失败而丢失**；
- 邮件、AI、图像的任何「成功」都必须来自上游的真实回执。
