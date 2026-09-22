"""工作区根目录的"选择"：浏览服务器目录（v0.35）+ 专用可写区域（v0.41）。

镜像同构：``app/services/workspace.py`` 的 ``browse`` / ``root_path_problem`` /
``create_problem`` / ``rename_problem`` → 本文件。

**为什么"选择"要服务端做**：工作区根目录是**服务器上**的路径（后端跑在 NAS 上），
浏览器的目录选择器给的是客户端本机的东西——指向的还是另一台机器。所以只能是
"服务端列给你看"。这一组用例钉四件事：

1. **每件事只有一份判定**：浏览时标"不可选 / 不可建 / 不可改名"用的就是真去动手时
   那一份（``root_path_problem`` / ``create_problem`` / ``rename_problem``），
   所以灰掉的一定也做不成——不会出现"能选但建失败"，也不会"按钮亮着点了报错"；
2. **不藏东西**：数据目录会出现在列表里但标着原因（静默省略会让人以为"这里没有它"）；
   隐藏目录排在后面但**照样列出来**（它们是合法的工作区）；
3. **专用区域是唯一能动手的地方**（v0.41）：默认落在它里面、起点里排第一、
   首次浏览顺手建出来；区域外只读浏览，而"为什么不能建"直接标在那一行上——
   用户报的正是"显示了又不给建"；
4. **报错要能指导下一步**：把文件当目录时会顺带说出它的父目录（用户多半是拖错了），
   路径不存在时说清是哪个路径。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.core.exceptions import InvalidRequestError
from app.services.workspace import (
    AREA_ROOT_LABEL,
    MAX_BROWSE_ENTRIES,
    WorkspaceService,
    root_path_problem,
    workspace_area,
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
def area_dir(data_dir: Path) -> Path:
    """专用区域。**单独建出来**：绝大多数用例关心的是"区域里/外"的行为，
    而不是"它会不会被建出来"（那一条有它自己的用例）。"""
    target = workspace_area(data_dir)
    target.mkdir(parents=True, exist_ok=True)
    return target


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


def test_the_area_is_one_exception_inside_the_data_directory(tmp_path: Path) -> None:
    """专用区域在数据目录里，但**它里面的目录正是最该能当工作区的地方**。

    例外只开给这一个前缀：数据目录的其它部分照旧不可选（上面的用例钉着），
    而区域**自身**也不可选——它是所有工作区的容器，指过去等于把里面每一个项目
    一起交出去（成员可以直接填这个路径，而它在部署里很好猜）。
    """
    data = tmp_path / "data"
    (data / "workspaces" / "proj").mkdir(parents=True)
    (data / "inside").mkdir()

    assert root_path_problem(data / "workspaces" / "proj", data_dir=data) is None
    assert "「工作区」区域本身" in str(root_path_problem(data / "workspaces", data_dir=data))
    # 平级那个目录不受影响（例外没有顺着前缀漏出去）
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
    """**当前这一层自己**也要给三件事的判定：界面那颗"选这个目录"靠它决定亮不亮。

    服务端给而不是让界面猜：那几条判定只有一份，界面再猜一次就会出现
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


# ------------------------------------------------------ 专用可写区域（v0.41）


def test_the_area_is_created_on_the_first_browse_and_starts_the_roots(
    service: WorkspaceService, data_dir: Path
) -> None:
    """① 首次浏览会把专用区域建出来，并且**起点里排第一**、默认就落在它里面。

    幂等是"顺手建"的前提：浏览是 GET，每次打开选择器都会走一遍，
    建第二次不能报错、也不能覆盖里面已有的东西（``mkdir(exist_ok=True)`` 正好）。
    """
    area = workspace_area(data_dir)
    assert not area.exists(), "用例前提：还没人浏览过"

    view = service.browse(None)

    assert area.is_dir(), "浏览一次就该有地方可建"
    assert view.path == str(area), "默认落在区域里（家目录在容器里往往只读甚至不存在）"
    assert view.area == str(area)
    assert view.roots[0].path == str(area), "起点里排第一"
    assert view.roots[0].name == AREA_ROOT_LABEL
    assert view.roots[0].creatable is True

    # 再浏览一次：不报错，也不动里面已有的东西
    (area / "已有项目").mkdir()
    again = service.browse(None)
    assert (area / "已有项目").is_dir()
    assert again.roots[0].path == str(area)


def test_home_directory_is_still_offered_as_a_root(service: WorkspaceService) -> None:
    """默认不在家目录起步 **不等于** 不提供它：起点里还要有家目录，
    本地开发/换机器时照样要从那儿找项目。"""
    assert "家目录" in {item.name for item in service.browse(None).roots}


