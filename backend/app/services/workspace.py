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
import os
import string
import uuid
from dataclasses import dataclass
from pathlib import Path

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.storage.base import StoreBundle, WorkspaceRecord

__all__ = [
    "BrowseView",
    "DirectoryEntry",
    "WorkspaceService",
    "root_path_problem",
    "validate_root_path",
]

logger = logging.getLogger(__name__)

#: 名字长度上限。与知识库同一个量级（120），界面上都是单行标题。
MAX_NAME_CHARS = 120
MAX_DESCRIPTION_CHARS = 500

#: 一次浏览最多列多少个子目录。**与工具面那些列表同一个量级**：真在一个有几万个子目录的
#: 目录里（比如某个媒体库）全列出来既慢又没用，而"前 N 个 + 还剩多少"足够让人判断
#: "对着不对"——他要找的东西要么在前面，要么他该换个起点（起点里有路径输入）。
MAX_BROWSE_ENTRIES = 300

#: 起点最多给几个。家目录、盘符、已有工作区目录加起来可能很多（工作区多时），
#: 而起点是"跳到某个熟悉的地方"用的，七八个足够；再多就成了一份目录清单。
MAX_BROWSE_ROOTS = 8


def root_path_problem(path: Path, *, data_dir: Path) -> str | None:
    """``path`` 能不能当工作区：能回 ``None``，不能回**一句给人看的原因**。

    **只有一份判定**（``validate_root_path`` 也走它），因为这件事有两个消费者：
    建/改工作区时抛异常，以及浏览目录时把不可选的目录标出来（灰掉 + 说明）。
    两份判定迟早会出现"能选但建不出来"（或者反过来），而那种不一致最难查。

    ``path`` 应当是**已经解析过**的绝对路径（``resolve()`` 之后）：
    存在性、``~`` 展开、软链的真实位置都由调用方先处理掉。
    """
    if not path.is_dir():
        return f"这个路径不是目录：{path}"

    # 第 1 道：文件系统根。`path.parent == path` 是"它是自己的父目录"，也就是根
    # （`/` 或 `C:\`）——比字符串比较可靠。
    if path.parent == path:
        return "不能把文件系统根目录作为工作区"

    # 第 2 道：数据目录。**必须是 resolve 之后比较**：`data/link-to-elsewhere`
    # 这种软链能绕过纯字符串前缀判断。
    guarded = data_dir.resolve()
    if path == guarded or path.is_relative_to(guarded):
        return (
            "不能把数据目录（或它里面的目录）作为工作区："
            "那里存着数据库、原件与其它账号的数据，指向它等于绕过了账号隔离"
        )
    return None


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

    后两道判定在 :func:`root_path_problem` 里——**浏览目录那条路用的是同一份**。
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

    problem = root_path_problem(resolved, data_dir=data_dir)
    if problem:
        raise InvalidRequestError(problem)
    return str(resolved)


@dataclass(frozen=True, slots=True)
class DirectoryEntry:
    """浏览目录时的一行：一个子目录，或一个"起点"。"""

    name: str
    """显示用。子目录就是目录名；起点是"家目录""D:\\"这类人话标签。"""
    path: str
    selectable: bool
    """能不能直接拿它当工作区。**判定与建工作区时同一份**（见 ``root_path_problem``），
    所以界面上灰掉的那些，点"选择"也一定建不出来。"""
    reason: str = ""
    """不能选的原因（原样显示给用户）。"""


