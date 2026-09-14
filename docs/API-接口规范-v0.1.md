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

1. **OpenAPI 表达不了的约定**——错误信封的形状、鉴权与凭据、分页口径、
   幂等键的四种结果、签名 URL 的语义、时间格式。这些是接 API 时真正会踩的坑；
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

**为什么不用 HTTP 状态码表达一切**：`409` 分不清"幂等键被占"和"同供应商下模型重名"，
而这两种情况的处理方式完全不同。

### 1.4 鉴权：两种凭据

**鉴权永远生效，没有开关**。第一次打开时只有 `GET /auth/status` 与
`POST /auth/setup` 可用——先建管理员账号（首个账号即管理员），
在此之前任何业务请求都是 `401`。

| 凭据 | 令牌形式 | 给谁用 | 能做什么 |
|------|---------|--------|---------|
| **登录会话** | `kylab_st_…` | Web 控制台 | 全部业务；`role=admin` 还能读写 `/settings`、`/api-keys`、模型凭据与用户管理 |
| **读写密钥** | `kylab_sk_…` | 外部程序 | 读写内容（建库、上传、删文档、拉数据源），**但碰不到服务端凭据** |
| **只读密钥** | `kylab_sk_…` | 外部程序 | 只读；所有写操作返回 `403` |

**为什么"管理员"不能由 API Key 兼任**：设置页是 embedding / LLM 密钥的落点，
而 `base_url` 可改——给了外部 API Key 就等于给它一条"把你的凭据转发到我的服务器"的路。
所以管理员身份只能来自登录会话里的 `role`，不能来自密钥。

四条纪律：

1. **凭据永不出接口**。密钥相关的响应只给"配没配"与掩码尾巴（`sk-…ec6`），
   任何情况下不回明文。明文**只在创建 API Key 的那一次响应里出现**。
2. **只存哈希**：API Key 存 SHA-256，登录会话令牌同样只存哈希，明文都不落库。
3. **只读与读写密钥都能限定知识库范围**（`knowledge_base_ids`）——
   越权的请求返回 `403`，而不是"空的检索结果"。
4. **成员只能见到自己的与被分享的知识库**，且"看得见"与"写得动"是两次判定：
   只读档分享的写操作返回 `403`；不属于自己的会话按不存在处理（`404`），
   以免"是否存在"本身被当成信息。

> **名册与账号同表。** `/users` 里没有 `username` 的条目只是"归属标注"，
> 不能登录；账号由管理员开通，本产品**不开放注册**。

### 1.5 分页

统一用 `limit` + `offset` 查询参数，响应里给**总数**：

```json
{ "items": [...], "total": 137 }
```

- `limit` 有服务端上限（各端点不同，超限返回 `422` 而不是静默截断）——
  静默截断会让调用方以为拿到了全部；
- 列表默认按**最近更新倒序**（哪里不同会在端点说明里写）。

### 1.6 幂等键（上传类接口）

`POST /knowledge-bases/{kb_id}/documents` 接受可选的 **`Idempotency-Key`** 请求头。
**可选**是刻意的：上传本来就按内容 hash 去重，幂等键解决的是"客户端重试"这一小类场景，
不该为了它给所有调用方增加负担。

四种结果，务必分清：

| 情况 | 结果 |
|------|------|
| 首次使用该键 | 正常处理 |
| 重放（键相同、请求体也相同） | 返回**上次的响应**（不是重新处理） |
| 键相同但请求体不同 | `409`——`409` 分不清"幂等键被占"和"同供应商下模型重名"，所以要看 `code` |
| 键相同、上次还在处理中 | `409`（不是 `500`，也不是空响应） |

键保留 24 小时，由后台空闲维护清理。

### 1.7 签名下载 URL

原文与解析产物的下载链接**短期有效**（默认 600 秒），签名是**无状态 HMAC-SHA256**：

