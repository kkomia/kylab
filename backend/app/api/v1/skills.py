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

from fastapi import APIRouter, Depends, status

from app.api.auth import require_admin, require_read
from app.api.v1.schemas import (
    SkillDetailOut,
    SkillInstalledOut,
    SkillInstallIn,
    SkillListOut,
    SkillMarketEntryOut,
    SkillMarketIn,
    SkillMarketOut,
    SkillOut,
)
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


# --------------------------------------------------------------------- 市场
#
# 市场是这一层风险最高的入口：它把"从别处拿来的文本"直接放进提示词。
# 所以安装**要管理员**，而且**装之前先扫描**（命中注入特征当场拒绝并删掉半成品）。
# 扫描/解压的防护在 services/skill_market.py，这里只做协议层。


@router.post("/market", response_model=SkillMarketOut, summary="浏览一个源的技能索引")
def browse_market(
    payload: SkillMarketIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
) -> SkillMarketOut:
    """`source` 可以是目录、``catalog.json``，或它们的 http(s)/file URL。

    **没有索引文件不算错**：那表示这个源没有可浏览的清单，用户仍可按名字直接装。
    """
    entries = services.skill_market.catalog(payload.source)
    return SkillMarketOut(
        source=payload.source,
        items=[
            SkillMarketEntryOut(
                name=item.name,
                description=item.description,
                source=item.source,
                installed=item.installed,
            )
            for item in entries
        ],
    )


@router.get("/market/installed", response_model=SkillInstalledOut, summary="已从市场装的技能")
def installed_skills(
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> SkillInstalledOut:
    """``技能名 → 来源``。**回答"这玩意儿哪来的"**，也是卸载时唯一允许删的集合。"""
    items = services.skill_market.installed()
    return SkillInstalledOut(items=items, total=len(items))


@router.post("/market/install", response_model=SkillOut, summary="安装一个技能")
def install_skill(
    payload: SkillInstallIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
) -> SkillOut:
    """装到 ``data/skills/<名字>/``。

    **装之前先扫描**：命中注入特征就拒绝安装并清掉已经落地的目录——
    与"扫描磁盘上已有的技能"不同，安装是**主动引入**，所以处置是拒绝而不是标注。
    """
    # 装完**回读注册表**（而不是自己拼响应）：名称与描述以磁盘上那份为准，
    # 这个接口要能验证"装完之后它真的被扫进来了"。
    services.skill_market.install(
        payload.name, source=payload.source, catalog=payload.catalog
    )
    record = services.skills.get(payload.name)
    return _out(record)


@router.delete(
    "/market/installed/{name}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="卸载一个技能",
)
def uninstall_skill(
    name: str,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
) -> None:
    """**只卸市场装的**：仓库自带的技能不在清单里，所以删不掉——
    否则一次误操作就能改掉"我们审过的那个版本"。"""
    services.skill_market.uninstall(name)
