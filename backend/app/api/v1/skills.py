"""技能端点（v0.15，设计见 ``docs/Agent-工作区与能力层设计-v0.1.md`` §6.1）。

技能是磁盘上的 ``SKILL.md``（仓库自带 ``skills/`` + 数据目录 ``data/skills/``）。
这一组端点做两件事：**列出来给人看**、**读正文给模型用**。

**技能是部署级的能力，不按账号隔离**（与工作区不同）：它是一段流程文本，
放在哪个账号名下都不改变它的内容。真正的账号隔离在于
"谁能看到哪些工作区、哪些知识库"——那两样才是数据。

被安全扫描拦下的技能**照样列出来**，只是标着原因（``flagged``）且不进模型目录：
静默藏掉会让用户以为技能没装上，而"为什么它不生效"就成了一个查不出的问题。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.auth import require_read
from app.api.v1.schemas import SkillDetailOut, SkillListOut, SkillOut
from app.core.services import Services, get_services
from app.services.api_key import Caller

router = APIRouter(prefix="/skills", tags=["skills"])


def _out(record) -> SkillOut:  # type: ignore[no-untyped-def]
    return SkillOut(
        name=record.name,
        description=record.description,
        source=record.source,
        path=record.path,
        directory=record.directory,
        used_by_prompt=record.used_by_prompt,
        flagged=list(record.flagged),
    )


@router.get("", response_model=SkillListOut, summary="技能列表")
def list_skills(
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> SkillListOut:
    """**每次都重新扫磁盘**：用户可能刚往 ``data/skills/`` 丢了一个技能，
    而那正是"技能比插件轻"的地方——不该要求他重启或点"重新加载"。"""
    items = services.skills.list()
    return SkillListOut(
        items=[_out(item) for item in items],
        usable=sum(1 for item in items if item.used_by_prompt),
    )


@router.get("/{name}", response_model=SkillDetailOut, summary="技能详情（含正文）")
def get_skill(
    name: str,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> SkillDetailOut:
    """连正文一起给：界面上要能读它（这也是用户核对"这个技能到底教了模型什么"的地方）。"""
    record, body = services.skills.read(name)
    return SkillDetailOut(**_out(record).model_dump(), body=body)
