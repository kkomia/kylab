"""FastAPI 入口（工程规范 §3.1）。"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import API_VERSION, get_settings
from app.core.exceptions import register_exception_handlers
from app.core.logging import setup_logging
from app.core.services import get_services
from app.workers.queue_worker import TaskWorker

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """启动：备好存储（建库/迁移/目录）并按配置拉起内嵌任务消费者。"""
    settings = get_settings()
    services = get_services()

    stop = asyncio.Event()
    worker_task: asyncio.Task[None] | None = None
    if settings.run_worker:
        worker_task = asyncio.create_task(_run_worker(services.worker, stop))
        logger.info("内嵌任务消费者已启动：%s", services.worker.owner)
    else:
        logger.warning("KYLAB_RUN_WORKER=false：未启动任务消费者，上传的文档不会被处理")

    try:
        yield
    finally:
        stop.set()
        if worker_task is not None:
            await asyncio.gather(worker_task, return_exceptions=True)


async def _run_worker(worker: TaskWorker, stop: asyncio.Event) -> None:
    """跑消费循环。

    关停时 ``stop`` 置位只是"别再领新任务"；真正让卡在
    ``await asyncio.to_thread(...)`` 上的循环动起来的是取消。收尾语义由
    ``TaskWorker.run_forever`` 自己保证（取消后仍等手上那份文档写完），
    所以这里对 ``CancelledError`` 只做原样上抛——吞掉它 asyncio 会误以为
    任务正常结束，取消语义就丢了。
    """
    try:
        await worker.run_forever(stop=stop)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("任务消费者异常退出")


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
