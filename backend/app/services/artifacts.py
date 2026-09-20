"""会话的文件区：Agent 做出来的文件**落在哪**、怎么浏览、什么时候**进知识库**（v0.26）。

"文件区"是这一层唯一的抽象——**每条会话恰好有一个**，位置由 :meth:`ArtifactService.spot_for`
决定：挂了工作区就是那个真实目录，没挂就是对象存储里按会话分的临时前缀。
浏览、上传、预览、下载四个动作都走这一份判断，所以界面上的文件面板
（`FileDrawer`）不需要知道自己在看的是哪一种。

这个模块存在的理由，是线上真的出过一次事：用户让 Agent「写一首四句的短诗，
导出成 docx 给我」，那个会话**没有挂工作区**，而导出工具的实现是"直接当一次入库
提交"——`knowledge_base_id` 是必填参数。模型于是替用户挑了一个语义上最顺手的库，
把 docx 塞进了「笔记」，并在回答里说明"你这边没有专门的工作区，我就选了最顺手的那个"。

三件事被这一次暴露出来，本模块就是它们的答案：

1. **产物不是天生要入库的**。它是"这一次对话做出来的一个文件"，与"知识库里的一份
   资料"是两个身份。身份混在一起时，"这份文件是怎么来的"就再也说不清了。
2. **要有一个存放地址**。没挂工作区的会话也有落点——对象存储里按会话分的临时前缀
   （``conversations/<会话 id>/…``）；挂了工作区的，就落进**用户的真实目录**，
   那是他打开项目就能看见的地方。
3. **入库是显式动作**。用户说「存进知识库」，或者自己点卡片上那个按钮；
   模型不会替他决定（那是"替用户做选择"，而他并不知道用户在整理什么）。

两档落点的区别不只是路径，**生命周期也不一样**：

| | 工作区 | 未挂工作区（对象存储） |
| --- | --- | --- |
| 位置 | 用户指定的真实目录 | ``conversations/<id>/`` 前缀 |
| 谁拥有 | 用户（他的项目文件） | 这条会话 |
| 删会话时 | **保留**（那是他的文件） | 一起清掉（只许诺会话期间有效） |

"删会话时保留工作区里的文件"是有意为之：那是他项目里的一份真文件，
删掉一次对话不该让它消失——那正是"我的文件被它弄没了"的典型事故。
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.services.sandbox import resolve_in
from app.storage.base import (
    ARTIFACT_IN_OBJECTS,
    ARTIFACT_IN_WORKSPACE,
    SAFE_KEY_CHARS,
    ConversationArtifactRecord,
    StoreBundle,
)

__all__ = [
    "MAX_READ_BYTES",
    "ArtifactService",
    "ArtifactSpot",
    "FileEntry",
    "FileListing",
    "file_signature_resource",
    "safe_filename",
    "split_filename",
]

logger = logging.getLogger(__name__)

CONVERSATION_PREFIX = "conversations"
"""对象存储里会话临时产物的前缀。**与内容寻址的 ``originals/`` 分开**：
后者是"入库的原文、按内容 hash 去重"，这里的是"还没决定要不要长期留下的东西"。
混在同一个前缀下，清理策略就没法只作用于其中一类。"""

_UNSAFE_IN_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
"""文件名里不能出现的字符（含 Windows 的保留字符与控制字符）。

