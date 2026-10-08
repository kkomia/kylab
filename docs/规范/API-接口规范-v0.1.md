# API 接口规范 · v0.1

> 适用：kylab 后端 REST 接口（`/api/v1`）
> 日期：2026-09-11
> 状态：基线
> 由来：计划 T4.9。验收条件是"与 OpenAPI 自动生成结果一致"。

---

## 0. 这份文档与 `/docs` 的分工

后端自己提供 **`/api/v1/docs`**（Swagger UI）与 **`/api/v1/openapi.json`**。
那份是**机器可读的权威 schema**；本文件是**给人读的约定**。

所以这里**只写两类东西**：

1. **OpenAPI 表达不了的约定**——错误信封的形状、请求主体（本机档只有"本机主人"一种，
   见 §1.4）、分页口径、签名 URL 的语义、时间格式。这些是接 API 时真正会踩的坑；
2. **端点清单**（§2）。它由脚本从真实 OpenAPI 抽出并写入，**且有测试核对**——
   手抄一份几十行的路径表必然会漂，所以不让它手抄。

字段级的类型与必填性**不在这里重复**，去 `/docs` 看：重复一遍只会制造两个真相。

---

## 1. 通用约定

### 1.1 版本与前缀

所有接口都在 `/api/v1` 下。**路径即版本**，不做 header 版本协商——
本项目只有一个消费方群体，多一套协商机制只会多一处出错的地方。

### 1.2 时间格式

**一律 ISO 8601 带时区**（`2026-09-11T08:30:00Z`），字段名以 `_at` 结尾。
服务端内部全部按 UTC 存；**只有"按天聚合"这类展示口径才转本地日历日**
（否则 UTC+8 的用户在每天 08:00 之前看到的"今天"会算到前一天去）。

### 1.3 错误信封

所有非 2xx 响应都是同一个形状：

```json
{ "code": "not_found", "message": "文档不存在：doc_abc123" }
```

- `code` 是**稳定的机器可读标识**，程序按它分支，全部取值见下表；
- `message` 是**给人看的中文说明**，可能随版本改进措辞，**程序不要解析它**。

| `code` | 含义 | 典型 HTTP |
|--------|------|-----------|
| `invalid_request` | 参数不合法、状态不允许、逻辑前置不满足 | 422 或 400 |
| `not_found` | 目标不存在 | 404 |
| `conflict` | 与现有状态冲突（键被占、重名、已索引完成） | 409 |
| `unauthorized` | 缺少或令牌无效 | 401 |
| `forbidden` | 身份有效但无权做这件事（含超出密钥的库范围） | 403 |
| `unsupported_content` | 格式或能力不支持（如该文档没有 Markdown 产物） | 422 |
| `payload_too_large` | 上传内容超过限额（切分/压缩再试） | 413 |
| `upstream_error` | 上游（模型、解析服务、被订阅的站点）失败 | 502 |
| `internal_error` | 未预期的服务端错误 | 500 |

**为什么要区分 `conflict` 与 `invalid_request`**：前者是"现在不行、重试或换个名字也许行"，
后者是"这个请求本身就不对"。混成一个码，调用方只能靠猜。

**为什么不用 HTTP 状态码表达一切**：`409` 分不清"这个名字已经被占了"和"这条状态现在不允许这么改"，
而这两种情况的处理方式完全不同。

### 1.4 鉴权：本机档没有账号体系

**这一档不鉴权。** 后端进程只监听 `127.0.0.1`、跑在用户自己的机器上，所以
"能打到这个端口的就是这台机器的主人"——`current_caller` 恒返回同一个 `LOCAL_CALLER`
（`is_admin=True`，名字「本机主人」），**不看 `Authorization`**，也没有登录页可跳
（账号体系、登录会话、API Key、成员与分享都随知识库产品剥离一起删了）。

- 端点签名上的 `require_read` / `require_write` 两道依赖**还在**（它们调
  `ApiKeyService.check_access`，对本机主人直接放行）。留着而不是删掉：
  **"谁有权碰这个库"只有一处定义**才不会漂，哪天真的接进第二个主体，判定不用重写；
- `require_admin` 那一档同样写在签名上（设置、模型注册、插件与技能、沙箱执行、
  工作区浏览/建目录），本机档恒满足；
- 真要限权，手段是"别让进程监听 `0.0.0.0`"——`Settings.host` 默认就是 `127.0.0.1`，
  壳起边车时也不给别的值。