```
GET /documents/{id}/download-url?format=original|markdown
→ { "url": "/api/v1/documents/{id}/content?format=…&expires=…&signature=…" }
```

- 返回的是**相对路径**：对外域名只有部署时才知道，服务端不猜；
- `content` 端点是**不鉴权的**（浏览器打开 PDF 时不会带自定义头）——
  安全性由签名 + 过期时间承担，所以签名比过期先校验；
- **没有签名密钥时后端拒绝签发**，而不是发一条无效链接——
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

---

## 2. 端点清单（由 OpenAPI 生成，有测试核对）

共 **114** 条端点。

### `api-keys`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/api-keys` | API Key 列表 |
| `POST` | `/api/v1/api-keys` | 创建 API Key（明文只在此响应出现） |
| `DELETE` | `/api/v1/api-keys/{key_id}` | 撤销 API Key |

### `auth`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/auth/login` | 登录（用户名 + 密码） |
| `POST` | `/api/v1/auth/logout` | 退出登录（吊销当前会话） |
| `GET` | `/api/v1/auth/me` | 当前登录账号 |
| `POST` | `/api/v1/auth/password` | 修改自己的密码 |
| `POST` | `/api/v1/auth/setup` | 首次初始化：创建管理员账号 |
| `GET` | `/api/v1/auth/status` | 认证状态（是否需初始化） |

### `chat`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/chat` | 快速检索问答（一次性） |
| `POST` | `/api/v1/chat/stream` | 快速检索问答（流式） |
| `GET` | `/api/v1/chat/suggested-questions` | 推荐问题（取自入库时为各分段生成的问题） |

### `chunks`

| 方法 | 路径 | 说明 |
|------|------|------|
| `DELETE` | `/api/v1/chunks/{chunk_id}` | 删除切块（连同索引与向量） |
| `GET` | `/api/v1/chunks/{chunk_id}` | 切块详情 |
| `PATCH` | `/api/v1/chunks/{chunk_id}` | 修改切块正文（会重新向量化） |
| `PUT` | `/api/v1/chunks/{chunk_id}/disabled` | 禁用 / 恢复切块 |
| `DELETE` | `/api/v1/documents/{document_id}/chunks/by-ordinal/{ordinal}` | 按文档与序号删除切块 |
| `GET` | `/api/v1/documents/{document_id}/chunks/by-ordinal/{ordinal}` | 按文档与序号取切块（推荐：URL 安全） |
| `PATCH` | `/api/v1/documents/{document_id}/chunks/by-ordinal/{ordinal}` | 按文档与序号改正文 |
| `PUT` | `/api/v1/documents/{document_id}/chunks/by-ordinal/{ordinal}/disabled` | 按文档与序号禁用 / 恢复 |

### `conversations`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/conversations` | 会话列表（置顶优先，其次最近更新） |
| `POST` | `/api/v1/conversations` | 新建会话 |
| `DELETE` | `/api/v1/conversations/{conversation_id}` | 删除会话（连同全部消息） |
| `GET` | `/api/v1/conversations/{conversation_id}` | 会话详情 |
| `PATCH` | `/api/v1/conversations/{conversation_id}` | 修改会话（标题 / 置顶） |
| `POST` | `/api/v1/conversations/{conversation_id}/rewind` | 回退最近 N 轮问答（「重新生成」用） |

### `data-sources`

| 方法 | 路径 | 说明 |
|------|------|------|
| `DELETE` | `/api/v1/data-sources/{source_id}` | 删除数据源（已抓取的文档保留） |
| `PATCH` | `/api/v1/data-sources/{source_id}/enabled` | 启用 / 停用数据源 |
| `POST` | `/api/v1/data-sources/{source_id}/sync` | 拉取一次（默认入队；wait=true 立刻做完） |
| `GET` | `/api/v1/knowledge-bases/{kb_id}/data-sources` | 某知识库的数据源 |
| `POST` | `/api/v1/knowledge-bases/{kb_id}/data-sources` | 登记数据源（HTML / RSS） |

