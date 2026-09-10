"""对话留存（《架构设计 v0.2》§3 对话层；开发计划 §11.2）。

**为什么现在做**：这一层原本刻意缺席——`ChatService` 的历史只活在前端内存里，
刷新即失。定位"快速验证知识库里有没有、答得对不对"时那样够用；但一旦用户开始
**回看**（"上周问过什么、当时依据哪几段"），没有留存就等于每次都从头问。

四件事收在这里：

1. **会话的生命周期**：建、列、改名、删；
2. **标题自动生成**：取首轮提问的前若干字。让用户自己起名字的对话工具，
   最后满屏都是"新对话"——而他从标题里想认的是"这是哪一次"；
3. **历史装载**：把库里最近若干轮折成 ``ChatMessage`` 交给对话层，
   于是**前端不再需要自己维护 history**（原来那套在前端内存里的历史可以退休了）；
4. **引用快照**：回答当时依据的原文出处随消息一起存。不是每轮重新检索——
   历史回答当时依据的是哪几段，事后回看必须还是那几段，否则引用编号就对不上。

**边界**：这里只管"存与取"。检索、拼提示词、生成回答仍在 ``ChatService``；
本模块不引入任何对 LLM 的依赖，所以它可以在没有模型配置时照常工作（列表、改名、删）。
"""

from __future__ import annotations

import logging
import uuid

from app.core.exceptions import NotFoundError
from app.services.llm import ChatMessage
from app.storage.base import ChatMessageRecord, ConversationRecord, StoreBundle

__all__ = ["TITLE_MAX_CHARS", "ConversationService"]

logger = logging.getLogger(__name__)

#: 自动标题长度。够认出"这是哪一次"，又不至于把整个问题塞进左栏。
TITLE_MAX_CHARS = 24

#: 装载历史时的默认轮数上限。与前端原来的 HISTORY_LIMIT 取同一个量级：
#: 无边界地带全部历史，提示词会先被自己挤爆。
DEFAULT_HISTORY_TURNS = 6


class ConversationService:
    """会话与消息的读写。"""

    def __init__(self, stores: StoreBundle) -> None:
        self._stores = stores

    # ------------------------------------------------------------------ 会话

    def create(self, *, kb_ids: list[str] | None = None, title: str = "") -> ConversationRecord:
        return self._stores.meta.create_conversation(
            ConversationRecord(
                id=f"conv_{uuid.uuid4().hex[:12]}",
                title=title.strip(),
                kb_ids=tuple(kb_ids or ()),
            )
        )

    def get(self, conversation_id: str) -> ConversationRecord:
        record = self._stores.meta.get_conversation(conversation_id)
        if record is None:
            raise NotFoundError(f"会话不存在：{conversation_id}")
        return record

    def list(self, *, limit: int | None = None) -> list[ConversationRecord]:
        return self._stores.meta.list_conversations(limit=limit)

    def rename(self, conversation_id: str, title: str) -> ConversationRecord:
        cleaned = title.strip()
        if not cleaned:
            raise ValueError("会话标题不能为空")
        self.get(conversation_id)
        self._stores.meta.rename_conversation(conversation_id, cleaned[:TITLE_MAX_CHARS])
        return self.get(conversation_id)

    def delete(self, conversation_id: str) -> None:
        self.get(conversation_id)
        self._stores.meta.delete_conversation(conversation_id)

    # ------------------------------------------------------------------ 消息

    def messages(self, conversation_id: str) -> list[ChatMessageRecord]:
        self.get(conversation_id)
        return self._stores.meta.list_messages(conversation_id)

    def message_count(self, conversation_id: str) -> int:
        return self._stores.meta.count_messages(conversation_id)

    def append(
        self,
        conversation_id: str,
        *,
        role: str,
        content: str,
        sources: list[dict[str, object]] | None = None,
    ) -> ChatMessageRecord:
        """追加一条消息，并把会话的 ``updated_at`` 推到现在。

        两个动作是**有意分开存但一起做**：消息本身只读不写，而列表要按
        "最近聊过"排序。忘了 touch 的后果是会话永远排在最后，很难被发现。
        """
        self.get(conversation_id)
        record = self._stores.meta.append_message(
            ChatMessageRecord(
                id=f"msg_{uuid.uuid4().hex[:12]}",
                conversation_id=conversation_id,
                role=role,
                content=content,
                sources=tuple(sources or ()),
            )
        )
        self._stores.meta.touch_conversation(conversation_id)
        return record

    def ensure_title(self, conversation_id: str, first_question: str) -> None:
        """首轮提问落库后用它生成标题——**只在还没有标题时**。

        用户手动改过名字的会话不该被后续提问覆盖掉。
        """
        record = self.get(conversation_id)
        if record.title.strip():
            return
        title = _title_from(first_question)
        if title:
            self._stores.meta.rename_conversation(conversation_id, title)

    # ------------------------------------------------------------------ 历史

    def history(
        self, conversation_id: str, *, turns: int = DEFAULT_HISTORY_TURNS
    ) -> list[ChatMessage]:
        """把最近 ``turns`` 轮折成交给模型的 history。

        取**最近**若干条而不是最早的：多轮对话里，指代与省略几乎总是指向上一轮，
        最早的几轮对当前问题的帮助最小。

        ``turns`` 数的是"消息条数"而不是"问答对数"：一问一答是两条，调用方给的
        是量级而非精确值——把它当条数更贴近"别把提示词挤爆"这个目的。
        """
        records = self._stores.meta.list_messages(conversation_id)
        recent = records[-turns:] if turns > 0 else []
        return [
            ChatMessage(role=item.role, content=item.content)
            for item in recent
            if item.role in ("user", "assistant") and item.content.strip()
        ]


def _title_from(question: str) -> str:
    """首轮提问 → 会话标题。

    压平空白再截断：用户可能粘一整段带换行的文本进来，标题里带换行会撑坏左栏。
    截断处不加省略号——中文标题里"…"占一个字宽，而左栏本来就会用 CSS 省略。
    """
    flat = " ".join(question.split())
    return flat[:TITLE_MAX_CHARS]
