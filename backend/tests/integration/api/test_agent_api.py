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

    updated = client.patch(
        f"/api/v1/workspaces/{workspace['id']}", json={"name": "改名了"}
    ).json()
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
    response = client.post(
        "/api/v1/workspaces", json={"name": "x", "root_path": root}
    )
    assert response.status_code == 422, response.text
    assert why in response.json()["message"]


def test_workspace_rejects_the_data_directory(client: TestClient) -> None:
    """指向数据目录 = 绕过全部账号隔离。**这是工作区这一层最要紧的一条**：
    `data/` 看起来只是个普通目录。"""
    data_dir = get_services().workspaces._data_dir
    response = client.post(
        "/api/v1/workspaces", json={"name": "x", "root_path": str(data_dir)}
    )
    assert response.status_code == 422
    assert "数据目录" in response.json()["message"]


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

    response = client.post(
        "/api/v1/sandbox/exec", json={"argv": ["ls"], "approved": True}
    )

    assert response.status_code == 403
    assert "拒绝" in response.json()["message"]


def test_sandbox_exec_rejects_an_empty_command(client: TestClient) -> None:
    assert client.post("/api/v1/sandbox/exec", json={"argv": []}).status_code == 422
