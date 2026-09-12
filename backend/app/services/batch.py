"""文档批量动作（多选之后的删除 / 重新摄入）。

**为什么单列一个服务而不是让接口层循环调单文档端点**：
批量动作的语义核心是"**部分失败**"——10 篇里 2 篇没删掉要如实说清是哪两篇、
为什么。把这段逻辑摊在 API 层，等于让协议适配层承担业务决策；放在这里还能被
单测直接覆盖。服务层对外只回一张逐条结果表，接口层原样转发。

**逐条成败而不是全有全无**：批量删除里有一篇已经被别人删掉了，不该让另外 9 篇
也跟着失败；反过来，为了"原子性"把 10 篇包进一个事务，会让一次误选变成整体回滚，
用户还得重新勾一遍。
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.exceptions import KylabError
from app.services.documents import DocumentService
from app.services.folder import FolderService
from app.services.lifecycle import LifecycleService
from app.storage.base import StoreBundle

__all__ = ["BatchItem", "DocumentBatchService"]

BATCH_ACTIONS = ("delete", "reprocess", "move", "enable", "disable")
"""支持的批量动作。加动作时同步改 API 的 ``Literal`` 与前端类型。"""


@dataclass(frozen=True, slots=True)
class BatchItem:
    """一条结果。``error`` 为空即成功。"""

    document_id: str
    ok: bool
    error: str | None = None


class DocumentBatchService:
    def __init__(
        self,
        stores: StoreBundle,
        documents: DocumentService,
        lifecycle: LifecycleService,
        folders: FolderService,
    ) -> None:
        self._stores = stores
        self._documents = documents
        self._lifecycle = lifecycle
        self._folders = folders

    def run(
        self, kb_id: str, action: str, document_ids: list[str], *, folder_id: str | None = None
    ) -> list[BatchItem]:
        """对一批文档执行同一个动作，逐条返回结果。

        **先校验归属再动手**：请求里的 id 可能来自另一个库（多标签页、手工构造），
        直接删就是越权。不属于本库的一律记成失败，不进入动作分支。

        ``folder_id`` 只对 ``move`` 有意义：给 id 就是移进那个目录，给 ``None``
        是移回根目录。目录归属由 ``FolderService.move_document`` 校验。
        """
        if action not in BATCH_ACTIONS:
            raise ValueError(f"不支持的批量动作：{action}")

        results: list[BatchItem] = []
        for document_id in document_ids:
            document = self._stores.meta.get_document(document_id)
            if document is None or document.knowledge_base_id != kb_id:
                results.append(BatchItem(document_id, False, "文档不存在或不属于这个知识库"))
                continue
            try:
                self._apply(action, document_id, folder_id=folder_id)
            except KylabError as exc:
                # 领域异常带可读文案（"已索引完成"之类），原样透给用户
                results.append(BatchItem(document_id, False, str(exc)))
            else:
                results.append(BatchItem(document_id, True))
        return results

    def _apply(self, action: str, document_id: str, *, folder_id: str | None = None) -> None:
        if action == "delete":
            self._lifecycle.delete_document(document_id)
            return
        if action == "move":
            # `folder_id=None` 是"移回根目录"；目标目录的归属由 folder 服务校验
            self._folders.move_document(document_id, folder_id)
            return
        if action in ("enable", "disable"):
            # 与切块级禁用同一套语义：只动标记，恢复零成本
            self._documents.set_disabled(document_id, action == "disable")
            return
        # 重跑：force=True 才允许对已索引的文档重新入队（见 DocumentService.enqueue_ingest）
        self._documents.enqueue_ingest(document_id, force=True)
