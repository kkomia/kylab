"""API Key 的发放、校验与作用域判定（《架构设计 v0.2》§3.2）。

架构给的约定只有两句：**绑定知识库范围**（可指定单个/多个库）**+ 只读 / 读写两种权限**。
本模块把这两句落成可执行的判断，其余（怎么放进 HTTP 请求、怎么回显）交给协议层。

三处刻意的设计：

1. **校验走"哈希查库"而不是"取全部再逐把比对"**。前者是 O(1) 索引查询，
   后者在密钥变多后既慢又会把全部摘要读进内存。

2. **作用域判定只有一个入口 ``check_access``**。权限与范围的组合判断散落到各个
   端点里，早晚会出现"某个端点忘了判"的洞——这类洞不会报错，只会静默放行。

3. **``使用时间`` 的更新是"尽力而为"**。它只用于界面展示，写失败不该让一次正常请求
   失败；所以这里吞掉异常并记日志，而不是让它冒到调用方。

**已知缺口（架构未要求，但要说清楚）**：API Key 目前**没有有效期**，
只能靠"撤销后重发"轮换。若要加过期，落点是 ``ApiKeyRecord`` 加一列 +
本模块 ``authenticate`` 里判一次——不需要动协议层。
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from app.core.exceptions import ForbiddenError, UnauthorizedError
from app.core.security import display_prefix, generate_token, hash_token
from app.models.enums import ApiKeyPermission
from app.storage.base import ApiKeyRecord, StoreBundle

__all__ = ["READ", "WRITE", "ApiKeyService", "Caller", "IssuedApiKey"]

logger = logging.getLogger(__name__)

READ = ApiKeyPermission.READONLY
"""语义别名：``check_access`` 的入参用它，读起来比枚举原名清楚。"""

WRITE = ApiKeyPermission.READWRITE


@dataclass(frozen=True, slots=True)
class IssuedApiKey:
    """创建结果：``token`` 是**唯一一次**出现的明文。"""

    record: ApiKeyRecord
    token: str


@dataclass(frozen=True, slots=True)
class Caller:
    """一次调用的主体。控制台令牌与 API Key 在这里统一成一种形状，
    免得下游每个地方都要判"这是哪种凭据"。"""

    #: 控制台令牌不是 API Key，没有记录；用它区分"管理员"与"受限调用方"
    is_console: bool = False
    api_key: ApiKeyRecord | None = None

    @property
    def permission(self) -> ApiKeyPermission | None:
        """``None`` 表示不受范围限制（仅控制台令牌如此）。"""
        return None if self.is_console else (self.api_key.permission if self.api_key else None)

    @property
    def knowledge_base_ids(self) -> tuple[str, ...]:
        if self.is_console or self.api_key is None:
            return ()
        return tuple(self.api_key.knowledge_base_ids)


class ApiKeyService:
    """把 API Key 的存储细节收在一处。"""

    def __init__(self, stores: StoreBundle) -> None:
        self._stores = stores

    # ------------------------------------------------------------------ 发放

    def create(
        self,
        *,
        name: str,
        permission: ApiKeyPermission,
        knowledge_base_ids: list[str] | None = None,
    ) -> IssuedApiKey:
        """发一把新钥匙。

        ``knowledge_base_ids`` 为空表示**该凭据可访问全部知识库**——
        与"绑定到空集合（什么都访问不了）"是两回事，所以这里显式区分：
        传 ``None``/空列表都按"不限范围"处理，并在返回的记录里保持空元组。
        """
        token = generate_token()
        record = ApiKeyRecord(
            id=f"key_{uuid.uuid4().hex[:12]}",
            name=name,
            key_hash=hash_token(token),
            permission=permission,
            knowledge_base_ids=tuple(knowledge_base_ids or ()),
            # 存一段前缀只为界面能分辨"哪把是哪把"；明文不入库
            key_prefix=display_prefix(token),
        )
        created = self._stores.meta.create_api_key(record)
        return IssuedApiKey(record=created, token=token)

    def list(self) -> list[ApiKeyRecord]:
        return self._stores.meta.list_api_keys()

    def revoke(self, key_id: str) -> None:
        self._stores.meta.delete_api_key(key_id)

    # ------------------------------------------------------------------ 校验

    def authenticate(self, token: str) -> Caller:
        """把明文凭据换成调用主体；无效即抛 401。

        错误文案**不区分**"前缀不对""长度不对""库里有没这条"——
        区分开等于给攻击者一个布尔预言机（"这个 key 存在但已撤销"是有用情报）。
        """
        if not token or not token.strip():
            raise UnauthorizedError("缺少 API Key：请在请求头带上 Authorization: Bearer <key>")

        record = self._stores.meta.get_api_key_by_hash(hash_token(token.strip()))
        if record is None:
            raise UnauthorizedError("API Key 无效或已被撤销")

        try:
            self._stores.meta.touch_api_key(record.id)
        except Exception:
            logger.warning("更新 API Key 使用时间失败（不影响本次调用）", exc_info=True)

        return Caller(api_key=record)

    def check_access(
        self,
        caller: Caller,
        *,
        need: ApiKeyPermission = READ,
        kb_ids: list[str] | None = None,
    ) -> None:
        """判定"这次调用能不能碰这些库"。不通过就抛 403。

        ``kb_ids`` 传 ``None`` 表示"不涉及具体知识库"（例如列全部任务），
        此时只判权限级别，不做范围收窄。

        越界时的报错**指出是哪个库**：用户配错了范围要能自己看出来，
        而库 ID 不是秘密（列表接口本来就能看到），提示它不额外泄露信息。
        """
        if caller.is_console:
            return  # 控制台令牌是管理员，不受库范围限制

        permission = caller.permission
        if permission is None:
            # 构造上不该出现（Caller 只有两种）。真出现说明有人绕过了 authenticate，
            # 这时**拒绝**而不是放行——安全判定的默认值必须是"不通过"
            raise UnauthorizedError("调用主体缺少权限信息")

        if need is WRITE and permission is not ApiKeyPermission.READWRITE:
            raise ForbiddenError("该 API Key 只有只读权限，本次操作需要读写权限")

        scope = caller.knowledge_base_ids
        if not scope:
            return  # 空范围 = 不受限（见 create 的说明）

        if kb_ids is None:
            return

        outside = [kb_id for kb_id in kb_ids if kb_id not in scope]
        if outside:
            raise ForbiddenError(
                "该 API Key 未授权访问知识库：" + "、".join(outside) + "（请检查密钥的绑定范围）"
            )

    def visible_kb_ids(self, caller: Caller) -> list[str] | None:
        """列出调用方能看到的库；``None`` 表示不受限（调用方不必再过滤）。"""
        if caller.is_console:
            return None
        scope = caller.knowledge_base_ids
        return list(scope) if scope else None
