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


# ----------------------------------------------------------------- 工作区


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
    """① 不留 path 就落在专用区域：它是唯一能新建目录的地方，也是默认起点。

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
    """③ 区域外的那一行**带着"为什么不能建"**——用户报的正是"显示了又不给建"。

    这一条是这次要修的核心体感：原因要摆在用户要点的那一行旁边，
    而不是等他点了"新建文件夹"再弹一个错。
    """
    home = tmp_path / "proj"
    (home / "sub").mkdir(parents=True)

    body = client.get("/api/v1/workspaces/browse", params={"path": str(home)}).json()
    assert body["current"]["creatable"] is False
    assert "「工作区」区域" in body["current"]["create_reason"]
    assert body["current"]["renamable"] is False
    assert body["current"]["rename_reason"]
    # 不可选与不可建是两件事：区域外照旧能选（只是不能写）
    assert body["current"]["selectable"] is True
    assert body["entries"][0]["creatable"] is False
    assert body["entries"][0]["create_reason"]


def test_create_outside_the_area_is_refused_with_the_marked_reason(
    client: TestClient, tmp_path: Path
) -> None:
    """③ 区域外建目录被拒，且理由与浏览时标在那一行上的**一字不差**。

    "同一份判定"这条只有把两边摆在一起比才知道有没有漂。
    """
    home = tmp_path / "proj"
    home.mkdir()
    marked = client.get("/api/v1/workspaces/browse", params={"path": str(home)}).json()["current"][
        "create_reason"
    ]

    response = client.post("/api/v1/workspaces/dirs", json={"parent": str(home), "name": "新项目"})
    assert response.status_code == 422, response.text
    assert response.json()["message"] == marked
    assert not (home / "新项目").exists()


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
    """④ 已有工作区仍能选中：区域外只读**不等于**区域外不能选。

    老用户的目录可能就在家目录或别的盘上，把它们变成"只能看"等于弄坏已有工作区。
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

    **这是"在服务器上写东西"**，所以比浏览严一档：只建一层、重名当场拒、
    **只在专用区域里**（v0.41）；改名只改名不搬位置，且区域外、区域本身、
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
    response = client.post(
        "/api/v1/workspaces/dirs", json={"parent": _area(client), "name": "a/b"}
    )
    assert response.status_code == 422
    assert "不能有这些字符" in response.json()["message"]


def test_rename_refuses_a_workspace_root(client: TestClient) -> None:
    """工作区的根目录不能改名——改了那条工作区就失联了。

    v0.41 起工作区多半就建在专用区域里，所以这条要在区域里验（外面那条路
    先被"区域外只读"拦住了，验不到工作区根目录这一条）。
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
    """无论这台机器有没有隔离，都要**如实报出来**（含怎么办），而不是报错。"""
    body = client.get("/api/v1/sandbox").json()

    assert body["backend"] in ("bwrap", "sandbox-exec", "docker", "none")
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


def test_sandbox_exec_requires_approval_under_ask_policy(client: TestClient) -> None:
    """默认策略是 ``ask``：未确认回 **409**（不是 403）——不是"你不能做"，
    是"要先确认"。界面据此弹确认框，确认后带 approved 重调。"""
    client.patch(
        "/api/v1/settings",
        json={"values": [{"key": "sandbox.exec_policy", "value": "ask"}]},
    )

    response = client.post("/api/v1/sandbox/exec", json={"argv": ["python", "-c", "print(1)"]})

    assert response.status_code == 409, response.text
    assert "确认" in response.json()["message"]


def test_sandbox_exec_refuses_when_no_isolation_is_available(client: TestClient) -> None:
    """**没有内核级隔离就拒绝执行**，不回退成裸跑。

    这条是这一层的立场，也是最容易被"先让它跑起来"优化掉的一条：
    回退会把"我们以为它在沙箱里"变成一个静默的假象，而那个假象比拒绝危险得多。
    """
    from app.services import isolation

    found = isolation.detect()
    if found.available:  # pragma: no cover - 有隔离的机器上这条不适用
        pytest.skip("这台机器有可用的隔离后端，拒绝路径不适用")

    client.patch(
        "/api/v1/settings",
        json={"values": [{"key": "sandbox.exec_policy", "value": "allow"}]},
    )
    response = client.post(
        "/api/v1/sandbox/exec", json={"argv": ["python", "-c", "print(1)"], "approved": True}
    )

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "unsupported_content"
    assert "拒绝执行" in response.json()["message"]


def test_sandbox_exec_respects_deny_policy(client: TestClient) -> None:
    client.patch(
        "/api/v1/settings",
        json={"values": [{"key": "sandbox.exec_policy", "value": "deny"}]},
    )

    response = client.post("/api/v1/sandbox/exec", json={"argv": ["ls"], "approved": True})

    assert response.status_code == 403
    assert "拒绝" in response.json()["message"]


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
            "sandbox.exec_policy": "allow",
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
        **{"sandbox.exec_policy": "ask", "sandbox.rules_allow": "Bash(git status:*)"},
    )

    # 命中放行规则 → **不再问确认**。这台机器没有内核隔离，所以它会继续走到
    # 隔离层并被那里拒绝（code=unsupported_content）——用这个区分两件事：
    # "准入已通过、卡在隔离" 与 "准入没过、卡在确认"。
    response = client.post("/api/v1/sandbox/exec", json={"argv": ["git", "status", "--short"]})
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "unsupported_content"


def test_command_outside_the_rules_still_asks(client: TestClient) -> None:
    """没命中任何规则时回到默认档（ask）——**默认放行等于规则表形同虚设**。"""
    _set_rules(client, **{"sandbox.exec_policy": "ask", "sandbox.rules_allow": "Bash(ls)"})

    response = client.post("/api/v1/sandbox/exec", json={"argv": ["curl", "https://x.test"]})

    assert response.status_code == 409
    assert "确认" in response.json()["message"]


def test_remember_writes_a_word_prefix_rule(client: TestClient) -> None:
    """「以后都允许」写进放行清单的是**词前缀**，不是完整命令——
    记住完整命令等于没记住（下次参数就不同了）。"""
    _set_rules(client, **{"sandbox.exec_policy": "ask", "sandbox.rules_allow": ""})

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
    _set_rules(client, **{"sandbox.exec_policy": "ask", "sandbox.rules_allow": "Bash(git:*)"})

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
