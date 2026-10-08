"""库范围准入判定：**本机只剩一个入口、一种主体**（《架构设计 v0.2》§3.2）。

架构原先给的约定是两句：**绑定知识库范围** + **只读 / 读写两种权限**。本机档里这两句
只剩前半句的形状——能打到边车那个端口的就是这台机器的主人
（`api/auth.py::current_caller`），他是管理员档、**不受库范围限制**，所以判定直接放行。
发放、校验、成员与分享那一套（`create` / `authenticate` / `visible_kb_ids` /
`can_write`）随知识库产品剥离一起删了：`api_keys` / `shares` 两张表本机库里没有，
范围在这里判不出来。

**身份契约不在这里**：`Caller` / `READ` / `WRITE` / `LOCAL_CALLER` / `LOCAL_USER_ID`
住在 `app.core.caller`——它们是两侧共用的契约（KB 侧判准入、Agent 侧拿它当类型并判
`WRITE`），与"发钥匙/校验"那套实现分开。本模块从那里 import 进来并在 `__all__` 里
再导出，**调用点一行没动**。

**为什么留着这一层而不是把依赖删掉**：`api/auth.py` 的 `require_read` /
`require_write`、工具执行器与若干端点都走 ``check_access``，于是"谁有权碰这个库"
**只有一处定义**。散到各端点去早晚会出现"某个端点忘了判"的洞——这类洞不会报错，
只会静默放行。
"""

from __future__ import annotations

from app.core.caller import LOCAL_CALLER, LOCAL_USER_ID, READ, WRITE, Caller
from app.core.exceptions import ForbiddenError
from app.models.enums import ApiKeyPermission

__all__ = [
    "LOCAL_CALLER",
    "LOCAL_USER_ID",
    "READ",
    "WRITE",
    "ApiKeyService",
    "Caller",
]


class ApiKeyService:
    """把"这次调用能不能碰这些库"收在一处。"""

    def check_access(
        self,
        caller: Caller,
        *,
        need: ApiKeyPermission = READ,
        kb_ids: list[str] | None = None,
    ) -> None:
        """判定"这次调用能不能碰这些库"。不通过就抛 403。

        ``kb_ids`` 传 ``None`` 表示"不涉及具体知识库"（例如列全部任务）；
        ``need`` 是 ``READ`` / ``WRITE`` 之一（本机档两者同档，留着是为了调用点不必改）。

        **本机只有一种主体**：`LOCAL_CALLER` 是管理员档，直接放行，**一个仓储方法都不碰**
        （本机库里连 `api_keys` 那张表都没有）。其余形态一律拒绝——构造上不该出现，
        真出现说明有人绕过了 `current_caller`；而范围既然判不出来，默认值只能是"不通过"。
        """
        if caller.is_admin:
            return  # 本机主人不受库范围限制
        raise ForbiddenError(
            "调用主体不是本机主人：本机档只认这一种身份"
            "（能打到这个端口的只有这台机器的主人）"
        )
