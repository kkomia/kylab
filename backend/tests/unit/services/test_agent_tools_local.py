"""新工具的接线（v0.33）：工具表里出现什么、结果怎么渲染给模型。

镜像同构：``app/services/agent_tools.py`` 的 ``_LOCAL_TOOLS`` / ``_LOCAL_KB_TOOLS`` /
``_run_file_tool`` / ``_list_tables`` / ``_query_table`` / ``_schedule_task`` → 本文件。

三件事：

1. **关掉知识库开关时，表格那两个工具一起消失**（判据是"数据从哪来"——
   表格副本就是入库文档的产物，留着它等于开一条按 SQL 读库里内容的近路）；
2. **文件与执行工具恒在**（它们不依赖知识库，依赖的是会话的工作区与沙箱）；
3. **渲染是给人/模型读的文本**：文件内容不能包在 JSON 里（一屏 ``\\n``），
   SQL 结果给 Markdown 表（模型对表格形状的读数比一层字段名准）。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.core.exceptions import InvalidRequestError
from app.services import agent_tools
from app.services.agent_files import Roots
from app.services.api_key import Caller
from app.storage.base import ScheduledTaskRecord
from tests.conftest import install_fake_chat  # noqa: F401  （保持与其它用例一致的导入面）


def _names(kb_ids: list[str] | None) -> set[str]:
    return {spec.name for spec in agent_tools.tool_specs(kb_ids=kb_ids)}


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
