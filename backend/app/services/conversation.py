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

from app.core.exceptions import InvalidRequestError, NotFoundError
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

    def create(
        self,
        *,
        kb_ids: list[str] | None = None,
        title: str = "",
        owner_id: str | None = None,
        model_pk: str | None = None,
        thinking: bool | None = None,
        thinking_effort: str | None = None,
        workspace_id: str | None = None,
    ) -> ConversationRecord:
        """``owner_id``（v10）：登录成员的会话归自己；控制台/API Key 通道无主。

        ``model_pk``（v12）：这条会话选用的对话模型；``None`` = 跟随全局默认。
        ``thinking`` / ``thinking_effort``（v16）：思考开关与强度；``None`` = 跟随全局默认。
        ``workspace_id``（v0.15）：挂到哪个工作区；``None`` = 未归档。
        """
        return self._stores.meta.create_conversation(
            ConversationRecord(
                id=f"conv_{uuid.uuid4().hex[:12]}",
                title=title.strip(),
                kb_ids=tuple(kb_ids or ()),
                owner_id=owner_id,
                model_pk=model_pk,
                thinking=thinking,
                thinking_effort=thinking_effort,
                workspace_id=workspace_id,
            )
        )

    def get(self, conversation_id: str) -> ConversationRecord:
        record = self._stores.meta.get_conversation(conversation_id)
        if record is None:
            raise NotFoundError(f"会话不存在：{conversation_id}")
        return record

    def get_for_owner(self, conversation_id: str, owner_id: str) -> ConversationRecord:
        """成员视角的取会话：**越主即 404**，不泄露"这条会话存在但不是你的"。

        对话内容是私有数据；用 403 会把别人的会话 id 变成可探测的存在性 oracle。
        """
        record = self.get(conversation_id)
        if record.owner_id != owner_id:
            raise NotFoundError(f"会话不存在：{conversation_id}")
        return record

    def list(
        self,
        *,
        limit: int | None = None,
        owner_id: str | None = None,
        q: str | None = None,
        workspace_id: str | None = None,
        ungrouped: bool = False,
        archived: bool = False,
    ) -> list[ConversationRecord]:
        """置顶优先、其次最近更新（v17 起支持按标题搜索）。

        ``owner_id`` 给成员过滤用（v10 私有隔离）。**搜索与归属过滤都在这里做**，
        而不是在 SQL 里——见下面的取舍说明。

        无过滤时保持 SQL LIMIT 透传；带归属过滤时全表取出再切片——本地部署的会话量
        （几百条）下这点差异无所谓，而"先过滤再 LIMIT"的 SQL 要为一个低频操作
        加一条仓储方法，不值。`q` 走 SQL（标题包含匹配），因为它能把结果集整体缩小，
        与 LIMIT 组合后语义才正确（"搜出来的前 50 条"而不是"前 50 条里搜出来的"）。
        """
        # 工作区过滤与归属过滤同类（都是"这批里要哪一部分"），所以在同一处做：
        # `workspace_id` 点名某个工作区；`ungrouped` 要的是"未归档"那一栏
        # （`workspace_id IS NULL`）——两者互斥，同时给等于没有交集，直接返回空。
        def keep(item: ConversationRecord) -> bool:
            # **归档是一道前置过滤**：默认视图里看不到归档的会话，
            # 要看它们得显式要（`archived=True`）。与归属过滤分开写，
            # 因为它们是两件不同的事（谁的 / 收没收起来）。
            if (item.archived_at is not None) != archived:
                return False
            if owner_id is not None and item.owner_id != owner_id:
                return False
            if ungrouped:
                return item.workspace_id is None
            if workspace_id is not None:
                return item.workspace_id == workspace_id
            return True

        if owner_id is None and workspace_id is None and not ungrouped and not archived:
            # 无过滤的快路径：SQL 里就把归档的排除掉，别拉回来再筛
            records = [
                item
                for item in self._stores.meta.list_conversations(limit=limit, q=q)
                if item.archived_at is None
            ]
            return records
        records = [
            item for item in self._stores.meta.list_conversations(limit=None, q=q) if keep(item)
        ]
        return records[:limit] if limit is not None else records

    def rename(self, conversation_id: str, title: str) -> ConversationRecord:
        cleaned = title.strip()
        if not cleaned:
            raise ValueError("会话标题不能为空")
        self.get(conversation_id)
        self._stores.meta.rename_conversation(conversation_id, cleaned[:TITLE_MAX_CHARS])
        return self.get(conversation_id)

    def set_model(self, conversation_id: str, model_pk: str | None) -> ConversationRecord:
        """记录该会话选用的对话模型（``None`` = 回到全局默认）。

        **不校验 model_pk 是否真实存在**：那是 ``ModelRegistryService`` 的事（解析时
        会报明确的错）。这里只管存，避免两处各写一份校验而漂。
        """
        self.get(conversation_id)
        self._stores.meta.set_conversation_model(conversation_id, model_pk)
        return self.get(conversation_id)

    def set_thinking(
        self, conversation_id: str, thinking: bool | None, effort: str | None
    ) -> ConversationRecord:
        """记录该会话的思考偏好（``None`` = 回到全局默认）。与 ``set_model`` 同一套口径。"""
        self.get(conversation_id)
        self._stores.meta.set_conversation_thinking(conversation_id, thinking, effort)
        return self.get(conversation_id)

    def delete(self, conversation_id: str) -> None:
        """删会话（消息由外键级联一并删掉）。"""
        self.get(conversation_id)
        self._stores.meta.delete_conversation(conversation_id)

    def set_archived(self, conversation_id: str, archived: bool) -> ConversationRecord:
        """归档 / 取消归档。**不是删除**：内容与引用都还在。
        不推 ``updated_at``（与置顶/改名同理，见存储层协议）。"""
        self.get(conversation_id)
        self._stores.meta.set_conversation_archived(conversation_id, archived)
        return self.get(conversation_id)

    def previews(self, conversation_ids: list[str]) -> dict[str, str]:
        """``会话 id → 最后一条回答``。历史会话面板的两行预览用它。"""
        return self._stores.meta.last_assistant_previews(conversation_ids)

    def set_pinned(self, conversation_id: str, pinned: bool) -> ConversationRecord:
        """置顶 / 取消置顶。**不推 updated_at**（与改名同一套口径）：置顶是一次整理
        动作，不该把会话顶到"最近活动"的最前面——何况它本来就排最前了。"""
        record = self.get(conversation_id)
        if bool(pinned) == record.pinned:
            return record
        self._stores.meta.set_conversation_pinned(conversation_id, pinned)
        record.pinned = bool(pinned)
        return record

    def rewind(self, conversation_id: str, *, turns: int = 1) -> str:
        """回退最近 ``turns`` 轮问答，返回**被删掉的那句提问**（没有则空串）。

        给「重新生成」用：删掉最后一轮（提问 + 回答），把那句提问还给调用方，
        由它重新发一次——重发走的是正常提问链路，所以**不需要**第二条生成路径。

        为什么是"删一轮"而不是"给回答加个版本"：会话是一份线性记录，
        版本化的代价（每条回答多一张表、回看时还要选版本）远大于它带来的价值；
        用户要的是"这个答案我不满意，重来一次"，旧答案留着反而会让上下文里有两条
        相互矛盾的回复。

        **没有可回退的提问就报错**，不返回空串：静默成功会让调用方以为删了点什么，
        接着发一次空提问。契约只有一个（要么给回问题、要么报错），调用方不必判两种情况。
        """
        if turns <= 0:
            raise InvalidRequestError("回退轮数必须为正整数")
        messages = self._stores.meta.list_messages(conversation_id)
        # 从末尾往前找第 turns 个"提问"，它就是这一轮的开始
        start: int | None = None
        seen = 0
        for index in range(len(messages) - 1, -1, -1):
            if messages[index].role == "user":
                seen += 1
                if seen == turns:
                    start = index
                    break
        if start is None:
            raise InvalidRequestError("这段对话里没有可回退的提问")
        removed = [item.id for item in messages[start:]]
        query = messages[start].content
        self._stores.meta.delete_chat_messages(removed)
        return query

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

    # ------------------------------------------------- 上下文摘要（v20.1 压缩）

    def summary(self, conversation_id: str) -> tuple[str, str | None]:
        """（早期对话的摘要，摘要覆盖到的最后一条消息 id）。

        ``("", None)`` = 还没压缩过。取的时候**不校验会话是否存在**——
        调用方通常是"先拿到会话再来问"，这里再查一次只是多一次往返。
        """
        return self._stores.meta.get_conversation_summary(conversation_id)

    def set_summary(
        self, conversation_id: str, summary: str, upto_message_id: str | None
    ) -> None:
        self._stores.meta.set_conversation_summary(conversation_id, summary, upto_message_id)


def _title_from(question: str) -> str:
    """首轮提问 → 会话标题。

    压平空白再截断：用户可能粘一整段带换行的文本进来，标题里带换行会撑坏左栏。
    截断处不加省略号——中文标题里"…"占一个字宽，而左栏本来就会用 CSS 省略。
    """
    flat = " ".join(question.split())
    return flat[:TITLE_MAX_CHARS]