**这是一道安全边界，不是显示偏好**：文件名来自模型，它会写出 ``../../.env``
这类"它以为这个项目里有"的路径。落到工作区时，那是往用户的真实目录里写文件——
一次越界的拼接就能覆盖用户的项目文件。
"""

_RESERVED_NAMES = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{index}" for index in range(1, 10)}
    | {f"lpt{index}" for index in range(1, 10)}
)
"""Windows 的保留设备名。叫这个名字的文件在那台机器上根本建不出来，
而报错会发生在写盘那一刻（`OSError: [Errno 22]`），离"名字有问题"很远。"""

MAX_NAME_CHARS = 120

MAX_LIST_ENTRIES = 300
"""一层最多列多少条。真实项目目录里 `node_modules` 动辄几万条——
全列出来既慢又没人看，而**截断必须如实上报**（见 ``FileListing.truncated``）。"""

MAX_READ_BYTES = 32 * 1024 * 1024
"""预览/下载单个文件的上限。这个端点走 HTTP 响应体，不是流式；
一个 2GB 的模型文件会把进程内存吃干净。超过就明确拒绝并提示下载。"""


def split_filename(filename: str) -> tuple[str, str]:
    """把 ``报告.docx`` 拆成 ``("报告", "docx")``。没有扩展名时后缀为空串。"""
    name = (filename or "").strip()
    dot = name.rfind(".")
    if dot <= 0:
        return name, ""
    return name[:dot], name[dot + 1 :].lower()


def safe_filename(filename: str, *, fallback: str = "产物") -> str:
    """把模型给的文件名收敛成一个**能安全落盘**的名字。

    处理顺序有讲究：先取基名（``os.path.basename`` 对 ``..\\a`` 这类不完整路径
    不认，所以正反斜杠各切一次），再删非法字符，最后处理保留名与长度。
    **不能只做"删掉 ``..``"**：``....//x`` 删完还是能拼出越界路径。
    """
    base = (filename or "").strip().replace("\\", "/").split("/")[-1]
    stem, suffix = split_filename(base)
    stem = _UNSAFE_IN_NAME.sub("", stem).strip(" .")
    suffix = _UNSAFE_IN_NAME.sub("", suffix).strip(" .")
    if not stem:
        stem = fallback
    if stem.lower() in _RESERVED_NAMES:
        # 加下划线前缀而不是报错：模型给这个名字没有恶意，只是巧了
        stem = f"_{stem}"
    if len(stem) > MAX_NAME_CHARS:
        stem = stem[:MAX_NAME_CHARS]
    return f"{stem}.{suffix}" if suffix else stem


@dataclass(frozen=True, slots=True)
class ArtifactSpot:
    """产物该落在哪儿——**这次落点的全部信息**。

    单独一个类型而不是在服务里现算：模型看到的说明（"已存到工作区「我的项目」"）
    与真正写文件用的是同一份判断，两者不可能漂。
    """

    conversation_id: str
    workspace_id: str | None = None
    root: Path | None = None
    """工作区目录。给了就落真实文件，否则落对象存储。"""
    workspace_name: str = ""

    @property
    def in_workspace(self) -> bool:
        return self.root is not None

    @property
    def label(self) -> str:
        """界面上那句"存到哪儿了"。**用户看得懂的说法**，不是路径。"""
        if self.root is None:
            return "本会话"
        return f"工作区「{self.workspace_name}」" if self.workspace_name else "工作区"

    @property
    def mode(self) -> str:
        """给界面判断用的一档：``workspace``（能进子目录）或 ``object``（平铺）。"""
        return ARTIFACT_IN_WORKSPACE if self.root is not None else ARTIFACT_IN_OBJECTS


@dataclass(frozen=True, slots=True)
class FileEntry:
    """文件面板里的一行。

    ``key`` 是**在这个文件区里唯一指代它**的东西，两种模式不一样：

    - 工作区：相对工作区根的路径（``报告/初稿.docx``）——它同时是磁盘上的真实位置；
    - 临时区：产物 id（``art_xxx``）——那里是平铺的，文件名可以重名。

    界面把它当作不透明字符串用（下载、预览都原样回传），所以两套 key 不会串。
    """

    key: str
    name: str
    is_dir: bool = False
    size_bytes: int = 0
    modified_at: datetime | None = None
    kind: str = ""
    """扩展名小写（``docx`` / ``md`` / ``png``…）。**界面按它选渲染器**，
    所以它由服务端算好——两处各算一遍迟早会分叉。"""


@dataclass(frozen=True, slots=True)
class FileListing:
    """一层目录（临时区是唯一的一层）。"""

    mode: str
    label: str
    path: str = ""
    parent: str | None = None
    entries: tuple[FileEntry, ...] = ()
    truncated: bool = False
    """条目被截断过。**要如实告诉界面**——否则"这个项目只有 300 个文件"
    与"我只给你看了 300 个"看起来一模一样。"""


class ArtifactService:
    """产物的落盘、读取、入库与清理。

    ``ingest`` / ``documents`` 是**可选能力**：不接摄入流水线时，落盘、下载、清理
    照常工作，只有"存进知识库"那一个动作会明确报错。这与笔记那边同一套口径——
    单测与不配模型的部署不该因为"某个旁路能力没接"就整个用不了。
    """

    def __init__(self, stores: StoreBundle, *, ingest=None, documents=None) -> None:  # type: ignore[no-untyped-def]
        self._stores = stores
        self._ingest = ingest
        self._documents = documents

    # ------------------------------------------------------------------ 落点

    def spot_for(self, conversation_id: str) -> ArtifactSpot:
        """这条会话的产物该落在哪儿。

        **工作区目录不存在时明确报错，不悄悄改落点**。目录没了说明用户的项目
        出了问题，那是他必须知道的事；替他把文件塞进临时区，他会以为"东西在项目里"，
        而这正是"落点不可预期"那类问题的形状。
        """
        conversation = self._stores.meta.get_conversation(conversation_id)
        if conversation is None:
            raise NotFoundError(f"会话不存在：{conversation_id}")
        if not conversation.workspace_id:
            return ArtifactSpot(conversation_id=conversation_id)
        workspace = self._stores.meta.get_workspace(conversation.workspace_id)
        if workspace is None:
            # 走不到这里：外键是 `ON DELETE SET NULL`，工作区一删，会话就退回未归档。
            # 留着是为了"记录对不上"时退到临时区，而不是抛一个用户看不懂的错。
            return ArtifactSpot(conversation_id=conversation_id)
        root = Path(workspace.root_path)
        if not root.is_dir():
            raise InvalidRequestError(
                f"这个会话挂在工作区「{workspace.name}」上，但它的目录不在了"
                f"（{workspace.root_path}）。产物没有落盘——请在工作区设置里检查这个路径，"
                "或者把这次要的东西改成存进知识库"
            )
        return ArtifactSpot(
            conversation_id=conversation_id,
            workspace_id=workspace.id,
            root=root,
            workspace_name=workspace.name,
        )

    # ------------------------------------------------------------------ 写

    def save(
        self,
        *,
        conversation_id: str,
        filename: str,
        content: bytes,
        kind: str,
        owner_id: str | None = None,
    ) -> ConversationArtifactRecord:
        """把一份产出落盘并登记。

        ``kind`` 是扩展名（``docx`` / ``xlsx`` / ``pptx`` / ``pdf``）——
        **以调用方生成的内容为准，不是以文件名的后缀为准**：文件名是模型写的，
        而字节是我们自己造的；两者不一致时，信字节。
        """
        spot = self.spot_for(conversation_id)
        name = safe_filename(filename, fallback=f"产物.{kind}" if kind else "产物")
        artifact_id = f"art_{uuid.uuid4().hex[:12]}"

        if spot.root is not None:
            # `safe_filename` 已经保证名字里没有路径分隔符，`resolve_in` 是**第二道**：
            # 往用户的真实目录里写文件的这条路上，一道校验不够（见 sandbox.py 的说明）。
            path = _write_new(resolve_in(spot.root, name), content)
            storage, location = ARTIFACT_IN_WORKSPACE, str(path)
        else:
            key = _object_key(conversation_id, artifact_id, name)
            location = self._stores.objects.write(key, content)
            storage = ARTIFACT_IN_OBJECTS

        return self._stores.meta.create_artifact(
            ConversationArtifactRecord(
                id=artifact_id,
                conversation_id=conversation_id,
                name=name,
                format=kind,
                size_bytes=len(content),
                storage=storage,
                location=location,
                workspace_id=spot.workspace_id,
                owner_id=owner_id,
            )
        )

    # ------------------------------------------------------------------ 文件区（浏览）

    def list_files(self, conversation_id: str, path: str = "") -> FileListing:
        """列一层文件。两条落点各列各的，返回同一个形状。

        ``path`` 只在工作区模式下有意义（临时区是平铺的，传了也不看）。
        """
        spot = self.spot_for(conversation_id)
        if spot.root is None:
            return self._list_temp(spot)
        return self._list_directory(spot, path)

    def _list_temp(self, spot: ArtifactSpot) -> FileListing:
        entries = [
            FileEntry(
                key=record.id,
                name=record.name,
                size_bytes=record.size_bytes,
                modified_at=record.created_at,
                kind=record.format or _suffix_of(record.name),
            )
            for record in self._stores.meta.list_artifacts(spot.conversation_id)
        ]
        return FileListing(mode=spot.mode, label=spot.label, entries=tuple(entries))

    def _list_directory(self, spot: ArtifactSpot, path: str) -> FileListing:
        directory = self._directory(spot, path)
        try:
            raw = list(directory.iterdir())
        except OSError as exc:
            raise InvalidRequestError(f"读不了这个目录（{path or '根目录'}）：{exc}") from exc

        entries: list[FileEntry] = []
        for item in raw:
            if item.name.startswith("."):
                # 隐藏项不进列表：`.git`、`.venv` 这些在"我的文件"里没有意义，
                # 而它们动辄上万个（node_modules 同理，那个不是隐藏项，见下面的截断）
                continue
            try:
                stat = item.stat()
            except OSError:
                # 断掉的符号链接、权限不足的条目：跳过它而不是整层失败
                continue
            is_dir = item.is_dir()
            entries.append(
                FileEntry(
                    key=_relative_key(spot.root, item),
                    name=item.name,
                    is_dir=is_dir,
                    size_bytes=0 if is_dir else stat.st_size,
                    modified_at=datetime.fromtimestamp(stat.st_mtime).astimezone(),
                    kind="dir" if is_dir else _suffix_of(item.name),
                )
            )
        # 目录在前、各自按名字（不区分大小写）——与文件管理器一个习惯
        entries.sort(key=lambda item: (not item.is_dir, item.name.lower()))
        truncated = len(entries) > MAX_LIST_ENTRIES
        return FileListing(
            mode=spot.mode,
            label=spot.label,
            path=_relative_key(spot.root, directory) if directory != spot.root else "",
            parent=_parent_of(spot.root, directory),
            entries=tuple(entries[:MAX_LIST_ENTRIES]),
            truncated=truncated,
        )

    def _directory(self, spot: ArtifactSpot, path: str) -> Path:
        root = spot.root
        if root is None:  # 只有工作区模式会走到这里，调用方已判过
            raise InvalidRequestError("这条会话没有目录（文件在临时区里）")
        if not path.strip():
            return root
        target = resolve_in(spot.root, path)
        if not target.is_dir():
            raise NotFoundError(f"目录不存在：{path}")
        return target

    def read_file(self, conversation_id: str, key: str) -> tuple[bytes, str]:
        """取一份文件的字节与显示名（预览与下载共用）。

        临时区那份按产物 id 找记录；工作区那份按相对路径落到磁盘上——
        两者都要过 ``resolve_in``，因为 key 是从浏览器回来的，而它最终拼成了文件路径。
        """
        spot = self.spot_for(conversation_id)
        if spot.root is None:
            record = self._stores.meta.get_artifact(key)
            if record is None or record.conversation_id != conversation_id:
                # 越会话取产物：不暴露"它在别处存在"，与 API 层同一口径
                raise NotFoundError(f"文件不存在：{key}")
            return self.content(record), record.name

        target = resolve_in(spot.root, key)
        if not target.is_file():
            raise NotFoundError(f"文件不存在：{key}")
        size = target.stat().st_size
        if size > MAX_READ_BYTES:
            raise InvalidRequestError(
                f"这个文件 {size // (1024 * 1024)}MB，超过预览上限 "
                f"{MAX_READ_BYTES // (1024 * 1024)}MB。下载它用本机的程序打开"
            )
        try:
            return target.read_bytes(), target.name
        except OSError as exc:
            raise InvalidRequestError(f"读不了这个文件（{key}）：{exc}") from exc

    def write_file(
        self, conversation_id: str, *, path: str, filename: str, content: bytes
    ) -> FileEntry:
        """往文件区里放一份文件（界面上的"上传"）。

        工作区：写进指定目录，**同名不覆盖**（退到 ``名字 (2).ext``，与产物落盘同一套）。
        临时区：登记成一条产物——那里的东西本来就按产物记账，另立一套"没有记录的文件"
        只会让清理策略漏掉它们。
        """
        spot = self.spot_for(conversation_id)
        if spot.root is None:
            record = self.save(
                conversation_id=conversation_id,
                filename=filename,
                content=content,
                kind=_suffix_of(filename),
            )
            return FileEntry(
                key=record.id,
                name=record.name,
                size_bytes=record.size_bytes,
                modified_at=record.created_at,
                kind=record.format,
            )

        directory = self._directory(spot, path)
        name = safe_filename(filename)
        target = _write_new(resolve_in(directory, name), content)
        stat = target.stat()
        return FileEntry(
            key=_relative_key(spot.root, target),
            name=target.name,
            size_bytes=stat.st_size,
            modified_at=datetime.fromtimestamp(stat.st_mtime).astimezone(),
            kind=_suffix_of(target.name),
        )

    # ------------------------------------------------------------------ 读

    def get(self, artifact_id: str) -> ConversationArtifactRecord:
        record = self._stores.meta.get_artifact(artifact_id)
        if record is None:
            raise NotFoundError(f"产物不存在：{artifact_id}")
        return record

    def list_for_conversation(self, conversation_id: str) -> list[ConversationArtifactRecord]:
        return self._stores.meta.list_artifacts(conversation_id)

    def label_for(self, record: ConversationArtifactRecord) -> str:
        """这份产物在哪儿——**给用户看的那句话**（不是路径）。"""
        if record.storage != ARTIFACT_IN_WORKSPACE:
            return "本会话"
        workspace = (
            self._stores.meta.get_workspace(record.workspace_id) if record.workspace_id else None
        )
        return f"工作区「{workspace.name}」" if workspace is not None else "工作区"

    def describe(self, record: ConversationArtifactRecord) -> dict[str, object]:
        """给界面用的那份形状。

        **SSE 的步骤事件与 REST 的产物列表共用这一个函数**：同一份产物在两处
        必须是同一个形状，否则"刷新之后卡片显示的与刚才不一样"就成了必然。
        """
        payload: dict[str, object] = {
            "artifact_id": record.id,
            "name": record.name,
            "size_bytes": record.size_bytes,
            "format": record.format,
            "storage": record.storage,
            "where": self.label_for(record),
        }
        if record.storage == ARTIFACT_IN_WORKSPACE:
            # 只有工作区那份的"路径"对用户有意义（他要去那儿拿）。
            # 对象存储的 Key 对他没有用处，露出来只会让人以为那是个能点的地址。
            payload["path"] = record.location
        if record.knowledge_base_id:
            payload["knowledge_base_id"] = record.knowledge_base_id
        if record.document_id:
            payload["document_id"] = record.document_id
        return payload

    def content(self, record: ConversationArtifactRecord) -> bytes:
        """取回产物的字节。

        两条落点各读各的：工作区那份从磁盘读，对象存储那份从对象存储读。
        **路径就在记录里**，不再做一次"猜它在哪"的判断。
        """
        if record.storage == ARTIFACT_IN_WORKSPACE:
            path = Path(record.location)
            if not path.is_file():
                raise NotFoundError(f"文件不在了：{record.location}（可能已被移动或删除）")
            return path.read_bytes()
        return self._stores.objects.read(record.location)

    # ------------------------------------------------------------------ 入库（显式）

    def ingest(
        self,
        record: ConversationArtifactRecord,
        *,
        knowledge_base_id: str,
        uploaded_by: str | None = None,
    ) -> tuple[str, bool]:
        """把这份产物**复制一份**进知识库，返回 ``(文档 id, 是不是库里的已有内容)``。

        **复制，不是搬家**：产物还在原处（工作区里那份仍在工作区），知识库里多一份
        可检索的。用户要的这两件事本来就不冲突，搬家反而会让"我刚导出的文件去哪了"
        变成一个新问题。

        走的是与界面上传**同一条链路**（``IngestService.submit``）：不另开一条
        "把产物写进库"的通道，否则库里会出现两种来源、两种格式。
        """
        if self._ingest is None or self._documents is None:
            raise RuntimeError("这条部署没有接上摄入链路，产物无法入库")
        content = self.content(record)
        outcome = self._ingest.submit(
            knowledge_base_id=knowledge_base_id,
            filename=record.name,
            content=content,
            uploaded_by=uploaded_by,
        )
        if not outcome.is_duplicate:
            self._documents.enqueue_ingest(outcome.document.id)
        self._stores.meta.mark_artifact_ingested(
            record.id, knowledge_base_id=knowledge_base_id, document_id=outcome.document.id
        )
        record.knowledge_base_id = knowledge_base_id
        record.document_id = outcome.document.id
        return outcome.document.id, outcome.is_duplicate

    # ------------------------------------------------------------------ 清理

    def discard_for_conversation(self, conversation_id: str) -> int:
        """删会话之前清掉**临时**产物（对象存储那些），返回清掉的份数。

        **工作区里的那些一份都不动**：它们已经在用户的目录里，是他的文件。
        删一次对话顺手删掉他项目里的 docx，是最不该有的"贴心"。
        """
        removed = 0
        for record in self._stores.meta.list_artifacts(conversation_id):
            if record.storage != ARTIFACT_IN_OBJECTS:
                continue
            try:
                self._stores.objects.delete(record.location)
            except Exception:
                logger.warning("清理会话产物失败：%s", record.location, exc_info=True)
                continue
            removed += 1
        return removed

    # ------------------------------------------------------------------ 下载

    def file_url(
        self,
        conversation_id: str,
        key: str,
        *,
        secret: str,
        ttl_seconds: int | None = None,
        inline: bool = False,
    ) -> tuple[str, int]:
        """签发一条短期文件链接（与文档下载同一套签名，见 ``core/signing.py``）。

        **为什么不能直接给路径**：工作区那份是服务器上的绝对路径、临时区那份是对象
        存储的 Key，两者都只有服务端读得到；而预览（`<iframe>`、`<img>`）与下载
        （`<a download>`）都带不了 Authorization 头。签名 URL 把"你有权取这份"
        编码进链接本身，并给它一个到期时间。

        ``inline`` 只影响响应头、**不参与签名**（签名绑的是"哪条会话的哪份文件"）：
        它不是一个权限参数——能不能内联渲染由协议层按后缀复核，见 API 里那张白名单。
        """
        from app.core.signing import DEFAULT_TTL_SECONDS, sign_resource

        signature, expires_at = sign_resource(
            file_signature_resource(conversation_id, key),
            secret,
            ttl_seconds=ttl_seconds or DEFAULT_TTL_SECONDS,
        )
        url = (
            f"/api/v1/conversations/{conversation_id}/files/content"
            f"?key={_quote_key(key)}&expires={expires_at}&signature={signature}"
        )
        if inline:
            url += "&disposition=inline"
        return url, expires_at


def file_signature_resource(conversation_id: str, key: str) -> str:
    """被签名的资源标识。

    **必须带上会话 id**：内容端点是 ``/conversations/{会话}/files/content?key=…``，
    两者都在 URL 里。只签 key 的话，签名与 URL 的另一半没有绑定关系——
    换一条会话去请求同一份签名，端点会先过一遍"这条会话里有没有这个文件"，
    而这层校验本该由签名本身保证。

    **key 里可能有斜杠**（工作区里的相对路径），所以拼进来之前要转义：
    不转的话 ``a/b`` 与 ``a:b`` 会撞成同一个资源标识，一条签名能换到另一份文件。
    """
    return f"file:{conversation_id}:{_quote_key(key)}"


def _quote_key(key: str) -> str:
    from urllib.parse import quote

    return quote(key, safe="")


def _suffix_of(name: str) -> str:
    """扩展名（小写、不带点）。界面按它选渲染器。"""
    return split_filename(name)[1]


def _relative_key(root: Path, target: Path) -> str:
    """磁盘路径 → 文件区里的 key（相对工作区根，用正斜杠）。

    **统一用正斜杠**：URL 查询串与前端都用它，Windows 的反斜杠在这里只会制造
    "同一份文件在界面上有两个 key"的问题。
    """
    try:
        return target.relative_to(root).as_posix()
    except ValueError:
        # 不该发生：调用方都先过了 `resolve_in`。真发生时报出去，而不是编一个 key
        raise InvalidRequestError(f"路径不在这个工作区里：{target}") from None


def _parent_of(root: Path, directory: Path) -> str | None:
    """上一层目录的 key。

    - 已经在根上 → ``None``（界面据此隐藏"返回上级"）；
    - 上一层就是根 → **空串**（根目录的 key 是 ``""``，与列根目录时的 ``path`` 一致）。
    """
    if directory == root:
        return None
    parent = directory.parent
    return "" if parent == root else _relative_key(root, parent)


def _object_key(conversation_id: str, artifact_id: str, name: str) -> str:
    """对象存储里的 Key：``conversations/<会话>/<产物>.<后缀>``。

    用产物 id 而不是文件名当主体：同名文件（模型很爱叫 ``报告.docx``）不会互相覆盖，
    而显示名存在库里、不依赖 Key。Key 里保留后缀是为了**直接看桶时认得出类型**。
    """
    safe_conversation = "".join(ch for ch in conversation_id if ch in SAFE_KEY_CHARS)
    if not safe_conversation:
        raise InvalidRequestError(f"会话 id 不含可用字符：{conversation_id!r}")
    _, suffix = split_filename(name)
    tail = f".{suffix}" if suffix else ""
    return f"{CONVERSATION_PREFIX}/{safe_conversation}/{artifact_id}{tail}"


def _write_new(target: Path, content: bytes) -> Path:
    """写入一份**不会覆盖既有文件**的新文件，返回实际落点。

    同名时退到 ``名字 (2).docx``，与系统的"另存为"同一套习惯。
    **直接覆盖是不可接受的**：用户目录里那个 ``报告.docx`` 可能比这次导出的重要得多，
    而"导出一次，旧文件没了"没有任何提示能补救。

    用**独占创建**（``xb``）而不是"先查在不在、再写"：那两步之间隔着一次系统调用，
    而工具循环会把一批调用并发跑（v0.27）——两个同名导出会同时查到"不存在"，
    然后后写的那份把先写的**悄悄盖掉**。``xb`` 撞了就换下一个候选名，
    谁先建成谁算数：这是文件系统替我们做的原子判定，比我们自己加锁更可靠
    （它还挡住了另一个进程）。
    """
    for candidate in _candidates(target):
        try:
            with candidate.open("xb") as handle:
                handle.write(content)
        except FileExistsError:
            continue
        except OSError as exc:
            # 权限、磁盘满、路径过长……**报出来**，不要让模型以为文件已经在那儿了
            raise InvalidRequestError(
                f"写不进去（{candidate}）：{exc}。对方需要检查这个目录的权限或磁盘空间"
            ) from exc
        return candidate
    # 兜底：不给出无限循环的机会（一个目录里 999 个同名文件本身就该有人来看看了）
    raise InvalidRequestError(f"这个目录里同名文件太多了：{target.name}")


def _candidates(target: Path) -> Iterator[Path]:
    """先试原名，再试 ``名字 (2)``、``名字 (3)``……（上限见 ``_write_new``）。"""
    yield target
    stem, suffix = split_filename(target.name)
    tail = f".{suffix}" if suffix else ""
    for index in range(2, 1000):
        yield target.with_name(f"{stem} ({index}){tail}")
