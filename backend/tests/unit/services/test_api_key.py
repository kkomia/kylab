"""调用主体与存取判定：这一档**只有一种主体**。

镜像同构：``app/services/api_key.py`` → ``tests/unit/services/test_api_key.py``。

原先这份用例钉的是账号体系那一套（API Key 的作用域、成员与分享的读写档）——
那套东西随知识库产品剥离一起搬走了：本仓库这个进程只监听 127.0.0.1、跑在用户
自己的机器上，**能打到那个端口的就是这台机器的主人**（`api/auth.py::current_caller`
恒返回 `LOCAL_CALLER`）。所以这里只钉还成立的那几条：

1. 本机主人是管理员档：`check_access` 直接放行——而且服务本身**没有任何存储入口**
   （`ApiKeyService` 连构造函数都没有）；
2. 非本机主人一律 403：本机库里判不出库范围（没有 `api_keys` / `shares` 两张表），
   判不出来就拒绝；
3. `require_admin` 那道闸对它也是放行——"本机不设门禁"这句话要能被验；
4. 判定**只有一处**：端点的依赖最终都走到 `ApiKeyService.check_access`，
   不是在协议层各写一遍。
"""

from __future__ import annotations

import pytest

from app.core.caller import LOCAL_USER_ID
from app.core.exceptions import ForbiddenError
from app.services.api_key import LOCAL_CALLER, READ, WRITE, ApiKeyService, Caller


@pytest.fixture
def service() -> ApiKeyService:
    return ApiKeyService()


def test_the_local_caller_is_the_machine_owner() -> None:
    """`LOCAL_CALLER` 就是"管理员会话"那一档：本机没有第二种主体。"""
    assert LOCAL_CALLER.is_admin is True
    # `user` **不是** None：协议层若干处默认调用者是一个账号（`caller.user.id`），
    # 给它一个真的 `UserRecord` 比到处判空更稳（那句"本机主人"也是界面上显示的名字）。
    assert LOCAL_CALLER.user is not None
    assert LOCAL_CALLER.user.id == LOCAL_USER_ID
    assert LOCAL_CALLER.owner_id is None, "共享桶：记忆与笔记按账号分目录，本机不分"


def test_current_caller_returns_it_without_looking_at_headers() -> None:
    """`api/auth.py::current_caller` 不看请求头——带着别处的令牌也还是本机主人。"""
    from app.api.auth import current_caller

    assert current_caller() is LOCAL_CALLER


@pytest.mark.parametrize("need", [READ, WRITE])
def test_access_check_passes_for_the_local_owner(service: ApiKeyService, need) -> None:  # type: ignore[no-untyped-def]
    """本机主人放行：两种权限档都不抛。"""
    service.check_access(LOCAL_CALLER, need=need)


def test_a_non_owner_is_refused(service: ApiKeyService) -> None:
    """**不是本机主人 → 403**（默认值是"不通过"）。

    本机库里没有 `api_keys` / `shares` 两张表，范围判不出来；判不出来就拒绝，
    不能因为"没有依据"而放行——那是一个不会报错的洞。
    """
    from app.storage.base import UserRecord

    stranger = Caller(user=UserRecord(id="u_1", name="别人", username="u1"))

    with pytest.raises(ForbiddenError):
        service.check_access(stranger, need=READ)


def test_the_admin_gate_also_passes() -> None:
    """`require_admin` 那道闸对本机主人放行（设置页 / 模型注册那些端点靠它）。"""
    from app.api.auth import require_admin

    assert require_admin(LOCAL_CALLER) is LOCAL_CALLER


def test_a_member_shape_is_still_honest_about_being_a_member() -> None:
    """`Caller` 仍然分得出"成员"这一档——本机不用它，但判定本身不能撒谎。

    留着这条是因为它是"哪种主体"这件事唯一的定义（`Caller.owner_id` /
    `is_admin` 两处派生都从它算）。
    """
    from app.storage.base import UserRecord

    member = Caller(user=UserRecord(id="user_m", name="成员", username="m"))

    assert member.is_admin is False
    assert member.owner_id == "user_m"
