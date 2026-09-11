"""认证端点：控制台令牌初始化（旧）+ 账号引导与登录（v10 起的主路径）。

**为什么需要 console-token 这个端点**：鉴权会在"库里出现第一把 API Key"时
自动生效，而设置页与密钥管理只认控制台令牌——于是"凭据关着时建了一把钥匙"
会把自己锁在门外，而且没有任何恢复途径（要用令牌才能拿到令牌）。
实测踩到过：建完 key 之后 ``GET /knowledge-bases`` 与 ``GET /api-keys`` 双双 401。

v10 起的主路径是账号：``POST /auth/setup`` 一次性创建管理员（认领无主老数据），
之后 ``POST /auth/login`` 换会话令牌。两个入口都是**一次性/限流**的，
不会成为后门。

令牌**明文存库**（不是摘要），这是一处刻意的例外，理由在 ``init_console_token`` 里。
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.auth import CONSOLE_TOKEN_SETTING, CallerDep, bootstrap_allowed
from app.core.config import Settings, get_settings
from app.core.exceptions import ConflictError, UnauthorizedError
from app.core.security import generate_token
from app.core.services import Services, get_services
from app.services.auth import MIN_PASSWORD_CHARS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

#: 控制台令牌不用 ``kylab_sk_`` 前缀：那个前缀是给"会被到处粘贴的集成密钥"用的，
#: 控制台令牌只在一台机器的浏览器里用，混用前缀会让两类凭据看起来一样。
#: noqa 的理由：这是**前缀**不是口令，S105 按变量名含 token 误报。
CONSOLE_TOKEN_PREFIX = "kylab_console_"  # noqa: S105


class BootstrapStatusOut(BaseModel):
    """前端据此决定显示"首次设置管理员"、"登录"还是直接进入。"""

    needs_token: bool
    auth_enabled: bool
    needs_setup: bool
    """还没有任何可登录账号（v10）。为真时控制台应进入首次设置向导。"""


class ConsoleTokenIn(BaseModel):
    token: str | None = Field(default=None, min_length=16)
    """留空表示由服务端生成（推荐：长度与随机性由服务端保证）。"""


class ConsoleTokenOut(BaseModel):
    token: str
    """**只在这一次响应里出现**。丢了只能重置（改 app_settings 里那个键）。"""


# ---------------------------------------------------------------------- 账号（v10）


class SetupIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=MIN_PASSWORD_CHARS)
    name: str | None = Field(default=None, max_length=32)
    """显示名；留空用用户名。"""


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1)


class AccountOut(BaseModel):
    id: str
    username: str
    name: str
    role: str


class LoginOut(BaseModel):
    """登录/初始化成功。``token`` 只在这一次响应里出现。"""

    token: str
    user: AccountOut


def _account_out(user) -> AccountOut:  # type: ignore[no-untyped-def]
    return AccountOut(
        id=user.id,
        username=user.username or "",
        name=user.name,
        role=user.role.value,
    )


@router.get("/status", response_model=BootstrapStatusOut, summary="认证状态（是否需初始化/登录）")
def status(
    settings: Annotated[Settings, Depends(get_settings)],
    services: Annotated[Services, Depends(get_services)],
) -> BootstrapStatusOut:
    """**不鉴权**：前端要靠它判断该显示登录界面还是首次设置界面。

    它只回布尔值，不透露任何可用信息。
    """
    needs = bootstrap_allowed(settings, services)
    try:
        needs_setup = not services.auth.has_accounts()
    except Exception:
        # 与 auth_enabled 同一口径：存储层抽风时按"已有账号"处理——
        # 误开初始化入口是后门，误关只是让用户走登录页
        logger.warning("检查账号状态失败，按已有账号处理", exc_info=True)
        needs_setup = False
    return BootstrapStatusOut(
        needs_token=needs,
        auth_enabled=not needs,
        needs_setup=needs_setup,
    )


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


@router.post("/setup", response_model=LoginOut, summary="首次初始化：创建管理员账号")
def setup(
    payload: SetupIn,
    services: Annotated[Services, Depends(get_services)],
) -> LoginOut:
    """仅当**还没有任何账号**时开放（服务层把关），首个账号即管理员，
    无主老数据（v10 之前的库与会话）认领给它。"""
    result = services.auth.setup(
        username=payload.username, password=payload.password, name=payload.name
    )
    return LoginOut(token=result.token, user=_account_out(result.user))


@router.post("/login", response_model=LoginOut, summary="登录（用户名 + 密码）")
def login(
    payload: LoginIn,
    services: Annotated[Services, Depends(get_services)],
) -> LoginOut:
    """换一条会话令牌（7 天滑动续期）。连续失败会被限流（服务层）。"""
    result = services.auth.login(username=payload.username, password=payload.password)
    return LoginOut(token=result.token, user=_account_out(result.user))


@router.post("/logout", status_code=204, summary="退出登录（吊销当前会话）")
def logout(
    caller: CallerDep,
    services: Annotated[Services, Depends(get_services)],
) -> None:
    # 只有会话能"退出"：API Key 要走撤销端点，控制台令牌要改配置
    if caller.session_id is None:
        raise UnauthorizedError("当前凭据不是登录会话，无需退出")
    services.auth.logout(caller.session_id)


@router.get("/me", response_model=AccountOut, summary="当前登录账号")
def me(caller: CallerDep) -> AccountOut:
    """前端启动时用它恢复身份。控制台令牌/API Key 通道没有账号，回 401。"""
    if caller.user is None:
        raise UnauthorizedError("当前凭据不是登录会话")
    return _account_out(caller.user)


class PasswordChangeIn(BaseModel):
    old_password: str = Field(min_length=1)
    new_password: str = Field(min_length=MIN_PASSWORD_CHARS)


class PasswordChangeOut(BaseModel):
    revoked_sessions: int
    """改密后被吊销的其他会话数（当前这条保住）。"""


@router.post("/password", response_model=PasswordChangeOut, summary="修改自己的密码")
def change_password(
    payload: PasswordChangeIn,
    caller: CallerDep,
    services: Annotated[Services, Depends(get_services)],
) -> PasswordChangeOut:
    if caller.user is None or caller.session_id is None:
        raise UnauthorizedError("当前凭据不是登录会话，无法改密")
    revoked = services.auth.change_password(
        caller.user,
        old_password=payload.old_password,
        new_password=payload.new_password,
        keep_session_id=caller.session_id,
    )
    return PasswordChangeOut(revoked_sessions=revoked)
