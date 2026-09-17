"""记忆端点的集成测试（v0.14 三期）。

镜像同构：``app/api/v1/memory.py`` → ``tests/integration/api/test_memory_api.py``。

覆盖三件事：

1. **文件浏览/编辑是走本地目录的**，所以 ``memory.enabled=false`` 时也该能用
   ——记忆关着的时候，用户依然该能打开自己的记忆文件看看写了什么；
2. **召回/记住需要服务**，关着时**明确报错**（不是返回空结果，见设计文档 §2.3）；
3. **路径越界要挡住**：路径由前端传进来，这是这个端点唯一的安全边界。

召回那一路把 ReMe 的 ``_post`` 打桩（不碰网络），但返回的是**实测抓下来的真实形状**
（结果在 ``metadata.results``、分数在 ``scores.score``）——第一版就是在这里猜错的。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.services import get_services
from tests.conftest import admin_client as admin_session


@pytest.fixture
def client():
    with admin_session() as test_client:
        yield test_client


@pytest.fixture
def workspace(client: TestClient):
    """往真实的工作区目录里放一份像样的记忆，返回那个目录。

    用 settings 算出来的路径（而不是自己拼一个）——不然测试和产品会在
    "工作区到底在哪"这件事上各说各话。
    """
    root = get_services().memory.workspace
    (root / "daily" / "2026-09-16").mkdir(parents=True)
    (root / "digest" / "personal").mkdir(parents=True)
    (root / "session" / "dialog").mkdir(parents=True)
    (root / "MEMORY.md").write_bytes(
        "---\nsummary: 核心\n---\n\n## 核心长期记忆\n\n- 用户偏好先给结论\n".encode()
    )
    (root / "SOUL.md").write_bytes("# 我是 KYLAB\n".encode())
    (root / "daily" / "2026-09-16" / "会话一.md").write_bytes(
        "# 今天的现场\n\n结论见 [[digest/personal/锂价.md]]\n".encode()
    )
    (root / "digest" / "personal" / "锂价.md").write_bytes(
        "---\ntags: [锂价]\n---\n\n# 锂价敏感性\n\n来源 [[会话一]]\n".encode()
    )
    (root / "session" / "dialog" / "conv_x.md").write_bytes("# 原始对话\n".encode())
    return root


def _enable(client: TestClient, **values: str) -> None:
    """把记忆打开（以及需要时改地址）。走设置端点，与用户的操作同一条路。

    设置端点的请求体是 ``{"values": [{"key": …, "value": …}]}``——**是列表不是字典**，
    因为一个键可能被重复提交，而且这样服务端能按序报出"哪个键不认识"。
    """
    payload = {"memory.enabled": "true", **values}
    response = client.patch(
        "/api/v1/settings",
        json={"values": [{"key": key, "value": value} for key, value in payload.items()]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["rejected"] == [], response.text


# --------------------------------------------------------------- 状态与列表


def test_overview_lists_files_and_counts(client: TestClient, workspace) -> None:
    body = client.get("/api/v1/memory").json()
    paths = [item["path"] for item in body["files"]]

    assert body["status"]["enabled"] is False  # 默认关（§2.3）
    assert body["status"]["core_file_exists"] is True
    assert body["status"]["file_count"] == len(paths)
    # 派生物目录不进列表：原始对话不是记忆
    assert "session/dialog/conv_x.md" not in paths
    assert {"MEMORY.md", "SOUL.md", "daily/2026-09-16/会话一.md"} <= set(paths)
    assert body["truncated"] is False


def test_overview_reports_retrievability_and_injection(client: TestClient, workspace) -> None:
    """``retrievable`` / ``injected`` 是界面解释"为什么搜不到"的依据（见 schemas 的说明）。"""
    by_path = {item["path"]: item for item in client.get("/api/v1/memory").json()["files"]}

    assert by_path["daily/2026-09-16/会话一.md"]["retrievable"] is True
    assert by_path["digest/personal/锂价.md"]["retrievable"] is True
    assert by_path["MEMORY.md"]["retrievable"] is False
    assert by_path["MEMORY.md"]["injected"] is True
    assert by_path["SOUL.md"]["injected"] is True


def test_overview_counts_unconsolidated(client: TestClient, workspace) -> None:
    """「哪些还没被整合」= ``daily/`` 里没被 ``digest/`` 链到的。
    实测那份里 ``会话一.md`` 是被链到的，所以计数为 0。"""
    assert client.get("/api/v1/memory").json()["status"]["unconsolidated_count"] == 0


def test_graph_comes_from_local_files(client: TestClient, workspace) -> None:
    """图谱是本地从 ``[[…]]`` 算的，**不需要记忆服务活着**。"""
    graph = client.get("/api/v1/memory/graph").json()
    assert graph["edges"] == [["daily/2026-09-16/会话一.md", "digest/personal/锂价.md"]]
    assert {node["path"] for node in graph["nodes"]} == {
        "daily/2026-09-16/会话一.md",
        "digest/personal/锂价.md",
    }


# ------------------------------------------------------------------- 读写


def test_read_write_delete_roundtrip(client: TestClient, workspace) -> None:
    """逐字往返：编辑器存回去不能改动用户的格式（换行、frontmatter 排列都算）。"""
    path = "digest/personal/锂价.md"
    original = client.get(f"/api/v1/memory/files/{path}").json()
    assert original["content"].startswith("---")
    assert original["meta"] == {"tags": ["锂价"]}
    assert original["title"] == "锂价敏感性"
    # 整合状态是**跨文件**才知道的：读单个文件时不猜，显式给 None（"没算"）
    assert original["consolidated"] is None

    updated = client.put(f"/api/v1/memory/files/{path}", json={"content": original["content"]})
    assert updated.status_code == 200, updated.text
    assert updated.json()["content"] == original["content"]

    assert client.delete(f"/api/v1/memory/files/{path}").status_code == 204
    assert client.get(f"/api/v1/memory/files/{path}").status_code == 404


def test_write_creates_new_file(client: TestClient, workspace) -> None:
    """要能新建整合笔记（``digest/procedure/…``），目录自动建。"""
    response = client.put(
        "/api/v1/memory/files/digest/procedure/新流程.md",
        json={"content": "# 新流程\n\n先看日志。\n"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["kind"] == "digest"
    assert response.json()["title"] == "新流程"


def test_editing_works_even_when_memory_disabled(client: TestClient, workspace) -> None:
    """**记忆关着也能编辑自己的文件**：要求"先起一个服务才能读自己的文本文件"
    是没道理的（这条界线写在 services/memory_files.py 的模块头）。"""
    assert client.get("/api/v1/memory").json()["status"]["enabled"] is False
    assert (
        client.put(
            "/api/v1/memory/files/MEMORY.md", json={"content": "# 手写\n"}
        ).status_code
        == 200
    )


@pytest.mark.parametrize(
    "bad",
    ["../backend.env", "daily/../../x.md", "C:foo.md", "notes.txt", "a.md:stream"],
)
def test_path_escape_never_reaches_a_file(client: TestClient, workspace, bad: str) -> None:
    """越界/非法路径一律拒。**这是这个端点唯一的安全边界**：路径由前端给出。

    这里断言的是"**没有 200**"而不是某个具体码，因为两条防线各自生效：

    - ``../backend.env`` 这类会被 HTTP 客户端**先归一化**（httpx 把它折成
      ``/api/v1/memory/backend.env``），于是根本没匹配上路由 → 404。
      真实的浏览器也一样，所以这条路径上"到不了处理器"是可接受的结局；
    - 但**裸客户端**（``curl --path-as-is``）能把未归一化的路径送到处理器，
      那时 ``safe_path`` 必须拦住它——那一条在
      ``tests/unit/services/test_memory_files.py`` 里逐条钉着（含 ``..``、
      盘符、ADS 数据流、控制字符）。协议层的用例只负责证明"文件读不出来"。
    """
    response = client.get(f"/api/v1/memory/files/{bad}")
    assert response.status_code != 200, response.text
    assert response.status_code in (404, 422), response.text


def test_oversized_write_is_rejected(client: TestClient, workspace) -> None:
    """字数是协议层挡的（与 service 的字节上限同源），不该等到落盘才拒。"""
    response = client.put(
        "/api/v1/memory/files/digest/大.md", json={"content": "字" * 1_000_001}
    )
    assert response.status_code == 422


# --------------------------------------------------------------- 召回与记住


def test_recall_requires_memory_enabled(client: TestClient, workspace) -> None:
    """关着时**明确报错**，不返回空结果——返回空会让模型以为"没有相关记忆"，
    然后基于错误前提继续推理（§2.3）。

    断言 ``code`` 与那句话（而不是只断言状态码）：这一层的价值全在"说清为什么"，
    只对状态码的话，把文案改成"参数不合法"也能过。
    """
    response = client.post("/api/v1/memory/recall", json={"query": "锂价"})
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"
    assert "未启用长期记忆" in response.json()["message"]


def test_recall_parses_the_real_response_shape(client: TestClient, workspace, monkeypatch) -> None:
    """真实形状：结果在 ``metadata.results``、分数在 ``scores.score``。
    第一版这两个位置都猜错了，是靠真跑一遍服务才纠正的——所以这里钉住它。"""
    _enable(client, **{"memory.base_url": "http://reme.test"})
    payload = {
        "answer": "…给人读的…",
        "success": True,
        "metadata": {
            "results": [
                {
                    "id": "abc",
                    "text": "用户偏好先给结论，再给理由。",
                    "path": "digest/personal/风格.md",
                    "start_line": 3,
                    "end_line": 5,
                    "scores": {"keyword": 2.72, "score": 2.72},
                }
            ],
            "link_expansion": {
                "digest/personal/风格.md": {
                    "outlinks": [{"path": "digest/personal/锂价.md", "meta": {"name": "锂价"}}],
                    "inlinks": [],
                }
            },
        },
    }
    monkeypatch.setattr("app.services.memory.httpx.post", lambda *a, **k: _FakeResponse(payload))

    body = client.post(
        "/api/v1/memory/recall", json={"query": "我喜欢什么风格", "limit": 3}
    ).json()

    assert body["hits"][0]["path"] == "digest/personal/风格.md"
    assert body["hits"][0]["start_line"] == 3
    assert body["hits"][0]["score"] == 2.72
    assert body["links"][0]["path"] == "digest/personal/锂价.md"
    assert body["links"][0]["direction"] == "out"
    assert body["links"][0]["name"] == "锂价"
    # 那句话必须提醒这是记忆、不是知识库原文（与 MCP 同一句）
    assert "不是知识库原文" in body["note"]


def test_recall_limit_is_clamped_by_the_schema(client: TestClient, workspace) -> None:
    _enable(client)
    assert (
        client.post("/api/v1/memory/recall", json={"query": "x", "limit": 999}).status_code
        == 422
    )


def test_recall_upstream_failure_is_not_an_empty_result(client: TestClient, workspace, monkeypatch):
    """记忆服务连不上时**报错**，不静默降级成"没有相关记忆"（§2.3）。

    502 而不是 500：上游出错与"我们内部出错了"该分得清（见 ``UpstreamError``
    的说明），用户看到文案就知道该去把那个进程拉起来。
    """
    import httpx

    monkeypatch.setattr(
        "app.services.memory.httpx.post",
        lambda *a, **k: (_ for _ in ()).throw(httpx.ConnectError("连不上")),
    )
    _enable(client, **{"memory.base_url": "http://reme.test"})

    response = client.post("/api/v1/memory/recall", json={"query": "x"})
    assert response.status_code == 502
    assert response.json()["code"] == "upstream_error"
    assert "记忆服务" in response.json()["message"]


def test_remember_without_service_writes_local_file(client: TestClient, workspace) -> None:
    """``remember`` **不经过 ReMe**：写的是本地 ``MEMORY.md``。
    所以记忆服务没起也能记住东西——这是那条路径刻意的设计。

    用一条**与夹具不同**的事实：夹具里已经有一条"先给结论"，
    拿同一条去记会走到"已存在"那一支，这条用例就测不到"真写进去了"。
    """
    _enable(client)
    fact = "发布前必须先跑一遍后端门禁脚本"

    first = client.post("/api/v1/memory/remember", json={"content": fact})
    assert first.status_code == 200, first.text
    assert first.json()["saved"] is True

    # 同一条再记一次：是"本来就有"，不是错误（saved=false）
    again = client.post("/api/v1/memory/remember", json={"content": fact}).json()
    assert again["saved"] is False
    assert "已经存在" in again["reason"]

    content = client.get("/api/v1/memory/files/MEMORY.md").json()["content"]
    assert content.count(fact) == 1
    # 夹具里手写的那条必须留着：只重建「核心长期记忆」那一节，别的小节原样保留
    assert "用户偏好先给结论" in content
    assert "## 核心长期记忆" in content


def test_remember_does_not_require_the_switch(client: TestClient, workspace) -> None:
    """**「记住」与 ``recall`` 不是同口径了**（v0.22 改）。

    它写的是 ``MEMORY.md``，那份文件不看开关、每轮都注入——写进去立即有效。
    原先它与 ``recall`` 共用 ``_require_enabled``，于是关掉记忆服务时
    "记住"整个是死的，而报错还劝用户"把记忆服务跑起来"——
    那句话对这里不成立（这里根本不经过 ReMe）。
    对照：``recall`` 关着时仍然 422，见 ``test_recall_requires_enabled``。
    """
    # 夹具里已有一条「用户偏好先给结论」——用它会被去重，那测的是去重不是这道闸
    response = client.post("/api/v1/memory/remember", json={"content": "项目代号叫 kylab"})

    assert response.status_code == 200, response.text
    assert response.json()["saved"] is True
    content = client.get("/api/v1/memory/files/MEMORY.md").json()["content"]
    assert "项目代号叫 kylab" in content
    # 夹具里手写的那条必须还在（只重建那一节，不是重写整份文件）
    assert "用户偏好先给结论" in content


def test_remember_rejects_too_long(client: TestClient, workspace) -> None:
    """一条记忆该是一句可复用的事实；超长的该存成笔记（否则 MEMORY.md 每轮注入都更贵）。
    字数是协议层挡的，与 service 同源。"""
    _enable(client)
    response = client.post("/api/v1/memory/remember", json={"content": "字" * 501})
    assert response.status_code == 422


def test_reindex_reports_upstream_detail(client: TestClient, workspace, monkeypatch) -> None:
    _enable(client, **{"memory.base_url": "http://reme.test"})
    monkeypatch.setattr(
        "app.services.memory.httpx.post",
        lambda *a, **k: _FakeResponse({"answer": "已重建索引", "success": True}),
    )
    response = client.post("/api/v1/memory/reindex")
    assert response.status_code == 200, response.text
    assert "已重建索引" in response.json()["detail"]


def test_probe_is_admin_only(client: TestClient) -> None:
    """「测试连接」打的是**可配置的地址**，与设置页其它测试同档：管理员专属。
    用普通读权限放行，等于把"让服务端按我指定的地址发请求"开放给任何成员。

    成员账号直接落库造（开通端点是另一条路的事），与 ``test_visibility_api``
    同一套写法——测的是**档位**，不是开通流程。
    """
    from app.core.security import hash_password
    from app.models.enums import UserRole
    from app.storage.base import UserRecord

    meta = get_services().auth._stores.meta
    meta.create_user(
        UserRecord(
            id="user_member",
            name="成员",
            username="member",
            password_hash=hash_password("member pass 123"),
            role=UserRole.MEMBER,
        )
    )
    member = client.post(
        "/api/v1/auth/login", json={"username": "member", "password": "member pass 123"}
    ).json()
    response = client.post(
        "/api/v1/memory/probe", headers={"Authorization": f"Bearer {member['token']}"}
    )
    assert response.status_code == 403


class _FakeResponse:
    """最小 httpx.Response 替身：只用得到 ``status_code``/``json()``/``text``。"""

    def __init__(self, payload: dict) -> None:
        self.status_code = 200
        self._payload = payload

    def json(self) -> dict:
        return self._payload

    @property
    def text(self) -> str:
        return str(self._payload)


def test_overview_does_not_claim_a_connection_it_never_checked(
    client: TestClient, workspace, monkeypatch
) -> None:
    """``GET /memory`` **不打远端**，所以它只能说"已启用"，不能说"未连接"。

    这是实测踩出来的：该端点原先返回 ``reachable: false``，而同一时刻
    ``/memory/probe`` 报"服务正常"——页头因此一直挂着"记忆服务未连接"的警示，
    而那时根本没有任何一次连接失败过。**没测过就别下结论。**
    """
    _enable(client, **{"memory.base_url": "http://reme.test"})

    def boom(*_a, **_k):  # type: ignore[no-untyped-def]
        raise AssertionError("GET /memory 不该发网络请求")

    monkeypatch.setattr("app.services.memory.httpx.post", boom)

    body = client.get("/api/v1/memory").json()

    assert body["status"]["enabled"] is True
    assert body["status"]["reachable"] is None


def test_probe_reports_a_real_connection(client: TestClient, workspace, monkeypatch) -> None:
    """probe 这条**成功路径**原先一条用例都没有，于是它在真机上 500：
    ``MemoryStatus`` 是 slots 记录、没有 ``__dict__``，而那里用
    ``MemoryStatus(**{**base.__dict__, ...})`` 拼的。只有真打一次服务才发现得了。
    """
    _enable(client, **{"memory.base_url": "http://reme.test"})
    monkeypatch.setattr(
        "app.services.memory.httpx.post",
        lambda *a, **k: _FakeResponse({"answer": "ReMe v0.4.1.12 - healthy"}),
    )

    body = client.post("/api/v1/memory/probe").json()

    assert body["reachable"] is True
    assert "服务正常" in body["detail"]


def test_probe_reports_a_failure_without_500(client: TestClient, workspace, monkeypatch) -> None:
    """连不上是 probe 的**正常产出**（它是设置页的「测试连接」），不是服务器错误。"""
    import httpx

    _enable(client, **{"memory.base_url": "http://reme.test"})
    monkeypatch.setattr(
        "app.services.memory.httpx.post",
        lambda *a, **k: (_ for _ in ()).throw(httpx.ConnectError("连不上")),
    )

    response = client.post("/api/v1/memory/probe")

    assert response.status_code == 200, response.text
    assert response.json()["reachable"] is False
