"""工作区根目录的"选择"：浏览服务器目录（v0.35）。

镜像同构：``app/services/workspace.py`` 的 ``browse`` / ``root_path_problem`` → 本文件。

**为什么"选择"要服务端做**：工作区根目录是**服务器上**的路径（后端跑在 NAS 上），
浏览器的目录选择器给的是客户端本机的东西——指向的还是另一台机器。所以只能是
"服务端列给你看"。这一组用例钉三件事：

1. **判定只有一份**：浏览时标"不可选"用的就是建工作区那一份判定
   （``root_path_problem``），所以灰掉的一定也建不出来——不会出现"能选但建失败"；
2. **不藏东西**：数据目录会出现在列表里但标着原因（静默省略会让人以为"这里没有它"）；
   隐藏目录排在后面但**照样列出来**（它们是合法的工作区）；
3. **报错要能指导下一步**：把文件当目录时会顺带说出它的父目录（用户多半是拖错了），
   路径不存在时说清是哪个路径。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.core.exceptions import InvalidRequestError
from app.services.workspace import (
    MAX_BROWSE_ENTRIES,
    WorkspaceService,
    root_path_problem,
)
from app.storage.base import WorkspaceRecord


class _FakeMeta:
    """只够 ``browse`` 用的一小撮存储（它只读已有工作区来当起点）。"""

    def __init__(self, records: list[WorkspaceRecord] | None = None) -> None:
        self.records = records or []

    def list_workspaces(self) -> list[WorkspaceRecord]:
        return list(self.records)


class _FakeStores:
    def __init__(self, meta: _FakeMeta) -> None:
        self.meta = meta


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    """数据目录（与 ``service`` 用的是同一个）——**单独给出来**，
    免得用例去摸 ``service._data_dir`` 那种私货。"""
    (tmp_path / "data" / "inside").mkdir(parents=True)
    return tmp_path / "data"


@pytest.fixture
def service(tmp_path: Path, data_dir: Path) -> WorkspaceService:  # type: ignore[no-untyped-def]
    """一个 tmp 数据目录 + 一棵小目录树：home/proj/{a,b}、home/loose.txt。"""
    home = tmp_path / "home"
    (home / "proj" / "a").mkdir(parents=True)
    (home / "proj" / "b").mkdir(parents=True)
    (home / ".hidden").mkdir()
    (home / "loose.txt").write_text("不是目录", encoding="utf-8")
    return WorkspaceService(_FakeStores(_FakeMeta()), data_dir)


# ------------------------------------------------------------------ 判定只有一份


def test_root_path_problem_is_the_only_judgement(tmp_path: Path) -> None:
    data = tmp_path / "data"
    (data / "inside").mkdir(parents=True)
    ok = tmp_path / "proj"
    ok.mkdir()

    assert root_path_problem(ok, data_dir=data) is None
    assert "文件系统根" in str(root_path_problem(Path(tmp_path.anchor), data_dir=data))
    assert "数据目录" in str(root_path_problem(data, data_dir=data))
    assert "数据目录" in str(root_path_problem(data / "inside", data_dir=data))


# ------------------------------------------------------------------ 列目录


def test_lists_only_directories_and_puts_hidden_last(
    service: WorkspaceService, tmp_path: Path
) -> None:
    """文件不列（工作区根必须是目录），隐藏目录排后面但**照样列**。"""
    view = service.browse(str(tmp_path / "home"))
    names = [item.name for item in view.entries]
    assert "loose.txt" not in names
    assert names[-1] == ".hidden"
    assert names[0] == "proj"


def test_entries_carry_a_usable_path(service: WorkspaceService, tmp_path: Path) -> None:
    """回的是**绝对路径**：界面选完要拿它当 ``root_path`` 提交。"""
    view = service.browse(str(tmp_path / "home"))
    entry = next(item for item in view.entries if item.name == "proj")
    assert entry.path == str((tmp_path / "home" / "proj").resolve())
    assert entry.selectable is True
    assert entry.reason == ""


def test_current_layer_is_described_too(
    service: WorkspaceService, tmp_path: Path, data_dir: Path
) -> None:
    """**当前这一层自己**也要给可选性：界面那颗"选这个目录"靠它决定亮不亮。

    服务端给而不是让界面猜：那条判定只有一份，界面再猜一次就会出现
    "按钮亮着、点了却建不出来"。
    """
    ok = tmp_path / "home" / "proj"
    view = service.browse(str(ok))
    assert view.current.path == str(ok.resolve())
    assert view.current.selectable is True
    assert view.current.name == "proj"

    inside = service.browse(str(data_dir))
    assert inside.current.selectable is False
    assert "数据目录" in inside.current.reason


def test_parent_walks_up(service: WorkspaceService, tmp_path: Path) -> None:
    child = tmp_path / "home" / "proj"
    view = service.browse(str(child))
    assert view.path == str(child.resolve())
    assert view.parent == str(child.parent.resolve())
    assert [item.name for item in view.entries] == ["a", "b"]


def test_the_data_directory_is_listed_but_not_selectable(service: WorkspaceService) -> None:
    """**不藏起来**：标着原因比凭空消失更有用（他要找的可能正是它旁边那个）。"""
    data_dir = service._data_dir
    view = service.browse(str(data_dir.parent))
    entry = next(item for item in view.entries if item.path == str(data_dir.resolve()))
    assert entry.selectable is False
    assert "数据目录" in entry.reason


def test_starting_point_is_the_home_directory(service: WorkspaceService) -> None:
    view = service.browse(None)
    assert view.path == str(Path.home())


def test_roots_offer_the_usual_places(service: WorkspaceService, tmp_path: Path) -> None:
    """起点里要有家目录、盘符（Windows）与**已有工作区的目录**。

    最后一条是真用法："再建一个旁边的项目"比"从根一路点下去"常见得多。
    """
    existing = tmp_path / "existing"
    existing.mkdir()
    service._stores.meta.records = [
        WorkspaceRecord(id="ws_1", name="老项目", root_path=str(existing))
    ]
    roots = service.browse(None).roots
    labels = {item.name for item in roots}
    assert "家目录" in labels
    assert "老项目" in labels


def test_roots_never_contain_forbidden_places_as_selectable(service: WorkspaceService) -> None:
    """文件系统根会作为**起点**出现（要从那儿往下走），但标着不可选。"""
    roots = service.browse(None).roots
    impossible = [item for item in roots if not item.selectable]
    assert all(item.reason for item in impossible), "不可选就得给出原因"


def test_too_many_subdirectories_are_capped_and_stated(tmp_path: Path, data_dir: Path) -> None:
    home = tmp_path / "many"
    home.mkdir()
    for index in range(MAX_BROWSE_ENTRIES + 5):
        (home / f"d{index:04d}").mkdir()
    service = WorkspaceService(_FakeStores(_FakeMeta()), data_dir)

    view = service.browse(str(home))
    assert len(view.entries) == MAX_BROWSE_ENTRIES
    assert "只列了前" in view.note


# ------------------------------------------------------------------ 报错


def test_a_file_says_where_its_parent_is(service: WorkspaceService, tmp_path: Path) -> None:
    """用户多半是**拖错了东西**，所以报错里带上它的父目录——下一步该去哪一目了然。"""
    with pytest.raises(InvalidRequestError, match="不是目录"):
        service.browse(str(tmp_path / "home" / "loose.txt"))
    # match 是正则，Windows 路径里的反斜杠要转义
    with pytest.raises(InvalidRequestError, match=re.escape(str((tmp_path / "home").resolve()))):
        service.browse(str(tmp_path / "home" / "loose.txt"))


def test_a_missing_path_says_which_one(service: WorkspaceService, tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError, match="不存在或不可访问"):
        service.browse(str(tmp_path / "nope"))


def test_browsing_into_the_data_directory_is_allowed(service: WorkspaceService) -> None:
    """**列出来无害**（界面标着不可选），而"点进去看看"是人的正常动作；
    真正不能做的是把它当工作区——那条判定在 ``root_path_problem`` 里。"""
    data_dir = service._data_dir
    view = service.browse(str(data_dir))
    assert view.path == str(data_dir.resolve())
    assert all(item.selectable is False for item in view.entries)