@dataclass(frozen=True, slots=True)
class BrowseView:
    """一次浏览的结果。"""

    path: str
    current: DirectoryEntry
    """**当前这一层自己**能不能选。

    服务端给而不是让界面自己判：那条判定（数据目录 / 文件系统根）只有一份，
    界面再去猜一次就会出现"按钮亮着但建不出来"。它也从侧面回答了
    "我现在站的这一层是什么"（名字 + 完整路径）。
    """
    parent: str | None
    """上一级；已经是这个根的最上层时为 ``None``（界面上把"上一级"置灰）。"""
    entries: list[DirectoryEntry]
    roots: list[DirectoryEntry]
    """起点清单（家目录 / 盘符 / 已有工作区的目录）：路径很长时不用从根一路点下来。"""
    note: str = ""


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

    # -------------------------------------------------------------- 浏览目录

    def browse(self, path: str | None = None) -> BrowseView:
        """列一个目录下的**子目录**，供界面"选一个目录当工作区"。

        **为什么这件事必须由服务端做**：工作区根目录是**服务器上**的路径
        （后端跑在 NAS 上），而浏览器拿不到、也不该拿到服务器上的绝对路径
        （`showDirectoryPicker` 给的是客户端本机的一个句柄，指向的还是错误的那台机器）。
        所以"选择"只能是"服务端列给你看"。

        三条规则：

        - **只列目录**（工作区根必须是目录，列出文件只会让人点错）；
        - **数据目录会出现但点不动**：它标着不可选与原因。**不藏起来**是有意的——
          静默省略会让人以为"这里没有这个目录"，而他要找的可能正是它旁边那个；
        - **可选性用的是建工作区那一份判定**（``root_path_problem``），所以灰掉的
          一定也建不出来，不会出现"能选但是建失败"。

        ``path`` 为空时从**家目录**起步（最可能的地方），并在 ``roots`` 里给出
        家目录 / 盘符 / 已有工作区目录这几个起点——路径很深时不用从根一路点下来。
        """
        target = self._browse_root(path)
        entries, note = self._subdirectories(target)
        return BrowseView(
            path=str(target),
            current=self._describe(target),
            parent=None if target.parent == target else str(target.parent),
            entries=entries,
            roots=self._browse_roots(),
            note=note,
        )

    def _describe(self, target: Path, *, label: str | None = None) -> DirectoryEntry:
        """把一个目录描述成一行（名字 + 可选性 + 不能选的原因）。"""
        problem = root_path_problem(target, data_dir=self._data_dir)
        return DirectoryEntry(
            name=label or target.name or str(target),
            path=str(target),
            selectable=problem is None,
            reason=problem or "",
        )

    def _browse_root(self, path: str | None) -> Path:
        """把请求的路径解析成一个**可以列**的目录。

        与 ``validate_root_path`` 的区别：这里**允许列数据目录本身**——
        列出来无害（界面标着不可选），而"点进去看看"是人的正常动作。
        真正不能做的是把它当工作区，那条规则在 ``root_path_problem`` 里。
        """
        text = (path or "").strip()
        if not text:
            home = Path.home()
            if home.is_dir():
                return home
            # 家目录都读不到（极少见）时退回数据目录的父目录：至少是个能列的地方
            return self._data_dir.parent.resolve()
        try:
            resolved = Path(text).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise InvalidRequestError(f"这个路径不存在或不可访问：{text}") from exc
        if not resolved.is_dir():
            # 说清它的父目录是哪儿：用户多半是把文件拖进来了，下一步该去哪一目了然
            raise InvalidRequestError(
                f"这是一个文件，不是目录：{text}。它的父目录是 {resolved.parent}"
            )
        return resolved

    def _subdirectories(self, target: Path) -> tuple[list[DirectoryEntry], str]:
        """列出 ``target`` 下的子目录（数量封顶，并把"截断了"如实说出来）。"""
        found: list[Path] = []
        skipped = 0
        try:
            children = list(target.iterdir())
        except OSError as exc:
            raise InvalidRequestError(f"这个目录读不了：{exc}") from exc
        for child in children:
            try:
                # **符号链接跟着走**（`is_dir()` 会解引用）：链到别处的目录是合法的工作区，
                # 而"链到数据目录"那种绕过后面的 `root_path_problem` 会拦住
                if not child.is_dir():
                    continue
            except OSError:
                skipped += 1  # 断链 / 权限不足：跳过，不因为一条坏链让整次浏览失败
                continue
            found.append(child)
        # **隐藏目录排后面**（而不是藏起来）：家目录里 `.cache` / `.cargo` 这类东西一堆，
        # 排前面会把真正的项目挤下去；但它们是合法的工作区，藏起来就成了
        # "我明明有那个目录，为什么选不到"
        found.sort(key=lambda item: (item.name.startswith("."), item.name.casefold()))

        # 可选性用**建工作区那一份判定**（`_describe` 里）：灰掉的一定也建不出来
        entries = [self._describe(child) for child in found[:MAX_BROWSE_ENTRIES]]
        notes = []
        if len(found) > MAX_BROWSE_ENTRIES:
            notes.append(f"这个目录里共有 {len(found)} 个子目录，只列了前 {MAX_BROWSE_ENTRIES} 个")
        if skipped:
            notes.append(f"有 {skipped} 个目录读不了（权限或断链），没有列出来")
        return entries, "；".join(notes)

    def _browse_roots(self) -> list[DirectoryEntry]:
        """起点清单：家目录、盘符（Windows）、以及已有工作区的目录。

        **已有工作区的目录也放进来**是有用的：真实用法里"再建一个旁边的项目"
        比"从根一路点下去"常见得多。
        """
        candidates: list[tuple[str, Path]] = []
        home = Path.home()
        if home.is_dir():
            candidates.append(("家目录", home))
        if os.name == "nt":
            for letter in string.ascii_uppercase:
                drive = Path(f"{letter}:/")
                if drive.exists():
                    candidates.append((f"{letter}:", drive))
        else:
            candidates.append(("/", Path("/")))
        for record in self._stores.meta.list_workspaces():
            candidates.append((record.name or "工作区", Path(record.root_path)))

        roots: list[DirectoryEntry] = []
        seen: set[str] = set()
        for name, item in candidates:
            try:
                resolved = item.resolve()
            except (OSError, RuntimeError):
                continue
            key = str(resolved)
            if key in seen or not resolved.is_dir():
                continue
            seen.add(key)
            roots.append(self._describe(resolved, label=name))
        return roots[:MAX_BROWSE_ROOTS]

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
