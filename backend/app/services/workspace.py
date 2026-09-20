"""工作区（Agent 的项目，v0.15）。

见 ``docs/设计/Agent-工作区与能力层设计-v0.1.md`` §3。**工作区回答"在哪儿干活"**，
与**沙箱**（"试错的地方在哪"，见 ``services/sandbox.py``）是两个概念：

| | 工作区 | 沙箱 |
| --- | --- | --- |
| 生命周期 | 长期，用户拥有 | 一次会话，可丢弃 |
| 位置 | 用户指定的路径 | `data/sandbox/<conversation_id>/` |
| 内容 | 真实项目文件 | 临时脚本、中间产物 |

归属口径与知识库 / 会话完全一致（`owner_id`）：管理员与 API Key 通道
（``user is None``）看得到全部，普通成员只看自己的。**越权一律 404 而不是 403**
——后者会暴露"这个 id 存在"。

`root_path` 的三道校验都在 ``validate_root_path`` 里，那是本模块唯一的安全边界：
它决定了 Agent 的文件操作能落到磁盘的哪个位置。
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from pathlib import Path

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.storage.base import StoreBundle, WorkspaceRecord

__all__ = ["WorkspaceService", "validate_root_path"]

logger = logging.getLogger(__name__)

#: 名字长度上限。与知识库同一个量级（120），界面上都是单行标题。
MAX_NAME_CHARS = 120
MAX_DESCRIPTION_CHARS = 500


def validate_root_path(raw: str, *, data_dir: Path) -> str:
    """校验并规范化工作区根目录，返回**绝对路径字符串**。

    三道校验，缺一不可：

    1. **必须存在且是目录**。允许用户填一个还没建的路径听起来友好，但那样
       "工作区建好了却什么都读不到"会变成一个要查很久的现象——不如当场说清。
    2. **拒绝文件系统根与系统关键目录**。把工作区设成 ``/`` 或 ``C:\\`` 等于
       把整台机器交给 Agent 的文件操作，而这不是"配置错了"，是**权限事故**。
    3. **拒绝指向数据目录自身**（含其内部任意层级）。那里放着数据库文件、原件、
       记忆与其它账号的数据。让一个工作区指过去，等于绕过了所有归属隔离——
       **这一条最要紧，也最容易被忽略**，因为 `data/` 看起来只是个普通目录。

    符号链接用 ``resolve()`` 之后的真实路径判断，避免"链到数据目录"这种绕过。
    """
    text = (raw or "").strip()
    if not text:
        raise InvalidRequestError("缺少参数：root_path（工作区的根目录）")

    target = Path(text).expanduser()
    try:
        resolved = target.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise InvalidRequestError(f"这个路径不存在或不可访问：{text}") from exc
    if not resolved.is_dir():
        raise InvalidRequestError(f"这个路径不是目录：{text}")

    # 第 2 道：文件系统根。`resolved.parent == resolved` 是"它是自己的父目录"，
    # 也就是根（`/` 或 `C:\`）——比字符串比较可靠。
    if resolved.parent == resolved:
        raise InvalidRequestError("不能把文件系统根目录作为工作区")

    # 第 3 道：数据目录。**必须是 resolve 之后比较**：`data/link-to-elsewhere`
    # 这种软链能绕过纯字符串前缀判断。
    guarded = data_dir.resolve()
    if resolved == guarded or resolved.is_relative_to(guarded):
        raise InvalidRequestError(
            "不能把数据目录（或它里面的目录）作为工作区："
            "那里存着数据库、原件与其它账号的数据，指向它等于绕过了账号隔离"
        )
    return str(resolved)


@dataclass(frozen=True, slots=True)
class WorkspaceView:
    """给界面用的工作区视图：记录本身 + 会话计数。

    计数由存储层单独查（一条 ``count(*)``），**不是把会话全拉回来再数**——
    侧栏每次渲染都要这些数字，那是不能按数据量增长的查询。
    """

    record: WorkspaceRecord
    conversation_count: int


class WorkspaceService:
    def __init__(self, stores: StoreBundle, data_dir: Path) -> None:
        self._stores = stores
        self._data_dir = data_dir

    # ------------------------------------------------------------------ 读

    def list(self, *, user_id: str | None) -> list[WorkspaceView]:
        """列出可见的工作区。``user_id=None`` = 管理员/API Key 通道，看全部。"""
        records = self._stores.meta.list_workspaces()
        visible = [item for item in records if self._visible(item, user_id)]
        return [
            WorkspaceView(
                record=item,
                conversation_count=self._stores.meta.count_workspace_conversations(item.id),
            )
            for item in visible
        ]

    def conversation_count(self, workspace_id: str) -> int:
        """这个工作区下有多少会话（侧栏那个计数）。

        **不校验归属**：它只被 ``get()`` 已经校验过的路径调用（见 api 层），
        内部再查一次等于把同一条规则写两遍。
        """
        return self._stores.meta.count_workspace_conversations(workspace_id)

    def get(self, workspace_id: str, *, user_id: str | None) -> WorkspaceRecord:
        """取一个工作区。**越权与不存在都回 404**：403 会暴露"这个 id 存在"。"""
        record = self._stores.meta.get_workspace(workspace_id)
        if record is None or not self._visible(record, user_id):
            raise NotFoundError(f"工作区不存在：{workspace_id}")
        return record

    # ------------------------------------------------------------------ 写

    def create(
        self,
        *,
        name: str,
        root_path: str,
        user_id: str | None,
        description: str = "",
        kb_ids: list[str] | None = None,
    ) -> WorkspaceRecord:
        clean_name = (name or "").strip()
        if not clean_name:
            raise InvalidRequestError("缺少参数：name（工作区名字）")
        if len(clean_name) > MAX_NAME_CHARS:
            raise InvalidRequestError(f"工作区名字最多 {MAX_NAME_CHARS} 字")
        if len(description) > MAX_DESCRIPTION_CHARS:
            raise InvalidRequestError(f"描述最多 {MAX_DESCRIPTION_CHARS} 字")

        return self._stores.meta.create_workspace(
            WorkspaceRecord(
                id=f"ws_{uuid.uuid4().hex[:12]}",
                name=clean_name,
                root_path=validate_root_path(root_path, data_dir=self._data_dir),
                owner_id=user_id,
                description=description.strip(),
                # 去重保序：同一个库勾两次没有意义，而顺序是用户勾选的顺序
                kb_ids=tuple(dict.fromkeys(kb_ids or ())),
            )
        )

    def update(
        self,
        workspace_id: str,
        *,
        user_id: str | None,
        name: str | None = None,
        root_path: str | None = None,
        description: str | None = None,
        kb_ids: list[str] | None = None,
    ) -> WorkspaceRecord:
        """改工作区。**只改传进来的字段**（``None`` = 不动）。

        归属**不可改**：`owner_id` 不在参数里。把一个工作区转给别人，
        连带的是"里头会话里的 Agent 行为"——那是另一个功能，不该顺手做掉。
        """
        record = self.get(workspace_id, user_id=user_id)
        if name is not None:
            clean = name.strip()
            if not clean:
                raise InvalidRequestError("工作区名字不能为空")
            if len(clean) > MAX_NAME_CHARS:
                raise InvalidRequestError(f"工作区名字最多 {MAX_NAME_CHARS} 字")
            record.name = clean
        if root_path is not None:
            record.root_path = validate_root_path(root_path, data_dir=self._data_dir)
        if description is not None:
            if len(description) > MAX_DESCRIPTION_CHARS:
                raise InvalidRequestError(f"描述最多 {MAX_DESCRIPTION_CHARS} 字")
            record.description = description.strip()
        if kb_ids is not None:
            record.kb_ids = tuple(dict.fromkeys(kb_ids))
        return self._stores.meta.update_workspace(record)

    def delete(self, workspace_id: str, *, user_id: str | None) -> None:
        """删工作区。**里面的会话退回未归档**，不跟着删（见存储层协议说明）。"""
        self.get(workspace_id, user_id=user_id)
        self._stores.meta.delete_workspace(workspace_id)

    # ------------------------------------------------------------- 会话归属

    def bind_conversation(
        self, conversation_id: str, workspace_id: str | None, *, user_id: str | None
    ) -> None:
        """把会话挂到工作区下（``workspace_id=None`` = 退回未归档）。

        先校验工作区可见：否则任何人都能把会话"挂进"别人的工作区
        （挂进去之后，那个工作区的主人就会在侧栏看到它）。
        """
        if workspace_id is not None:
            self.get(workspace_id, user_id=user_id)
        self._stores.meta.set_conversation_workspace(conversation_id, workspace_id)

    # ------------------------------------------------------------------ 内部

    @staticmethod
    def _visible(record: WorkspaceRecord, user_id: str | None) -> bool:
        """可见性：无归属过滤的通道（管理员/API Key）看全部；成员只看自己的。

        **老数据（``owner_id is None``）对成员不可见**——与知识库同一口径：
        无主的东西不该自动落到某个成员名下。
        """
        if user_id is None:
            return True
        return record.owner_id == user_id
