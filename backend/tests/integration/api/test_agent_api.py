"""工作区 / 技能 / MCP 端点（v0.15）。

镜像同构：``app/api/v1/workspaces.py`` + ``skills.py`` + ``mcp_servers.py`` → 本文件。

三组端点各有一条"只能靠接口层才发现"的断言：

1. **工作区**：归属（越权与不存在都是 404）与 `root_path` 的三道校验——
   校验在服务层，但**用户看到的是接口的报错**，所以要在这一层确认文案与状态码；
2. **技能**：磁盘上真有一份 `skills/kylab-knowledge-base/SKILL.md`，
   接口要能列出它并给出正文（不是打桩的假技能）；
3. **MCP**：**凭据不回显**——这条只有对着接口看才知道有没有漏；
   以及策略闸在接口层回 409 而不是 403。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.security import hash_password
from app.core.services import get_services
from app.models.enums import UserRole
from app.services.skill_categories import CATEGORIES
from app.storage.base import UserRecord
from tests.conftest import admin_client as admin_session


@pytest.fixture
def client():
    with admin_session() as test_client:
        yield test_client


@pytest.fixture
def member_token(client: TestClient) -> str:
    """一个普通成员，用来验归属隔离（直接落库造账号，与 test_visibility_api 同一套）。"""
    meta = get_services().auth._stores.meta
    existing = meta.find_user_by_username("member_ws")
    if existing is not None:
        meta.delete_user(existing.id)
    meta.create_user(
        UserRecord(
            id="user_member_ws",
            name="成员",
            username="member_ws",
            password_hash=hash_password("member pass 123"),
            role=UserRole.MEMBER,
        )
    )
    body = client.post(
        "/api/v1/auth/login", json={"username": "member_ws", "password": "member pass 123"}
    ).json()
    return str(body["token"])


def _as(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


#: 桌面壳注入的两个头（与 `desktop/src-tauri/src/resources.rs` 同名）。
DEVICE_HEADER = "X-Kylab-Device"
DEVICE_NAME_HEADER = "X-Kylab-Device-Name"
#: 两台"电脑"的标识（壳生成的是 UUID v4，这里给两个形状相同的常量）。
DEVICE_A = "11111111-1111-4111-8111-111111111111"
DEVICE_B = "22222222-2222-4222-8222-222222222222"


def _device(device_id: str, name: str = "DESKTOP-A") -> dict[str, str]:
    """一次"从某台电脑发出来"的请求头。**不带它**才是网页版/直连 API。

    设备名用 ASCII：**HTTP 头只能是 ASCII**（与 ``X-Kylab-Operator`` 同一个坑，
    实测浏览器与 curl 都会在中文头上报编码错）。真值是主机名，通常就是 ASCII；
    而它只是给人看的，判定一律按 ``device_id``。
    """
    return {DEVICE_HEADER: device_id, DEVICE_NAME_HEADER: name}


def _folder(tmp_path: Path, name: str) -> str:
    target = tmp_path / name
    target.mkdir()
    return str(target)


# ----------------------------------------------------------------- 工作区


def test_workspace_device_isolation(client: TestClient, tmp_path: Path) -> None:
    """带 ``X-Kylab-Device`` 建的项目**只在那台机器上看得见**（v0.59）。

    三个方向都要钉：同一台设备看得到、另一台设备看不到、不带头的网页版也看不到——
    只钉一个方向时，"看不看得见"可能只是列表恰好是空的。
    """
    created = client.post(
        "/api/v1/workspaces",
        json={"name": "桌面上的项目", "root_path": _folder(tmp_path, "desktop")},
        headers=_device(DEVICE_A),
    )
    assert created.status_code == 201, created.text
    workspace = created.json()
    # 打戳：记录归属哪台机器，以及那个给人看的名字
    assert workspace["device_id"] == DEVICE_A
    assert workspace["device_name"] == "DESKTOP-A"

    same = client.get("/api/v1/workspaces", headers=_device(DEVICE_A)).json()["items"]
    assert [item["id"] for item in same] == [workspace["id"]]
    # 另一台电脑：这条记录不该出现
    assert client.get("/api/v1/workspaces", headers=_device(DEVICE_B)).json()["items"] == []
    # 网页版 / 直连 API：不带设备头，看到的是**服务器端**那批，也没有它
    assert client.get("/api/v1/workspaces").json()["items"] == []
    # 详情同样按设备隔离
    assert (
        client.get(f"/api/v1/workspaces/{workspace['id']}", headers=_device(DEVICE_A)).status_code
        == 200
    )
    assert client.get(f"/api/v1/workspaces/{workspace['id']}").status_code == 404


def test_workspace_without_device_is_server_side(client: TestClient, tmp_path: Path) -> None:
    """不带设备头建的项目落 ``NULL`` = **服务器端**（路径在服务器的盘上）。

    隔离是**双向**的：桌面端同样看不见它——否则"没带设备头"就成了"两边都能看"。
    """
    made = client.post(
        "/api/v1/workspaces",
        json={"name": "服务器上的项目", "root_path": _folder(tmp_path, "server")},
    ).json()
    assert made["device_id"] is None
    assert made["device_name"] == ""

    assert [item["id"] for item in client.get("/api/v1/workspaces").json()["items"]] == [made["id"]]
    assert client.get("/api/v1/workspaces", headers=_device(DEVICE_A)).json()["items"] == []
    # **空串按"没带"处理**（curl 传了头却没给值）：它落进服务器端那一档，
    # 而不是变成一个从此再没人用的设备 id
    empty = client.get("/api/v1/workspaces", headers={DEVICE_HEADER: ""}).json()["items"]
    assert [item["id"] for item in empty] == [made["id"]]


def test_other_device_looks_like_not_found(client: TestClient, tmp_path: Path) -> None:
    """设备不匹配的读 / 改 / 删 / 挂**都是 404，且措辞与"不存在"逐字一致**。

    措辞不一样就等于承认"这个 id 存在"——而这台机器本来不该知道别的机器有哪些项目。
    """
    workspace = client.post(
        "/api/v1/workspaces",
        json={"name": "A 机的项目", "root_path": _folder(tmp_path, "a")},
        headers=_device(DEVICE_A),
    ).json()
    target = f"/api/v1/workspaces/{workspace['id']}"

    for response in (
        client.get(target, headers=_device(DEVICE_B)),
        client.get(target),  # 不带设备头
        client.patch(target, json={"name": "改名"}, headers=_device(DEVICE_B)),
        client.delete(target, headers=_device(DEVICE_B)),
    ):
        assert response.status_code == 404, response.text
        assert response.json()["message"] == f"工作区不存在：{workspace['id']}"

    # 越权那三次**什么都没发生**：记录还在、名字没变
    alive = client.get(target, headers=_device(DEVICE_A)).json()
    assert alive["name"] == "A 机的项目"

    # 挂会话（bind）也过同一道闸：别的机器不能把会话挂进这个项目
    conversation = client.post("/api/v1/conversations", json={}).json()
    bound = client.patch(
        f"/api/v1/conversations/{conversation['id']}",
        json={"workspace_id": workspace["id"]},
        headers=_device(DEVICE_B),
    )
    assert bound.status_code == 404, bound.text
    assert bound.json()["message"] == f"工作区不存在：{workspace['id']}"
    # 本机的会话挂得进去（上面那条 404 不是因为 bind 坏了）
    mine = client.patch(
        f"/api/v1/conversations/{conversation['id']}",
        json={"workspace_id": workspace["id"]},
        headers=_device(DEVICE_A),
    )
    assert mine.status_code == 200, mine.text


def test_device_all_is_admin_only(
    client: TestClient, member_token: str, tmp_path: Path
) -> None:
    """``?device=all`` 是**管理员**的跨机清理通道；成员传它回 422 并如实说明。

    422 而不是 404：这不是"有没有"的问题，是一条明确的权限口径——
    悄悄退化成"只看自己的"会让调用方以为手里是跨设备的清单。
    """
    desktop_a = client.post(
        "/api/v1/workspaces",
        json={"name": "A 机", "root_path": _folder(tmp_path, "a")},
        headers=_device(DEVICE_A),
    ).json()
    desktop_b = client.post(
        "/api/v1/workspaces",
        json={"name": "B 机", "root_path": _folder(tmp_path, "b")},
        headers=_device(DEVICE_B),
    ).json()
    server = client.post(
        "/api/v1/workspaces",
        json={"name": "服务器端", "root_path": _folder(tmp_path, "s")},
    ).json()

    everything = client.get("/api/v1/workspaces", params={"device": "all"})
    assert everything.status_code == 200, everything.text
    ids = {item["id"] for item in everything.json()["items"]}
    assert {desktop_a["id"], desktop_b["id"], server["id"]} <= ids

    # 成员：拒，并说清为什么
    rejected = client.get(
        "/api/v1/workspaces", params={"device": "all"}, headers=_as(member_token)
    )
    assert rejected.status_code == 422, rejected.text
    assert "管理员" in rejected.json()["message"]

    # device 只认 all：别的值当场拒（静默忽略会让"传了没生效"变成一个要查很久的现象）
    other = client.get("/api/v1/workspaces", params={"device": DEVICE_A})
    assert other.status_code == 422, other.text
    # 不传 device 时不受影响，仍是按设备头的三态
    assert client.get("/api/v1/workspaces", headers=_device(DEVICE_A)).json()["items"] != []


def test_workspace_crud_roundtrip(client: TestClient, tmp_path: Path) -> None:
    folder = tmp_path / "proj"
    folder.mkdir()

    created = client.post(
        "/api/v1/workspaces",
        json={"name": "产品化", "root_path": str(folder), "description": "一条线"},
    )
    assert created.status_code == 201, created.text
    workspace = created.json()
    assert workspace["id"].startswith("ws_")
    assert workspace["root_path"] == str(folder.resolve())
    assert workspace["conversation_count"] == 0

    listed = client.get("/api/v1/workspaces").json()["items"]
    assert [item["id"] for item in listed] == [workspace["id"]]

    updated = client.patch(f"/api/v1/workspaces/{workspace['id']}", json={"name": "改名了"}).json()
    assert updated["name"] == "改名了"
    # 只改传了的字段：根目录不该被动过
    assert updated["root_path"] == workspace["root_path"]

    assert client.delete(f"/api/v1/workspaces/{workspace['id']}").status_code == 204
    assert client.get(f"/api/v1/workspaces/{workspace['id']}").status_code == 404


@pytest.mark.parametrize(
    ("root", "why"),
    [
        ("E:/definitely-not-here-kylab", "路径不存在"),
    ],
)
def test_workspace_rejects_bad_root(client: TestClient, root: str, why: str) -> None:
    """**路径不存在要当场拒**（而不是建一个空目录）：否则"工作区建好了却什么都读不到"
    会变成一个要查很久的现象。"""
    response = client.post("/api/v1/workspaces", json={"name": "x", "root_path": root})
    assert response.status_code == 422, response.text
    assert why in response.json()["message"]


def test_workspace_rejects_the_data_directory(client: TestClient) -> None:
    """指向数据目录 = 绕过全部账号隔离。**这是工作区这一层最要紧的一条**：
    `data/` 看起来只是个普通目录。"""
    data_dir = get_services().workspaces._data_dir
    response = client.post("/api/v1/workspaces", json={"name": "x", "root_path": str(data_dir)})
    assert response.status_code == 422
    assert "数据目录" in response.json()["message"]


def test_browse_lists_server_directories(client: TestClient, tmp_path: Path) -> None:
    """目录浏览（v0.35）：界面"选一个目录当工作区"靠它。

    **为什么这件事在服务端做**：工作区根目录是服务器上的路径，而浏览器里的目录选择器
    给的是客户端本机的东西——指向的是另一台机器。
    """
    home = tmp_path / "proj"
    (home / "sub").mkdir(parents=True)
    (home / "loose.txt").write_text("x", encoding="utf-8")

    body = client.get("/api/v1/workspaces/browse", params={"path": str(home)}).json()
    assert body["path"] == str(home.resolve())
    assert body["parent"] == str(tmp_path.resolve())
    # 只列目录：工作区根必须是目录，把文件列出来只会让人点错
    assert [item["name"] for item in body["entries"]] == ["sub"]
    assert body["entries"][0]["selectable"] is True
    assert all("path" in item and "reason" in item for item in body["entries"])
    # 当前这一层自己也要给可选性（界面的"选这个目录"靠它）
    assert body["current"]["path"] == str(home.resolve())
    assert body["current"]["selectable"] is True
    # 起点：路径很深时不用从根一路点下来
    assert body["roots"]


def test_browse_marks_the_data_directory_unselectable(client: TestClient) -> None:
    """数据目录**列出来但点不动**（标着原因）。判定与建工作区同一份——
    灰掉的一定也建不出来，不会出现"能选但建失败"。"""
    data_dir = get_services().workspaces._data_dir
    body = client.get("/api/v1/workspaces/browse", params={"path": str(data_dir.parent)}).json()
    entry = next(item for item in body["entries"] if item["path"] == str(data_dir.resolve()))
    assert entry["selectable"] is False
    assert "数据目录" in entry["reason"]


# ------------------------------------------------------ 专用可写区域（§12.224 第 10 条）


def _area(client: TestClient) -> str:
    """专用区域在哪儿：**从浏览接口拿**，不自己拼路径。

    界面也是这么做的（`area` 字段）——数据目录在哪只有服务端知道，
    用例自己拼一次就等于在断言里写了一份会漂的第二判定。
    """
    return str(client.get("/api/v1/workspaces/browse").json()["area"])


def test_browse_lands_in_the_area_and_offers_it_first(client: TestClient) -> None:
    """① 不留 path 就落在专用区域：它是选择器的默认落脚点，也是默认起点。

    "首次浏览顺手建出来"这条只有对着接口看才知道：容器里没人会先去 shell 里
    `mkdir`，而落在一个不存在的目录上等于选择器打不开。
    """
    body = client.get("/api/v1/workspaces/browse").json()
    area = Path(body["area"])
    assert area.is_dir(), "浏览一次就该有地方可建"
    assert body["path"] == body["area"], "默认落在区域里（家目录在容器里常常只读）"
    assert body["roots"][0]["path"] == body["area"], "起点里排第一"
    # 区域自己不是工作区（它是容器），但里面能建
    assert body["current"]["selectable"] is False
    assert body["current"]["creatable"] is True


def test_browse_marks_where_you_cannot_create(client: TestClient, tmp_path: Path) -> None:
    """③ 三件事各给各的判定，摆在同一屏幕上（v0.58 起的组合）：

    - 区域外**能建**也**能选**（用户要在 `D:\\` 下开项目，就得让他在那儿建目录）；
    - 区域外**仍不能改名**（改名动的是别人的既有目录）；
    - 数据目录树**不能建**，且原因就标在那一行上。

    这一条是这次要修的核心体感：界面上的禁用态与文案全部由服务端这三个判定驱动，
    所以它们必须一起对。
    """
    home = tmp_path / "proj"
    (home / "sub").mkdir(parents=True)

    body = client.get("/api/v1/workspaces/browse", params={"path": str(home)}).json()
    assert body["current"]["creatable"] is True
    assert body["current"]["create_reason"] == ""
    assert body["current"]["selectable"] is True
    assert body["current"]["renamable"] is False, "改名仍只在「工作区」区域里"
    assert body["current"]["rename_reason"]
    assert body["entries"][0]["creatable"] is True

    data_dir = get_services().workspaces._data_dir
    listing = client.get(
        "/api/v1/workspaces/browse", params={"path": str(data_dir.parent)}
    ).json()
    row = next(item for item in listing["entries"] if item["path"] == str(data_dir.resolve()))
    assert row["creatable"] is False
    assert "数据目录里不能新建目录" in row["create_reason"]


def test_the_filesystem_root_is_creatable_but_not_selectable(
    client: TestClient, tmp_path: Path
) -> None:
    """文件系统根：**能建（creatable=True）但不能选（selectable=False）**（v0.58）。

    两件事两个判定，所以这一行是"能在它下面建目录、但不能拿它当工作区"：
    新建不再限区域，而"把整台机器交给 Agent 的文件操作"照旧是权限事故。
    """
    root = tmp_path.anchor
    body = client.get("/api/v1/workspaces/browse", params={"path": root}).json()
    assert body["path"] == str(Path(root).resolve())
    assert body["current"]["creatable"] is True
    assert body["current"]["create_reason"] == ""
    assert body["current"]["selectable"] is False
    assert "文件系统根" in body["current"]["reason"]


def test_create_outside_the_area_works_and_the_row_says_so(
    client: TestClient, tmp_path: Path
) -> None:
    """区域外建目录**能成**（v0.58），且浏览时那一行标的就是"能建"。

    两侧一起钉：界面亮着的那一行，点下去必须真建出来——判定只有一份
    （``create_problem``），浏览的标记与真去动手的结果不会各说各的。
    """
    home = tmp_path / "proj"
    home.mkdir()
    body = client.get("/api/v1/workspaces/browse", params={"path": str(home)}).json()
    assert body["current"]["creatable"] is True

    response = client.post("/api/v1/workspaces/dirs", json={"parent": str(home), "name": "新项目"})
    assert response.status_code == 201, response.text
    assert response.json()["creatable"] is True
    assert (home / "新项目").is_dir()


def test_create_refuses_inside_the_data_directory(client: TestClient) -> None:
    """数据目录树是**唯一还禁的一棵**（v0.58）：里面是服务端自己的库与原件。"""
    data_dir = get_services().workspaces._data_dir
    response = client.post(
        "/api/v1/workspaces/dirs", json={"parent": str(data_dir), "name": "新库"}
    )
    assert response.status_code == 422, response.text
    assert "数据目录里不能新建目录" in response.json()["message"]


def test_create_outside_the_area_and_use_it_as_a_workspace(
    client: TestClient, tmp_path: Path
) -> None:
    """**验收**（v0.58）：在区域外的自定义路径建目录 → 以它为根建工作区，一步成功。

    用户报的正是这条路走不通（"新建目录被限制在专用区域里，区域外都是只读"），
    所以这里盯着它通到底：落盘 → 建工作区 → 工作区的根就是它。
    """
    custom = tmp_path / "custom"
    custom.mkdir()
    created = client.post(
        "/api/v1/workspaces/dirs", json={"parent": str(custom), "name": "我的项目"}
    )
    assert created.status_code == 201, created.text
    entry = created.json()
    assert entry["selectable"] is True and entry["creatable"] is True

    made = client.post("/api/v1/workspaces", json={"name": "我的项目", "root_path": entry["path"]})
    assert made.status_code == 201, made.text
    assert made.json()["root_path"] == entry["path"]


def test_create_in_the_area_and_use_it_as_a_workspace(client: TestClient) -> None:
    """② + 验收：在专用区域里建目录、**选中它当工作区**，一步成功。"""
    area = _area(client)

    created = client.post("/api/v1/workspaces/dirs", json={"parent": area, "name": "新项目"})
    assert created.status_code == 201, created.text
    entry = created.json()
    assert entry["selectable"] is True
    assert entry["creatable"] is True
    assert entry["renamable"] is True

    # 建完它就出现在浏览里（界面"建完直接进去"那一步靠它）
    listing = client.get("/api/v1/workspaces/browse", params={"path": area}).json()
    assert [item["name"] for item in listing["entries"]] == ["新项目"]
    assert listing["entries"][0]["selectable"] is True

    made = client.post("/api/v1/workspaces", json={"name": "项目", "root_path": entry["path"]})
    assert made.status_code == 201, made.text
    assert made.json()["root_path"] == entry["path"]


def test_the_area_itself_is_not_a_workspace(client: TestClient) -> None:
    """区域是**容器**不是项目：拿它当工作区等于把里面每一个项目一起交出去。"""
    response = client.post("/api/v1/workspaces", json={"name": "x", "root_path": _area(client)})
    assert response.status_code == 422, response.text
    assert "区域本身" in response.json()["message"]


def test_an_existing_workspace_outside_the_area_is_still_selectable(
    client: TestClient, tmp_path: Path
) -> None:
    """④ 已有工作区仍能选中：**改写盘规则不动"能不能选"**。

    老用户的目录可能就在家目录或别的盘上，把它们变成"只能看"等于弄坏已有工作区。
    v0.58 起区域外连"写"也放开了，但这条口径的要点没变：三条判定各守自己那件事。
    """
    folder = tmp_path / "老项目"
    folder.mkdir()
    made = client.post("/api/v1/workspaces", json={"name": "老项目", "root_path": str(folder)})
    assert made.status_code == 201, made.text

    body = client.get("/api/v1/workspaces/browse", params={"path": str(folder)}).json()
    assert body["current"]["selectable"] is True
    root = next(item for item in body["roots"] if item["name"] == "老项目")
    assert root["path"] == str(folder.resolve())
    assert root["selectable"] is True


def test_browse_rejects_a_file_and_says_where_it_lives(client: TestClient, tmp_path: Path) -> None:
    folder = tmp_path / "proj"
    folder.mkdir()
    target = folder / "a.md"
    target.write_text("x", encoding="utf-8")
    response = client.get("/api/v1/workspaces/browse", params={"path": str(target)})
    assert response.status_code == 422
    assert str(folder.resolve()) in response.json()["message"]


def test_create_and_rename_directories(client: TestClient) -> None:
    """在服务器上建目录 / 改名（v0.36）：选择器里那两个动作。

    **这是"在服务器上写东西"**，所以比浏览严一档：只建一层、重名当场拒；
    新建除数据目录树之外都能建（v0.58）；改名只改名不搬位置，且区域外、区域本身、
    工作区根目录都会被拒。
    """
    area = Path(_area(client))

    created = client.post("/api/v1/workspaces/dirs", json={"parent": str(area), "name": "新项目"})
    assert created.status_code == 201, created.text
    entry = created.json()
    assert entry["name"] == "新项目"
    assert entry["selectable"] is True
    assert (area / "新项目").is_dir()

    renamed = client.patch(
        "/api/v1/workspaces/dirs", json={"path": entry["path"], "name": "正式项目"}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "正式项目"
    assert (area / "正式项目").is_dir() and not (area / "新项目").exists()

    # 落盘的结果在浏览里看得见（界面刷新那一步靠它）
    listing = client.get("/api/v1/workspaces/browse", params={"path": str(area)}).json()
    assert [item["name"] for item in listing["entries"]] == ["正式项目"]


def test_create_refuses_a_bad_name(client: TestClient) -> None:
    response = client.post("/api/v1/workspaces/dirs", json={"parent": _area(client), "name": "a/b"})
    assert response.status_code == 422
    assert "不能有这些字符" in response.json()["message"]


def test_rename_refuses_a_workspace_root(client: TestClient) -> None:
    """工作区的根目录不能改名——改了那条工作区就失联了。

    v0.41 起工作区多半就建在专用区域里，所以这条要在区域里验（外面那条路
    先被"改名只在区域里"拦住了，验不到工作区根目录这一条）。
    """
    area = _area(client)
    folder = Path(area) / "proj"
    assert (
        client.post("/api/v1/workspaces/dirs", json={"parent": area, "name": "proj"}).status_code
        == 201
    )
    created = client.post(
        "/api/v1/workspaces", json={"name": "项目", "root_path": str(folder)}
    ).json()
    assert created["id"]

    # 浏览时那一行就写着原因（界面据此把改名图标灰掉）
    entry = next(
        item
        for item in client.get("/api/v1/workspaces/browse", params={"path": area}).json()["entries"]
        if item["name"] == "proj"
    )
    assert entry["renamable"] is False
    assert "工作区「项目」" in entry["rename_reason"]

    response = client.patch("/api/v1/workspaces/dirs", json={"path": str(folder), "name": "proj2"})
    assert response.status_code == 422
    assert response.json()["message"] == entry["rename_reason"]
    assert folder.is_dir(), "被拒时不该动到目录"


def test_directory_writes_are_admin_only(
    client: TestClient, member_token: str, tmp_path: Path
) -> None:
    folder = tmp_path / "proj"
    folder.mkdir()
    assert (
        client.post(
            "/api/v1/workspaces/dirs",
            json={"parent": str(folder), "name": "x"},
            headers=_as(member_token),
        ).status_code
        == 403
    )
    assert (
        client.patch(
            "/api/v1/workspaces/dirs",
            json={"path": str(folder), "name": "y"},
            headers=_as(member_token),
        ).status_code
        == 403
    )


def test_browse_is_admin_only(client: TestClient, member_token: str) -> None:
    """**管理员专属**：目录名本身就是信息（谁的项目叫什么、备份在哪），
    而成员建工作区只需要填一个路径——不为了顺手而扩权。"""
    response = client.get("/api/v1/workspaces/browse", headers=_as(member_token))
    assert response.status_code == 403


def test_workspace_binds_knowledge_bases(client: TestClient, tmp_path: Path) -> None:
    folder = tmp_path / "proj2"
    folder.mkdir()
    kb = client.post("/api/v1/knowledge-bases", json={"name": "库"}).json()

    workspace = client.post(
        "/api/v1/workspaces",
        json={"name": "带库的", "root_path": str(folder), "kb_ids": [kb["id"]]},
    ).json()

    assert workspace["kb_ids"] == [kb["id"]]


def test_conversation_inherits_the_workspace_knowledge_bases(
    client: TestClient, tmp_path: Path
) -> None:
    """**"知识库与 Agent 天生融合"落到行为上的样子**：进入项目，资料范围就定了。

    ``kb_ids`` 留空时继承工作区的库——这是用户不必每开一次会话重勾一遍的原因。
    """
    folder = tmp_path / "proj3"
    folder.mkdir()
    kb = client.post("/api/v1/knowledge-bases", json={"name": "项目资料"}).json()
    workspace = client.post(
        "/api/v1/workspaces",
        json={"name": "项目", "root_path": str(folder), "kb_ids": [kb["id"]]},
    ).json()

    conversation = client.post(
        "/api/v1/conversations", json={"workspace_id": workspace["id"], "kb_ids": []}
    ).json()

    assert conversation["workspace_id"] == workspace["id"]
    assert conversation["kb_ids"] == [kb["id"]]


def test_deleting_a_workspace_keeps_its_conversations(client: TestClient, tmp_path: Path) -> None:
    """**删工作区不删会话**：它们退回"未归档"。会话里有用户问过的内容，误删不可恢复。

    这一条在接口层的价值：它是用户最担心的那件事，得能在端到端上验证。
    """
    folder = tmp_path / "proj4"
    folder.mkdir()
    workspace = client.post(
        "/api/v1/workspaces", json={"name": "临时的", "root_path": str(folder)}
    ).json()
    conversation = client.post(
        "/api/v1/conversations", json={"workspace_id": workspace["id"], "kb_ids": []}
    ).json()

    assert client.delete(f"/api/v1/workspaces/{workspace['id']}").status_code == 204

    still_there = client.get(f"/api/v1/conversations/{conversation['id']}")
    assert still_there.status_code == 200
    assert still_there.json()["workspace_id"] is None
    ungrouped = client.get("/api/v1/conversations?ungrouped=true").json()["items"]
    assert conversation["id"] in [item["id"] for item in ungrouped]


def test_workspaces_are_owner_scoped(client: TestClient, member_token: str, tmp_path: Path) -> None:
    folder = tmp_path / "proj5"
    folder.mkdir()
    mine = client.post(
        "/api/v1/workspaces", json={"name": "管理员的", "root_path": str(folder)}
    ).json()

    # 成员看不到别人的，而且**越权与不存在一样是 404**（403 会暴露 id 存在）
    listed = client.get("/api/v1/workspaces", headers=_as(member_token)).json()
    assert listed["items"] == []
    detail = client.get(f"/api/v1/workspaces/{mine['id']}", headers=_as(member_token))
    assert detail.status_code == 404
    assert (
        client.patch(
            f"/api/v1/workspaces/{mine['id']}", json={"name": "抢"}, headers=_as(member_token)
        ).status_code
        == 404
    )


def test_member_cannot_bind_a_conversation_into_someone_elses_workspace(
    client: TestClient, member_token: str, tmp_path: Path
) -> None:
    """否则任何人都能把会话"挂进"别人的工作区——挂进去之后，
    那个工作区的主人就会在侧栏看到它。"""
    folder = tmp_path / "proj6"
    folder.mkdir()
    foreign = client.post(
        "/api/v1/workspaces", json={"name": "别人的", "root_path": str(folder)}
    ).json()
    # 管理员通道没有归属过滤，所以这条要拿成员的身份来试
    member_conversation = client.post(
        "/api/v1/conversations", json={"kb_ids": []}, headers=_as(member_token)
    ).json()
    response = client.patch(
        f"/api/v1/conversations/{member_conversation['id']}",
        json={"workspace_id": foreign["id"]},
        headers=_as(member_token),
    )
    assert response.status_code == 404, response.text


def test_conversation_can_move_back_to_ungrouped(client: TestClient, tmp_path: Path) -> None:
    """`workspace_id: null` 表示"退回未归档"——而它与"这个字段没传"在值上一样，
    所以接口层要能区分（后端用 `model_fields_set` 判）。"""
    folder = tmp_path / "proj7"
    folder.mkdir()
    workspace = client.post(
        "/api/v1/workspaces", json={"name": "装会话的", "root_path": str(folder)}
    ).json()
    conversation = client.post(
        "/api/v1/conversations", json={"workspace_id": workspace["id"], "kb_ids": []}
    ).json()

    moved = client.patch(
        f"/api/v1/conversations/{conversation['id']}", json={"workspace_id": None}
    ).json()

    assert moved["workspace_id"] is None
    # 只传标题时**不该**把归属改掉（这正是"没传"与"传了 null"要分开的原因）
    renamed = client.patch(
        f"/api/v1/conversations/{conversation['id']}", json={"title": "改个名"}
    ).json()
    assert renamed["workspace_id"] is None
    assert renamed["title"] == "改个名"


# ------------------------------------------------------------------- 技能


def test_skills_lists_the_repo_skill(client: TestClient) -> None:
    """磁盘上真有一份 ``skills/kylab-knowledge-base/SKILL.md``——接口要能列出它。

    不用打桩的假技能：这一层的价值就在"它真去读了磁盘"。
    """
    body = client.get("/api/v1/skills").json()

    names = [item["name"] for item in body["items"]]
    assert "kylab-knowledge-base" in names
    assert body["usable"] >= 1
    entry = next(item for item in body["items"] if item["name"] == "kylab-knowledge-base")
    assert entry["source"] == "builtin"
    assert entry["used_by_prompt"] is True
    assert entry["description"]
    # P0-3：每一行都要带"是不是被丢弃了"，能力页靠它把坏技能单独标出来
    assert entry["discarded"] is False


def test_the_skill_list_carries_categories_and_the_featured_ones(client: TestClient) -> None:
    """分类与精选也走**完整链路**（真磁盘 → 服务 → 接口 → 界面字段），v0.61。

    要看的就三件事：每条都带分类、顶层分类清单按页面分组顺序给、精选只标在**能用**的
    技能上。产品自带那 5 条按名字钉死在「效率与自动化」（4 条）与「文档与办公」（1 条），
    所以前者一定排得满 2 条，而后者**只有一条就给一条**——不足 2 条不凑数、不报错。
    """
    body = client.get("/api/v1/skills").json()

    declared = [item.slug for item in CATEGORIES]
    assert [group["slug"] for group in body["categories"]] == declared
    assert all(group["label"] for group in body["categories"])
    assert all(item["category"] in declared for item in body["items"])

    marks = {item["name"]: item for item in body["items"]}
    featured: list[str] = []
    for group in body["categories"]:
        assert len(group["featured"]) <= 2, f"{group['slug']} 每类最多 2 条"
        for name in group["featured"]:
            assert marks[name]["featured"] is True, "清单里的名字要在技能上标出来"
            assert marks[name]["used_by_prompt"] is True, "精选不推点不开的东西"
        featured.extend(group["featured"])
    # 反过来也成立：标成精选的都在清单里（两处是同一份判断，不是各算一遍）
    assert {name for name, item in marks.items() if item["featured"]} == set(featured)

    productivity = next(group for group in body["categories"] if group["slug"] == "productivity")
    assert len(productivity["featured"]) == 2
    documents = next(group for group in body["categories"] if group["slug"] == "documents")
    assert "kylab-office-export" in documents["featured"]


def test_a_broken_skill_is_listed_with_its_reason(client: TestClient, tmp_path) -> None:
    """坏技能（frontmatter 缺 description）**照样在列表里**，但要标成已丢弃并给出理由。

    这条走的是完整链路（真磁盘 → 服务 → 接口 → 界面用的字段）：
    校验在前置做了，可界面必须还看得见它，否则用户只会看到"我明明放进去了，
    怎么没有"（见 ``api/v1/skills.py`` 的说明）。
    """
    directory = tmp_path / "data" / "skills" / "broken"
    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text("---\nname: broken\n---\n\n正文\n", encoding="utf-8")

    body = client.get("/api/v1/skills").json()
    entry = next(item for item in body["items"] if item["name"] == "broken")

    assert entry["discarded"] is True
    assert entry["used_by_prompt"] is False
    assert "description" in entry["flagged"][0]
    # 详情页读得出来（人要能核对它到底写了什么），理由也照旧带着
    detail = client.get("/api/v1/skills/broken").json()
    assert detail["discarded"] is True
    assert detail["body"].strip() == "正文"


def test_skill_detail_returns_the_body(client: TestClient) -> None:
    """正文是"按需展开"的那一段，用户有权读它（核对技能到底教了模型什么）。"""
    body = client.get("/api/v1/skills/kylab-knowledge-base").json()

    assert body["body"]
    # frontmatter 不该出现在正文里
    assert not body["body"].startswith("---")


def test_unknown_skill_is_404(client: TestClient) -> None:
    assert client.get("/api/v1/skills/nope-not-a-skill").status_code == 404


# ------------------------------------------------------------------- MCP


def test_mcp_create_list_and_hide_secrets(client: TestClient) -> None:
    """**凭据不回显**：接口只给键名。回显一次，日志、截图、浏览器缓存里就各留一份。"""
    created = client.post(
        "/api/v1/mcp-servers",
        json={
            "name": "本地工具",
            "transport": "stdio",
            "target": "python",
            "args": ["-m", "x"],
            "env": {"TOKEN": "super-secret-value"},
            "policy": "ask",
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()

    assert body["secret_keys"] == ["TOKEN"]
    assert body["has_secrets"] is True
    assert "super-secret-value" not in created.text
    assert body["tool_prefix"] == "mcp__本地工具__"

    listed = client.get("/api/v1/mcp-servers").json()["items"]
    assert [item["id"] for item in listed] == [body["id"]]
    assert "super-secret-value" not in str(listed)


def test_mcp_create_validates_input(client: TestClient) -> None:
    bad_transport = client.post(
        "/api/v1/mcp-servers",
        json={"name": "x", "transport": "carrier-pigeon", "target": "y"},
    )
    assert bad_transport.status_code == 422

    bad_policy = client.post(
        "/api/v1/mcp-servers",
        json={"name": "x", "transport": "stdio", "target": "y", "policy": "maybe"},
    )
    assert bad_policy.status_code == 422


def test_mcp_deny_policy_blocks_the_call(client: TestClient) -> None:
    server = client.post(
        "/api/v1/mcp-servers",
        json={"name": "禁的", "transport": "stdio", "target": "python", "policy": "deny"},
    ).json()

    response = client.post(
        f"/api/v1/mcp-servers/{server['id']}/call", json={"tool": "x", "arguments": {}}
    )

    assert response.status_code == 403
    assert "拒绝" in response.json()["message"]


def test_mcp_ask_policy_returns_409_until_approved(client: TestClient) -> None:
    """``ask`` 未确认时是 **409**（不是 403）：不是"你不能做"，是"要先确认"。
    界面据此弹确认框，确认后带 `approved=true` 重调。"""
    server = client.post(
        "/api/v1/mcp-servers",
        json={"name": "要确认的", "transport": "stdio", "target": "python", "policy": "ask"},
    ).json()

    response = client.post(
        f"/api/v1/mcp-servers/{server['id']}/call", json={"tool": "x", "arguments": {}}
    )

    assert response.status_code == 409
    assert "确认" in response.json()["message"]


def test_mcp_probe_reports_failure_without_5xx(client: TestClient) -> None:
    """「测试连接」的失败是**结果**（200 + reachable=false + 人话），不是服务器错误。"""
    server = client.post(
        "/api/v1/mcp-servers",
        json={
            "name": "连不上的",
            "transport": "stdio",
            "target": "definitely-not-a-real-command-kylab",
        },
    ).json()

    response = client.post(f"/api/v1/mcp-servers/{server['id']}/probe")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reachable"] is False
    assert body["detail"]
    assert body["tools"] == []


def test_mcp_servers_are_owner_scoped(client: TestClient, member_token: str) -> None:
    mine = client.post(
        "/api/v1/mcp-servers",
        json={"name": "管理员的", "transport": "stdio", "target": "python"},
    ).json()

    assert client.get("/api/v1/mcp-servers", headers=_as(member_token)).json()["items"] == []
    assert (
        client.get(f"/api/v1/mcp-servers/{mine['id']}", headers=_as(member_token)).status_code
        == 404
    )


# ------------------------------------------------------------------ 沙箱


def test_sandbox_capability_is_admin_only(client: TestClient, member_token: str) -> None:
    """沙箱执行是这个产品里权限最大的动作（在用户机器上跑代码），
    与设置页同档：**管理员专属**。"""
    response = client.get("/api/v1/sandbox", headers=_as(member_token))

    assert response.status_code == 403


def test_sandbox_capability_reports_something(client: TestClient) -> None:
    """无论这台机器有没有隔离，都要**如实报出来**（含怎么办），而不是报错。

    ``direct`` 是 v0.55 的降级档（没有真隔离、且没开严格模式时）——它不是沙箱，
    如实报出来正是这一条的要求。
    """
    body = client.get("/api/v1/sandbox").json()

    assert body["backend"] in ("bwrap", "sandbox-exec", "docker", "direct", "none")
    assert body["detail"]
    assert body["max_output_chars"] > 0


def test_sandbox_plan_shows_what_would_run(client: TestClient) -> None:
    """`plan` **只算不跑**：用户要核对"到底会发生什么"时，
    最需要的不是我们替他判断，而是看清楚 argv。"""
    body = client.post(
        "/api/v1/sandbox/plan", json={"argv": ["python", "-c", "print(1)"], "session_id": "t1"}
    ).json()

    assert body["argv"]  # 有隔离时是包好的 argv；没有隔离时是原样命令
    assert body["workdir"]


def test_sandbox_exec_requires_approval_under_manual_policy(client: TestClient) -> None:
    """「手动批准」那一档：未确认回 **409**（不是 403）——不是"你不能做"，
    是"要先确认"。界面据此弹确认框，确认后带 approved 重调。

    ⚠️ 2026-09-29 四档化：原来这条钉的是旧值 ``workspace``（如今映射到「默认（智能）」），
    而智能档按"工作区内不问"判，`python -c print(1)` 不会问 ✗ —— 所以**钉住会问的那一档**
    （手动批准）。断言强度不变：**没确认就必须 409，且说的是"要确认"**。
    """
    client.patch(
        "/api/v1/settings",
        json={"values": [{"key": "chat.permission", "value": "manual"}]},
    )

    response = client.post("/api/v1/sandbox/exec", json={"argv": ["python", "-c", "print(1)"]})

    assert response.status_code == 409, response.text
    assert "确认" in response.json()["message"]


def test_sandbox_exec_refuses_when_isolation_is_required(client: TestClient) -> None:
    """**严格模式**（设置里打开「无隔离时拒绝执行」）下，没有内核级隔离就拒绝，不回退裸跑。

    这条钉的是那一项设置的行为；默认是**降级为直接执行**，见下一条。
    """
    from app.services import isolation

    found = isolation.detect()
    if found.available:  # pragma: no cover - 有隔离的机器上这条不适用
        pytest.skip("这台机器有可用的隔离后端，拒绝路径不适用")

    client.patch(
        "/api/v1/settings",
        json={
            "values": [
                {"key": "chat.permission", "value": "full"},
                {"key": "sandbox.require_isolation", "value": "true"},
            ]
        },
    )
    response = client.post(
        "/api/v1/sandbox/exec", json={"argv": ["python", "-c", "print(1)"], "approved": True}
    )

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "unsupported_content"
    assert "拒绝执行" in response.json()["message"]


def test_sandbox_exec_degrades_to_direct_without_isolation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**默认降级为直接执行**（v0.55）：没有 bwrap / docker 的机器也要能跑命令。

    与上一条是一对：默认那一档要让"本地源码启动与容器部署"两边都能执行工具
    （用户报的"明明指定了工作区，还是不能执行工具"）。降级时后端如实报 ``direct``。
    """
    from app.services import isolation

    found = isolation.detect()
    if found.available:  # pragma: no cover - 有隔离的机器上这条不适用
        pytest.skip("这台机器有可用的隔离后端，降级路径不适用")

    monkeypatch.setattr(
        isolation,
        "run_isolated",
        lambda argv, **kwargs: isolation.ExecutionResult(
            exit_code=0, stdout="1\n", stderr="", truncated=False, backend="direct"
        ),
    )
    client.patch(
        "/api/v1/settings",
        json={
            "values": [
                {"key": "chat.permission", "value": "full"},
                {"key": "sandbox.require_isolation", "value": "false"},
            ]
        },
    )
    response = client.post(
        "/api/v1/sandbox/exec", json={"argv": ["python", "-c", "print(1)"], "approved": True}
    )

    assert response.status_code == 200, response.text
    assert response.json()["backend"] == "direct"