### `documents`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/documents/{document_id}` | 文档详情 |
| `PATCH` | `/api/v1/documents/{document_id}` | 重命名文档 |
| `POST` | `/api/v1/documents/{document_id}/cancel` | 取消解析（叫停还在跑的摄入） |
| `GET` | `/api/v1/documents/{document_id}/chunks` | 切块列表（文档详情页的正文预览） |
| `GET` | `/api/v1/documents/{document_id}/content` | 按签名取内容（下载 / 页面内渲染） |
| `PATCH` | `/api/v1/documents/{document_id}/disabled` | 停用 / 恢复检索 |
| `GET` | `/api/v1/documents/{document_id}/download-url` | 签发下载链接（带过期时间） |
| `GET` | `/api/v1/documents/{document_id}/parts` | 子文件树（大文件切分） |
| `GET` | `/api/v1/documents/{document_id}/preview` | 阅读视角（解析文本内联 / 原件版式给签名链接） |
| `POST` | `/api/v1/documents/{document_id}/reprocess` | 重新摄入（失败重跑） |
| `GET` | `/api/v1/knowledge-bases/{kb_id}/documents` | 知识库下的文档列表 |
| `POST` | `/api/v1/knowledge-bases/{kb_id}/documents` | 上传文档（异步摄入） |
| `POST` | `/api/v1/knowledge-bases/{kb_id}/documents/batch` | 批量删除 / 重新摄入 / 移动 / 停用启用 / 生成问题 |

### `folders`

| 方法 | 路径 | 说明 |
|------|------|------|
| `PATCH` | `/api/v1/documents/{document_id}/folder` | 把文档移进目录 / 移回根 |
| `DELETE` | `/api/v1/folders/{folder_id}` | 删除目录（非空则拒绝） |
| `PATCH` | `/api/v1/folders/{folder_id}` | 重命名目录 |
| `GET` | `/api/v1/knowledge-bases/{kb_id}/folders` | 知识库的目录列表（含每个目录的文档数） |
| `POST` | `/api/v1/knowledge-bases/{kb_id}/folders` | 新建目录 |

### `health`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/health` | 服务存活探针 |

### `knowledge-bases`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/knowledge-bases` | 知识库列表 |
| `POST` | `/api/v1/knowledge-bases` | 创建知识库 |
| `GET` | `/api/v1/knowledge-bases/{kb_id}` | 知识库详情 |
| `PATCH` | `/api/v1/knowledge-bases/{kb_id}` | 修改知识库（名称 / 简介） |

### `lifecycle`

| 方法 | 路径 | 说明 |
|------|------|------|
| `DELETE` | `/api/v1/documents/{document_id}` | 删除文档（原文进回收站，索引立即清除） |
| `GET` | `/api/v1/documents/{document_id}/impact` | 删除这份文档会波及什么 |
| `DELETE` | `/api/v1/knowledge-bases/{kb_id}` | 删除知识库（不可恢复） |
| `GET` | `/api/v1/knowledge-bases/{kb_id}/impact` | 删除这个知识库会波及什么 |
| `GET` | `/api/v1/trash` | 回收站 |
| `DELETE` | `/api/v1/trash/{trash_id}` | 彻底删除 |
| `POST` | `/api/v1/trash/{trash_id}/restore` | 从回收站恢复（需要重新摄入） |

### `maintenance`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/maintenance/compact` | 整理存储 |
| `GET` | `/api/v1/maintenance/storage` | 存储空间概览 |

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
| `GET` | `/api/v1/notes/tags` | 用过的标签与条数 |
| `DELETE` | `/api/v1/notes/{note_id}` | 删除笔记 |
| `GET` | `/api/v1/notes/{note_id}` | 笔记详情 |
| `PATCH` | `/api/v1/notes/{note_id}` | 更新笔记 |
| `POST` | `/api/v1/notes/{note_id}/ai` | 用对话模型排版 / 润色笔记 |
| `POST` | `/api/v1/notes/{note_id}/attach` | 把笔记加入知识库 |
| `POST` | `/api/v1/notes/{note_id}/images` | 上传笔记配图 |
| `GET` | `/api/v1/notes/{note_id}/images/{name}` | 读取笔记配图 |

