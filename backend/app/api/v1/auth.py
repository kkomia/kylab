"""控制台令牌的初始化（首次进入控制台用）。

**为什么需要这个端点**：鉴权会在"库里出现第一把 API Key"时自动生效，而设置页与
密钥管理只认控制台令牌——于是"凭据关着时建了一把钥匙"会把自己锁在门外，
而且没有任何恢复途径（要用令牌才能拿到令牌）。实测踩到过：建完 key 之后
``GET /knowledge-bases`` 与 ``GET /api-keys`` 双双 401。

所以留一个**一次性**入口：仅在"库里与 .env 都没有令牌"时开放。
设过一次即永久关闭（见 ``bootstrap_allowed``），因此它不是后门——
在一个本来就无鉴权的系统上允许设置第一把钥匙，不绕过任何东西。

令牌**明文存库**（不是摘要），这是一处刻意的例外，理由在 ``init_console_token`` 里。
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.auth import CONSOLE_TOKEN_SETTING, bootstrap_allowed
from app.core.config import Settings, get_settings
from app.core.exceptions import ConflictError
from app.core.security import generate_token
from app.core.services import Services, get_services

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

#: 控制台令牌不用 ``kylab_sk_`` 前缀：那个前缀是给"会被到处粘贴的集成密钥"用的，
#: 控制台令牌只在一台机器的浏览器里用，混用前缀会让两类凭据看起来一样。
#: noqa 的理由：这是**前缀**不是口令，S105 按变量名含 token 误报。
CONSOLE_TOKEN_PREFIX = "kylab_console_"  # noqa: S105


class BootstrapStatusOut(BaseModel):
    """是否还能初始化（控制台据此决定显示"首次设置"还是"输入令牌"）。"""

    needs_token: bool
    auth_enabled: bool


class ConsoleTokenIn(BaseModel):
    token: str | None = Field(default=None, min_length=16)
    """留空表示由服务端生成（推荐：长度与随机性由服务端保证）。"""


class ConsoleTokenOut(BaseModel):
    token: str
    """**只在这一次响应里出现**。丢了只能重置（改 app_settings 里那个键）。"""


@router.get("/status", response_model=BootstrapStatusOut, summary="控制台令牌是否已初始化")
def status(
    settings: Annotated[Settings, Depends(get_settings)],
    services: Annotated[Services, Depends(get_services)],
) -> BootstrapStatusOut:
    """**不鉴权**：前端要靠它判断该显示登录界面还是首次设置界面。

    它只回两个布尔值，不透露任何可用信息。
    """
    needs = bootstrap_allowed(settings, services)
    return BootstrapStatusOut(needs_token=needs, auth_enabled=not needs)


@router.post(
    "/console-token",
    response_model=ConsoleTokenOut,
    summary="首次设置控制台令牌（仅在尚未设置时可用）",
)
def init_console_token(
    payload: ConsoleTokenIn,
    settings: Annotated[Settings, Depends(get_settings)],
    services: Annotated[Services, Depends(get_services)],
) -> ConsoleTokenOut:
    """初始化控制台令牌。

    **这里存明文，是全项目唯一一处**，理由是它必须能被比对：
    用户从浏览器里送来的就是明文，而"鉴定它是否正确"只有两条路——
    存明文直接比，或存摘要后比对摘要。后者其实更标准，但会让"用户忘了令牌要找回"
    变得不可能（摘要不可逆）；而控制台令牌是**单机自用**的一把钥匙，
    它不是发给第三方的凭据，泄露面就是"能读到这台机器 SQLite 的人"——
    那个人本来就能拿到 embedding / LLM 的 API Key。

    结论：**API Key 一律只存摘要**（那是要发给外部集成的），
    控制台令牌存明文以便找回。这个区别是有意的，不是疏忽。
    """
    if not bootstrap_allowed(settings, services):
        # 409 而不是 403：这不是权限问题，是状态问题——令牌已经设过了
        raise ConflictError(
            "控制台令牌已设置过，此入口已关闭。"
            f"如需重置，请清空 app_settings 里的 {CONSOLE_TOKEN_SETTING}"
        )

    token = payload.token or (CONSOLE_TOKEN_PREFIX + generate_token().removeprefix("kylab_sk_"))
    services.runtime.set({CONSOLE_TOKEN_SETTING: token})
    logger.warning("已初始化控制台令牌：此后 /api/v1 需要凭据")
    return ConsoleTokenOut(token=token)
