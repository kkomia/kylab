"""任务端点（M4；可观测性收口 M7 / T7.4）。

界面需要看到"哪些任务在跑、卡在哪一步、重试了几次"（架构 §12 可观测性），
所以任务响应里带上 attempts / max_attempts / error / 租约到期时间。

**M7 补上的是"健康判据"**：原先只有状态标签，而 `running` 本身说明不了任何事——
一个跑了 5 秒的和一个卡了两小时的看起来完全一样。现在每个任务带一个由后端算出的
``health``，界面据此把"可能卡住"标出来。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.auth import require_read
from app.api.v1.schemas import HealthOverviewOut, TaskList, TaskOut
from app.core.config import get_settings
from app.core.exceptions import ForbiddenError
from app.core.services import Services, get_services
from app.models.enums import TaskState
from app.services.api_key import Caller

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("", response_model=TaskList, summary="任务列表（每项带健康判据）")
async def list_tasks(
    state: TaskState | None = Query(default=None, description="按状态过滤"),
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> TaskList:
    # 成员（v10）只看到自己库里的文档任务；任务内容（文件名、报错）是私有数据
    kb_ids = services.api_keys.visible_kb_ids(caller) if caller.user is not None else None
    tasks = services.documents.list_tasks(state, kb_ids=kb_ids)
    # 任务 → 所属库，一次批量取回：界面的"按知识库筛选"靠它，
    # 不必逐个库拉文档来反查归属（那是 N 次请求）
    documents = services.documents.get_documents_by_ids(
        [task.document_id for task in tasks if task.document_id]
    )
    items: list[TaskOut] = []
    for task in tasks:
        health = services.observability.assess(task)
        out = TaskOut.model_validate(task)
        out.health = health.status
        out.health_label = health.label
        out.health_detail = health.detail
        if task.document_id and task.document_id in documents:
            document = documents[task.document_id]
            out.knowledge_base_id = document.knowledge_base_id
            out.document_name = document.name
        items.append(out)
    return TaskList(items=items)


@router.get("/health", response_model=HealthOverviewOut, summary="运行态总览")
async def tasks_health(
    services: Services = Depends(get_services),
    caller: Caller = Depends(require_read),
) -> HealthOverviewOut:
    """任务运行态总览。

    把"有没有卡住"变成一个可以直接看的数，而不是让用户自己去列表里比对时间。
    ``worker_enabled`` 尤其重要：**内嵌消费线程关掉时任务不会自己跑**——
    这是"任务一直排队"最常见的原因，界面必须能解释它。

    成员（v10）看不到这里：总览包含全局运维信息（有没有别的任务在跑、
    worker 状态），那是管理员的视角。成员的任务在列表里已经够用。
    """
    if caller.user is not None and not caller.is_admin:
        raise ForbiddenError("运行态总览需要管理员身份")
    overview = services.observability.overview()
    # worker 是**启动期**开关（KYLAB_RUN_WORKER，见 main.py），不是运行期设置——
    # 它决定进程里到底有没有那个消费协程，改它要重启，所以从 Settings 读
    return HealthOverviewOut.model_validate(
        {**overview, "worker_enabled": get_settings().run_worker}
    )
