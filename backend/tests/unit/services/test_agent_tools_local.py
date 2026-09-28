"""新工具的接线（v0.33）：工具表里出现什么、结果怎么渲染给模型。

镜像同构：``app/services/agent_tools.py`` 的 ``_LOCAL_TOOLS`` / ``_LOCAL_KB_TOOLS`` /
``_run_file_tool`` / ``_list_tables`` / ``_query_table`` / ``_schedule_task`` /
``_read_memory`` / ``_write_memory`` → 本文件。

四件事：

1. **关掉知识库开关时，表格那两个工具一起消失**（判据是"数据从哪来"——
   表格副本就是入库文档的产物，留着它等于开一条按 SQL 读库里内容的近路）；
2. **文件与执行工具恒在**（它们不依赖知识库，依赖的是会话的工作区与沙箱）；
3. **渲染是给人/模型读的文本**：文件内容不能包在 JSON 里（一屏 ``\\n``），
   SQL 结果给 Markdown 表（模型对表格形状的读数比一层字段名准）；
4. **记忆那一侧跟着记忆开关走**：关着时 ``recall`` 与 ``read_memory`` 一起消失，
   而 ``remember`` 留着（它不看那个开关，见 ``MemoryService.remember``）。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.services import agent_tools, memory_files
from app.services.agent_files import Roots
from app.services.api_key import Caller
from app.services.memory import MemoryService
from app.storage.base import ScheduledTaskRecord
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
    """文件、执行、定时任务**不依赖知识库**：关掉知识库它们照样在。"""
    names = _names(None)
    assert {"list_files", "read_file", "search_files", "run_command"} <= names
    assert {"schedule_task", "list_scheduled_tasks"} <= names


def test_tabular_tools_follow_the_knowledge_base_switch() -> None:
    assert {"list_tables", "query_table"} <= _names(["kb_x"])
    assert not ({"list_tables", "query_table"} & _names(None))


def test_local_tools_come_before_external_ones() -> None:
    """内置 → 技能 → 这台机器上的能力 → 外部服务（我们对前三段负责，外部排最后）。"""
    names = [spec.name for spec in agent_tools.tool_specs(kb_ids=["kb_x"])]
    assert names.index("read_skill") < names.index("list_files") < names.index("schedule_task")


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


# ------------------------------------------------------------------ 表格渲染


class _FakeTabular:
    def __init__(
        self, items: list[dict[str, Any]] | None = None, payload: dict | None = None
    ) -> None:  # type: ignore[type-arg]
        self._items = items or []
        self._payload = payload or {}
        self.seen: dict[str, Any] = {}

    def tables(self, *, kb_ids: list[str] | None = None) -> list[dict[str, Any]]:
        return self._items

    def query_sql(self, *, sql: str, kb_ids: list[str] | None = None, limit: int = 100) -> dict:  # type: ignore[type-arg]
        self.seen = {"sql": sql, "kb_ids": kb_ids, "limit": limit}
        return self._payload


class _FakeServices:
    def __init__(self, **parts: object) -> None:
        self.__dict__.update(parts)


def test_list_tables_shows_columns_so_sql_can_be_written() -> None:
    """列名要给全：模型下一步要写 SQL，**它得知道列叫什么**。"""
    services = _FakeServices(
        tabular=_FakeTabular(
            items=[
                {
                    "document_id": "doc_a",
                    "name": "记账.csv",
                    "columns": ["月份", "金额"],
                    "rows": 12,
                }
            ]
        )
    )
    outcome = agent_tools._list_tables(services, ["kb_x"])
    assert "doc_a" in outcome.content
    assert "月份、金额" in outcome.content
    assert "12 行" in outcome.content


def test_list_tables_without_scope_explains_the_switch() -> None:
    outcome = agent_tools._list_tables(_FakeServices(), [])
    assert "没有可查的知识库" in outcome.content


def test_query_table_renders_markdown_and_passes_the_scope() -> None:
    payload = {
        "sql": "SELECT 1",
        "columns": ["科目", "合计"],
        "rows": [["餐饮", "320"]],
        "total": 1,
        "truncated": False,
        "tables": [],
        "note": "最多回 100 行",
    }
    fake = _FakeTabular(payload=payload)
    outcome = agent_tools._query_table(_FakeServices(tabular=fake), ["kb_x"], {"sql": "SELECT 1"})
    assert "| 科目 | 合计 |" in outcome.content
    assert "| 餐饮 | 320 |" in outcome.content
    assert fake.seen["kb_ids"] == ["kb_x"]


def test_query_table_reports_a_refusal_verbatim() -> None:
    """拒绝的理由要**原样回给模型**：那里的措辞是照着"下一步怎么做"写的。"""

    class _Refusing(_FakeTabular):
        def query_sql(self, **kwargs: object) -> dict:  # type: ignore[type-arg]
            raise InvalidRequestError("这些表不在这一轮能查的范围内：doc_secret")

    outcome = agent_tools._query_table(_FakeServices(tabular=_Refusing()), ["kb_x"], {"sql": "x"})
    assert "doc_secret" in outcome.content
    assert outcome.summary == "查询没跑成"


# ------------------------------------------------------------------ 定时任务工具


class _FakeSchedules:
    def __init__(self) -> None:
        self.created: dict[str, Any] = {}
        self.records: list[ScheduledTaskRecord] = []

    def create(self, **kwargs: object) -> ScheduledTaskRecord:
        self.created = dict(kwargs)
        record = ScheduledTaskRecord(
            id="sched_1",
            name=str(kwargs.get("name")),
            prompt=str(kwargs.get("prompt")),
            kind=str(kwargs.get("kind")),
            cron=str(kwargs.get("cron") or ""),
            run_at=kwargs.get("run_at"),  # type: ignore[arg-type]
            next_run_at=datetime.now().astimezone() + timedelta(hours=1),
            kb_ids=tuple(kwargs.get("kb_ids") or ()),  # type: ignore[arg-type]
            owner_id=kwargs.get("owner_id"),  # type: ignore[arg-type]
        )
        self.records.append(record)
        return record

    def next_run_text(self, record: ScheduledTaskRecord) -> str:
        return "每天 09:00"

    def list(self, *, owner_id: str | None) -> list[ScheduledTaskRecord]:
        return self.records


def test_schedule_task_defaults_the_scope_to_this_conversation() -> None:
    """库范围默认跟随这一轮：留给模型一个空白字段，它要么编一个、要么把库全勾上。"""
    fake = _FakeSchedules()
    outcome = agent_tools._schedule_task(
        _FakeServices(schedules=fake),
        Caller(is_admin=True),
        ["kb_1"],
        {"name": "早报", "prompt": "汇总昨天", "cron": "0 9 * * *"},
    )
    assert fake.created["kb_ids"] == ["kb_1"]
    assert fake.created["kind"] == "cron"
    assert "每天 09:00" in outcome.content


def test_schedule_task_with_a_time_is_a_one_shot() -> None:
    fake = _FakeSchedules()
    agent_tools._schedule_task(
        _FakeServices(schedules=fake),
        Caller(is_admin=True),
        [],
        {"name": "一次", "prompt": "跑", "run_at": "2027-01-01T09:00"},
    )
    assert fake.created["kind"] == "once"
    assert fake.created["run_at"] == datetime(2027, 1, 1, 9, 0)


def test_schedule_task_with_a_broken_time_says_what_to_write() -> None:
    with pytest.raises(InvalidRequestError, match="ISO 8601"):
        agent_tools._schedule_task(
            _FakeServices(schedules=_FakeSchedules()),
            Caller(is_admin=True),
            [],
            {"name": "坏的", "prompt": "跑", "run_at": "明天早上"},
        )


def test_list_scheduled_tasks_says_when_nothing_is_scheduled() -> None:
    outcome = agent_tools._list_scheduled(
        _FakeServices(schedules=_FakeSchedules()), Caller(is_admin=True)
    )
    assert outcome.content == "还没有挂过定时任务。"


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
    """记忆关着时 **``recall`` 与 ``read_memory`` 一起消失**，``remember`` 留着。

    关着时 ``recall`` 会明确报"未启用长期记忆"，而"给了又拒"正是知识库那一侧
    已经修过的坑（模型先试一次、再拿一句错误，白花一个来回——见 ``_KB_TOOLS``）。

    ``remember`` **必须留着**：它写的是 ``MEMORY.md``，那份文件不看开关也会注入，
    所以关着时它照样有效（与 ``MemoryService.remember`` 同一口径）。
    """
    on = _names_with_memory(True, ["kb_x"])
    off = _names_with_memory(False, ["kb_x"])

    assert {"recall", "read_memory"} <= on
    assert not ({"recall", "read_memory"} & off)
    # 写人设与 `remember` 一样**不看开关**：人设文件不看开关也会注入，
    # 所以关着记忆时它们照样有效（见 `MemoryService.remember` 的说明）
    assert {"remember", "write_memory"} <= off


def test_read_memory_description_says_when_to_use_it() -> None:
    """描述要写清"**片段不够时**用它"。

    缺了这一句，模型看到的是"有个读记忆的工具"，而它并不觉得自己需要——
    它以为自己手上的片段就是全文。那正是原先那个缺口的样子。
    """
    specs = {
        spec.name: spec for spec in agent_tools.tool_specs(
            SimpleNamespace(memory=_FakeMemory(True)), kb_ids=["kb_x"]
        )
    }
    description = specs["read_memory"].description

    assert "recall" in description and "展开" in description


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


def _file_services(artifacts: Any = None, *, duplicate: bool = False) -> _FakeServices:
    return _FakeServices(
        artifacts=artifacts,
        ingest=_FakeIngest(duplicate=duplicate),
        documents=_FakeDocuments(),
        api_keys=_FakeApiKeys(),
    )


def test_conversation_file_tools_are_always_there() -> None:
    """会话文件区那两个**不依赖知识库**：用户上传的东西与"查不查库"没关系。"""
    names = _names(None)
    assert {"list_conversation_files", "read_conversation_file"} <= names


def test_ingest_file_follows_the_knowledge_base_switch() -> None:
    """入库是**写知识库**：关掉开关时它一起消失（与表格那两个同一条纪律）。"""
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

    assert services.ingest.calls[0]["filename"] == "报告.pdf"
    assert services.ingest.calls[0]["content"] == b"pdf-bytes"
    assert services.documents.enqueued == ["doc_new"]
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

    assert services.ingest.calls[0]["content"] == b"a,b\n1,2\n"
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

    assert services.documents.enqueued == []
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


def test_read_memory_expands_a_hit_by_line_window(tmp_path: Path) -> None:
    """按行窗口给正文，并说清"这是第几行到第几行、**共几行**"。

    行号是模型接着往下读的依据：不说总行数，它不知道还有没有下文，
    就会把这一窗当成全文——于是又回到"以为自己看到了全部"。
    """
    service = _memory_service(tmp_path)
    relative = "daily/2026-09-27/某会话.md"
    memory_files.write_file(
        service.workspace, relative, "\n".join(f"第 {index} 行" for index in range(1, 21))
    )

    outcome = agent_tools._read_memory(
        SimpleNamespace(memory=service),
        Caller(is_admin=True),
        {"path": relative, "start_line": 5, "limit": 3},
    )

    assert "第 5 行" in outcome.content and "第 7 行" in outcome.content
    assert "第 4 行" not in outcome.content and "第 8 行" not in outcome.content
    assert "共 20 行" in outcome.content


def test_read_memory_refuses_to_escape_the_workspace(tmp_path: Path) -> None:
    """路径越界一律拒——**不因为"path 是从 recall 结果里抄来的"就放行**。

    走的是记忆那一侧的同一套安全解析（``safe_path``），所以这里只需确认
    它没被绕过、并且把原因如实回了模型（它据此才该改路）。
    """
    service = _memory_service(tmp_path)

    outcome = agent_tools._read_memory(
        SimpleNamespace(memory=service),
        Caller(is_admin=True),
        {"path": "../../backend/.env"},
    )

    assert "读不了这份记忆" in outcome.content


def test_read_memory_without_a_path_says_so() -> None:
    outcome = agent_tools._read_memory(
        SimpleNamespace(memory=None), Caller(is_admin=True), {}
    )

    assert "缺少参数" in outcome.content


def test_write_memory_updates_a_persona_file(tmp_path: Path) -> None:
    """整份改写 ``PROFILE.md``——**首次引导靠它才落得下来**（Agent 自己写对方是谁）。

    回应里必须带上"告诉对方"：那是他的设定（设计文档 §2.5 的两条约定之一：
    **改动要告知用户**）。
    """
    service = _memory_service(tmp_path)

    outcome = agent_tools._write_memory(
        SimpleNamespace(memory=service),
        Caller(is_admin=True),
        {"name": "PROFILE.md", "content": "# 我是 KYLAB\n\n- 名字：小又\n"},
    )

    assert "PROFILE.md" in outcome.content
    assert "告诉对方" in outcome.content
    assert memory_files.read_file(service.workspace, "PROFILE.md").content.startswith("# 我是")


def test_write_memory_refuses_memory_md(tmp_path: Path) -> None:
    """``MEMORY.md`` **不在白名单里**：它的条目由 `remember` 一条条维护
    （管去重、只替换「核心长期记忆」那一节），允许整份覆盖等于把"逐条维护"
    换成"一把梭"——而它每轮整份进上下文，写坏了影响面最大。

    拒绝时要把**该用什么**说清楚：只说"不行"，模型会换个名字再试。
    """
    service = _memory_service(tmp_path)

    outcome = agent_tools._write_memory(
        SimpleNamespace(memory=service),
        Caller(is_admin=True),
        {"name": "MEMORY.md", "content": "- 覆盖整份"},
    )

    assert "只能改" in outcome.content
    assert "remember" in outcome.content
    assert not (service.workspace / "MEMORY.md").exists()


def test_write_memory_refuses_the_agents_own_persona(tmp_path: Path) -> None:
    """``SOUL.md`` / ``AGENTS.md`` **也不在白名单里**（v0.52，用户口径）。

    白名单里只留 ``PROFILE.md``（关于"对方是谁"的事实）。这两份是**用户自己的东西**
    ——Agent 改自己的人格与规程，既难回滚、也难让用户察觉，而它们每轮整份进上下文。
    拒绝时要告诉它**该怎么做**（说出来让对方决定），而不是只回一句"不行"：
    只说不行，模型会换个说法再试一次。
    """
    service = _memory_service(tmp_path)

    for name in ("SOUL.md", "AGENTS.md"):
        outcome = agent_tools._write_memory(
            SimpleNamespace(memory=service),
            Caller(is_admin=True),
            {"name": name, "content": "我自己改的"},
        )
        assert "PROFILE.md" in outcome.content
        assert "说给他听" in outcome.content or "说给" in outcome.content
        assert not (service.workspace / name).exists()


def test_write_memory_needs_content(tmp_path: Path) -> None:
    service = _memory_service(tmp_path)

    outcome = agent_tools._write_memory(
        SimpleNamespace(memory=service),
        Caller(is_admin=True),
        {"name": "PROFILE.md", "content": "   "},
    )

    assert "缺少参数" in outcome.content


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
