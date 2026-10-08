"""请求身份契约：一次调用**是谁在调**（《架构设计 v0.2》§3.2）。

两侧都要它，所以它住共享底座：

- **KB 侧**：`services/api_key.py` 的 `check_access` 按它判准入；
- **Agent 侧**：每个 api 模块拿它当 `Depends` 的类型、判 `WRITE`；工具执行器、
  会话/笔记/记忆的归属都从它取（`owner_id`）。

**为什么与实现分家**（2026-10-08 剥离阶段 0 的那一刀）：账号体系的实现（发钥匙、
校验、库范围判定）随 KB 走，而这份**契约**是两侧共用的——契约与实现同住
`services/api_key.py` 时，Agent 侧十几个模块 import 一个 KB 域模块，
在域间引用检查里全被算成越界（报告第 10.1 节）。搬到这里之后：

- 需要契约的模块从 `app.core.caller` 取（Agent 侧 + 共享侧）；
- KB 侧调用点一行没动：`services/api_key.py` 仍从 `__all__` 再导出这几个名字。

**`Caller` 的派生属性（`owner_id`）也在这份契约里**，而不是散到调用点：它已经有过
几份副本，而"同一份数据在两个页面里看到的不是同一份"这类不一致极难查
（见 `owner_id` 的说明）。
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.enums import ApiKeyPermission, UserRole
from app.storage.base import UserRecord

__all__ = [
    "LOCAL_CALLER",
    "LOCAL_USER_ID",
    "READ",
    "WRITE",
    "Caller",
]

READ = ApiKeyPermission.READONLY
"""语义别名：``check_access`` 的入参用它，读起来比枚举原名清楚。"""

WRITE = ApiKeyPermission.READWRITE


@dataclass(frozen=True, slots=True)
class Caller:
    """一次调用的主体。

    本机档只有一种形态（`LOCAL_CALLER`，管理员档）。``is_admin=False`` + 带 ``user``
    那一档今天只在用例里出现，留着是因为"归属按账号算"这条口径要有地方落
    （见 `owner_id`）。
    """

    #: **不受库范围限制**那一档（本机主人就是它，见 `services/api_key.py::check_access`）。
    #: 与"有没有账号"是两件事：本机主人也有一个 `user`。
    is_admin: bool = False
    #: 这次调用归属的账号。本机主人有一个真的 ``UserRecord``——协议层若干处默认
    #: 调用者是账号（``caller.user.id``），比到处判空更稳。
    user: UserRecord | None = None
    #: 当前会话 id（明文 token 的哈希）。退出登录、改密吊销都要定位到它
    session_id: str | None = None

    @property
    def owner_id(self) -> str | None:
        """这一轮该按**谁**的归属去读写（知识库、会话、笔记、工作区、记忆、能力）。

        普通成员 → 自己的账号；本机主人（管理员档）→ ``None``（共享桶）。

        口径写在这里、不写在各调用点：它已经有过三份副本（对话的记忆归属、
        MCP 端点、工具执行器），而这三处必须**完全一致**——只要有一处判成了别人，
        表现就是"同一份数据在两个页面里看到的不是同一份"，那种不一致极难查。
        """
        if self.user is not None and not self.is_admin:
            return self.user.id
        return None


LOCAL_USER_ID = "local-owner"
"""本机档"本机主人"在库里的 id（M2 §4.1：本机运行时不设门禁）。"""

LOCAL_CALLER = Caller(
    is_admin=True,
    user=UserRecord(id=LOCAL_USER_ID, name="本机主人", role=UserRole.ADMIN),
)
"""**本机档**（桌面壳的边车进程）唯一的调用主体，见 `app/api/auth.py::current_caller`。

三处口径：

- ``is_admin=True``：这里是"**不受库范围限制**"那个意思（见 `check_access` 的第一行）。
  本机没有账号体系（``users`` / ``sessions`` 两张表都不在本机库里，见 v0.3 §8-1），
  而能打到边车那个端口的只有这台机器的主人；
- ``owner_id`` 因此是 ``None``（共享桶）——本机只有一个人，不存在"别人的数据"，
  于是会话 / 笔记 / 记忆的归属天然一致；
- ``user`` 不是 ``None``：协议层若干处默认调用者是一个账号（`caller.user.id`），
  给它一个真的 `UserRecord` 比到处判空更稳（那句"本机主人"也是界面上能显示的名字）。

**这是一个可以共享的不可变对象**（`Caller` 是 frozen dataclass），每个请求给同一个就行。
"""
