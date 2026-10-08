"""FastAPI 入口（工程规范 §3.1）。

这个进程只有一种形态：**本机档**（桌面壳的边车）。原先的"服务器档"随知识库产品
剥离到独立仓库一起拆掉了——路由表只剩 ``local_router`` 一张，存储只剩本机 SQLite +
本地目录，消费者只剩"定时任务到点跑 + 本机库空闲维护"那一个。
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import local_router
from app.core.config import API_VERSION, get_settings
from app.core.exceptions import register_exception_handlers
from app.core.http import close_shared_client
from app.core.logging import add_file_handler, log_file_for, setup_logging
from app.core.services import get_services
from app.core.storage import close_stores
from app.storage.base import IMPORT_UNFINISHED_STATES
from app.workers.local_worker import bind_local_maintainer, run_local_maintainer

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """启动：备好存储（建库/迁移/目录）并按配置拉起内嵌任务消费者。"""
    settings = get_settings()
    services = get_services()

    # 记忆/人设文件（v0.1.1）：**启动时幂等铺一遍**，不等"第一次对话"。
    # 新容器里还没有任何对话，这是唯一能让「记忆」页一打开就有东西可看的时机
    # （浏览/编辑那几个文件本来就不受 memory.enabled 那道闸管，见 services/memory.py）。
    # 只补共享桶（data/memory/）：按账号的工作区在各自第一次对话时补。
    # 写不出来只警告不拦启动——与上面那条日志处理器同一个口径。
    try:
        created = services.memory.seed_persona()
    except OSError:
        logger.warning("记忆/人设模板建不出来：%s", services.memory.workspace, exc_info=True)
    else:
        if created:
            logger.info("记忆/人设模板已就位：%s", "、".join(created))

    # 旧取值写回新档（2026-09-27 拆分权限轴时的一次迁移）：库里可能还留着
    # 四档模式时代的 `build` / `edit` / `yolo`。只在读的时候映射的话，设置页那个下拉
    # 会因为"没有匹配的选项"显示成空——**界面与引擎不一致**正是最难查的一类问题。
    # 失败只警告：迁移不成不该拦住整个服务起来（引擎侧本来就有 coerce 兜底）。
    try:
        migrated = services.runtime.normalize_modes()
    except Exception:
        logger.warning("旧模式取值写回失败", exc_info=True)
    else:
        if migrated:
            logger.info("旧的模式/权限取值已写回新档：%s", "；".join(migrated))

    stop = asyncio.Event()
    worker_tasks: list[asyncio.Task[None]] = []
    # **消费者只有一个**：它做的是本机库那几件只增不减的收尾（现在只有过期的用量行），
    # 而"入库/回收站"那几件收尾是知识库（NAS）自己的事，本机没有那些表。起了摄取那个
    # 消费者，表现是"进程里有个协程每隔几秒去撞一次不可用的库"，日志天天刷错却什么也做不成。
    # 落点与边界写在 `workers/local_worker.py` 的模块头。
    if settings.run_worker:
        maintainer = bind_local_maintainer(services)
        worker_tasks = [asyncio.create_task(run_local_maintainer(maintainer, stop))]
        logger.info("已启动本机消费者（本机库空闲维护）")
    else:
        logger.warning("KYLAB_RUN_WORKER=false：未起消费者，本机库不会自动收尾")
    # R1 的"启动时看一眼"：上次旧会话导入要是被杀在半路，账在库里（状态是
    # planned/running）。**只报不重试**——重跑是用户的决定（来源可能都不在了），
    # 而"重跑同一个来源就接着往下走"这条承诺由会话级幂等兜着（见 services/legacy_import.py）。
    _report_unfinished_imports(services)

    try:
        yield
    finally:
        stop.set()
        if worker_tasks:
            await asyncio.gather(*worker_tasks, return_exceptions=True)
        # 释放本机 SQLite 句柄与 WAL 尾巴：进程级资源，不还回去会拖住文件
        close_stores()
        # 出站 HTTP 客户端同理（见 core/http.py）：连接池也是进程级资源
        close_shared_client()


def _report_unfinished_imports(services) -> None:  # type: ignore[no-untyped-def]
    """启动时如实报一句"还有几笔导入没结"（R1；**不自动重试**，只报）。

    读台账失败只警告：它不该拦住整个服务起来（与上面"记忆模板建不出来"同一口径）。
    """
    importer = services.legacy_import
    if importer is None:  # pragma: no cover - 组合根一定给得出它
        return
    try:
        unfinished = [
            batch
            for batch in importer.recent_batches(limit=20)
            if batch.state in IMPORT_UNFINISHED_STATES
        ]
    except Exception:
        logger.warning("读导入台账失败（不影响启动）", exc_info=True)
        return
    if unfinished:
        logger.warning(
            "有 %d 个旧会话导入批次没跑完（%s）：重跑同一个来源即可续上（会话级幂等）",
            len(unfinished),
            "、".join(batch.id for batch in unfinished),
        )


def create_app() -> FastAPI:
    """组装应用：配置、中间件、异常映射、路由、生命周期。"""
    settings = get_settings()
    setup_logging(settings.log_level)
    # **文件日志在启动时挂上**（库代码不该决定往磁盘写什么）：
    # 控制台日志活不过一次重启，而"昨晚那次为什么慢"只能从文件里翻。
    # 路径不能拼错也没法失败退出——写不出来只影响日志，不该让服务起不来。
    try:
        location = add_file_handler(log_file_for(settings.data_dir))
        logger.info("日志文件：%s", location)
    except OSError:
        logger.warning("日志文件建不出来，本次只输出到控制台", exc_info=True)

    app = FastAPI(
        title="KYLAB 本机服务",
        version=settings.app_version,
        docs_url=f"/api/{API_VERSION}/docs",
        redoc_url=f"/api/{API_VERSION}/redoc",
        openapi_url=f"/api/{API_VERSION}/openapi.json",
        # FastAPI 默认会注册 /docs/oauth2-redirect，不带版本前缀，必须显式归位
        swagger_ui_oauth2_redirect_url=f"/api/{API_VERSION}/docs/oauth2-redirect",
        description=(
            "桌面端的本机后端（边车）。会话、笔记、设置、模型凭据都落这一台机器，"
            "知识库在别处（另一台机器上的提供者），本机是它的客户端。"
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
    # **只有一张路由表**（清单与理由见 `api/v1/router.py` 的模块头）。
    # 这张表是白名单：本机没有知识库数据源，挂上去的每一条都必须答得出话。
    app.include_router(local_router, prefix=f"/api/{API_VERSION}")
    return app


app = create_app()