**下载签名密钥**（`KYLAB_URL_SIGNING_SECRET`）与用户凭据无关，但那几条预览/下载端点要它：
**没配时后端回 `503`**（我们这边没配好），不是 `401`——照 `401` 前端会把人往登录页送，
而问题根本不在登录（那一页也已经没有了）。契约与实现见 `backend/app/api/auth.py`
与 `backend/app/core/caller.py`。

> 这一节原先写的是「两种凭据」——登录会话 `kylab_st_…` 加读写/只读 API Key `kylab_sk_…`，
> 外加"名册与账号同表、成员只能见到自己与被分享的知识库"。那一整套不在本仓库里了。

### 1.5 分页

统一用 `limit` + `offset` 查询参数，响应里给**总数**：

```json
{ "items": [...], "total": 137 }
```

- `limit` 有服务端上限（各端点不同，超限返回 `422` 而不是静默截断）——
  静默截断会让调用方以为拿到了全部；
- 列表默认按**最近更新倒序**（哪里不同会在端点说明里写）。

### 1.6 幂等键（上传类接口）

**本机这几条上传端点都不收 `Idempotency-Key`**（笔记配图、会话文件、技能包）——
它们落在本机库与数据目录上，重试就是"同一份文件再写一遍"，没有远端去重的需要。

`Idempotency-Key` 只出现在**知识库提供者的入库调用**上：本机把新建文档的 id 当这个头
发给 NAS（见 §1.12），那边怎么处理"重放 / 键同体不同"由对端的口径定，不在本文件里。

> 这一节原先写的是 `POST /knowledge-bases/{kb_id}/documents` 的四种结果
> （首次 / 重放 / 键同体不同 / 处理中）——那条端点不在本仓库里。

### 1.7 签名下载 URL

会话文件区与笔记配图的链接**短期有效**（会话文件默认 600 秒），
签名是**无状态 HMAC-SHA256**：

```
GET /conversations/{id}/files/download-url?key=<文件区 key>[&disposition=inline]
→ { "url": "/api/v1/conversations/{id}/files/content?key=…&expires=…&signature=…",
    "expires_at": …, "name": "…" }
```

（笔记配图不走这一步：上传图片时直接返回已带签名的 `url`，
形如 `/api/v1/notes/{note_id}/images/{name}?expires=…&signature=…`。）

- 返回的是**相对路径**：对外域名只有部署时才知道，服务端不猜；
- `files/content` 与配图那两个端点**刻意不挂鉴权依赖**（浏览器里 `<img>` 与下载链
  带不了 `Authorization`）——授权凭据就是 URL 里的签名，所以**签名比过期先校验**；
- 签名绑的是"哪条会话的哪份文件"（配图绑"哪条笔记的哪张图"）：key 里可能带斜杠
  （工作区相对路径），拼进资源标识前要转义——不转的话 `a/b` 与 `a:b` 会撞成同一个标识，
  一条签名能换到另一份文件；
- `disposition=inline` 只影响响应头、**不参与签名**：它不是权限参数，
  能不能真的内联渲染由协议层按后缀白名单（pdf / 图片那几档）复核；
- **没有签名密钥时后端拒绝签发**（`503`），而不是发一条无效链接——
  后者会让用户以为是网络问题。

### 1.8 对话：流式是默认

`POST /chat/stream` 返回 `text/event-stream`，每行一个 JSON：

```
data: {"type":"sources","items":[…]}   # 先给依据，再给回答
data: {"type":"delta","text":"向"}      # 逐块增量
data: {"type":"done","answer":"…"}      # 收尾（含拼好的全文，便于兜底）
data: {"type":"error","message":"…"}    # 任何失败都在流内报
```

**失败必须走流内事件，不能靠 HTTP 状态码**：流一旦开始发送，状态码已经发出去了。
非流式的 `POST /chat` 逻辑完全相同，给脚本与 MCP 用。

**事件带 `seq`，一轮不跟着连接走**（P2-2）：`seq` 就是这条会话事件日志里的编号
（`GET /conversations/{id}/events` 的同一个 `seq`）。带 `conversation_id` 的一轮跑在
后台任务里，**客户端断开不取消它**（取消只有 `/stop` 一条路）；断线回来用
`GET /chat/turns/{conversation_id}/live?after=<最后收到的 seq>` 补发没看到的事件并接着流，
那一轮已经跑完时，补发完会给一条带 `recovered` 与说明的 `done`（里面是完整答复）。
不带 `conversation_id` 的调用没有可补发的地方，事件里不带 `seq`，仍然是断开即结束。

