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

import json
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, UploadFile, status

from app.api.auth import require_admin, require_read
from app.api.v1.schemas import (
    MarketSkillOut,
    SkillBrowseIn,
    SkillBrowseOut,
    SkillBundleOut,
    SkillDetailOut,
    SkillInspectIn,
    SkillInstalledOut,
    SkillInstallIn,
    SkillListOut,
    SkillMarketEntryOut,
    SkillMarketIn,
    SkillMarketOut,
    SkillOut,
    SkillSourceIn,
    SkillSourceInstallIn,
    SkillSourceListOut,
    SkillSourceOut,
    SkillSourcePatchIn,
)
from app.core.exceptions import InvalidRequestError
from app.core.services import Services, get_services
from app.services.api_key import Caller
from app.services.skill_market import MAX_UNPACKED_BYTES

router = APIRouter(prefix="/skills", tags=["skills"])


def _out(record, summary: str = "") -> SkillOut:  # type: ignore[no-untyped-def]
    """技能记录 → 界面形状。``summary`` 是**中文简介**（v0.28）。

    它不住在技能目录里，而是安装时记进清单的那一行（``installed.json``）——
    技能的 ``SKILL.md`` 我们一个字都不改（见 ``services/skill_blurb.py``）。
    所以由调用方查出来传进来：只有市场装的技能才有。
    """
    return SkillOut(
        name=record.name,
        description=record.description,
        summary=summary,
        source=record.source,
        path=record.path,
        directory=record.directory,
        used_by_prompt=record.used_by_prompt,
        flagged=list(record.flagged),
    )


def _summaries(services) -> dict[str, str]:  # type: ignore[no-untyped-def]
    """已装技能的中文简介（``技能名 → 简介``）。读不出来就当没有。"""
    try:
        records = services.skill_market.installed_records()
    except Exception:  # 清单坏了不该让技能列表打不开——它只是界面上多一行
        return {}
    return {
        name: str(record.get("summary") or "")
        for name, record in records.items()
        if record.get("summary")
    }