def test_inside_the_area_every_thing_is_selectable_and_creatable(
    service: WorkspaceService, area_dir: Path
) -> None:
    """② 区域里：能当工作区、能建目录、能改名——三件事一起亮。"""
    (area_dir / "proj").mkdir()
    view = service.browse(str(area_dir))

    assert view.current.selectable is False, "区域自身不是工作区（它是容器）"
    assert view.current.creatable is True
    proj = next(item for item in view.entries if item.name == "proj")
    assert proj.selectable is True
    assert proj.creatable is True
    assert proj.renamable is True
    assert proj.reason == "" and proj.create_reason == "" and proj.rename_reason == ""


def test_outside_the_area_rows_are_marked_read_only_with_the_reason(
    service: WorkspaceService, tmp_path: Path
) -> None:
    """③ 区域外：**原因标在那一行上**，而不是等用户点了"新建"才报错。

    断言的是"标记与拒绝是同一句话"——这条比"有没有标记"更要紧：
    两份规则一漂，界面就会开始说谎。
    """
    view = service.browse(str(tmp_path / "home"))
    proj = next(item for item in view.entries if item.name == "proj")
    assert proj.creatable is False
    assert proj.renamable is False
    assert "「工作区」区域" in proj.create_reason
    assert proj.selectable is True, "区域外仍然**可选**（只是不能写），改的只是能写的地方"

    with pytest.raises(InvalidRequestError) as create_exc:
        service.create_directory(parent=proj.path, name="新项目")
    assert str(create_exc.value) == proj.create_reason

    with pytest.raises(InvalidRequestError) as rename_exc:
        service.rename_directory(path=proj.path, name="proj2")
    assert str(rename_exc.value) == proj.rename_reason

    # 当前这一层也一样：界面上那颗「新建文件夹」就靠它决定亮不亮
    assert view.current.creatable is False
    with pytest.raises(InvalidRequestError) as here_exc:
        service.create_directory(parent=view.path, name="新项目")
    assert str(here_exc.value) == view.current.create_reason


def test_symlinks_are_judged_on_the_real_path(
    service: WorkspaceService, tmp_path: Path, area_dir: Path
) -> None:
    """软链：**判定必须落在解析后的位置上**，否则界面会说谎。

    两个方向都验：

    - 区域里链到区域外（`<区域>/escape -> <家目录>`）：写盘那条路 resolve 之后
      会被拒，所以浏览时那一行也得标着"不能建"——不然就是"标着能建、点了报错"；
    - 区域外链到区域里（`<家目录>/in -> <区域>`）：反过来，able 要写在前面，
      因为真去建是允许的（resolve 之后落在区域里）。
    """
    home = tmp_path / "home"
    outside_link = area_dir / "escape"
    inside_link = home / "in"
    try:
        outside_link.symlink_to(home, target_is_directory=True)
        inside_link.symlink_to(area_dir, target_is_directory=True)
    except (OSError, NotImplementedError):  # pragma: no cover - Windows 无权限时跳过
        pytest.skip("这个环境不允许建符号链接")

    escape = next(item for item in service.browse(str(area_dir)).entries if item.name == "escape")
    assert escape.creatable is False
    with pytest.raises(InvalidRequestError) as excinfo:
        service.create_directory(parent=str(outside_link), name="新项目")
    assert str(excinfo.value) == escape.create_reason
    assert not (home / "新项目").exists(), "被拒时不该动到区域外的目录"

    inside = next(item for item in service.browse(str(home)).entries if item.name == "in")
    assert inside.creatable is True
    entry = service.create_directory(parent=str(inside_link), name="新项目")
    assert entry.path == str((area_dir / "新项目").resolve())


def test_the_data_directory_row_says_the_specific_reason(
    service: WorkspaceService, data_dir: Path
) -> None:
    """数据目录（区域除外）也在"区域外"那一档里，但**说法更具体**：
    它同时告诉用户服务端的数据在哪儿、该去哪儿建项目。"""
    view = service.browse(str(data_dir.parent))
    entry = next(item for item in view.entries if item.path == str(data_dir.resolve()))
    assert entry.creatable is False
    assert "数据目录里不能新建目录" in entry.create_reason
    assert "「工作区」区域" in entry.create_reason

    # 而区域那一行是**能进去建**的（否则用户没有入口走到能建的地方）
    area_entry = next(item for item in service.browse(str(data_dir)).entries if item.creatable)
    assert area_entry.path == str(workspace_area(data_dir))


