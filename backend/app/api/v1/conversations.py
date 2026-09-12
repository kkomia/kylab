"""对话留存端点（开发计划 §11.2）。

**为什么单独一组端点而不是塞进 `/chat`**：会话的建、列、改名、删是**管理动作**，
与"问一个问题"是两件事。混在一起的话，前端每次提问都要顺便处理一堆会话状态；
分开之后 `/chat` 只负责回答，会话列表自己刷新。

**要不要鉴权**：要。这些端点读写的是用户与知识库的历史对话，属于内容本身；
用 ``ReadDep`` / ``WriteDep``，外部只读 API Key 也能回看历史（合理），
但删会话需要读写权限。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.api.auth import require_read, require_write
from app.api.v1.schemas import (
    ChatMessageOut,
    ChatSourceOut,
    ConversationCreateIn,
    ConversationDetailOut,
    ConversationListOut,
    ConversationOut,
    ConversationRewindIn,
    ConversationRewindOut,
    ConversationUpdateIn,
)
from app.core.services import Services, get_services
from app.services.api_key import Caller

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _summary(services: Services, record) -> ConversationOut:  # type: ignore[no-untyped-def]
    return ConversationOut(
        id=record.id,
        title=record.title,
        kb_ids=list(record.kb_ids),
        model_pk=record.model_pk,
        thinking=record.thinking,
        thinking_effort=record.thinking_effort,
        pinned=record.pinned,
        created_at=record.created_at,
        updated_at=record.updated_at,
        message_count=services.conversations.message_count(record.id),
    )


def _get_visible(services: Services, caller: Caller, conversation_id: str):  # type: ignore[no-untyped-def]
    """成员只能碰自己的会话（404 而不是 403：不暴露存在性）；其余通道照旧。"""
    owner = _caller_owner(caller)
    if owner is None:
        return services.conversations.get(conversation_id)
    return services.conversations.get_for_owner(conversation_id, owner)


def _caller_owner(caller: Caller) -> str | None:
    """只有**普通成员**会话才有归属过滤；管理员会话（is_admin）与
    API Key 通道都没有——否则管理员用网页会话看不到 API Key 建的无主会话（回归踩过）。
    """
    if caller.user is not None and not caller.is_admin:
        return caller.user.id
    return None


@router.get("", response_model=ConversationListOut, summary="会话列表（置顶优先，其次最近更新）")
def list_conversations(
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
    limit: int = Query(default=50, ge=1, le=200),
    q: str | None = Query(default=None, description="按标题搜索（包含匹配）"),
) -> ConversationListOut:
    # 成员只看到自己的会话（v10 私有隔离）：对话内容是私有数据，
    # 列表不按归属过滤就等于把别人的问题全部摊开
    records = services.conversations.list(
        limit=limit, owner_id=_caller_owner(caller), q=q
    )
    return ConversationListOut(items=[_summary(services, item) for item in records])


@router.post(
    "",
    response_model=ConversationOut,
    status_code=status.HTTP_201_CREATED,
    summary="新建会话",
)
def create_conversation(
    payload: ConversationCreateIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> ConversationOut:
    """新建会话。

    标题允许留空：真正的标题由**第一轮提问**生成（见 ``ConversationService``）。
    这里能传标题是为了"复制一次旧会话"这类将来可能有的用法。
    """
    record = services.conversations.create(
        kb_ids=payload.kb_ids,
        title=payload.title,
        owner_id=_caller_owner(caller),
        model_pk=payload.model_pk,
        thinking=payload.thinking,
        thinking_effort=payload.thinking_effort,
    )
    return _summary(services, record)


@router.get("/{conversation_id}", response_model=ConversationDetailOut, summary="会话详情")
def get_conversation(
    conversation_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> ConversationDetailOut:
    """会话 + 全部消息。

    一次给全而不是分页：一次对话通常几十轮，比"翻页找上文"的体验好得多；
    真到了几百轮再谈分页。
    """
    record = _get_visible(services, caller, conversation_id)
    messages = [
        ChatMessageOut(
            id=item.id,
            role=item.role,
            content=item.content,
            sources=[ChatSourceOut.model_validate(src) for src in item.sources],
            created_at=item.created_at,
        )
        for item in services.conversations.messages(conversation_id)
    ]
    return ConversationDetailOut(**_summary(services, record).model_dump(), messages=messages)


@router.patch(
    "/{conversation_id}",
    response_model=ConversationOut,
    summary="修改会话（标题 / 置顶）",
)
def update_conversation(
    conversation_id: str,
    payload: ConversationUpdateIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> ConversationOut:
    """标题与置顶都可选，只处理传了的那些；都为空时幂等。"""
    _get_visible(services, caller, conversation_id)
    record = services.conversations.get(conversation_id)
    if payload.title is not None:
        record = services.conversations.rename(conversation_id, payload.title)
    if payload.pinned is not None:
        record = services.conversations.set_pinned(conversation_id, payload.pinned)
    return _summary(services, record)


@router.post(
    "/{conversation_id}/rewind",
    response_model=ConversationRewindOut,
    summary="回退最近 N 轮问答（「重新生成」用）",
)
def rewind_conversation(
    conversation_id: str,
    payload: ConversationRewindIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> ConversationRewindOut:
    """删掉最近 ``turns`` 轮（提问 + 回答），返回被删掉的那句提问。

    **不在这里重新生成**：回答是流式产出的，重发必须走 `/chat/stream`——
    在这里再调一次模型会让"怎么重试、怎么中断"出现第二条实现。
    前端拿到 ``query`` 后原样重发一次即可。
    """
    _get_visible(services, caller, conversation_id)
    before = services.conversations.message_count(conversation_id)
    query = services.conversations.rewind(conversation_id, turns=payload.turns)
    after = services.conversations.message_count(conversation_id)
    return ConversationRewindOut(query=query, removed=max(0, before - after))


@router.delete(
    "/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除会话（连同全部消息）",
)
def delete_conversation(
    conversation_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_write)],
) -> None:
    _get_visible(services, caller, conversation_id)
    services.conversations.delete(conversation_id)