### 1.9 对话分叉：「从这里重开」（D11）

`POST /conversations/{id}/branch` 以**第 N 轮**为界，把到那一轮为止的历史**复制**进一条
**新会话**，然后在它里面继续。请求体 `{"turn": N}`，`N` 是**第几个提问**（1 起数）；
越界（`0` / 超过总轮数）返回 `422`，不夹到边界——静默夹过去会让调用方以为分叉点就是
他点的那一处。原会话**一个字节都不动**（两条可以分别继续，也可以各自再分叉）。

**带走的**：消息（含出处 / 步骤 / 思考快照）与它的事件日志（`seq` 是新会话自己的）、
知识库范围 / 模型 / 思考偏好 / 工作区，以及**归属**（新会话归源会话的主人）；
压缩摘要**只有它的覆盖标记落在这段历史里**才带（标记在 cut 之外说明那份摘要讲的是
后面那些轮次）。

**不带走文件区**（一条用户能感知到的边界，务必照实说）：

- 产物记录与对象存储里的字节都不搬 → **分叉出来的会话历史正文在、文件区是空的**；
- 因此用户消息上的**附件片也不会出现**——那份 key 指向源会话的记账，抄过去点开必然
  404；而让两条会话共享同一个对象 key 更糟：删掉源会话会把分叉的文件一起带走，
  "两条真的独立"就不成立了。

新会话的标题是 `源标题（分支 · 第 N 轮）`；再分叉时标记换成**新的那一处**（不一路接下去）。

### 1.10 工作区按设备隔离：`X-Kylab-Device`

桌面壳在**每一条** `/api/**` 请求上注入两个头（网页版与直连 API 不带）：

| 头 | 必填 | 说明 |
|----|------|------|
| `X-Kylab-Device` | 否 | 这台电脑的标识（壳生成的 UUID v4，见 `config.json` 的 `device_id`）。**判定只认它** |
| `X-Kylab-Device-Name` | 否 | 设备名（主机名）。只给人看，**不参与判等** |

带头的调用方**只看得到、也只能操作** `device_id` 等于该值的工作区；不带头看到的是
`device_id IS NULL` 的那批——语义是**服务器端**（`root_path` 在服务器的盘上），
不是"没有归属"。**设备不匹配与越权、不存在一样回 `404`**（`404` 是三者共用的答案，
能区分就等于承认"这个 id 存在"）。

例外只有一个，且在列表上：**`GET /workspaces?device=all`** 返回**全部设备**的工作区，
供跨机清理用。它**只对管理员开放**——非管理员传 `all` 回 `422` 并如实说明这一口径
（不是 `404`：这不是"有没有"的问题，是一条明确的权限线）；`device` 传其它值也回 `422`
（静默忽略会让"我明明传了却没按它过滤"变成一个要查很久的现象）。

**只有工作区按设备隔离**：会话、知识库、文档这些仍只按账号归属判定
（同一条会话在哪台机器上打开都是同一条）。改工作区时 `device_id` **不可改**——
换机器请在新机器上新建，因为 `root_path` 是那台机器上的路径。

### 1.11 会话导出：`GET /conversations/export`（NDJSON）

桌面端把旧会话导进本机库时用的一条**行格式**接口（M2「会话落本机」§3.1）。
本机**不直连服务器数据库**，所以要有这一条：它导出的是一份**自包含、有版本号**的流。

- **响应**：`200 application/x-ndjson`，一行一个 JSON 对象，边读边发（流式）；
- **六型信封**：首行 `header` → 每会话 `conversation` + 若干 `message` / `event` /
  `artifact` → 末行 `footer`；
- **`data` 块是库列原样**（时间列是 UTC 毫秒整数，会话那一块含不在别的 API 里的
  `context_summary` / `summary_upto`）——它是搬运用的机器契约，**没有** ISO 时间那一层；
- **`footer` 在不在 = 这一页完整不完整**：连接被掐断时流会停在半路，读的人按"没见到
  末行"当失败处理；
- **`export_version`** 是唯一的兼容判据：读的一方不认识某个版本**当场拒绝**，
  不猜着读；
- **分页**：`limit`（一页最多几条会话）/ `offset`（跳过几条）是**按扫过的会话数**算的
  游标；`since` 只导**严格晚于**该时刻更新过的（增量导入用）；
- **归属**：与列表同一个判据——成员只导自己的，管理员/本机主人导自己可见的全部；
  **归档的会话也导**（归档不是删除）；
