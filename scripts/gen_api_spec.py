"""根据真实的 OpenAPI 生成《API 接口规范》正文（T4.9）。

**为什么用生成而不是手写清单**：计划里 T4.9 的验收是"与 OpenAPI 自动生成结果一致"，
而手抄一份 69 行的路径表**必然**会漂——加了端点忘了改文档，是这类文档最常见的死法。
所以路径清单由脚本从 FastAPI 的 OpenAPI 里抽出来写进文档，
并且有一条测试在 CI 里核对它（`tests/unit/api/test_api_spec.py`）。

手写的部分是**约定**：错误信封、鉴权、分页、幂等键、签名 URL、时间格式。
那些是机器读不出来的东西，也是接 API 的人真正需要读的东西。
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
from pathlib import Path


# **别把仓库根的 ``data/`` 当数据目录**：门禁从仓库根执行本脚本，而
# ``KYLAB_DATA_DIR`` 的默认值是**相对路径** ``./data``——于是 ``create_app()``
# 挂的日志会落到 ``<仓库根>/data/logs``，多跑几次就在仓库里长出一个数据目录
# （历史上那份 ``data/kylab.db`` 就是这么来的，直到存储换 PostgreSQL 才成死文件）。
# 本脚本只读 OpenAPI，不需要真实数据目录，显式指到临时目录即可。
os.environ["KYLAB_DATA_DIR"] = tempfile.mkdtemp(prefix="kylab-openapi-")

ROOT = Path(__file__).resolve().parents[1]

# ``app`` 包在 ``backend/`` 下。门禁从 backend/ 调本脚本时它天然可导入，
# 但从仓库根调就不是——所以显式补上，别让调用方记住这件事。
_BACKEND = ROOT / "backend"
if _BACKEND.is_dir() and str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


def _route_tables() -> str:
    from app.main import create_app

    spec = create_app().openapi()
    groups: dict[str, list[tuple[str, str, str]]] = {}
    for path, operations in spec["paths"].items():
        for method, operation in operations.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            tag = (operation.get("tags") or ["(无标签)"])[0]
            groups.setdefault(tag, []).append(
                (path, method.upper(), operation.get("summary", ""))
            )

    blocks: list[str] = [f"共 **{sum(len(v) for v in groups.values())}** 条端点。", ""]
    for tag in sorted(groups):
        blocks.append(f"### `{tag}`")
        blocks.append("")
        blocks.append("| 方法 | 路径 | 说明 |")
        blocks.append("|------|------|------|")
        for path, method, summary in sorted(groups[tag]):
            blocks.append(f"| `{method}` | `{path}` | {summary} |")
        blocks.append("")
    return "\n".join(blocks)


HEADER = """# API 接口规范 · v0.1

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

"""

FOOTER = """
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
"""


def main() -> int:
    target = ROOT / "docs" / "API-接口规范-v0.1.md"
    content = HEADER + _route_tables() + FOOTER
    io.open(target, "w", encoding="utf-8").write(content)
    print("已写入", target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