def test_an_existing_workspace_outside_the_area_is_still_selectable(
    service: WorkspaceService, tmp_path: Path
) -> None:
    """④ 已有工作区仍能选中：**区域外只读不等于区域外不能选**。

    老用户的目录在 NAS 上的别处（甚至就在家目录里），把它们变成"只能看、不能选"
    等于把已有工作区弄坏——所以"能不能选"与"能不能写"是两件事，两个判定。
    """
    existing = tmp_path / "elsewhere" / "老项目"
    existing.mkdir(parents=True)
    service._stores.meta.records = [
        WorkspaceRecord(id="ws_1", name="老项目", root_path=str(existing))
    ]

    view = service.browse(str(existing))
    assert view.current.path == str(existing.resolve())
    assert view.current.selectable is True, "老工作区照旧能选中"
    assert view.current.creatable is False, "但那儿建不了新目录"

    roots = {item.name: item for item in view.roots}
    assert roots["老项目"].path == str(existing.resolve())
    assert roots["老项目"].selectable is True


def test_roots_offer_the_usual_places(service: WorkspaceService, tmp_path: Path) -> None:
    """起点里要有专用区域、家目录、盘符（Windows）与**已有工作区的目录**。

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
    assert AREA_ROOT_LABEL in labels
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
    真正不能做的是把它当工作区、或者在里面写东西——那两条判定在别处。"""
    data_dir = service._data_dir
    view = service.browse(str(data_dir))
    assert view.path == str(data_dir.resolve())
    assert all(item.selectable is False for item in view.entries)


# ------------------------------------------------------------------ 建目录


def test_create_makes_one_directory_and_describes_it(
    service: WorkspaceService, area_dir: Path
) -> None:
    """② 区域内建目录：建完那一行**立刻就是可选的**（"建完选中它当工作区"，一步到位）。"""
    entry = service.create_directory(parent=str(area_dir), name="  新项目  ")
    assert entry.name == "新项目"  # 首尾空格会被清掉（不然盘上的名字不是他写的那个）
    assert entry.path == str((area_dir / "新项目").resolve())
    assert entry.selectable is True
    assert entry.creatable is True
    assert entry.renamable is True
    assert (area_dir / "新项目").is_dir()


def test_create_outside_the_area_is_refused_with_the_marked_reason(
    service: WorkspaceService, tmp_path: Path
) -> None:
    """③ 区域外建目录被拒，且拒绝的理由与浏览时标在那一行上的**一字不差**。"""
    marked = service.browse(str(tmp_path / "home")).current.create_reason
    with pytest.raises(InvalidRequestError) as excinfo:
        service.create_directory(parent=str(tmp_path / "home"), name="新项目")
    assert str(excinfo.value) == marked
    assert not (tmp_path / "home" / "新项目").exists(), "被拒时不该动到磁盘"


def test_create_refuses_an_existing_name(service: WorkspaceService, area_dir: Path) -> None:
    """重名**当场拒**：不覆盖也不合并——两种"顺手"都可能毁掉已有目录。"""
    (area_dir / "a").mkdir()
    with pytest.raises(InvalidRequestError, match="已经存在"):
        service.create_directory(parent=str(area_dir), name="a")


def test_create_does_not_make_parents(service: WorkspaceService, area_dir: Path) -> None:
    """只建一层：名字里带路径分隔符是歧义，拒掉让他分两步做。"""
    with pytest.raises(InvalidRequestError, match="不能有这些字符"):
        service.create_directory(parent=str(area_dir), name="x/y")


def test_create_refuses_inside_the_data_directory(
    service: WorkspaceService, data_dir: Path
) -> None:
    with pytest.raises(InvalidRequestError, match="数据目录里不能新建目录"):
        service.create_directory(parent=str(data_dir), name="新库")


@pytest.mark.parametrize(
    ("name", "why"),
    [
        ("con", "保留"),
        ("NUL.txt", "保留"),
        (".hidden", "以点开头"),
        ("trailing.", "以点开头或结尾"),
        ("a:b", "不能有这些字符"),
        ("x" * 81, "最多 80"),
    ],
)
def test_bad_names_are_refused_with_a_reason(
    service: WorkspaceService, area_dir: Path, name: str, why: str
) -> None:
    """名字按**可移植的那一套**校验：目录常要在 Windows 与 NAS 之间互拷。"""
    with pytest.raises(InvalidRequestError, match=why):
        service.create_directory(parent=str(area_dir), name=name)


