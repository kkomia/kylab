"""请求级鉴权依赖：**一句话是"打得到本机端口的就是这台机器的主人"**。

这个进程只监听 127.0.0.1、跑在用户自己的机器上，所以没有账号体系也不该有：
能打到那个端口的就是主人。于是 ``current_caller`` 恒返回 `api_key.LOCAL_CALLER`，
**不看 ``Authorization``**——带着别处的令牌打本机也不该被当成另一种身份。

**门禁那套东西（登录会话 / API Key / 成员与分享）随知识库产品剥离搬走了**，
留下来的只有两件：

1. ``require_read`` / ``require_write`` 这两道依赖**仍然在**（端点签名上写着它们），
   它们做的事是调 `ApiKeyService.check_access`——而本机这个主体是管理员，
   那一步直接放行。留着它而不是把依赖删掉：**"谁有权碰这个库"这件事只有一处定义**
   才不会漂，哪天真的接进第二个主体，判定不用重写。
2. **签名密钥**（``signing_secret`` / ``signing_secret_or_raise``）：下载链接要它，
   而"有没有配"与用户凭据毫无关系——所以缺了回 **503**（我们这边没配好），
   不是 401（那样前端会把人踢到登录页，而问题根本不在登录）。
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends

from app.core.config import Settings
from app.core.exceptions import ForbiddenError, ServiceUnavailableError
from app.core.services import KbServices, Services, get_kb_services
from app.core.signing import URL_SIGNING_SECRET_SETTING
from app.models.enums import ApiKeyPermission
from app.services.api_key import LOCAL_CALLER, READ, WRITE, Caller

logger = logging.getLogger(__name__)

__all__ = [
    "AdminDep",
    "CallerDep",
    "ReadDep",
    "WriteDep",
    "check_kb_scope",
    "current_caller",
]


def current_caller() -> Caller:
    """本机主人。**没有第二种主体**，也不看请求头。

    为什么不做成"没有凭据就 401"：这一档没有账号体系可验（那两张表不在这份库里），
    而 401 会让前端跳登录页——那一页早就删了。真要限权，手段是"别让进程监听
    0.0.0.0"（`Settings.host` 默认就是 127.0.0.1，壳起边车时也不给别的值）。
    """
    return LOCAL_CALLER


CallerDep = Annotated[Caller, Depends(current_caller)]


def _check(
    services: KbServices,
    caller: Caller,
    *,
    need: ApiKeyPermission,
    kb_ids: list[str] | None = None,
) -> None:
    services.api_keys.check_access(caller, need=need, kb_ids=kb_ids)


def require_read(
    services: Annotated[KbServices, Depends(get_kb_services)], caller: CallerDep
) -> Caller:
    """只读端点。"""
    _check(services, caller, need=READ)
    return caller


def require_write(
    services: Annotated[KbServices, Depends(get_kb_services)], caller: CallerDep
) -> Caller:
    """写端点（上传、建库、删除、改设置）。"""
    _check(services, caller, need=WRITE)
    return caller


def require_admin(caller: CallerDep) -> Caller:
    """管理员专属端点（设置页、模型注册、插件与技能、沙箱执行、工作区浏览/建目录）。

    **必须是管理员会话**，不能只要求"读写权限"：
    这些端点里是 embedding / rerank / LLM 的密钥与外部服务地址，而地址可改——
    拿到写权限就等于拿到一条转发凭据的路。
    """
    if not caller.is_admin:
        raise ForbiddenError(
            "该操作需要管理员权限：外部 API Key 不能读写服务端凭据配置"
            "（否则改掉 base_url 就能截获你的 API Key）"
        )
    return caller


ReadDep = Annotated[Caller, Depends(require_read)]
WriteDep = Annotated[Caller, Depends(require_write)]
AdminDep = Annotated[Caller, Depends(require_admin)]


def check_kb_scope(
    services: KbServices,
    caller: Caller,
    kb_ids: list[str] | None,
    *,
    need: ApiKeyPermission = READ,
) -> None:
    """带库范围的作用域判定。

    不做成依赖，是因为它需要**已解析的请求体或路径参数**，而依赖拿不到；
    硬要拿就得把 body 模型也声明成依赖，签名会重复一遍。

    ``need``：写端点必须传 ``WRITE``——成员拿到的分享可能是只读档，
    只按"看得见"判定会让只读分享变成可写（回归测试钉在 test_visibility_api）。
    """
    services.api_keys.check_access(caller, need=need, kb_ids=kb_ids)


def signing_secret(settings: Settings, services: KbServices | Services) -> str | None:
    """下载签名用的密钥：专用密钥（库 / 环境变量），**没有别的来源**。

    都为 None 时返回 None，表示不允许签发——那条路径上没有任何凭据体系能提供
    "这条链接只该给他"的依据，与其发一条永远有效的链接，不如让调用方走需要鉴权的
    常规接口（API 层据此拒绝）。

    首次 ``POST /auth/setup`` 会生成一条落库，**本机档则在组合根生成一次**
    （见 ``services/auth.ensure_url_signing_secret`` 与 ``core/services.py`` 那一段；
    本机档没有初始化流程，不在装配时补这一下这条键就永远是空的）。

    **形参收两个根**（2026-10-08 拆组合根）：它只取共享底座的 `services.runtime`，
    而调用它的既有 KB 侧（文档下载）也有 Agent 侧（会话/笔记的图片与产物下载），
    两边给各自手上的根都对。写成 `KbServices | Services` 是为了让这条"只碰共享件"
    的事实留在签名上，而不是逼调用方多写一次 `.kb`。
    """
    try:
        stored = services.runtime.get(URL_SIGNING_SECRET_SETTING)
    except Exception:
        logger.warning("读取签名密钥失败，退回环境变量", exc_info=True)
        stored = None
    return stored or settings.url_signing_secret


def signing_secret_or_raise(settings: Settings, services: KbServices | Services) -> str:
    """要签名密钥；**没有就抛 503**（不是 401）。

    与 :func:`signing_secret` 的分工：那个返回 ``None`` 让调用方自己决定（有一处**故意**
    不报错：预览时没有密钥就退化成"只能下载"，见 ``api/v1/documents.py`` 的 binary 那条）；
    这个给"必须签发 / 必须校验"的那些端点用。形参同样收两个根，理由见上面那条。

    **为什么不是 401**（桌面壳里实测到的那次故障）：前端把 401 当"登录失效"并跳登录页
    ——那是设计。而"这台机器还没有下载签名密钥"根本与用户的凭据无关，是**我们这边没配好**：
    本机档（边车）没有初始化流程，密钥要么由组合根生成、要么这台机器真的没有可用的库。
    踢到登录页只会让人以为账号出了问题，而正确的下一步是"补配置 / 稍后重试"。
    503 正是这个语义（``ServiceUnavailableError``：这个部署现在没有这个能力）。
    """
    secret = signing_secret(settings, services)
    if not secret:
        raise ServiceUnavailableError(
            "尚未配置下载签名密钥：请在环境里配置 KYLAB_URL_SIGNING_SECRET，"
            "或让这台机器正常启动一次（本机档会在装配时生成一条并落库；"
            "服务器档由首次初始化生成）"
        )
    return secret
