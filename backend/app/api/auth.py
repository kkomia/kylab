"""请求级鉴权依赖（《架构设计 v0.2》§3.2）。

两种凭据，一个入口：

- **控制台令牌**（``KYLAB_CONSOLE_TOKEN``）：Web 控制台用，管理员身份，不受库范围限制；
- **API Key**：给外部程序用，绑定知识库范围 + 只读/读写。

为什么要有控制台令牌：控制台要能打开设置页，而设置页里就是 embedding / LLM 的密钥。
**外部 API Key 绝不该能读设置**（那等于把凭据发给每一个集成方），
所以"能进控制台"必须是一种比 API Key 更高的身份，而不是同一把钥匙的另一个权限档。

三处刻意的决定：

1. **默认关闭鉴权**。本机单人开发时每次请求都要带令牌纯属折磨，且默认开启会让
   升级后所有既有客户端立刻 401（最难排查的一类故障）。所以
   ``KYLAB_AUTH_ENABLED`` 默认为 false；**一旦设置了控制台令牌或创建过任何 API Key
   就自动生效**，不需要用户记得去翻开关——能配出凭据，就说明他要鉴权。

2. **只在 ``/api/v1`` 下生效**。健康探针（``/health``）与前端静态资源不鉴权：
   前者是容器编排用来判断存活的，带上鉴权会让 readiness 探针误判。

3. **失败快、文案钝**。缺令牌与令牌无效都回 401，且不区分原因（见 api_key.py）。
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends, Header

from app.core.config import Settings, get_settings
from app.core.exceptions import ForbiddenError, UnauthorizedError
from app.core.security import tokens_equal
from app.core.services import Services, get_services
from app.models.enums import ApiKeyPermission
from app.services.api_key import READ, WRITE, Caller

logger = logging.getLogger(__name__)

__all__ = [
    "CallerDep",
    "ConsoleDep",
    "ReadDep",
    "WriteDep",
    "auth_enabled",
    "check_kb_scope",
    "current_caller",
]


def auth_enabled(settings: Settings, services: Services) -> bool:
    """鉴权是否生效：显式开关、或已经配出了任何凭据。

    后两个条件很要紧——用户建了 API Key 却忘了开开关，等于建了一把不锁的门。

    每次请求查一次 ``list_api_keys()``：没有密钥时它就是一次空查询，
    比起"漏判导致裸奔"，这点开销换得的值。
    """
    if settings.auth_enabled:
        return True
    if console_token(settings, services):
        return True
    try:
        return bool(services.api_keys.list())
    except Exception:
        logger.warning("检查 API Key 列表失败，本次按未启用鉴权处理", exc_info=True)
        return False


def _bearer(authorization: str | None) -> str | None:
    """从 ``Authorization: Bearer <token>`` 里取令牌。"""
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def current_caller(
    services: Annotated[Services, Depends(get_services)],
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
) -> Caller:
    """解析调用主体。

    鉴权未启用时直接放行成"控制台"身份——这样本机开发不必配任何东西，
    而一旦配了凭据，同一条路径立即开始强制校验。
    """
    if not auth_enabled(settings, services):
        return Caller(is_console=True)

    token = _bearer(authorization)
    if token is None:
        raise UnauthorizedError(
            "缺少凭据：请在请求头带上 Authorization: Bearer <API Key 或控制台令牌>"
        )

    # 先比控制台令牌。用定时安全比较；空的控制台令牌绝不能等于空请求令牌
    expected = console_token(settings, services)
    if expected and tokens_equal(token, expected):
        return Caller(is_console=True)

    return services.api_keys.authenticate(token)


CallerDep = Annotated[Caller, Depends(current_caller)]


def _check(
    services: Services,
    caller: Caller,
    *,
    need: ApiKeyPermission,
    kb_ids: list[str] | None = None,
) -> None:
    services.api_keys.check_access(caller, need=need, kb_ids=kb_ids)


def require_read(
    services: Annotated[Services, Depends(get_services)], caller: CallerDep
) -> Caller:
    """只读端点。"""
    _check(services, caller, need=READ)
    return caller


def require_write(
    services: Annotated[Services, Depends(get_services)], caller: CallerDep
) -> Caller:
    """写端点（上传、建库、删除、改设置）。"""
    _check(services, caller, need=WRITE)
    return caller


def require_console(caller: CallerDep) -> Caller:
    """控制台专属端点（设置页、API Key 管理）。

    **设置页必须是控制台身份**，不能只要求"读写权限"：
    它是 embedding / rerank / LLM 密钥的落点，而 `base_url` 可改——
    给了外部 API Key 就等于给了它一条"把 Bearer Token 转发到我的服务器"的路。
    封这条路的办法只有一个：外部密钥根本进不来这个端点。
    """
    if not caller.is_console:
        raise ForbiddenError(
            "该操作需要控制台令牌：外部 API Key 不能读写服务端凭据配置"
            "（否则改掉 base_url 就能截获你的 API Key）"
        )
    return caller


ReadDep = Annotated[Caller, Depends(require_read)]
WriteDep = Annotated[Caller, Depends(require_write)]
ConsoleDep = Annotated[Caller, Depends(require_console)]


def check_kb_scope(services: Services, caller: Caller, kb_ids: list[str] | None) -> None:
    """带库范围的作用域判定。

    不做成依赖，是因为它需要**已解析的请求体或路径参数**，而依赖拿不到；
    硬要拿就得把 body 模型也声明成依赖，签名会重复一遍。
    """
    services.api_keys.check_access(caller, kb_ids=kb_ids)


#: 控制台令牌在 app_settings 里的键。存在库里而不是只读 .env，
#: 是为了让"第一次进入控制台"这件事能就地完成（见下面 console_token 的说明）。
#: noqa 的理由：这是**键名**不是口令，S105 按变量名里含 token 误报。
CONSOLE_TOKEN_SETTING = "auth.console_token"  # noqa: S105


def console_token(settings: Settings, services: Services) -> str | None:
    """当前生效的控制台令牌：库里的优先，其次 .env。

    为什么要能存在库里：否则会有一个真实的死锁——鉴权在"库里出现第一把 API Key"时
    自动生效，而设置页与密钥管理只认控制台令牌，于是"凭据关着时建了一把钥匙"
    就把自己锁在门外，**没有任何恢复途径**（要用令牌才能拿到令牌）。
    实测踩到过：建完 key 之后 GET /knowledge-bases 与 GET /api-keys 双双 401。

    库里的值可以就地设置（``POST /auth/console-token``），而那个入口只在
    **两个来源都为空**时开放；设过一次即关闭，所以它不是后门。
    """
    try:
        stored = services.runtime.get(CONSOLE_TOKEN_SETTING)
    except Exception:
        logger.warning("读取控制台令牌失败，退回环境变量", exc_info=True)
        stored = None
    return stored or settings.console_token or None


def bootstrap_allowed(settings: Settings, services: Services) -> bool:
    """是否允许初始化控制台令牌（仅当两个来源都还没有值时）。"""
    return console_token(settings, services) is None
