"""记忆端点的集成测试（v0.14 三期；v0.46 起记忆是**进程内的本地实现**）。

镜像同构：``app/api/v1/memory.py`` → ``tests/integration/api/test_memory_api.py``。

覆盖三件事：

1. **文件浏览/编辑是走本地目录的**，所以 ``memory.enabled=false`` 时也该能用
   ——记忆关着的时候，用户依然该能打开自己的记忆文件看看写了什么；
2. **召回要跑在真实工作区上**：从这里进去的请求要能命中磁盘上的记忆、
   带回文件与行号，噪声查询返回空；关着时**明确报错**（不是返回空结果，见 §2.3）；
3. **路径越界要挡住**：路径由前端传进来，这是这个端点唯一的安全边界。

**没有"测试连接"这类端点了**（v0.46 删）：记忆跑在我们自己的进程里，
没有第二个进程可连。所以这一份里也不再有任何 ``monkeypatch`` 打桩的 HTTP——
本地实现不需要假装别的东西活着，这本身就是这次改动的价值。
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
        "---\ntags: [锂价]\n---\n\n# 锂价敏感性\n\n来源 [[会话一]]\n"
        "\n锂价下跌 10% 会让电池业务毛利下降约 0.8 个百分点。\n".encode()
    )
    (root / "session" / "dialog" / "conv_x.md").write_bytes("# 原始对话\n".encode())
    return root


def _enable(client: TestClient, **values: str) -> None:
    """把记忆打开（以及需要时改别的项）。走设置端点，与用户的操作同一条路。

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


def test_overview_reports_local_counts(client: TestClient, workspace) -> None:
    """状态是**纯本地的数字**：几份文件、其中几份可召回、可召回几条、上次更新。

    这三个数字原先由界面 filter 出来（而且"可召回"那时是别人家索引的性质）；
    现在它们是这一层的本地事实——也就必须有用例钉住"数的是召回池里那些文件"。
    """
    status = client.get("/api/v1/memory").json()["status"]

    assert status["retrievable_count"] == 2  # daily 一份 + digest 一份
    assert status["entry_count"] > 0
    assert status["last_changed_at"], "有文件就该有'上次更新'时间"
    # **没有连通性字段了**：没有第二个进程可连，也就没有"连没连上"这回事
    assert "reachable" not in status
    assert "base_url" not in status


def test_overview_counts_unconsolidated(client: TestClient, workspace) -> None:
    """「哪些还没被整合」= ``daily/`` 里没被 ``digest/`` 链到的。
    实测那份里 ``会话一.md`` 是被链到的，所以计数为 0。"""
    assert client.get("/api/v1/memory").json()["status"]["unconsolidated_count"] == 0


def test_overview_counts_unconsolidated_when_nothing_links_back(
    client: TestClient, workspace
) -> None:
    """反向也要钉：没有回链的日笔记要**真的算进**那个计数。

    只测"等于 0"的话，一个恒为 0 的实现也能过——而那个数字是界面上
    「待整合」标记的依据（本轮没有自动整理，它是用户判断"还有多少没归档"的唯一线索）。
    """
    (workspace / "daily" / "2026-09-17.md").write_bytes("# 新的一天\n\n还没被整合。\n".encode())

    assert client.get("/api/v1/memory").json()["status"]["unconsolidated_count"] == 1