- **文件本体不在这份流里**：产物与附件只给记录与 `location`（NAS 上的 key），
  字节不搬（体积不可控，且与"工作区文件永不上传"对称）。

线格式的完整说明（每一块的字段与取舍）在 `backend/app/services/conversation_export.py`
的模块头。

### 1.12 知识库提供者握手：`GET /provider/handshake`（M3）

> **这一族端点在对端（NAS）那边，不在本仓库的 `/api/v1` 里**——§2 的清单是从本仓库的
> OpenAPI 抽的，所以那里面没有它。本机是它的**客户端**；本机自己的那条状态端点见 §2 的
> `local` 组（`GET|PATCH /local/provider`）。下面记的是客户端要遵守的对端口径。

桌面端（"本机后端"）把 NAS 当**知识库提供者**用，这一条是它开机后的第一句话：
一次调用回答"凭据有效吗、这台提供者能做什么、我能用哪些库"。窄 API 就是这一族
既有的知识库端点（检索 / 入库 / 进度 / 库管理），**只新增了这一个**。

- **鉴权**：登录会话或 API Key 都行（它只要只读）。配置与凭据都不进响应体——
  **凭据错是 `401` / `403`（去改钥匙），连不上是超时 / 连接被拒（去改地址）**；
  客户端必须把这两档分开说，混成一句"连不上"会让人白跑一趟；
- **`protocol_version` 是整数且只增**：当前是 `1`。客户端规则——**不认识（大于本机
  所知）即判不可用**，原因句子里带版本号，**绝不硬试**（拿新协议当旧协议发请求，
  会把语义错误显示成网络故障）；
- **`capabilities`** 报的是"这台机器现在能做什么"（不是"代码支持什么"）：
  `embedding.configured` 为假时仍能上传、只是检索拿不到向量通道；
  `ingest.max_bytes` 与 `ingest.extensions` 是**界面该照抄的那一份**
  （上传上限与格式提示不再各写一处）；
- **`caller`**：同一台 NAS 上**两套身份是事实**（页面用会话、本机后端用钥匙）。
  那把长期 API Key **不是管理员**（`is_admin=false`），拿不到 `/settings`、
  `/api-keys`、`/users`、`/trash`、`/maintenance`、`/sandbox` 那一族（`403`）——
  界面据此隐藏这类入口；
- **`knowledge_bases`** 只含**这次调用看得见**的库（受限密钥只看到范围内的），
  每项的 `can_write` 与 `GET /knowledge-bases` 同一个判据。

### 1.13 备份快照：`/backup/*` 是 append-only 的（M5）

> **同样是对端（NAS）那边的端点**，不在本仓库的 `/api/v1` 里；本机自己的备份端点
> （状态 / 队列 / 恢复点 / 恢复 / 立刻打一份）见 §2 的 `local` 组。

桌面端把 NAS 当**备份提供者**用：快照由 NAS 收下、落在它自己的对象存储里
（**客户端永不接触 S3 凭据**——那条路要求把整个桶的钥匙下发到每台机器）。握手是
`GET /backup/handshake`，与知识库那条是**两个提供者、两个协议版本**（都是整数且只增，
客户端分开判；不认识即判不可用）。这一族只有七条端点，语义是这样的：

| 端点 | 语义 |
|------|------|
| `GET /backup/handshake` | 一次给全：能力集 + **这台提供者看得见的全部设备** + 额度（配了多少、用了多少） |
| `GET /backup/snapshots` | 恢复点清单（最近在前，`device_id` / `limit` / `offset` 过滤，回 `total` 与 `quota`） |
| `PUT …/{device_id}/{snapshot_id}/blob` | 上传快照体（`octet-stream`），**先传** |
| `PUT …/{device_id}/{snapshot_id}/manifest` | 上传清单（JSON），**后传**——它是"这一份传完了"的标记 |
| `GET …/{device_id}/{snapshot_id}` | 取清单原文 |
| `GET …/{device_id}/{snapshot_id}/blob` | 流式下载（带 `Content-Length` 与 `X-Kylab-Sha256`） |
| `DELETE …/{device_id}/{snapshot_id}` | 删**一个恢复点**（快照体 + 清单一起），回 `{"removed": n}` |

**append-only 的四条硬规矩**（这一族的全部要点）：

1. **不覆盖**。路径就是幂等键，不需要 `Idempotency-Key`（本机这些上传端点都不收，见 §1.6）：
   同路径 + 同内容 → **200**（幂等 no-op，桶里那份不动）；同路径 + **不同内容 → 409**，
   永不覆盖。判定靠上传时写进对象元数据的 sha256——**没有那一栏的对象（别人手工放的）
   一律当"内容不同"**，宁可 409。
