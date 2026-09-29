"""站点图标端点（D11-②）：给"网页 logo"一个**我们自己的源**。

前端只请求这一条，浏览器不再直连第三方站点（隐私与稳定，理由见
``services/site_icons.py`` 的模块说明）。端点本身很小——判断与缓存都在服务层。

**为什么是"取 blob"而不是让 `<img src>` 直接指过来**：这一组端点要凭据（v0.11 起
`/api/v1` 一律要），而 `<img>` 带不了 ``Authorization`` 头；换签名又要在客户端按图标
逐个签发。前端用 ``fetch`` + ``Blob`` + ``ObjectURL``：既有凭据，又不会因为 404
在控制台留下一条"加载图片失败"（取不到就走字母牌）。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from app.api.auth import require_read
from app.core.exceptions import NotFoundError
from app.core.services import Services, get_services
from app.services.api_key import Caller
from app.services.site_icons import SiteIconService

router = APIRouter(prefix="/site-icons", tags=["site-icons"])


@router.get(
    "",
    response_class=Response,
    summary="站点图标（本机缓存，取不到回 404 由前端退回字母牌）",
)
def site_icon(
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
    domain: str = Query(description="站点域名（必须是已知站点表里的，见 services/site_icons）"),
) -> Response:
    """按域名发一枚图标（png / jpeg / gif / ico / webp，按魔数嗅探后才发）。

    - **不在已知站点表里 → 422**：这条接口不代为抓任意域名（别当跳板用）；
    - **表里但抓不到 → 404**：正常的降级路径，前端退回字母牌，不报错、不留空位；
    - 缓存命中时不发任何外部请求；响应带一天浏览器缓存。
    """
    icon = SiteIconService(services.runtime.data_dir).icon(domain)
    if icon is None:
        raise NotFoundError(f"这个站点暂时取不到图标：{domain}")
    return Response(
        content=icon.content,
        media_type=icon.media_type,
        headers={
            # 一天：图标是低频变化的东西，而我们自己那边还有 30 天的磁盘缓存
            "Cache-Control": "public, max-age=86400",
            # 位图仍然按嗅探结果发，明确禁止浏览器再猜一次类型
            "X-Content-Type-Options": "nosniff",
        },
    )
