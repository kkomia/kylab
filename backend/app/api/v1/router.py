"""v1 路由聚合。

鉴权不在这里挂全局依赖，而是**逐个端点显式声明**（``ReadDep`` / ``WriteDep``）：
全局依赖无法表达"这个端点需要读写、那个只要只读、设置端还只认管理员"，
只能一律放同一个档位——那等于没有作用域隔离。

**两张路由表，按部署档挂哪一张**（M2 §4.1，`app/main.py` 判档）：

- ``api_router``：**服务器档**（默认）的全量端点，一位行为不变；
- ``local_router``：**本机档**（桌面壳的边车）那张**白名单**——只挂"数据在本机、
  本机服务得了"的那些。白名单而不是黑名单：本机没有知识库数据源（在 NAS 上），
  黑名单意味着"新加的端点默认挂上去"，而它们会在第一次被点到时才 500 ✗。
"""

from fastapi import APIRouter

from app.api.v1 import (
    api_keys,
    auth,
    avatars,
    chat,
    chunks,
    conversations,
    data_sources,
    documents,
    folders,
    frontend,
    health,
    knowledge_bases,
    lifecycle,
    local,
    maintenance,
    mcp_servers,
    memory,
    model_proxy,
    model_registry,
    notes,
    plugins,
    sandbox,
    schedules,
    search,
    settings,
    shares,
    site_icons,
    skills,
    stats,
    tabular,
    tasks,
    users,
    webhooks,
    wiki,
    workspaces,
)

api_router = APIRouter()
# 健康探针不鉴权：容器编排靠它判断存活，带鉴权会让 readiness 探针误判
api_router.include_router(health.router, tags=["health"])
# 认证端点自己管鉴权（/auth/status 公开、/auth/setup 只在无账号时开放），见 api/v1/auth.py
api_router.include_router(auth.router)
api_router.include_router(knowledge_bases.router)
api_router.include_router(documents.router)
api_router.include_router(folders.router)
api_router.include_router(search.router)
api_router.include_router(chat.router)
api_router.include_router(settings.router)
api_router.include_router(stats.router)
api_router.include_router(tasks.router)
# 定时任务（v0.33）：界面上归在任务中心那一页里（分段），但它是独立的一组端点
api_router.include_router(schedules.router)
api_router.include_router(api_keys.router)
api_router.include_router(conversations.router)
api_router.include_router(notes.router)
api_router.include_router(chunks.router)
api_router.include_router(model_registry.router)
api_router.include_router(users.router)
# 头像图片（v0.29）：**不鉴权、只认签名**——`<img src>` 带不了 Authorization 头，
# 而签名绑定了"哪个用户的哪张图"（见 api/v1/avatars.py）
api_router.include_router(avatars.router)
api_router.include_router(lifecycle.router)
api_router.include_router(data_sources.router)
api_router.include_router(shares.router)
api_router.include_router(tabular.router)
api_router.include_router(webhooks.router)
api_router.include_router(maintenance.router)
api_router.include_router(wiki.router)
# 记忆（v0.14 三期）：与知识库是**两个池子**，所以单独一组 /memory
api_router.include_router(memory.router)
# 工作区（v0.15）：Agent 的项目，会话挂在它下面
api_router.include_router(workspaces.router)
# 技能（v0.15）：磁盘上的 SKILL.md，目录进提示词、正文按需展开
api_router.include_router(skills.router)
# 插件包（v0.43）：插件 = 一个目录 + plugin.json，目录即本地市场；
# 与上面那组「插件」（MCP 服务）是两件事——那是外部服务，这是磁盘上的能力包
api_router.include_router(plugins.router)
# MCP 客户端（v0.15）：接外部工具进来（此前只有服务端的一半）
api_router.include_router(mcp_servers.router)
# 沙箱执行（v0.16）：内核级隔离 + 策略闸（管理员专属）
api_router.include_router(sandbox.router)
# 站点图标（D11-②）：浏览器不直连第三方站点，图标由本机缓存代理
api_router.include_router(site_icons.router)
# 模型代理（Phase B · P2）：服务器用自己的 key 调模型，把增量透传给边车/壳
api_router.include_router(model_proxy.router)
# 前端资源包（v0.56）：桌面壳取界面的那两份（版本清单 + 整包）——
# "服务器发了新前端、客户端下次启动自动用上"那条承诺的服务器半边
api_router.include_router(frontend.router)


# ====================================================================== 本机档
#
# **白名单**（M2 §4.2）：本机档只挂"数据在本机、本机服务得了"的端点。逐个说清理由，
# 因为这张表是"本机运行时到底能做什么"的唯一定义，而漏挂一个与错挂一个都看不出来：

local_router = APIRouter()
# 探活：桌面壳与界面都要能问一句"本机后端在不在"
local_router.include_router(health.router, tags=["health"])
# 会话 / 消息 / 事件 / 产物 / 文件区全在本机（`/files*` 走本机对象存储）
local_router.include_router(conversations.router)
# 笔记落本机
local_router.include_router(notes.router)
# 设置落本机（运行期配置表 `app_settings` 在这份库里）
local_router.include_router(settings.router)
# 模型凭据与注册表落本机（v0.3 §1："模型凭据走本机"）
local_router.include_router(model_registry.router)
# 工作区是机器本地的路径
local_router.include_router(workspaces.router)
# 定时任务的产物是会话（会话在本机）
local_router.include_router(schedules.router)
# 外部 MCP 服务配置属于这台机器
local_router.include_router(mcp_servers.router)
# 记忆本体本来就在 `data_dir/memory`
local_router.include_router(memory.router)
# 本机档专属：`/local/status`（`/local/import*` 在阶段 5）
local_router.include_router(local.router)
# 两条薄重声明的只读端点（事件日志 / 上下文用量）——**不整 include `chat.router`**：
# 那个 router 还有服务器专属的 `/chat/stream`，摆出来就是一条会 500 的路。
# 理由与做法见 `api/v1/local.py` 的模块头。
local_router.include_router(local.chat_reads)

# **明确不挂**（每一条都因为"数据或能力不在这台机器上"）：`documents` /
# `knowledge_bases` / `search` / `chunks` / `folders` / `wiki` / `stats` / `tasks` /
# `tabular` / `data_sources` / `shares` / `api_keys` / `users` / `auth` / `avatars` /
# `lifecycle` / `maintenance` / `webhooks` / `frontend` / `model_proxy` / `sandbox` /
# `site_icons` / `skills` / `plugins`（后几个若要方便可以后续加，M2 不阻塞）。
# 本机档的会话事件与上下文用量在 `local.chat_reads` 上，不靠 include `chat`。