2. **只能整份删**。删除的粒度是"一个恢复点"：两个对象一起走，返回实际删掉的个数
   （只有半截上传时是 1）。没有"删某个对象"的入口；什么都没删到回 **404**。
3. **枚举只认有 `manifest` 的**。上传中断留下的孤儿 blob **留在桶里不删**（append-only），
   但**不列、不算进额度、页面上也看不见**——它谁也恢复不了。这条同时满足
   "只增不改"与"完整才可见"。
4. **服务端绝不替用户删**。保留份数（默认 30/设备）或配额（默认 20 GiB）超限时回 **409**
   并说清数字，**不静默淘汰最旧的一份**——静默淘汰最坏的地方不是丢数据，是用户不知道丢了。

**上传的三档拒收**（都要"不落桶"）：

| 情况 | 结果 |
|------|------|
| 声明或实收的字节数超上限（默认 2 GiB） | `413 payload_too_large` |
| `?sha256=` / `?bytes=` 与**实收**不符 | `400 invalid_request`（服务端边收边算，算完才落桶） |
| 同路径内容不同 / 超保留份数 / 超配额 | `409 conflict` |

清单 PUT 另有两条：**快照体必须已经在桶里**（否则 409——先传大件后传标记），
以及清单里的 `device_id` / `snapshot_id` 必须对得上路径（否则 400）。

**边界（如实写在这里）**：

- **可见范围 = 这把钥匙能看见的全部设备**。备份不建 ACL：谁拿着这把钥匙，谁就看得见
  （也能删）所有设备的恢复点。登记为"将来要按设备限权"的一条；
- **受限只读密钥能下载、不能上传 / 删除**（写操作是 `403`）；
- 握手不受"有没有配知识库"影响（两个提供者可以指向不同 NAS，所以是两条握手）；
- 快照**不做应用层加密**：`encryption` 是自描述字段（当前恒为 `none`），
  防的是"秘密进包"——凭据类内容在打包时就排除，这是另一侧（客户端）的责任。

### 1.14 技能列表的分类与精选：`GET /skills`（v0.61）

每条技能多了 `category` / `featured` 两位，响应顶层多了一份 `categories`——
**只增不改**：不读它们的客户端照旧跑（`items` / `usable` 的语义一位没动），
字段级类型见 `/docs`，这里只写机器读不出来的那几条口径。

- `category` 是**算出来的**，不是技能自己声明的：`SKILL.md` 没有分类字段
  （第三方的 `tags:` 我们也不认），取值来自一套可复现的加权信号，
  与页面那份离线映射同源（`services/skill_categories.py`）；
- `categories[]` 是 `{slug, label, total, featured[]}`，**顺序就是界面分组顺序**；
  `total` 是**全库**该类的条数（与 `usable` 同一口径，不是这一页的）；
  `featured` 是每类默认展示的技能名（每类最多 2 条，某类不够就有几条给几条）；
- **精选只从"能用"的里挑**：被安全扫描拦下、依赖没满足、被用户关掉、被丢弃的都不参选；
- **精选是全库口径**：翻到第 3 页时那两条标记仍然标在它们自己身上——
  精选是技能的一个属性，不随分页变；
- **分类与精选都不进提示词目录**：模型的技能目录仍是"常驻名单 + 按名字兜底"的
  60 条 / 2 万字符预算，界面这一层怎么改都不动它。

---

## 2. 端点清单（由 OpenAPI 生成，有测试核对）

共 **130** 条端点。

### `conversations`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/conversations` | 会话列表（置顶优先，其次最近更新） |
| `POST` | `/api/v1/conversations` | 新建会话 |
| `GET` | `/api/v1/conversations/export` | 导出会话（NDJSON 流；给本机导入器用） |
| `DELETE` | `/api/v1/conversations/{conversation_id}` | 删除会话（连同全部消息） |
| `GET` | `/api/v1/conversations/{conversation_id}` | 会话详情 |
| `PATCH` | `/api/v1/conversations/{conversation_id}` | 修改会话（标题 / 置顶） |
| `GET` | `/api/v1/conversations/{conversation_id}/artifacts` | 这条会话产出的文件 |
| `POST` | `/api/v1/conversations/{conversation_id}/artifacts/{artifact_id}/ingest` | 把一份产物存进知识库（显式动作） |
| `POST` | `/api/v1/conversations/{conversation_id}/branch` | 从第 N 轮分叉出一条新会话（「从这里重开」） |
| `GET` | `/api/v1/conversations/{conversation_id}/files` | 这条会话的文件区（会话文件 / 项目目录） |
| `POST` | `/api/v1/conversations/{conversation_id}/files` | 往文件区里放一份文件 |
| `GET` | `/api/v1/conversations/{conversation_id}/files/content` | 按签名取文件内容（预览 / 下载共用） |
| `GET` | `/api/v1/conversations/{conversation_id}/files/download-url` | 签发文件链接（预览 / 下载共用） |
| `POST` | `/api/v1/conversations/{conversation_id}/files/import` | 把项目目录里的一份文件取进本会话 |
| `POST` | `/api/v1/conversations/{conversation_id}/rewind` | 回退最近 N 轮问答（「重新生成」用） |

