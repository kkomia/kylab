"""v1 路由聚合。

鉴权不在这里挂全局依赖，而是**逐个端点显式声明**（``ReadDep`` / ``WriteDep``）：
全局依赖无法表达"这个端点需要读写、那个只要只读、设置端还只认管理员"，
只能一律放同一个档位——那等于没有作用域隔离。
"""

from fastapi import APIRouter

from app.api.v1 import (
    api_keys,
    auth,
    chat,
    chunks,
    conversations,
    data_sources,
    documents,
    folders,
    health,
    knowledge_bases,
    lifecycle,
    maintenance,
    mcp_servers,
    memory,
    model_registry,
    notes,
    sandbox,
    search,
    settings,
    shares,
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
api_router.include_router(api_keys.router)
api_router.include_router(conversations.router)
api_router.include_router(notes.router)
api_router.include_router(chunks.router)
api_router.include_router(model_registry.router)
api_router.include_router(users.router)
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
# MCP 客户端（v0.15）：接外部工具进来（此前只有服务端的一半）
api_router.include_router(mcp_servers.router)
# 沙箱执行（v0.16）：内核级隔离 + 策略闸（管理员专属）
api_router.include_router(sandbox.router)
