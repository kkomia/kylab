"""文档与任务服务（M4 支撑）。

API 层只做协议适配，所以"列文档""入队""查任务"这些动作都收在这里，
路由里不出现任何存储调用（工程规范 §3.3 的 L1 规则）。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from app.core.exceptions import ConflictError, NotFoundError, UnsupportedContentError
from app.core.signing import DEFAULT_TTL_SECONDS, sign_resource
from app.models.enums import DocumentStage, TaskKind, TaskState
from app.storage.base import (
    ChunkRecord,
    DocumentPartRecord,
    DocumentRecord,
    StoreBundle,
    TaskRecord,
)

__all__ = ["DocumentContent", "DocumentService", "signature_resource"]

ACTIVE_TASK_STATES = (TaskState.PENDING, TaskState.RUNNING)
"""这两个状态下重复入队没有意义——同一文档不该同时跑两个摄入任务。"""


@dataclass(frozen=True, slots=True)
class DocumentContent:
    """一次下载的内容与元信息。"""

    data: bytes
    filename: str
    media_type: str


def signature_resource(document_id: str, fmt: str) -> str:
    """被签名的资源标识。

    **必须带上 ``fmt``**：否则一条"下载 Markdown"的链接会被改个参数拿去下原文，
    而两者是不同的东西（原文可能含用户不想外传的原始版式）。

    公开导出：API 层校验签名时要用**同一个**函数算出被签内容，
    两处各写一遍字符串拼接迟早会漂（漂了就是全员下载 401）。
    """
    return f"document:{document_id}:{fmt}"


def _stem(name: str) -> str:
    dot = name.rfind(".")
    return name[:dot] if dot > 0 else name


class DocumentService:
    """文档查询、重跑入队与任务查询。"""

    def __init__(self, stores: StoreBundle) -> None:
        self._stores = stores

    # ------------------------------------------------------------------ 文档

    def list_documents(self, kb_id: str) -> list[DocumentRecord]:
        if self._stores.meta.get_knowledge_base(kb_id) is None:
            raise NotFoundError(f"知识库不存在：{kb_id}")
        return self._stores.meta.list_documents(kb_id)

    def chunk_counts(self, document_ids: list[str]) -> dict[str, int]:
        """批量取切块数。列表页用它，避免每个文档查一次库。"""
        return self._stores.meta.count_chunks_by_documents(document_ids)

    def get(self, document_id: str) -> DocumentRecord:
        record = self._stores.meta.get_document(document_id)
        if record is None:
            raise NotFoundError(f"文档不存在：{document_id}")
        return record

    def list_parts(self, document_id: str) -> list[DocumentPartRecord]:
        """子文件树（大文件切分的产物，UI 点击展开）。"""
        self.get(document_id)
        return self._stores.meta.list_document_parts(document_id)

    def chunk_count(self, document_id: str) -> int:
        return self._stores.meta.count_chunks(document_id)

    def list_chunks(self, document_id: str, *, limit: int | None = None) -> list[ChunkRecord]:
        """按序取切块（文档详情页的正文预览用）。

        先确认文档存在：否则"文档不存在"和"文档还没切块"都返回空列表，
        调用方分不清是地址写错了还是流水线还没跑到，只能靠猜。
        """
        self.get(document_id)
        return list(self._stores.meta.iter_chunks(document_id, limit=limit))

    # ------------------------------------------------------------------ 下载

    def content(self, document_id: str, *, fmt: str = "original") -> DocumentContent:
        """取下载内容：``original``（原文件，默认）或 ``markdown``（解析产物）。

        这是 T4.5 的"下载双选项"。**默认原文件**是刻意的：用户上传的是什么，
        下载回来的就该是什么；Markdown 是我们加工的中间产物，想要它的人会自己说。
        """
        if fmt not in ("original", "markdown"):
            raise UnsupportedContentError(f"不支持的下载格式：{fmt}")

        document = self.get(document_id)

        if fmt == "markdown":
            parsed = self._stores.meta.get_parse_result(document_id)
            if parsed is None:
                # 还没解析完。这不是"文件不存在"，要说清是"还没到时候"
                raise UnsupportedContentError(
                    "该文档还没有 Markdown 产物（解析尚未完成或已失败）"
                )
            data = self._stores.objects.read(parsed.markdown_path)
            return DocumentContent(
                data=data,
                filename=f"{_stem(document.name)}.md",
                media_type="text/markdown; charset=utf-8",
            )

        path = self._stores.meta.get_setting(f"document.{document_id}.original_path")
        if not path or not self._stores.objects.exists(path):
            raise NotFoundError("原文不在对象存储里（可能已被回收站清理）")
        return DocumentContent(
            data=self._stores.objects.read(path),
            filename=document.name,
            media_type=document.mime_type or "application/octet-stream",
        )

    def download_url(
        self, document_id: str, *, fmt: str, secret: str, ttl_seconds: int = DEFAULT_TTL_SECONDS
    ) -> tuple[str, int]:
        """签发一条下载链接，返回 ``(相对 URL, 到期时间戳)``。

        返回相对路径而不是绝对地址：绝对地址需要知道对外域名，而那个信息
        只有部署时才知道（反代、端口、协议）。让前端拿相对路径自己拼
        比在这里猜一个 ``http://localhost:8000`` 可靠。
        """
        self.get(document_id)  # 文档不存在就别签发
        resource = signature_resource(document_id, fmt)
        signature, expires_at = sign_resource(
            resource, secret, ttl_seconds=ttl_seconds
        )
        url = (
            f"/api/v1/documents/{document_id}/content"
            f"?format={fmt}&expires={expires_at}&signature={signature}"
        )
        return url, expires_at

    # ------------------------------------------------------------------ 任务

    def enqueue_ingest(
        self, document_id: str, *, kind: TaskKind = TaskKind.PARSE, force: bool = False
    ) -> TaskRecord:
        """把文档排进摄入队列。

        默认**幂等**：同一文档已有待执行/执行中的任务时返回既有的那个，
        避免用户连点几次上传就在队列里堆出重复任务。
        ``force=True`` 用于"重跑"按钮，会先确认没有在跑的任务。
        """
        document = self.get(document_id)
        if document.stage is DocumentStage.INDEXED and not force:
            raise ConflictError(f"文档 {document_id} 已索引完成；如需重跑请带 force=true")

        existing = self._find_active_task(document_id, kind)
        if existing is not None:
            return existing

        return self._stores.meta.enqueue_task(
            TaskRecord(
                id=f"task_{uuid.uuid4().hex[:12]}",
                kind=kind,
                state=TaskState.PENDING,
                payload={"document_id": document_id},
                document_id=document_id,
            )
        )

    def list_tasks(self, state: TaskState | None = None) -> list[TaskRecord]:
        return self._stores.meta.list_tasks(state)

    def get_task(self, task_id: str) -> TaskRecord:
        task = self._stores.meta.get_task(task_id)
        if task is None:
            raise NotFoundError(f"任务不存在：{task_id}")
        return task

    def _find_active_task(self, document_id: str, kind: TaskKind) -> TaskRecord | None:
        for state in ACTIVE_TASK_STATES:
            for task in self._stores.meta.list_tasks(state):
                if task.document_id == document_id and task.kind is kind:
                    return task
        return None
