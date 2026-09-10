"""v1 路由聚合。"""

from fastapi import APIRouter

from app.api.v1 import chat, documents, health, knowledge_bases, search, settings, stats, tasks

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(knowledge_bases.router)
api_router.include_router(documents.router)
api_router.include_router(search.router)
api_router.include_router(chat.router)
api_router.include_router(settings.router)
api_router.include_router(stats.router)
api_router.include_router(tasks.router)
