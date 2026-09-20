"""会话产物：落在哪、能不能读回来、什么时候进知识库（v0.26）。

这一组用例针对的是一次真实事故：用户让 Agent 导出一份 docx，那条会话没有工作区，
而导出工具的实现是"直接当一次入库提交"（`knowledge_base_id` 必填）——
模型只好替用户挑了一个语义上最顺手的库，把文件塞进了「笔记」。
所以下面每一条都在钉住"落点由服务决定、入库由用户决定"这两件事。
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from app.core.exceptions import NotFoundError
from app.core.services import Services
from app.services.api_key import Caller
from app.services.artifacts import ArtifactService, safe_filename, split_filename
from app.storage.base import ARTIFACT_IN_OBJECTS, ARTIFACT_IN_WORKSPACE


@pytest.fixture
def services() -> Services:
    from app.core.services import get_services

    return get_services()


@pytest.fixture
def admin() -> Caller:
    return Caller(is_admin=True)


@pytest.fixture
def kb(services: Services) -> str:  # type: ignore[no-untyped-def]
    return services.knowledge_bases.create(
        kb_id=f"kb_{uuid.uuid4().hex[:12]}", name="资料库"
    ).id


@pytest.fixture
def conversation(services: Services) -> str:  # type: ignore[no-untyped-def]
    """一条**没挂工作区**的会话——事故里那个形状。"""
    return services.conversations.create(title="导出短诗").id


@pytest.fixture
def workspace_conversation(services: Services, tmp_path: Path):  # type: ignore[no-untyped-def]
    """一条挂在真实目录上的会话。返回 ``(会话 id, 工作区目录)``。"""
    root = tmp_path / "project"
    root.mkdir()
    workspace = services.workspaces.create(
        name="我的项目", root_path=str(root), user_id=None
    )
    conversation_id = services.conversations.create(
        title="写进项目", workspace_id=workspace.id
    ).id
    return conversation_id, root


# ------------------------------------------------------------------ 文件名


def test_safe_filename_strips_paths_and_unsafe_chars() -> None:
    """模型会写出路径（它在猜这个项目的结构），落到用户真实目录前必须收敛成一个名字。"""
    assert safe_filename("../../.env") != "../../.env"
    assert "/" not in safe_filename("a/b/c.docx")
    assert "\\" not in safe_filename(r"C:\Users\x\报告.docx")
    assert safe_filename(r"C:\Users\x\报告.docx") == "报告.docx"
    # Windows 保留设备名：不处理的话，报错发生在写盘那一刻（OSError 22），
    # 离"名字有问题"很远
    assert safe_filename("CON.docx").startswith("_")
    # 空名字有兜底，不会变成一个只有扩展名的隐藏文件
    assert safe_filename("") == "产物"


def test_split_filename() -> None:
    assert split_filename("报告.docx") == ("报告", "docx")
    assert split_filename("noext") == ("noext", "")
    # 前导点不是扩展名（`.gitignore` 不是一个叫 gitignore 的文件）
    assert split_filename(".gitignore") == (".gitignore", "")


# ------------------------------------------------------------------ 落点


def test_without_workspace_the_file_goes_to_the_conversation_area(
    services: Services, conversation: str
) -> None:
    """没挂工作区的会话也有落点：对象存储里按会话分的临时前缀。"""
    artifact = services.artifacts.save(
        conversation_id=conversation,
        filename="短诗.docx",
        content=b"hello",
        kind="docx",
    )

    assert artifact.storage == ARTIFACT_IN_OBJECTS
    assert artifact.location.startswith(f"conversations/{conversation}/")
    # 落点是对象存储的 Key，不是服务器上的某个路径——那是给用户的"本会话"
    assert services.artifacts.label_for(artifact) == "本会话"
    assert services.artifacts.content(artifact) == b"hello"


def test_with_workspace_the_file_is_a_real_file_in_the_project(
    services: Services, workspace_conversation: tuple[str, Path]
) -> None:
    conversation_id, root = workspace_conversation
    artifact = services.artifacts.save(
        conversation_id=conversation_id,
        filename="随访方案.docx",
        content=b"docx-bytes",
        kind="docx",
    )

    assert artifact.storage == ARTIFACT_IN_WORKSPACE
    written = root / "随访方案.docx"
    assert written.is_file(), "工作区里的产物必须是一份用户打得开的真文件"
    assert written.read_bytes() == b"docx-bytes"
    assert artifact.location == str(written)
    assert services.artifacts.label_for(artifact) == "工作区「我的项目」"


def test_same_name_never_overwrites_the_users_file(
    services: Services, workspace_conversation: tuple[str, Path]
) -> None:
    """同名退到 ``名字 (2).docx``。

    **直接覆盖是不可接受的**：用户目录里那个 `报告.docx` 可能比这次导出的重要得多，
    而"导出一次，旧文件没了"没有任何提示能补救。
    """
    conversation_id, root = workspace_conversation
    original = root / "报告.docx"
    original.write_bytes(b"user's own file")

    artifact = services.artifacts.save(
        conversation_id=conversation_id, filename="报告.docx", content=b"new", kind="docx"
    )

    assert original.read_bytes() == b"user's own file"
    assert Path(artifact.location).name == "报告 (2).docx"
    assert Path(artifact.location).read_bytes() == b"new"


def test_missing_workspace_directory_is_an_error_not_a_silent_redirect(
    services: Services, workspace_conversation: tuple[str, Path], tmp_path: Path
) -> None:
    """工作区目录没了就报错，**不悄悄改落点**。

    替他放进临时区，他会以为东西在项目里——那正是"落点不可预期"的形状。
    """
    from app.core.exceptions import InvalidRequestError

    conversation_id, root = workspace_conversation
    root.rmdir()

    with pytest.raises(InvalidRequestError, match="目录不在了"):
        services.artifacts.save(
            conversation_id=conversation_id, filename="a.docx", content=b"x", kind="docx"
        )


# ------------------------------------------------------------------ 入库是显式动作


def test_saving_does_not_put_anything_in_a_knowledge_base(
    services: Services, conversation: str, kb: str
) -> None:
    """**这是这次改动的核心断言**：导出之后，库里一份文档都没多。"""
    before = services.documents.count_documents(kb)

    artifact = services.artifacts.save(
        conversation_id=conversation, filename="短诗.docx", content=b"x", kind="docx"
    )

    assert artifact.knowledge_base_id is None and artifact.document_id is None
    assert services.documents.count_documents(kb) == before


def test_ingest_is_the_explicit_step_that_files_it(
    services: Services, conversation: str, kb: str, admin: Caller
) -> None:
    artifact = services.artifacts.save(
        conversation_id=conversation, filename="短诗.docx", content=b"poem", kind="docx"
    )

    document_id, is_duplicate = services.artifacts.ingest(
        artifact, knowledge_base_id=kb, uploaded_by=None
    )

    assert not is_duplicate
    assert services.documents.get(document_id).name == "短诗.docx"
    # 记录被就地更新，界面据此把卡片换成"已存进知识库"
    assert artifact.knowledge_base_id == kb and artifact.document_id == document_id
    stored = services.artifacts.get(artifact.id)
    assert stored.knowledge_base_id == kb


def test_ingest_copies_it_does_not_move(
    services: Services, workspace_conversation: tuple[str, Path], kb: str
) -> None:
    """入库是**复制**：产物还在原来那个目录里。

    搬家的话，"我刚导出的文件去哪了"会变成一个没人回答得了的新问题。
    """
    conversation_id, root = workspace_conversation
    artifact = services.artifacts.save(
        conversation_id=conversation_id, filename="方案.docx", content=b"body", kind="docx"
    )
    services.artifacts.ingest(artifact, knowledge_base_id=kb)

    assert (root / "方案.docx").read_bytes() == b"body"


def test_ingesting_twice_reuses_the_document(
    services: Services, conversation: str, kb: str
) -> None:
    """同一份内容重复入库由内容 hash 去重——不会在库里出现两份。"""
    artifact = services.artifacts.save(
        conversation_id=conversation, filename="a.docx", content=b"same", kind="docx"
    )
    first, _ = services.artifacts.ingest(artifact, knowledge_base_id=kb)
    second, is_duplicate = services.artifacts.ingest(artifact, knowledge_base_id=kb)

    assert first == second and is_duplicate


# ------------------------------------------------------------------ 清理


def test_discard_clears_only_the_temporary_ones(
    services: Services, kb: str, tmp_path: Path
) -> None:
    """删会话清掉对象存储里的临时产物，**工作区里那份一份都不动**。

    顺手删掉用户项目里的 docx，是最不该有的"贴心"。
    """
    loose = services.conversations.create(title="临时的").id
    temp = services.artifacts.save(
        conversation_id=loose, filename="tmp.docx", content=b"tmp", kind="docx"
    )

    root = tmp_path / "proj"
    root.mkdir()
    workspace = services.workspaces.create(name="项目", root_path=str(root), user_id=None)
    bound = services.conversations.create(title="项目的", workspace_id=workspace.id).id
    kept = services.artifacts.save(
        conversation_id=bound, filename="keep.docx", content=b"keep", kind="docx"
    )

    from app.core.storage import get_stores

    removed = services.artifacts.discard_for_conversation(loose)

    assert removed == 1
    assert not get_stores().objects.exists(temp.location)
    # 工作区那份还在原处（它的记录随后会话一起删，但文件是用户的）
    services.artifacts.discard_for_conversation(bound)
    assert Path(kept.location).is_file()


def test_deleting_the_conversation_takes_its_artifact_records(
    services: Services, conversation: str
) -> None:
    services.artifacts.save(
        conversation_id=conversation, filename="a.docx", content=b"a", kind="docx"
    )
    services.conversations.delete(conversation)

    assert services.artifacts.list_for_conversation(conversation) == []


# ------------------------------------------------------------------ 描述形状


def test_describe_is_the_same_shape_for_sse_and_rest(
    services: Services, workspace_conversation: tuple[str, Path]
) -> None:
    """步骤事件与产物列表**共用这一个函数**——两处分叉，刷新之后卡片就会变脸。"""
    conversation_id, _ = workspace_conversation
    artifact = services.artifacts.save(
        conversation_id=conversation_id, filename="a.docx", content=b"a", kind="docx"
    )

    described = services.artifacts.describe(artifact)
    assert described["artifact_id"] == artifact.id
    assert described["where"] == "工作区「我的项目」"
    assert described["path"] == artifact.location
    # 没入库就不带那两个键：界面据此决定给不给「存进知识库」
    assert "knowledge_base_id" not in described and "document_id" not in described


def test_object_backed_artifact_hides_the_key(
    services: Services, conversation: str
) -> None:
    """对象存储的 Key 对用户没有用处，露出来只会让人以为那是个能点的地址。"""
    artifact = services.artifacts.save(
        conversation_id=conversation, filename="a.docx", content=b"a", kind="docx"
    )
    assert "path" not in services.artifacts.describe(artifact)


def test_unwired_ingest_says_so_instead_of_silently_doing_nothing(conversation: str) -> None:
    """没接摄入链路时**明确报错**：静默返回"已入库"会让模型告诉用户一件没发生的事。

    不接摄入链路是合法部署（单测、只管产出的脚本），所以它不是断言失败而是 RuntimeError。
    """
    from app.core.storage import get_stores
    from app.storage.base import ConversationArtifactRecord

    service = ArtifactService(get_stores())  # 刻意不传 ingest / documents
    record = ConversationArtifactRecord(
        id="art_x", conversation_id=conversation, name="a.docx", format="docx"
    )
    with pytest.raises(RuntimeError, match="摄入链路"):
        service.ingest(record, knowledge_base_id=f"kb_{uuid.uuid4().hex[:6]}")


# ------------------------------------------------------------------ 文件区（v0.26）


def test_temp_area_lists_the_conversations_files(services: Services, conversation: str) -> None:
    """没挂工作区的会话也有"文件"可看：临时区里就是这条会话的产物。"""
    services.artifacts.save(
        conversation_id=conversation, filename="短诗.docx", content=b"x", kind="docx"
    )

    listing = services.artifacts.list_files(conversation)

    assert listing.mode == ARTIFACT_IN_OBJECTS
    assert listing.label == "本会话"
    assert [item.name for item in listing.entries] == ["短诗.docx"]
    assert listing.entries[0].kind == "docx"
    # 临时区是平铺的：没有上下级
    assert listing.path == "" and listing.parent is None


def test_workspace_area_lists_real_directories(
    services: Services, workspace_conversation: tuple[str, Path]
) -> None:
    conversation_id, root = workspace_conversation
    (root / "章节").mkdir()
    (root / "章节" / "一.md").write_text("正文", encoding="utf-8")
    (root / "说明.txt").write_text("说明", encoding="utf-8")
    (root / ".git").mkdir()  # 隐藏项不进列表

    listing = services.artifacts.list_files(conversation_id)

    assert listing.mode == ARTIFACT_IN_WORKSPACE
    assert listing.label == "工作区「我的项目」"
    # 目录在前、各自按名字排序
    assert [item.name for item in listing.entries] == ["章节", "说明.txt"]
    assert listing.entries[0].is_dir and listing.entries[0].kind == "dir"

    inner = services.artifacts.list_files(conversation_id, "章节")
    assert [item.key for item in inner.entries] == ["章节/一.md"]
    assert inner.path == "章节" and inner.parent == ""


def test_reading_a_file_from_either_area(
    services: Services, conversation: str, tmp_path: Path
) -> None:
    temp = services.artifacts.save(
        conversation_id=conversation, filename="a.txt", content=b"temp", kind="txt"
    )
    content, name = services.artifacts.read_file(conversation, temp.id)
    assert (content, name) == (b"temp", "a.txt")

    root = tmp_path / "proj2"
    root.mkdir()
    workspace = services.workspaces.create(name="项目", root_path=str(root), user_id=None)
    bound = services.conversations.create(title="工作区的", workspace_id=workspace.id).id
    (root / "note.md").write_text("hello", encoding="utf-8")

    content, name = services.artifacts.read_file(bound, "note.md")
    assert (content, name) == (b"hello", "note.md")


def test_traversal_out_of_the_workspace_is_refused(
    services: Services, workspace_conversation: tuple[str, Path], tmp_path: Path
) -> None:
    """**key 是从浏览器回来的**，而它最终会拼成文件路径。

    没有这道判定，`?key=../../other-user/secret` 就能读到工作区外面的东西——
    这是整个文件面板最要紧的一条。
    """
    from app.core.exceptions import InvalidRequestError

    conversation_id, _root = workspace_conversation
    (tmp_path / "outside.txt").write_text("外面", encoding="utf-8")

    for key in ("../outside.txt", "..", "章节/../../outside.txt", str(tmp_path / "outside.txt")):
        with pytest.raises((InvalidRequestError, NotFoundError)):
            services.artifacts.read_file(conversation_id, key)


def test_reading_another_conversations_artifact_is_refused(
    services: Services, conversation: str
) -> None:
    """临时区按产物 id 取：不校验归属就能拿别人的文件。"""
    other = services.conversations.create(title="别人的").id
    record = services.artifacts.save(
        conversation_id=other, filename="secret.txt", content=b"s", kind="txt"
    )

    with pytest.raises(NotFoundError):
        services.artifacts.read_file(conversation, record.id)


def test_upload_into_the_temp_area_becomes_an_artifact(
    services: Services, conversation: str
) -> None:
    """临时区的东西按产物记账——另立一套"没有记录的文件"只会让清理策略漏掉它们。"""
    entry = services.artifacts.write_file(
        conversation_id=conversation, path="", filename="我传的.txt", content=b"up"
    )

    assert entry.name == "我传的.txt" and entry.size_bytes == 2
    assert services.artifacts.get(entry.key).name == "我传的.txt"


def test_upload_into_a_workspace_does_not_overwrite(
    services: Services, workspace_conversation: tuple[str, Path]
) -> None:
    conversation_id, root = workspace_conversation
    (root / "已有.txt").write_text("原来的", encoding="utf-8")

    entry = services.artifacts.write_file(
        conversation_id=conversation_id, path="", filename="已有.txt", content="新的".encode()
    )

    assert (root / "已有.txt").read_text(encoding="utf-8") == "原来的"
    assert entry.name == "已有 (2).txt"
    assert services.artifacts.read_file(conversation_id, entry.key)[0] == "新的".encode()


def test_upload_to_a_subdirectory(
    services: Services, workspace_conversation: tuple[str, Path]
) -> None:
    conversation_id, root = workspace_conversation
    (root / "素材").mkdir()

    entry = services.artifacts.write_file(
        conversation_id=conversation_id, path="素材", filename="图.txt", content=b"x"
    )

    assert entry.key == "素材/图.txt"
    assert (root / "素材" / "图.txt").is_file()


def test_file_signature_covers_the_conversation_and_the_key() -> None:
    """签名必须绑定"哪条会话的哪份文件"。

    key 里带斜杠，所以拼之前要转义——不转的话 `a/b` 与 `a:b` 会撞成同一个资源标识，
    一条签名能换到另一份文件。
    """
    from app.services.artifacts import file_signature_resource

    assert file_signature_resource("conv_1", "章节/一.md") != file_signature_resource(
        "conv_2", "章节/一.md"
    )
    assert file_signature_resource("conv_1", "a/b") != file_signature_resource("conv_1", "a:b")
