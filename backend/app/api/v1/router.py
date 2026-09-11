"""v1 路由聚合。

鉴权不在这里挂全局依赖，而是**逐个端点显式声明**（``ReadDep`` / ``WriteDep``）：
全局依赖无法表达"这个端点需要读写、那个只要只读、设置端还只认控制台令牌"，
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
    health,
    knowledge_bases,
    lifecycle,
    model_registry,
    search,
    settings,
    shares,
    stats,
    tabular,
    tasks,
    users,
    webhooks,
)

api_router = APIRouter()
# 健康探针不鉴权：容器编排靠它判断存活，带鉴权会让 readiness 探针误判
api_router.include_router(health.router, tags=["health"])
# 控制台令牌的初始化入口自己管鉴权（只在尚未设置时开放），见 api/v1/auth.py
api_router.include_router(auth.router)
api_router.include_router(knowledge_bases.router)
api_router.include_router(documents.router)
api_router.include_router(search.router)
api_router.include_router(chat.router)
api_router.include_router(settings.router)
api_router.include_router(stats.router)
api_router.include_router(tasks.router)
api_router.include_router(api_keys.router)
api_router.include_router(conversations.router)
api_router.include_router(chunks.router)
api_router.include_router(model_registry.router)
api_router.include_router(users.router)
api_router.include_router(lifecycle.router)
api_router.include_router(data_sources.router)
api_router.include_router(shares.router)
api_router.include_router(tabular.router)
api_router.include_router(webhooks.router)
