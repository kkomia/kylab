"""FastAPI 入口（工程规范 §3.1）。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import API_VERSION, get_settings
from app.core.exceptions import register_exception_handlers
from app.core.logging import setup_logging
from app.core.storage import build_stores


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """启动时把存储准备好：建库、跑迁移、备齐目录（幂等，可重复调用）。"""
    build_stores()
    yield


def create_app() -> FastAPI:
    """组装应用：配置、中间件、异常映射、路由、生命周期。"""
    settings = get_settings()
    setup_logging(settings.log_level)

    app = FastAPI(
        title="KYLAB 知识库服务",
        version=settings.app_version,
        docs_url=f"/api/{API_VERSION}/docs",
        redoc_url=f"/api/{API_VERSION}/redoc",
        openapi_url=f"/api/{API_VERSION}/openapi.json",
        # FastAPI 默认会注册 /docs/oauth2-redirect，不带版本前缀，必须显式归位
        swagger_ui_oauth2_redirect_url=f"/api/{API_VERSION}/docs/oauth2-redirect",
        description=(
            "轻量知识库产品（架构设计 v0.2）。"
            "产品边界：对外只返回检索结果原文，不做任何 LLM 预处理。"
        ),
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_exception_handlers(app)
    app.include_router(api_router, prefix=f"/api/{API_VERSION}")
    return app


app = create_app()