@router.get("", response_model=SkillListOut, summary="技能列表")
def list_skills(
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> SkillListOut:
    """**每次都重新扫磁盘**：用户可能刚往 ``data/skills/`` 丢了一个技能，
    而那正是"技能比插件轻"的地方——不该要求他重启或点"重新加载"。"""
    items = services.skills.list()
    summaries = _summaries(services)
    return SkillListOut(
        items=[_out(item, summaries.get(item.name, "")) for item in items],
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
    return SkillDetailOut(
        **_out(record, _summaries(services).get(record.name, "")).model_dump(), body=body
    )


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
    services.skill_market.install(payload.name, source=payload.source, catalog=payload.catalog)
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


# --------------------------------------------------------------------- 线上源
#
# 与上面那组的分工：那组是"从一个地址装"，这组是"从一个仓库浏览着挑"。
# 出站全部走服务端（GitHub 匿名配额 60 次/小时，前端直连一分钟就能打爆），
# 装之前**先把文件清单给出去**（`/inspect`），用户确认了才 `/install-source`。
# 这里也**只给管理员**：装技能 = 往提示词里加东西，与 MCP 那一侧同一档。


@router.get("/market/sources", response_model=SkillSourceListOut, summary="技能源列表")
def list_sources(
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> SkillSourceListOut:
    """内置源 + 用户自己加的。**读得到的都能看**：清单本身不是敏感信息，
    而管理员要在这里决定启用哪些（见下一个端点）。"""
    return SkillSourceListOut(
        items=[SkillSourceOut(**item.to_dict()) for item in services.skill_sources.list_sources()]
    )


@router.post("/market/sources", response_model=SkillSourceOut, summary="添加一个技能源")
def add_source(
    payload: SkillSourceIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
) -> SkillSourceOut:
    """填 ``owner/repo``，或 GitHub 上那个仓库（含子目录）的 URL。

    **任意合规仓库都能加**：我们扫的是 ``**/SKILL.md``，不是谁家的市场清单——
    而市场清单这件事各家都不一样，也压根没有统一协议（调研 §0.1）。
    """
    source = services.skill_sources.add_source(payload.repo)
    return SkillSourceOut(**source.to_dict())


@router.patch(
    "/market/sources/{source_id}", response_model=SkillSourceOut, summary="启用 / 停用一个源"
)
def patch_source(
    source_id: str,
    payload: SkillSourcePatchIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
) -> SkillSourceOut:
    source = services.skill_sources.set_enabled(source_id, payload.enabled)
    return SkillSourceOut(**source.to_dict())


@router.delete(
    "/market/sources/{source_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除一个自定义源",
)
def delete_source(
    source_id: str,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
) -> None:
    """**内置源删不掉，只能停用**：它是一份我们审过的清单。"""
    services.skill_sources.remove_source(source_id)


@router.post("/market/browse", response_model=SkillBrowseOut, summary="浏览一个源里的技能")
def browse_source(
    payload: SkillBrowseIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_read)],
) -> SkillBrowseOut:
    """递归扫这个仓库里的 ``**/SKILL.md``，只取 name 与 description。

    **正文与附件不在这里取**：那是"点了某个技能之后"的事——渐进式加载的天然对应，
    也省得一次浏览就把几十个技能的正文全拉下来（调研 §1）。
    """
    installed = [item.name for item in services.skills.list()]
    source, items = services.skill_sources.browse(
        payload.source_id, refresh=payload.refresh, installed=installed
    )
    return SkillBrowseOut(
        source=SkillSourceOut(**source.to_dict()),
        items=[MarketSkillOut(**item.to_dict()) for item in items],
        cached=not payload.refresh,
    )


@router.post("/market/inspect", response_model=SkillBundleOut, summary="看一个技能的文件清单")
def inspect_skill(
    payload: SkillInspectIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
) -> SkillBundleOut:
    """**装之前的那一步**：文件清单（含大小与"是不是可执行的代码"）、体积、commit SHA。

    调研 §4.6 把这一步列为"必须做"：技能目录里的 ``scripts/`` 是会被 agent
    执行的代码，而用户在看到清单之前没有别的地方能判断"我到底在装什么"。
    """
    bundle = services.skill_sources.inspect(payload.source_id, payload.path)
    return SkillBundleOut(**bundle.to_dict())


@router.post("/market/upload", response_model=SkillOut, summary="上传一个技能（文件夹或压缩包）")
async def upload_skill(
    files: Annotated[list[UploadFile], File(description="技能的文件；压缩包就传一个 .zip")],
    paths: Annotated[
        str,
        Form(description="与 files 一一对应的相对路径（JSON 数组）。传 .zip 时忽略"),
    ] = "[]",
    services: Services = Depends(get_services),  # type: ignore[assignment]
    caller: Caller = Depends(require_admin),  # type: ignore[assignment]
) -> SkillOut:
    """**从本机添加技能**：选一个文件夹，或选一个 ``.zip``。

    两件事与市场那条路完全一致（写盘、扫描、拒绝覆盖），因为落到最后都是同一个
    ``install_files``：**只有一处写入实现**。

    文件夹那条路用的是浏览器给的相对路径（``webkitRelativePath``）——
    它与用户磁盘上的目录结构一致，所以顶层的 ``my-skill/`` 会被去掉，
    技能名取 ``SKILL.md`` 里的 ``name``。
    """
    if not files:
        raise InvalidRequestError("没有选中任何文件")
    origin = f"upload:{files[0].filename or 'skill'}"
    if len(files) == 1 and (files[0].filename or "").casefold().endswith(".zip"):
        blob = await files[0].read()
        if len(blob) > MAX_UNPACKED_BYTES:
            raise InvalidRequestError(
                f"压缩包太大（{len(blob) // 1024} KB，上限 {MAX_UNPACKED_BYTES // 1024} KB）"
            )
        name = services.skill_market.install_archive(blob, origin=origin)
    else:
        wanted = _upload_paths(paths, len(files))
        uploads = [
            (wanted[index] or (item.filename or f"file{index}"), await item.read())
            for index, item in enumerate(files)
        ]
        name = services.skill_market.install_uploads(uploads, origin=origin)
    return _out(services.skills.get(name), _summaries(services).get(name, ""))


def _upload_paths(raw: str, count: int) -> list[str]:
    """解析与文件一一对应的相对路径数组（前端传 JSON）。

    解析不出来就**返回空串数组**（退回用 ``filename``）：路径只是用来还原目录结构的，
    而这份表单是浏览器自己生成的——为它 500 掉一次上传不值得。
    """
    try:
        parsed = json.loads(raw or "[]")
    except ValueError:
        return [""] * count
    if not isinstance(parsed, list):
        return [""] * count
    out = [str(item) for item in parsed if isinstance(item, str)]
    return (out + [""] * count)[:count]


@router.post("/market/install-source", response_model=SkillOut, summary="从线上源安装一个技能")
def install_from_source(
    payload: SkillSourceInstallIn,
    services: Annotated[Services, Depends(get_services)],
    caller: Annotated[Caller, Depends(require_admin)],
) -> SkillOut:
    """按 ``inspect`` 给出的那个 commit SHA 取文件并安装。

    **两步之间用同一个 SHA**：分支会在"用户点安装"与"我们下载"之间变，
    而用户确认的是他看到的那个版本。装完记进清单（来源、SHA、逐文件 hash），
    于是"这份技能是哪个版本、有没有被改过"永远答得出来。
    """
    bundle = services.skill_sources.inspect(payload.source_id, payload.path)
    files = services.skill_sources.download(bundle)
    services.skill_market.install_files(
        bundle.name,
        files,
        origin=f"github:{bundle.repo}@{bundle.sha}#{bundle.path}",
        lock={
            "repo": bundle.repo,
            "sha": bundle.sha,
            "path": bundle.path,
            "source_id": bundle.source_id,
            # 中文简介跟着一起记：装完之后能力页上那一行还得是中文
            "summary": bundle.summary,
        },
    )
    record = services.skills.get(bundle.name)
    return _out(record, bundle.summary)