### `health`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/health` | 服务存活探针 |

### `local`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/chat/commands` | 可用命令（内置 + 自定义 + 技能，被遮蔽的也在里面） |
| `GET` | `/api/v1/chat/context-usage` | 上下文用量（按来源分解，估算） |
| `GET` | `/api/v1/conversations/{conversation_id}/events` | 会话事件日志（只追加，按 seq 正序） |
| `GET` | `/api/v1/local/backup` | 备份：提供者状态 + 待传队列 + 最近几份（连不上也要给本机那一半） |
| `PATCH` | `/api/v1/local/backup` | 改备份提供者的地址 / 开关 / 含工作区 / 自动间隔（白名单四键，写完立刻重探） |
| `GET` | `/api/v1/local/backup/points` | 恢复点清单（透传 NAS；连不上就如实回三态，不是 500） |
| `DELETE` | `/api/v1/local/backup/points/{device_id}/{snapshot_id}` | 删一个恢复点（整份；服务端本来就没有 → 404 如实回） |
| `POST` | `/api/v1/local/backup/restore` | 按点恢复：从一份快照重建本机（dry_run=true 只预演，同步回报告） |
| `POST` | `/api/v1/local/backup/snapshots` | 立刻打一份快照并入队（断网也能打：202 + 队列一行 + 原因） |
| `POST` | `/api/v1/local/import` | 导入 NAS 上的旧会话（后台跑，返回批次 id 供轮询） |
| `GET` | `/api/v1/local/import/{batch_id}` | 导入进度（轮询） |
| `POST` | `/api/v1/local/import/{batch_id}/rollback` | 回滚一个导入批次（删新建的 / 用快照恢复被替换的 / 本机改过的保留） |
| `DELETE` | `/api/v1/local/kb-cache` | 清掉本机留的快照（全清 / 按地址 / 按库） |
| `GET` | `/api/v1/local/kb-cache/documents/{document_id}` | 快照：文档条目 |
| `GET` | `/api/v1/local/kb-cache/knowledge-bases` | 快照：库列表（页面先画一帧用） |
| `GET` | `/api/v1/local/kb-cache/knowledge-bases/{kb_id}` | 快照：库详情 |
| `GET` | `/api/v1/local/kb-cache/knowledge-bases/{kb_id}/documents` | 快照：文档列表（只认规范视图） |
| `GET` | `/api/v1/local/kb-cache/knowledge-bases/{kb_id}/folders` | 快照：库内目录 |
| `POST` | `/api/v1/local/kb-cache/revalidate` | 再确认一份快照（焦点回来 / 「立即刷新」） |
| `GET` | `/api/v1/local/kb-cache/stats` | 本机留的那一份有多大 / 最近更新（设置面板读它） |
| `GET` | `/api/v1/local/provider` | 知识库提供者状态（三态 + 原因 + 能力集 + 库清单） |
| `PATCH` | `/api/v1/local/provider` | 改知识库提供者的地址 / 开关（白名单两键，写完立刻重探） |
| `GET` | `/api/v1/local/secrets` | 钥匙串：可用性与还有几处明文（只报数，不回显任何秘密） |
| `POST` | `/api/v1/local/secrets/migrate` | 把库里的旧明文凭据收进系统钥匙串（逐项、幂等、可重跑） |
| `GET` | `/api/v1/local/status` | 本机档状态（库在哪、接的是谁） |
| `GET` | `/api/v1/stats/usage` | 用量（本机 usage_events：token 与调用量，不含钱） |