def test_graph_comes_from_local_files(client: TestClient, workspace) -> None:
    """图谱是本地从 ``[[…]]`` 算的，**不需要任何别的东西活着**。"""
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
    """**记忆关着也能编辑自己的文件**：要求"先打开一个开关才能读自己的文本文件"
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


def test_recall_finds_a_real_memory_with_source(client: TestClient, workspace) -> None:
    """召回跑在真实工作区上：命中要带回**文件 + 行号 + 分数 + 覆盖率**。

    行号是"渐进式展开"的入口，也是界面"点一下跳到那一段"的依据（见 §3.1 的四条轴）。
    """
    _enable(client)

    body = client.post("/api/v1/memory/recall", json={"query": "锂价下跌对毛利的影响"}).json()

    assert body["hits"], f"这条记忆就在磁盘上，必须能召回：{body}"
    top = body["hits"][0]
    assert top["path"] == "digest/personal/锂价.md"
    # 行号是**文件里的真实行号**（frontmatter 占 3 行、标题/来源/空行各 1 行）
    assert top["start_line"] == 9 and top["end_line"] == 9
    assert "毛利" in top["text"]
    assert top["score"] > 0
    # 覆盖率是**判据**（归一化量），与只用于排序的分数不是一回事
    assert top["coverage"] >= 1 / 3
    # 那句话必须提醒这是记忆、不是知识库原文（与 MCP 同一句）
    assert "不是知识库原文" in body["note"]


def test_recall_returns_empty_for_a_noise_query(client: TestClient, workspace) -> None:
    """**开着时返回空是诚实的答案**（检索确实跑过了），与"关着时返回空"不是一回事。

    本地检索没有"连不上"这种中间态，所以空只有一个含义：
    这几份记忆里确实没有相关的话。
    """
    _enable(client)

    body = client.post("/api/v1/memory/recall", json={"query": "合唱团的排练时间安排"}).json()

    assert body["hits"] == []


def test_recall_never_returns_document_pool_content(client: TestClient, workspace) -> None:
    """两池不混（§2.1）在这一层的证据：召回只读 ``data/memory/`` 下的召回池，
    连工作区里"不参与召回"的那几份（``MEMORY.md`` 等）都不会出现在结果里，
    更不可能碰到任何文档片段——这一路根本不 import 检索服务。"""
    _enable(client)

    body = client.post("/api/v1/memory/recall", json={"query": "用户偏好先给结论"}).json()

    assert body["hits"] == []
    assert all("知识库" not in hit["path"] for hit in body["hits"])


def test_recall_limit_is_clamped_by_the_schema(client: TestClient, workspace) -> None:
    _enable(client)
    assert (
        client.post("/api/v1/memory/recall", json={"query": "x", "limit": 999}).status_code
        == 422
    )


def test_remember_writes_the_local_file(client: TestClient, workspace) -> None:
    """``remember`` 写的是本地 ``MEMORY.md``，改完下一句问话就能被注入读到。

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
    """**「记住」与 ``recall`` 不是同口径**（v0.22 改）。

    它写的是 ``MEMORY.md``，那份文件不看开关、每轮都注入——写进去立即有效。
    对照：``recall`` 关着时仍然 422（见上一条）。
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


def test_there_is_no_probe_endpoint(client: TestClient, workspace) -> None:
    """**「测试连接」这个端点删掉了**（v0.46）：记忆跑在我们自己的进程里，
    没有第二个进程可连——留着它只会在界面上引出一串用户不该读的实现细节
    （地址、端口、异常原文）。

    断言 404 而不是 403/405：它不该以任何形态存在。
    """
    assert client.post("/api/v1/memory/probe").status_code == 404


def test_the_settings_group_has_no_service_address(client: TestClient, workspace) -> None:
    """设置里「长期记忆」那一组**不再有服务地址**（那是 ReMe 的遗物）。

    这条钉的是配置面：字段名一旦漏出去，界面会自动把它渲染成一个输入框
    （设置页的字段是后端给的，见 ``SettingsModal`` 的 featureGroups），
    于是用户会看到一个填了也没用的地址栏。
    """
    groups = client.get("/api/v1/settings").json()["groups"]
    memory_group = next(item for item in groups if item["key"] == "memory")
    keys = [field["key"] for field in memory_group["fields"]]

    assert keys == ["memory.enabled", "memory.workspace", "memory.capture_every"]
    assert all("base_url" not in key and "service_scope" not in key for key in keys)
