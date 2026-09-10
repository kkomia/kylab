"""统计端点：驾驶舱的数据源。

一个接口给全量数字，而不是拆成七八个——驾驶舱要同时渲染五六块图，
分开请求既慢又容易"上半页是新的、下半页是旧的"。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.auth import require_read
from app.api.v1.schemas import DashboardOut
from app.core.services import Services, get_services
from app.services.api_key import Caller
from app.services.stats import DEFAULT_WINDOW_DAYS

router = APIRouter(tags=["stats"])

MAX_WINDOW_DAYS = 365


@router.get("/stats/dashboard", response_model=DashboardOut, summary="驾驶舱统计")
async def dashboard(
    window_days: int = Query(
        default=DEFAULT_WINDOW_DAYS,
        ge=7,
        le=MAX_WINDOW_DAYS,
        description="活跃度观察窗口（天）",
    ),
    services: Services = Depends(get_services),
    _: Caller = Depends(require_read),
) -> DashboardOut:
    stats = services.stats.dashboard(window_days=window_days)
    return DashboardOut.model_validate(stats)