### `mcp`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/mcp-servers` | MCP 服务列表 |
| `POST` | `/api/v1/mcp-servers` | 登记一个 MCP 服务 |
| `GET` | `/api/v1/mcp-servers/tools` | 所有已登记服务的工具 |
| `DELETE` | `/api/v1/mcp-servers/{server_id}` | 删除 MCP 服务 |
| `GET` | `/api/v1/mcp-servers/{server_id}` | 单个 MCP 服务 |
| `PATCH` | `/api/v1/mcp-servers/{server_id}` | 改 MCP 服务 |
| `POST` | `/api/v1/mcp-servers/{server_id}/call` | 调用一个外部工具 |
| `POST` | `/api/v1/mcp-servers/{server_id}/probe` | 测试连接并发现工具 |

### `memory`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/memory` | 记忆状态与文件列表 |
| `GET` | `/api/v1/memory/archive` | 档案卡（分区、条目、读数） |
| `GET` | `/api/v1/memory/changes` | 变更流（倒序） |
| `POST` | `/api/v1/memory/draft/organize` | 整理迁移草稿（一次模型调用，只给建议） |
| `GET` | `/api/v1/memory/files/{path}` | 读一个记忆文件 |
| `POST` | `/api/v1/memory/forget` | 忘掉一条 |
| `POST` | `/api/v1/memory/group` | 项目组改名 |
| `POST` | `/api/v1/memory/migrate` | 折叠旧记忆（零模型调用） |
| `POST` | `/api/v1/memory/recall` | 在档案的变更流里查证 |
| `POST` | `/api/v1/memory/remember` | 记一条（新增或顶替） |
| `POST` | `/api/v1/memory/restore` | 还原一条旧值 |

### `model-registry`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/model-registry` | 注册器总览（供应商 + 模型 + 用途） |
| `GET` | `/api/v1/model-registry/models` | 模型列表 |
| `POST` | `/api/v1/model-registry/models` | 登记模型 |
| `DELETE` | `/api/v1/model-registry/models/{model_pk}` | 删除模型 |
| `PATCH` | `/api/v1/model-registry/models/{model_pk}` | 修改模型 |
| `GET` | `/api/v1/model-registry/providers` | 供应商列表 |
| `POST` | `/api/v1/model-registry/providers` | 新建供应商 |
| `DELETE` | `/api/v1/model-registry/providers/{provider_id}` | 删除供应商（连同其模型） |
| `PATCH` | `/api/v1/model-registry/providers/{provider_id}` | 修改供应商 |
| `GET` | `/api/v1/model-registry/providers/{provider_id}/available-models` | 拉取供应商可用的模型列表（探测，不落库） |
| `POST` | `/api/v1/model-registry/providers/{provider_id}/test` | 测试供应商的地址与凭据是否可用 |
| `GET` | `/api/v1/model-registry/slots` | 用途（任务槽位）状态 |
| `PUT` | `/api/v1/model-registry/slots/{slot}` | 绑定 / 解绑用途 |
| `POST` | `/api/v1/model-registry/slots/{slot}/test` | 测试该用途的模型是否可用 |

### `notes`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/notes` | 笔记列表（置顶优先，其次最近更新） |
| `POST` | `/api/v1/notes` | 新建笔记 |
| `GET` | `/api/v1/notes/folders` | 文件夹列表（含每个文件夹的笔记数） |
| `POST` | `/api/v1/notes/folders` | 新建文件夹 |
| `DELETE` | `/api/v1/notes/folders/{folder_id}` | 删除文件夹（子文件夹一起删，里面的笔记回到未归档） |
| `PATCH` | `/api/v1/notes/folders/{folder_id}` | 重命名文件夹 |
| `PATCH` | `/api/v1/notes/folders/{folder_id}/parent` | 移动文件夹（换父级） |
| `GET` | `/api/v1/notes/tags` | 用过的标签与条数 |
| `DELETE` | `/api/v1/notes/{note_id}` | 删除笔记 |
| `GET` | `/api/v1/notes/{note_id}` | 笔记详情 |
| `PATCH` | `/api/v1/notes/{note_id}` | 更新笔记 |
| `POST` | `/api/v1/notes/{note_id}/ai` | 用对话模型排版 / 润色笔记 |
| `POST` | `/api/v1/notes/{note_id}/attach` | 把笔记加入知识库 |
| `PATCH` | `/api/v1/notes/{note_id}/folder` | 把笔记移进文件夹 / 移回未归档 |
| `POST` | `/api/v1/notes/{note_id}/images` | 上传笔记配图 |
| `GET` | `/api/v1/notes/{note_id}/images/{name}` | 读取笔记配图 |

