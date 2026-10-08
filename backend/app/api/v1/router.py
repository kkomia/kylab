"""v1 路由聚合：**本机档一张表**。

鉴权不在这里挂全局依赖，而是**逐个端点显式声明**（``ReadDep`` / ``WriteDep``）：
全局依赖无法表达"这个端点需要读写、那个只要只读"，只能一律放同一个档位——
那等于没有作用域隔离。本机档这些依赖最终短路成"本机主人"（见 ``api/auth.py``）。

只有 ``local_router`` 一张表了。原先那张 ``api_router``（服务器档：知识库管理台 +
备份提供者 + 模型代理 + 前端资源包 + 账号体系）随服务器档一起拆掉——知识库产品已经
剥离到独立仓库，本仓库剩下的这个进程是**桌面壳的本机边车**，只服务这一台机器上的数据。

这张表是**白名单**，不是黑名单：本机没有知识库数据源（在 NAS 上），黑名单意味着
"新加的端点默认挂上去"，而它们会在第一次被点到时才 500。逐条理由写在下面每一行旁边。

**明确不挂的域**（历史上写在这里的服务器档清单，随那些模块一起删了）：
知识库那一整族（documents / knowledge_bases / search / chunks / folders / wiki /
tabular / data_sources / shares）——那几张表不在本机库里，KB 域的方法在本机档由
`RemoteMetaStore` 整体抛 `KnowledgeBaseUnavailable`；`tasks` / `lifecycle` /
`webhooks` / `maintenance` 数的都是知识库那边的家当，数据不在本机，挂了没有一条
答得出话；账号体系（`users` / `auth` / `api_keys` / `avatars`）本机档不设门禁，
调用主体直接短路成"本机主人"。
"""

from fastapi import APIRouter

from app.api.v1 import (
    chat,
    conversations,
    health,
    local,
    mcp_servers,
    memory,
    model_registry,
    notes,
    plugins,
    sandbox,
    schedules,
    settings,
    site_icons,
    skills,
    stats,
    web,
    workspaces,
)

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
# 技能目录 = `<data_dir>/skills/` + 仓库自带 `skills/` + `~/.agents/skills`（v0.15）：
# 三处都在**这台机器**上，而启停状态存在本地 `app_settings`（`chat.disabled_skills`）。
# 所以它不是一个"服务器能力"——`SkillService` 的目录随 `settings.data_dir` 走，
# 本机档的 data_dir 就是本机的那个（见 `core/services.py` 的组合根）。
local_router.include_router(skills.router)
# 插件包（v0.43）：目录 = `<data_dir>/plugins/` + 仓库自带 `plugins/`，
# 启停/屏蔽写在本地 `app_settings`（`plugins.enabled.*`）——同上，权威在本机的 data_dir。
local_router.include_router(plugins.router)
# 沙箱（v0.16）：**它就是"在这台机器上执行"**（隔离探测 / 策略闸 / 工作区三样都在本机，
# 见 api/v1/sandbox.py 与 services/isolation.py）。边车的工具面早就在本机跑命令了，
# 这一组只是把同一件事给界面一个直接入口——三道闸（管理员 / 策略 / 隔离）一道没绕。
#
# **只挂两条，不挂 `POST /sandbox/exec`**（2026-10-05）：那是一条**裸 HTTP 执行口**
# （一个 body 里写命令就执行），没有任何前端/客户端调用它——界面上那条链是
# `GET /sandbox`（看这台机器有什么隔离）+ `POST /sandbox/plan`（只算不跑，先把 argv
# 摆出来给人看），而 Agent 真正要执行时走的是**进程内**的 `services/agent_exec.py`
# （工具调用那条路，带模式闸 / 权限档 / 计划门闸 + 审批），不经过这个 HTTP 口。
# 它同时缺三样一般做法都要求的东西：**Origin / Host 校验**、**本地令牌**、
# 以及 `approved` 由**请求方自填**（自己说"我批准了"就过闸）。
# 留着它=在本机开一个"任何人（含浏览器里任意页面通过 CSRF 打回环）都能执行命令"的洞。
_sandbox_local = APIRouter()
_sandbox_local.routes.extend(
    route
    for route in sandbox.router.routes
    if getattr(route, "path", "") in ("/sandbox", "/sandbox/plan")
)
local_router.include_router(_sandbox_local)
# 站点图标（D11-②）：抓取与 30 天磁盘缓存都在本机（`<data_dir>/site-icons/`，见
# services/site_icons.py）——它本来就是"本机代浏览器去取"。
local_router.include_router(site_icons.router)
# 网页取页（阅读模式）：两个请求都是**这台机器**替界面发出去的——"读一页正文"与
# "探一次对方让不让嵌"。出口在本机（见 web.py）。不是"服务器抓一页"那条路。
local_router.include_router(web.router)
# 本机档专属：`/local/status`（导入的 `/local/import*` 与知识库提供者的
# `/local/provider` 都在这个 router 上——三样都是"只在本机档成立"的东西，见 local.py）
local_router.include_router(local.router)
# 会话事件日志 / 上下文用量 / 用量面板这三条（`local.chat_reads` / `local.stats_reads`）
local_router.include_router(local.chat_reads)
local_router.include_router(local.stats_reads)
# 命令目录（`GET /chat/commands`）：它读的是**这台机器上的**命令与技能
# （`data/commands/` + 仓库命令 + `<data_dir>/skills/`，含"被禁用的技能"那栏的读法），
# 而桌面真正执行那一轮的是**边车** —— 目录与执行必须同源，否则壳里列出来的
# 与真正能被执行的不是同一批（同一个端点也就有了两个答案）。
_chat_commands_local = APIRouter()
_chat_commands_local.routes.extend(
    route for route in chat.router.routes if getattr(route, "path", "") == "/chat/commands"
)
local_router.include_router(_chat_commands_local)
