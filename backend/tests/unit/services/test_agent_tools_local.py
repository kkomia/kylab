"""新工具的接线（v0.33）：工具表里出现什么、结果怎么渲染给模型。

镜像同构：``app/services/agent_tools.py`` 的 ``_LOCAL_TOOLS`` / ``_LOCAL_KB_TOOLS`` /
``_query_table`` / ``_read_memory`` / ``_write_memory`` → 本文件。

四件事：

1. **关掉知识库开关时，表格那两个工具一起消失**（判据是"数据从哪来"——
   表格副本就是入库文档的产物，留着它等于开一条按 SQL 读库里内容的近路）；
2. **文件与执行工具恒在**（它们不依赖知识库，依赖的是会话的工作区与沙箱）；
3. **渲染是给人/模型读的文本**：文件内容不能包在 JSON 里（一屏 ``\\n``），
   SQL 结果给 Markdown 表（模型对表格形状的读数比一层字段名准）；
4. **记忆那一侧跟着记忆开关走**：关着时 ``recall`` 从工具表里消失，
   而 ``remember`` / ``read_memory`` 留着（它们不看那个开关）。
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.core.exceptions import NotFoundError
from app.services import agent_tools
from app.services.agent_files import Roots
from app.services.api_key import Caller
from app.services.memory import MemoryService
from tests.conftest import install_fake_chat  # noqa: F401  （保持与其它用例一致的导入面）


def _names(kb_ids: list[str] | None) -> set[str]:
    return {spec.name for spec in agent_tools.tool_specs(kb_ids=kb_ids)}


class _FakeMemory:
    """只实现 ``tool_specs`` 用到的那一个属性（形状与真的一致）。"""

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled


class _FakeRuntime:
    """只实现 MemoryService 用到的那三个读接口（形状与真的一致）。"""

    def __init__(self, values: dict[str, str]) -> None:
        self._values = values

    def get(self, key: str) -> str:
        return self._values.get(key, "")

    def get_bool(self, key: str, *, default: bool = False) -> bool:
        raw = self._values.get(key)
        if raw is None or not raw.strip():
            return default
        return raw.strip().lower() in {"1", "true", "yes", "on"}

    def get_int(self, key: str) -> int:
        return 0

    def llm(self):
        """没配对话模型的那个快照（读记忆不必有模型，这一条顺带钉住它）。"""
        from app.services.llm import LLMConfig

        return LLMConfig(base_url="", api_key="", model_id="")

    def embedding(self):
        """**一律没配**：服务层退回开发用确定性嵌入（无语义的词面哈希）。"""
        from app.services.runtime_config import EmbeddingSettings

        return EmbeddingSettings(base_url="", api_key="", model_id="", dim=0, batch_size=32)


def _memory_service(tmp_path: Path) -> MemoryService:
    return MemoryService(  # type: ignore[arg-type]
        _FakeRuntime({"memory.workspace": "memory"}), tmp_path
    )


def _names_with_memory(enabled: bool, kb_ids: list[str] | None = None) -> set[str]:
    """带一个假记忆服务的工具表。

    ``services`` 只给 ``memory`` 一项：``_mcp_specs`` 读不到 ``services.mcp`` 会
    自己吞掉（那一处是"外部工具读不出来不该让整轮起不来"）。
    """
    services = SimpleNamespace(memory=_FakeMemory(enabled))
    return {spec.name for spec in agent_tools.tool_specs(services, kb_ids=kb_ids)}


# ------------------------------------------------------------------ 工具表


def test_machine_tools_are_always_there() -> None:
    """文件与执行**不依赖知识库**：关掉知识库它们照样在。"""
    names = _names(None)
    assert {"list_files", "read_file", "search_files", "run_command"} <= names


def test_local_tools_come_before_external_ones() -> None:
    """内置 → 技能 → 这台机器上的能力 → 外部服务（我们对前三段负责，外部排最后）。"""
    names = [spec.name for spec in agent_tools.tool_specs(kb_ids=["kb_x"])]
    assert names.index("read_skill") < names.index("list_files")


# ------------------------------------------------------------------ 文件渲染


@pytest.fixture
def roots(tmp_path):  # type: ignore[no-untyped-def]
    workspace = tmp_path / "ws"
    sandbox = tmp_path / "box"
    workspace.mkdir()
    sandbox.mkdir()
    (workspace / "main.py").write_text("import os\nprint(os.getcwd())\n", encoding="utf-8")
    (workspace / "sub").mkdir()
    return Roots(workspace=workspace, sandbox=sandbox)


def test_list_files_renders_a_readable_listing(roots: Roots) -> None:
    outcome = agent_tools._run_file_tool("list_files", roots, {})
    assert outcome.content.startswith("workspace:.")
    assert "d sub" in outcome.content
    assert "f main.py" in outcome.content
    assert outcome.summary


def test_read_file_returns_plain_text_not_json(roots: Roots) -> None:
    """文件内容必须是**原文**：包成 JSON 会变成一屏转义字符，而这段是给模型读的。"""
    outcome = agent_tools._run_file_tool("read_file", roots, {"path": "main.py"})
    assert "print(os.getcwd())" in outcome.content
    assert "\\n" not in outcome.content
    assert "共 2 行" in outcome.content


def test_search_files_renders_path_and_line(roots: Roots) -> None:
    outcome = agent_tools._run_file_tool("search_files", roots, {"pattern": "getcwd"})
    assert "main.py:2:" in outcome.content
    assert outcome.summary == "命中 1 处"


def test_search_without_hits_says_so(roots: Roots) -> None:
    outcome = agent_tools._run_file_tool("search_files", roots, {"pattern": "不存在的词"})
    assert "（没有命中）" in outcome.content


class _FakeServices:
    def __init__(self, **parts: object) -> None:
        self.__dict__.update(parts)


def test_the_machine_tools_are_wired_into_the_runner(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """执行器要真的认识这些名字（少接一个，模型调它时只会得到"未知的工具"）。"""
    # **要打 ``agent_tools`` 上那个名字**：它是 `from ... import resolve_roots`
    # 引进来的绑定，改 ``agent_exec`` 里的同名函数对这个模块没有影响
    monkeypatch.setattr(
        agent_tools,
        "resolve_roots",
        lambda *a, **k: Roots(workspace=None, sandbox=Path(tmp_path)),
    )
    (tmp_path / "note.txt").write_text("hello", encoding="utf-8")
    runner = agent_tools.build_runner(_FakeServices(), Caller(is_admin=True), kb_ids=[])
    outcome = runner("read_file", {"path": "note.txt"})
    assert "hello" in outcome.content


# ------------------------------------------------------------------ 记忆工具


def test_memory_tools_follow_the_memory_switch() -> None:
    """记忆关着时**只有 ``recall`` 消失**，其余三件留着。

    关着时 ``recall`` 会明确报"未启用长期记忆"（关的正是注入与 recall 这一对），
    而"给了又拒"正是知识库那一侧已经修过的坑（模型先试一次、再拿一句错误，
    白花一个来回——见 ``_KB_TOOLS``）。

    **``remember`` / ``forget`` / ``read_memory`` 不看那个开关**（它管的是
    注入与 recall，记忆的读写不看它）——"关了也能改自己的东西"这条纪律保留。
    """
    on = _names_with_memory(True, ["kb_x"])
    off = _names_with_memory(False, ["kb_x"])

    assert "recall" in on
    assert "recall" not in off
    assert {"remember", "forget", "read_memory"} <= off
    # `write_memory` 退场（§7.4）：工具表里不再有它，开关开着也没有
    assert "write_memory" not in on


def test_read_memory_description_says_what_it_reads() -> None:
    """描述要写清**它列的是记忆条目**、以及为什么还要看它（条目每轮已经注入）。

    缺了这一句，模型会问"我不是已经看到了吗"——或者更糟：把注入块里那几条
    （渲染过的形状、**不带 id**）当成库里的原文，于是改 / 删时指不准是哪一条。
    """
    specs = {
        spec.name: spec for spec in agent_tools.tool_specs(
            SimpleNamespace(memory=_FakeMemory(True)), kb_ids=["kb_x"]
        )
    }
    description = specs["read_memory"].description

    assert "长期记忆" in description
    assert "id" in description


# ------------------------------------------------------------------ 会话文件区（v0.55）


class _FakeArtifacts:
    """会话文件区的假件：只实现那两个工具用到的方法（形状与真的一致）。"""

    def __init__(
        self,
        *,
        label: str = "本会话",
        entries: list[Any] | None = None,
        blobs: dict[str, bytes] | None = None,
        truncated: bool = False,
    ) -> None:
        self.label = label
        self.entries = list(entries or [])
        self.blobs = dict(blobs or {})
        self.truncated = truncated

    def list_files(self, conversation_id: str, path: str = "") -> Any:
        return SimpleNamespace(label=self.label, entries=self.entries, truncated=self.truncated)

    def read_file(self, conversation_id: str, key: str) -> tuple[bytes, str]:
        if key not in self.blobs:
            raise NotFoundError(f"文件区里没有这份：{key}")
        return self.blobs[key], key.rsplit("/", 1)[-1]


class _FakeIngest:
    def __init__(self, *, duplicate: bool = False) -> None:
        self.duplicate = duplicate
        self.calls: list[dict[str, Any]] = []

    def submit(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return SimpleNamespace(
            document=SimpleNamespace(id="doc_new", name=kwargs["filename"]),
            is_duplicate=self.duplicate,
        )


class _FakeDocuments:
    def __init__(self) -> None:
        self.enqueued: list[str] = []

    def enqueue_ingest(self, document_id: str) -> None:
        self.enqueued.append(document_id)


class _FakeApiKeys:
    def __init__(self) -> None:
        self.checks: list[tuple[Any, list[str]]] = []

    def check_access(self, caller: Any, *, need: Any = None, kb_ids: Any = None) -> None:
        self.checks.append((need, list(kb_ids or [])))


class _FakeKb:
    """够用的假组合根（`services.kb` 那一格）：入库两条接缝 + 凭据判定。

    真身见 `core/services.py::KbServices`——本机这一档它就只有这三样。
    """

    def __init__(self, *, duplicate: bool = False) -> None:
        self.ingest = _FakeIngest(duplicate=duplicate)
        self.documents = _FakeDocuments()
        self.api_keys = _FakeApiKeys()


def _file_services(artifacts: Any = None, *, duplicate: bool = False) -> _FakeServices:
    return _FakeServices(artifacts=artifacts, kb=_FakeKb(duplicate=duplicate))


def test_conversation_file_tools_are_always_there() -> None:
    """会话文件区那两个**不依赖知识库**：用户上传的东西与"查不查库"没关系。"""
    names = _names(None)
    assert {"list_conversation_files", "read_conversation_file"} <= names


def test_ingest_file_follows_the_knowledge_base_switch() -> None:
    """入库是**写知识库**：关掉开关时它一起消失（与检索那条同一条纪律）。"""
    assert "ingest_file" in _names(["kb_x"])
    assert "ingest_file" not in _names(None)


def test_list_conversation_files_renders_the_file_area() -> None:
    entry = SimpleNamespace(key="art_1", name="报告.txt", is_dir=False, size_bytes=2048)
    services = _file_services(_FakeArtifacts(entries=[entry]))

    outcome = agent_tools._run_conversation_file_tool(
        "list_conversation_files", services, "c1", {}
    )

    assert "本会话" in outcome.content
    assert "art_1" in outcome.content
    assert outcome.summary == "本会话 1 项"


def test_conversation_file_tools_say_so_without_a_conversation() -> None:
    """没有会话（外部 MCP 客户端那条链路）时**如实说**，而不是抛。"""
    services = _file_services(_FakeArtifacts())
    for name in ("list_conversation_files", "read_conversation_file"):
        outcome = agent_tools._run_conversation_file_tool(name, services, None, {"key": "k"})
        assert "文件区" in outcome.content


def test_read_conversation_file_pages_text() -> None:
    blob = "第一行\n第二行\n第三行\n".encode()
    services = _file_services(_FakeArtifacts(blobs={"notes.txt": blob}))

    outcome = agent_tools._run_conversation_file_tool(
        "read_conversation_file", services, "c1", {"key": "notes.txt", "offset": 2, "limit": 1}
    )

    assert "2: 第二行" in outcome.content
    assert "共 3 行" in outcome.content


def test_read_conversation_file_tells_binary_how_to_ingest() -> None:
    """二进制读不出来时**给出下一步**（入库 → 检索）——当前链路没有多模态，
    这是唯一能"看"到图片 / PDF 内容的路。"""
    services = _file_services(_FakeArtifacts(blobs={"shot.png": b"\x89PNG\x00\x00"}))

    outcome = agent_tools._run_conversation_file_tool(
        "read_conversation_file", services, "c1", {"key": "shot.png"}
    )

    assert "二进制" in outcome.content
    assert "ingest_file" in outcome.content


def test_ingest_file_reads_from_the_conversation_file_area() -> None:
    """文件区命中：字节从那儿来，落库那一段与 ``upload_document`` 同一条路。"""
    services = _file_services(_FakeArtifacts(blobs={"报告.pdf": b"pdf-bytes"}))

    outcome = agent_tools._ingest_file(
        services,
        Caller(is_admin=True),
        "c1",
        Roots(workspace=None, sandbox=Path(".")),
        {"knowledge_base_id": "kb_1", "path": "报告.pdf"},
    )

    assert services.kb.ingest.calls[0]["filename"] == "报告.pdf"
    assert services.kb.ingest.calls[0]["content"] == b"pdf-bytes"
    assert services.kb.documents.enqueued == ["doc_new"]
    assert "doc_new" in outcome.content


def test_ingest_file_falls_back_to_the_file_face(tmp_path: Path) -> None:
    """文件区没有这份（模型自己 ``run_command`` 造出来的东西）就落到工作区/沙箱那一侧。"""
    (tmp_path / "out.csv").write_bytes(b"a,b\n1,2\n")
    services = _file_services(_FakeArtifacts())

    outcome = agent_tools._ingest_file(
        services,
        Caller(is_admin=True),
        "c1",
        Roots(workspace=tmp_path, sandbox=tmp_path),
        {"knowledge_base_id": "kb_1", "path": "out.csv"},
    )

    assert services.kb.ingest.calls[0]["content"] == b"a,b\n1,2\n"
    assert "doc_new" in outcome.content


def test_ingest_file_reports_a_duplicate_without_enqueueing() -> None:
    """库里已有同一份：**不重复入库、也不入队**，并如实说。"""
    services = _file_services(_FakeArtifacts(blobs={"a.txt": b"x"}), duplicate=True)

    outcome = agent_tools._ingest_file(
        services,
        Caller(is_admin=True),
        "c1",
        Roots(workspace=None, sandbox=Path(".")),
        {"knowledge_base_id": "kb_1", "path": "a.txt"},
    )

    assert services.kb.documents.enqueued == []
    assert "相同" in outcome.content


def test_ingest_file_says_where_to_find_paths_when_missing() -> None:
    """找不到时要说清"两种路径分别从哪儿拿"——否则模型只能瞎猜。"""
    services = _file_services(_FakeArtifacts())

    outcome = agent_tools._ingest_file(
        services,
        Caller(is_admin=True),
        "c1",
        Roots(workspace=None, sandbox=Path(".")),
        {"knowledge_base_id": "kb_1", "path": "nope.pdf"},
    )

    assert "list_conversation_files" in outcome.content
    assert "list_files" in outcome.content


def test_read_memory_lists_every_item_with_its_id(tmp_path: Path) -> None:
    """``read_memory`` 列的是**库里的全部条目、每条带 id**。

    它服务的是"自查"与"指出具体哪一条"两件事：注入块里那几条是渲染过的
    （按分区排、**不带 id**），而改 / 删都按 id 走，所以模型需要一个能拿到
    id 的入口；`replaces` 也要求原文对得上。
    """
    service = _memory_service(tmp_path)
    item_id = service.remember("用户要求先给结论", section="长期偏好与风格").item_id

    outcome = agent_tools._read_memory(
        SimpleNamespace(memory=service), Caller(is_admin=True), {}
    )

    assert "## 长期偏好与风格" in outcome.content
    assert f"[{item_id}] 用户要求先给结论" in outcome.content


def test_read_memory_says_when_the_store_is_empty(tmp_path: Path) -> None:
    """空库要说清"还没有一条"并指出该用什么，而不是回一段空白。"""
    service = _memory_service(tmp_path)

    outcome = agent_tools._read_memory(
        SimpleNamespace(memory=service), Caller(is_admin=True), {}
    )

    assert "空" in outcome.content
    assert "remember" in outcome.content


def test_write_memory_is_retired_and_says_what_to_use_instead(tmp_path: Path) -> None:
    """``write_memory`` **退场**（§7.4）：一律拒绝，并给出现在的四条路。

    整份覆盖与条目级预算/变更流不相容——它一次能撑爆预算，也能删掉一条不留痕。
    拒绝时把该用的工具点出来：只说"不行"，模型会换个说法再试（老客户端里
    ``write_memory`` 这个名字可能还在，这一句就是给那种情况准备的）。
    """
    service = _memory_service(tmp_path)

    outcome = agent_tools._write_memory(
        SimpleNamespace(memory=service),
        Caller(is_admin=True),
        {"name": "PROFILE.md", "content": "# 我自己写一份"},
    )

    assert "remember" in outcome.content
    assert "forget" in outcome.content
    assert "replaces" in outcome.content
    # **一个字都没写进去**：PROFILE.md 连文件都不该被建出来
    assert not (service.workspace / "PROFILE.md").exists()


# ------------------------------------------------------- D34：列表要自解释
# ------------------------------------------------------- D36：PDF 那种没有 NUL 的也算二进制


def test_the_file_listing_labels_the_key_so_the_model_does_not_copy_the_whole_line() -> None:
    """D34：列表每行要有**文件名**与 `key=` 标签，表头还要说清"只取 key= 后面那串"。

    病灶：原先是 `f art_6a6f9058babd（2.3 KB）`——没有文件名，也没说那串 id 是干什么的。
    实测模型会把**整行**当 key 交给 read_conversation_file，于是必然读失败
    （`读不了这份文件：文件不存在：f art_6a6f9058babd（2.3 KB）`），白烧三次调用。
    """
    entry = SimpleNamespace(key="art_1", name="走查样例.md", is_dir=False, size_bytes=549)
    services = _file_services(_FakeArtifacts(entries=[entry]))

    outcome = agent_tools._run_conversation_file_tool("list_conversation_files", services, "c1", {})

    assert "走查样例.md" in outcome.content, "文件名要出现（不然人也不知道那是哪一份）"
    assert "key=art_1" in outcome.content, "key 要有标签"
    assert "别带" in outcome.content, "表头要说清取哪一段"
    # 旧形状那种"只有一个裸 id"的行不该再出现
    assert "\nf art_1" not in outcome.content


def test_a_pdf_without_nul_bytes_is_still_binary(tmp_path: Path) -> None:
    """D36：PDF 的文件头里**没有 NUL**，还能按 UTF-8 解出来——只看字节会把它当文本。

    实测（走查那个 397 B 的样例）：前 4KB 里 0 个 NUL、`_text_or_none` 也放它过，
    于是"读"出来是 `1: %PDF-1.4 …` 这种原始字节，模型照样把它当内容去猜。
    这里三条判据一起钉：按路径、按名字、按字节。
    """
    from app.services import agent_files

    body = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(body)

    assert agent_files._looks_binary(pdf) is True
    assert agent_files.looks_binary_name("sample.pdf") is True
    # 字节那一侧也认（魔数兜底）——"改了名 / 没有扩展名"的靠它
    assert agent_tools._text_or_none(body) is None
    renamed = tmp_path / "mystery"
    renamed.write_bytes(body)
    assert agent_files._looks_binary(renamed) is True


def test_ordinary_text_files_are_not_mistaken_for_binary(tmp_path: Path) -> None:
    """反向那一半：这份名单是**黑名单**，不能误伤自造 / 小众文本格式。

    （只敢看 NUL 的那个顾虑正是"按扩展名白名单会漏掉 .log/.yaml/Dockerfile"——
    黑名单不会：它们不在名单里，所以照样按文本读。）
    """
    from app.services import agent_files

    for name in ("app.log", "conf.yaml", "notes.txt", "Makefile"):
        path = tmp_path / name
        path.write_text("普通文本\n", encoding="utf-8")
        assert agent_files._looks_binary(path) is False, name
        assert agent_files.looks_binary_name(name) is False, name


# --------------------------------------------------------- list_skills 分页（§12.341 ⑤）


def _skill_record(
    name: str,
    *,
    usable: bool = True,
    discarded: bool = False,
    flagged: str = "",
) -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        description=f"{name} 的说明",
        used_by_prompt=usable,
        discarded=discarded,
        flagged=flagged,
    )


def _skills_services(records: list[SimpleNamespace]) -> SimpleNamespace:
    """只需要 `services.skills.list()` 这一件事。"""
    return SimpleNamespace(skills=SimpleNamespace(list=lambda: records))


def test_list_skills_pages_instead_of_dumping_everything() -> None:
    """一次只给一页（默认 40 条），并说清"共几个、下一页从哪儿看"。

    现场（`conv_a5f4628f405f`）：近两百个技能全量输出是 **12,024 字**（结果被截断），
    而那一问只是要"有没有下载论文的技能"。
    """
    records = [_skill_record(f"skill-{index:03d}") for index in range(95)]
    text = agent_tools._render_skills(_skills_services(records))

    assert text.startswith("技能 1–40 / 共 95 个：")
    assert len([line for line in text.splitlines() if line.startswith("- ")]) == 40
    assert "offset=40" in text, "要告诉它下一页从哪儿开始"
    # 比全量短得多（这一条才是分页的意义）
    full = "\n".join(f"- {item.name}（可用）：{item.description}" for item in records)
    assert len(text) < len(full)


def test_list_skills_offset_walks_to_the_last_page() -> None:
    """`offset` 翻页；最后一页不再提"后面还有"。"""
    records = [_skill_record(f"skill-{index:03d}") for index in range(95)]
    text = agent_tools._render_skills(_skills_services(records), {"offset": 80})

    assert text.startswith("技能 81–95 / 共 95 个：")
    assert len([line for line in text.splitlines() if line.startswith("- ")]) == 15
    assert "后面还有" not in text


def test_list_skills_clamps_the_page_size() -> None:
    """调用方要再多也不给：分页上限是硬的（否则那个 12,024 字又回来了）。"""
    records = [_skill_record(f"skill-{index:03d}") for index in range(200)]
    text = agent_tools._render_skills(_skills_services(records), {"limit": 1000})

    assert len([line for line in text.splitlines() if line.startswith("- ")]) == 60


def test_list_skills_survives_garbage_paging_arguments() -> None:
    """翻页参数是模型给的：给字符串 / 布尔 / 越界值都不许把这次调用弄失败。"""
    records = [_skill_record(f"skill-{index:03d}") for index in range(95)]

    weird = agent_tools._render_skills(_skills_services(records), {"offset": "x", "limit": True})
    assert weird.startswith("技能 1–40 / 共 95 个："), "解析不了就回到第一页"

    beyond = agent_tools._render_skills(_skills_services(records), {"offset": 500})
    assert "越界" in beyond and "95" in beyond


def test_list_skills_keeps_the_two_unavailable_reasons_apart() -> None:
    """分页没有把 v0.43 那条口径弄丢：**被丢弃**与**被同名遮蔽**要分开说。"""
    records = [
        _skill_record("ok"),
        _skill_record("bad", usable=False, discarded=True, flagged="缺 name"),
        _skill_record("shadowed", usable=False),
    ]
    text = agent_tools._render_skills(_skills_services(records))

    assert "已丢弃（缺 name）" in text
    assert "被同名技能遮蔽" in text


def test_list_skills_schema_advertises_the_paging_arguments() -> None:
    """工具表里那一份 schema 也得说清怎么翻页（模型照它填参数）。"""
    schema = next(item for item in agent_tools._SKILL_TOOLS if item["name"] == "list_skills")
    properties = schema["inputSchema"]["properties"]

    assert set(properties) == {"offset", "limit"}
    assert str(agent_tools.SKILLS_PAGE_SIZE) in schema["description"]


def test_list_skills_says_so_when_nothing_is_installed() -> None:
    assert agent_tools._render_skills(_skills_services([])) == "这台机器上还没有安装技能。"
