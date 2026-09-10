"""任务端点（M4）：任务中心的数据来源。

界面需要看到"哪些任务在跑、卡在哪一步、重试了几次"（架构 §12 可观测性），
所以任务响应里带上 attempts / max_attempts / error / 租约到期时间。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.v1.schemas import TaskList, TaskOut
from app.core.services import Services, get_services
from app.models.enums import TaskState

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("", response_model=TaskList, summary="任务列表")
async def list_tasks(
    state: TaskState | None = Query(default=None, description="按状态过滤"),
    services: Services = Depends(get_services),
) -> TaskList:
    return TaskList(
        items=[TaskOut.model_validate(task) for task in services.documents.list_tasks(state)]
    )