### `search`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/search` | 混合检索 |

### `settings`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/settings` | 运行期配置（密钥打码） |
| `PATCH` | `/api/v1/settings` | 更新运行期配置 |
| `POST` | `/api/v1/settings/test/{target}` | 连通性测试（embedding / mineru / paddleocr） |

### `shares`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/knowledge-bases/{kb_id}/shares` | 库的分享列表 |
| `PUT` | `/api/v1/knowledge-bases/{kb_id}/shares` | 分享/调整档位（按登录名） |
| `DELETE` | `/api/v1/knowledge-bases/{kb_id}/shares/{user_id}` | 收回分享 |

### `stats`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/stats/dashboard` | 驾驶舱统计 |
| `GET` | `/api/v1/stats/usage` | 用量（token 与调用量，含检索） |

### `tabular`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/documents/{document_id}/table` | 读表格文档的结构化副本（分页） |

### `tasks`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/tasks` | 任务列表（每项带健康判据） |
| `POST` | `/api/v1/tasks/cancel` | 取消还没结束的任务 |
| `GET` | `/api/v1/tasks/health` | 运行态总览 |

### `users`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/users` | 使用者名册 |
| `POST` | `/api/v1/users` | 添加使用者 / 开通账号（带 username 即账号） |
| `DELETE` | `/api/v1/users/{user_id}` | 删除使用者（其文档保留，归属置空） |
| `PUT` | `/api/v1/users/{user_id}/disabled` | 禁用 / 启用账号（禁用即吊销全部会话） |
| `PUT` | `/api/v1/users/{user_id}/password` | 重置密码（吊销其全部会话） |

### `webhooks`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/webhooks` | 订阅列表（密钥掩码） |
| `POST` | `/api/v1/webhooks` | 新建订阅（密钥明文只在这里返回一次） |
| `GET` | `/api/v1/webhooks/events` | 支持的事件清单 |
| `DELETE` | `/api/v1/webhooks/{webhook_id}` | 删除订阅 |
| `PATCH` | `/api/v1/webhooks/{webhook_id}` | 启用 / 停用订阅 |

### `wiki`

| 方法 | 路径 | 说明 |
|------|------|------|
| `DELETE` | `/api/v1/knowledge-bases/{kb_id}/wiki` | 清空这个知识库的 Wiki 页面 |
| `GET` | `/api/v1/knowledge-bases/{kb_id}/wiki` | Wiki 目录与生成状态 |
| `POST` | `/api/v1/knowledge-bases/{kb_id}/wiki/generate` | 重建这个知识库的 Wiki（异步） |
| `GET` | `/api/v1/wiki/pages/{page_id}` | 读一页 Wiki（正文 + 出处） |

---

## 3. 不改动的部分去哪看

- **字段类型 / 必填 / 枚举取值**：`/api/v1/openapi.json`（或 `/docs`）；
- **领域概念与设计取舍**：《架构设计 v0.2》；
- **MCP 工具**（与 REST 一一对应、共用服务层）：`skills/kylab-knowledge-base/SKILL.md`。

## 4. 变更纪律

- **接口变更必须同步本文件的 §1 约定与 §2 清单**（§2 由脚本生成，跑一次即可）；
- **已发布的约定不原地改**：错误信封、鉴权档位、幂等语义这类东西一旦有人依赖，
  改动要按工程规范 §2.1 升版本，而不是悄悄改；
- 新增端点会自动出现在 §2——但**新增"约定"（头、语义、状态码含义）必须手写进来**，
  那是机器读不出来的部分。
