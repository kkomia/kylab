"""v1 路由聚合。"""

from fastapi import APIRouter

from app.api.v1 import documents, health, knowledge_bases, search, tasks

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(knowledge_bases.router)
api_router.include_router(documents.router)
api_router.include_router(search.router)
api_router.include_router(tasks.router)