def test_sandbox_exec_respects_view_permission(client: TestClient) -> None:
    """「仅查看」这一档：命令**不跑**，而且回的话要说清是权限档拦的。

    2026-09-27：这一档原来是设置里的「命令执行策略 = 拒绝」（`sandbox.exec_policy`），
    那一项已折进权限轴，所以现在推到的是 `chat.permission = view`。
    """
    client.patch(
        "/api/v1/settings",
        json={"values": [{"key": "chat.permission", "value": "view"}]},
    )

    response = client.post("/api/v1/sandbox/exec", json={"argv": ["ls"], "approved": True})

    assert response.status_code == 403
    assert "仅查看" in response.json()["message"]


def test_sandbox_exec_rejects_an_empty_command(client: TestClient) -> None:
    assert client.post("/api/v1/sandbox/exec", json={"argv": []}).status_code == 422


# ------------------------------------------------------------- 准入规则（v0.17）


def _set_rules(client: TestClient, **values: str) -> None:
    response = client.patch(
        "/api/v1/settings",
        json={"values": [{"key": key, "value": value} for key, value in values.items()]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["rejected"] == []


def test_exec_deny_rule_wins_over_a_broader_allow(client: TestClient) -> None:
    """**deny 永远优先**，而且要能通过接口看到这个结论。

    少了这一条，用户"我加了一条 deny"会被一条更宽的 allow 静默盖掉——
    而用户以为自己已经禁掉了。
    """
    _set_rules(
        client,
        **{
            "chat.permission": "full",
            "sandbox.rules_allow": "Bash(git push:*)",
            "sandbox.rules_deny": "Bash(git push --force:*)",
        },
    )

    allowed = client.post("/api/v1/sandbox/plan", json={"argv": ["git", "push", "origin", "main"]})
    assert allowed.status_code == 200

    blocked = client.post(
        "/api/v1/sandbox/exec", json={"argv": ["git", "push", "--force", "origin", "main"]}
    )
    assert blocked.status_code == 403, blocked.text
    assert "拒绝规则" in blocked.json()["message"]


def test_allow_rule_skips_the_confirmation(client: TestClient) -> None:
    """放行清单里的命令**不再问**——这正是规则存在的意义（同一个动作问一遍就够）。"""
    _set_rules(
        client,
        **{
            "chat.permission": "workspace",
            "sandbox.rules_allow": "Bash(git status:*)",
            # **把隔离模式显式钉成严格**（v0.55 起默认是"没有真隔离就用降级档 direct 直接跑"，
            # 见 `test_sandbox_exec_degrades_to_direct_without_isolation`）。不钉的话，
            # 这条用例的期望取决于**跑它的机器有没有内核隔离**：有隔离时 409、
            # 没有时 200 且命令真的跑掉——同一条用例两种结果，那不是在测行为，是在测环境。
            "sandbox.require_isolation": "true",
        },
    )

    # 命中放行规则 → **不再问确认**；严格模式下没有内核隔离就由隔离层拒绝
    # （code=unsupported_content）——用这个区分两件事：
    # "准入已通过、卡在隔离" 与 "准入没过、卡在确认"。
    response = client.post("/api/v1/sandbox/exec", json={"argv": ["git", "status", "--short"]})
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "unsupported_content"


def test_command_outside_the_rules_still_asks(client: TestClient) -> None:
    """没命中任何规则时回到默认档（ask）——**默认放行等于规则表形同虚设**。"""
    _set_rules(client, **{"chat.permission": "workspace", "sandbox.rules_allow": "Bash(ls)"})

    response = client.post("/api/v1/sandbox/exec", json={"argv": ["curl", "https://x.test"]})

    assert response.status_code == 409
    assert "确认" in response.json()["message"]


def test_remember_writes_a_word_prefix_rule(client: TestClient) -> None:
    """「以后都允许」写进放行清单的是**词前缀**，不是完整命令——
    记住完整命令等于没记住（下次参数就不同了）。"""
    _set_rules(client, **{"chat.permission": "workspace", "sandbox.rules_allow": ""})

    client.post(
        "/api/v1/sandbox/exec",
        json={"argv": ["git", "status", "--short"], "approved": True, "remember": True},
    )

    # 设置的读回形状是 `groups[].fields[]`（**不是** `values`）——
    # 密钥那一类只给掩码，这里读的是明文配置项
    view = client.get("/api/v1/settings").json()
    values = {field["key"]: field["value"] for group in view["groups"] for field in group["fields"]}
    assert values["sandbox.rules_allow"].strip() == "Bash(git:*)"


def test_remember_does_not_duplicate(client: TestClient) -> None:
    _set_rules(client, **{"chat.permission": "workspace", "sandbox.rules_allow": "Bash(git:*)"})

    client.post(
        "/api/v1/sandbox/exec",
        json={"argv": ["git", "commit"], "approved": True, "remember": True},
    )

    view = client.get("/api/v1/settings").json()
    values = {field["key"]: field["value"] for group in view["groups"] for field in group["fields"]}
    assert values["sandbox.rules_allow"].count("Bash(git:*)") == 1


def test_mcp_deny_rule_blocks_an_external_tool(client: TestClient) -> None:
    """规则层**对 MCP 工具同样生效**（用限定名匹配）：外部工具与本地命令是同一类
    "以用户名义执行的动作"，两处各写一套判定就会出现"这边能拦、那边拦不住"。"""
    server = client.post(
        "/api/v1/mcp-servers",
        json={"name": "外部服务", "transport": "stdio", "target": "python"},
    ).json()
    _set_rules(client, **{"sandbox.rules_deny": "mcp__外部服务__danger"})

    response = client.post(
        f"/api/v1/mcp-servers/{server['id']}/call",
        json={"tool": "danger", "arguments": {}, "approved": True},
    )

    assert response.status_code == 403, response.text
    assert "拒绝规则" in response.json()["message"]