### `plugins`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/plugins` | 插件列表 |
| `POST` | `/api/v1/plugins/{plugin_id}/disable` | 停用一个插件 |
| `POST` | `/api/v1/plugins/{plugin_id}/enable` | 启用一个插件 |

### `sandbox`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/sandbox` | 这台机器上的隔离能力 |
| `POST` | `/api/v1/sandbox/plan` | 看这条命令会被怎么隔离 |

### `scheduled-tasks`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/scheduled-tasks` | 定时任务列表 |
| `POST` | `/api/v1/scheduled-tasks` | 新建定时任务 |
| `DELETE` | `/api/v1/scheduled-tasks/{scheduled_id}` | 删定时任务 |
| `PATCH` | `/api/v1/scheduled-tasks/{scheduled_id}` | 改定时任务 |
| `POST` | `/api/v1/scheduled-tasks/{scheduled_id}/run` | 立即跑一次 |

### `settings`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/settings` | 运行期配置（密钥打码） |
| `PATCH` | `/api/v1/settings` | 更新运行期配置 |
| `POST` | `/api/v1/settings/test/{target}` | 连通性测试（embedding / mineru / paddleocr） |

### `site-icons`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/site-icons` | 站点图标（本机缓存；任意合法域名，取不到回 404 由前端退字牌 / 地球） |

### `skills`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/skills` | 技能列表 |
| `POST` | `/api/v1/skills/market` | 浏览一个源的技能索引 |
| `POST` | `/api/v1/skills/market/browse` | 浏览一个源里的技能 |
| `POST` | `/api/v1/skills/market/inspect` | 看一个技能的文件清单 |
| `POST` | `/api/v1/skills/market/install` | 安装一个技能 |
| `POST` | `/api/v1/skills/market/install-source` | 从线上源安装一个技能 |
| `GET` | `/api/v1/skills/market/installed` | 已从市场装的技能 |
| `DELETE` | `/api/v1/skills/market/installed/{name}` | 卸载一个技能 |
| `GET` | `/api/v1/skills/market/sources` | 技能源列表 |
| `POST` | `/api/v1/skills/market/sources` | 添加一个技能源 |
| `DELETE` | `/api/v1/skills/market/sources/{source_id}` | 删除一个自定义源 |
| `PATCH` | `/api/v1/skills/market/sources/{source_id}` | 启用 / 停用一个源 |
| `POST` | `/api/v1/skills/market/upload` | 上传一个技能（文件夹或压缩包） |
| `GET` | `/api/v1/skills/{name}` | 技能详情（含正文） |
| `PUT` | `/api/v1/skills/{name}/enabled` | 开/关一条技能 |

### `web`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/web/embed-check` | 这一页能不能嵌进 iframe（探一次响应头；连不上按不能嵌回，不报错） |
| `GET` | `/api/v1/web/page` | 取一个网页的正文（本机代取；内网 / 本机地址一律拒） |

### `workspaces`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/workspaces` | 工作区列表 |
| `POST` | `/api/v1/workspaces` | 新建工作区（指定根目录） |
| `GET` | `/api/v1/workspaces/browse` | 浏览服务器上的目录（选工作区根目录用） |
| `PATCH` | `/api/v1/workspaces/dirs` | 给服务器上的目录改名（选工作区时用） |
| `POST` | `/api/v1/workspaces/dirs` | 在服务器上新建一个目录（选工作区时用） |
| `DELETE` | `/api/v1/workspaces/{workspace_id}` | 删除工作区（里面的会话退回未归档） |
| `GET` | `/api/v1/workspaces/{workspace_id}` | 工作区详情 |
| `PATCH` | `/api/v1/workspaces/{workspace_id}` | 改工作区 |

---

## 3. 不改动的部分去哪看

- **字段类型 / 必填 / 枚举取值**：`/api/v1/openapi.json`（或 `/docs`）；
- **领域概念与设计取舍**：《架构设计 v0.2》；
- **MCP 工具**（与 REST 一一对应、共用服务层）：`skills/kylab-knowledge-base/SKILL.md`。

## 4. 变更纪律

- **接口变更必须同步本文件的 §1 约定与 §2 清单**（§2 由脚本生成，跑一次即可）；
- **已发布的约定不原地改**：错误信封、请求主体与鉴权档位、幂等语义这类东西一旦有人依赖，
  改动要按工程规范 §2.1 升版本，而不是悄悄改；
- 新增端点会自动出现在 §2——但**新增"约定"（头、语义、状态码含义）必须手写进来**，
  那是机器读不出来的部分。