# ------------------------------------------------------------------ 改目录名


def test_rename_moves_the_name_only(service: WorkspaceService, area_dir: Path) -> None:
    before = area_dir / "proj"
    before.mkdir()
    (before / "inner.txt").write_text("x", encoding="utf-8")
    entry = service.rename_directory(path=str(before), name="alpha")
    after = area_dir / "alpha"
    assert entry.path == str(after.resolve())
    assert after.is_dir()
    assert (after / "inner.txt").is_file(), "内容要跟着走"
    assert not before.exists()


def test_rename_to_the_same_name_is_a_no_op(service: WorkspaceService, area_dir: Path) -> None:
    """名字没变时当作成功（幂等）：界面上点了两下不该报错。"""
    target = area_dir / "proj"
    target.mkdir()
    entry = service.rename_directory(path=str(target), name="proj")
    assert entry.path == str(target.resolve())


def test_rename_refuses_an_existing_name(service: WorkspaceService, area_dir: Path) -> None:
    (area_dir / "a").mkdir()
    (area_dir / "b").mkdir()
    with pytest.raises(InvalidRequestError, match="已经存在"):
        service.rename_directory(path=str(area_dir / "a"), name="b")


def test_rename_outside_the_area_is_refused_with_the_marked_reason(
    service: WorkspaceService, tmp_path: Path
) -> None:
    """区域外改名同样被拒，理由也同样是浏览时那一句（同一份判定）。"""
    marked = service.browse(str(tmp_path / "home")).current.rename_reason
    with pytest.raises(InvalidRequestError) as excinfo:
        service.rename_directory(path=str(tmp_path / "home" / "proj"), name="proj2")
    assert str(excinfo.value) == marked
    assert (tmp_path / "home" / "proj").is_dir()


def test_rename_refuses_the_area_itself(service: WorkspaceService, area_dir: Path) -> None:
    """区域本身不能改名：它是选择器的默认落脚点，改了就找不回来了。"""
    with pytest.raises(InvalidRequestError, match="区域本身不能改名"):
        service.rename_directory(path=str(area_dir), name="projects")
    assert area_dir.is_dir()


def test_rename_refuses_a_workspace_root_inside_the_area(
    service: WorkspaceService, area_dir: Path
) -> None:
    """改了它，那条工作区就指向一个不存在的位置——表现为"突然什么都读不到"。

    v0.41 起工作区多半就落在区域里，所以这一条比过去更容易碰到：
    界面上那一行的改名图标会灰掉，并写着同一句话。
    """
    root = area_dir / "proj"
    root.mkdir()
    service._stores.meta.records = [
        WorkspaceRecord(id="ws_1", name="老项目", root_path=str(root))
    ]

    marked = next(item for item in service.browse(str(area_dir)).entries if item.name == "proj")
    assert marked.renamable is False
    assert "工作区「老项目」" in marked.rename_reason

    with pytest.raises(InvalidRequestError) as excinfo:
        service.rename_directory(path=str(root), name="proj2")
    assert str(excinfo.value) == marked.rename_reason
    assert root.is_dir(), "被拒时不该动到目录"


def test_rename_refuses_the_filesystem_root(service: WorkspaceService, tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError, match="文件系统根目录不能改名"):
        service.rename_directory(path=str(Path(tmp_path.anchor)), name="disk")


def test_rename_refuses_the_data_directory(service: WorkspaceService, data_dir: Path) -> None:
    with pytest.raises(InvalidRequestError, match="数据目录"):
        service.rename_directory(path=str(data_dir), name="data2")
    with pytest.raises(InvalidRequestError, match="数据目录"):
        service.rename_directory(path=str(data_dir / "inside"), name="inside2")


def test_rename_refuses_a_directory_that_contains_the_data_directory(tmp_path: Path) -> None:
    """**最容易漏的一条**：它是数据目录的祖先，改了名字服务端就找不到自己的库了。

    开发机上很常见——数据目录就在仓库里（`backend/data`）。
    """
    holder = tmp_path / "holder"
    (holder / "data").mkdir(parents=True)
    service = WorkspaceService(_FakeStores(_FakeMeta()), holder / "data")
    with pytest.raises(InvalidRequestError, match="里面有服务端的数据目录"):
        service.rename_directory(path=str(holder), name="holder2")


def test_rename_a_file_is_refused(service: WorkspaceService, tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError, match="不是目录"):
        service.rename_directory(path=str(tmp_path / "home" / "loose.txt"), name="x")
