# kylab 知识库 Skill

让 Agent 能查你自己的 kylab 知识库，并**拿到可追溯的原文出处**。

## 它做什么

kylab 的核心能力是**带出处的检索**：返回的是你文档里的原文片段
（含文档名、页码、标题路径），不是一段生成的回答。

这个区别是这个 Skill 存在的理由：需要**核对**答案时，原文是证据，摘要不是。
所以无论是 MCP 工具还是本目录的脚本，给出的都是片段而不是总结。

## 两条接入路径

| 路径 | 适合 | 怎么用 |
|------|------|--------|
| **MCP** | 支持 MCP 的客户端（Claude Desktop、Cursor 等） | 见 `SKILL.md` 里的配置片段 |
| **脚本** | 只会 shell 与 HTTP 的运行环境 | `python scripts/kylab_query.py --query "…"` |

两条路走的是**同一套检索**，只是传输不同。不是所有运行环境都能说 MCP，
而 shell 与 HTTP 几乎哪里都有——所以两条都提供。

## 快速自检

```bash
# 1) 后端在跑吗
curl -s http://127.0.0.1:8000/api/v1/health

# 2) MCP 工具认得出来吗（需要先装 mcp extra）
cd backend && python -m app.mcp_server.server --list-tools

# 3) 脚本能查到东西吗（开了鉴权才需要令牌）
KYLAB_CONSOLE_TOKEN=... python scripts/kylab_query.py --list
KYLAB_CONSOLE_TOKEN=... python scripts/kylab_query.py --query "眼轴怎么监测"
```

## 三个容易踩的点

1. **注册数据源不会立刻抓取。** `add_data_source` 只是登记，
   要等定时任务或在控制台点「立即拉取」。
2. **未 `indexed` 的文档搜不到。** 上传后处理是异步的；
   搜不到时先用 `get_document_status` 看它到哪一步了，别急着说"没有这份资料"。
3. **删文档不可当场撤销。** 原文进回收站保留 7 天，
   但切块与向量**立即清除**——所以删完立刻就搜不到了。

## 安全

MCP 的 HTTP 模式**没有自己的鉴权**，而工具能读**也能删**文档。
默认只监听 `127.0.0.1` 是有意的；要在局域网上开，
请先打开后端鉴权并只在可信网络里使用。
