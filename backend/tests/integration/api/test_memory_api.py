"""记忆端点的集成测试（v0.14 三期；v0.57 起后端是 **mem0**，见 ``services/memory.py``）。

镜像同构：``app/api/v1/memory.py`` → ``tests/integration/api/test_memory_api.py``。

覆盖五件事：

1. **状态是纯本地的**：开没开、库在哪、几条、向量是不是兜底；
2. **按条目读写**：列表 / 检索 / 加 / 改 / 删 / 看历史——回执从服务层那一处来；
3. **文件读取走本地目录**，所以 ``memory.enabled=false`` 时也该能用
   ——记忆关着的时候，用户依然该能打开自己的人设文件看看写了什么；
4. **路径越界要挡住**：路径由前端传进来，这是读端点唯一的安全边界；
5. **旧档案制那几个端点确实没了**：``/recall`` / ``/remember`` / ``/forget`` /
   ``/archive`` / ``/changes`` / ``/restore`` / ``/group`` / ``/migrate`` /
   ``/draft/organize``——它们不该以任何形态存在（断言 404/405，而不是"返回了错误码"），
   替代品是 ``/items`` 一族与 ``/import-legacy``。

**没有"测试连接"这类端点了**（v0.46 删）：记忆跑在我们自己的进程里，
没有第二个进程可连。所以这一份里也不再有任何 ``monkeypatch`` 打桩的 HTTP——
本地实现不需要假装别的东西活着，这本身就是那次改动的价值。

## 为什么这一份打**本机档**

``/memory*`` 与它那组设置都在本机档（NAS 网页端已退役），所以用
`conftest.local_client`：**不带凭据**（本机档不设门禁，主体短路成"本机主人"）。

## 嵌入模型没配时走的是**开发兜底嵌入**

测试环境没登记向量化模型（见 ``MemoryService._embedder``），于是检索走的是
无语义的词面哈希——所以下面那些检索断言都用**同一个说法**去查（词面重合才有分），
而不是"换个说法也能命中"。那不是这一层要测的东西。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.services import get_services

_LEGACY = """---
updated: 2026-10-03
---

# 用户档案

## 身份与称呼

- 用户叫小又，称呼「小又」即可。

## 长期偏好与风格

- 用户要求回答先给结论，再列依据。

## 进行中的项目

### 内网部署

- 项目目标是不出公网。

## 工具与环境

- 用户的内网有一台 L20。
"""


@pytest.fixture
def client(local_client: TestClient) -> TestClient:
    """本机档客户端（记忆 + 它的开关都只在本机档成立）。"""
    return local_client


@pytest.fixture
def workspace(client: TestClient):
    """往真实的工作区目录里放一份旧档案，返回那个目录。

    用 settings 算出来的路径（而不是自己拼一个）——不然测试和产品会在
    "工作区到底在哪"这件事上各说各话。
    """
    root = get_services().memory.workspace
    root.mkdir(parents=True, exist_ok=True)
    (root / "PROFILE.md").write_bytes(_LEGACY.encode())
    (root / "SOUL.md").write_bytes("# 我是 KYLAB\n".encode())
    return root


def _enable(client: TestClient, **values: str) -> None:
    """把记忆打开（以及需要时改别的项）。走设置端点，与用户的操作同一条路。"""
    payload = {"memory.enabled": "true", **values}
    response = client.patch(
        "/api/v1/settings",
        json={"values": [{"key": key, "value": value} for key, value in payload.items()]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["rejected"] == [], response.text


def _disable(client: TestClient) -> None:
    response = client.patch(
        "/api/v1/settings",
        json={"values": [{"key": "memory.enabled", "value": "false"}]},
    )
    assert response.status_code == 200, response.text


def _add(client: TestClient, content: str, **extra) -> dict:
    response = client.post("/api/v1/memory/items", json={"content": content, **extra})
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------- 状态


def test_overview_reports_status_only(client: TestClient, workspace) -> None:
    """``GET /memory`` 只报状态：开没开、库在哪、几条、向量兜底没有。

    原先它还带一份**文件列表**（每项有个 ``injected`` 标记）：列表只服务记忆页上
    那节只读的「旧记忆」，那一节下掉之后它没有读者，字段与能力一起删。
    """
    body = client.get("/api/v1/memory").json()

    # **默认开**：注入一次模型调用都不产生，所以"默认关"只等于"这个功能默认不存在"
    assert body["status"]["enabled"] is True
    assert "files" not in body
    status = body["status"]
    assert status["items"] == 0, "新库里一条都没有"
    # **没有连通性字段**：没有第二个进程可连，也就没有"连没连上"这回事
    assert "reachable" not in status
    assert "base_url" not in status
    # 向量是兜底时要如实说（界面据此提示"检索质量不代表真实效果"）
    assert status["development"] is True
    assert status["embedder"] == "dev/deterministic-hash"


def test_overview_counts_items(client: TestClient, workspace) -> None:
    """写完一条之后状态里的条数与"上次更新"跟着动。"""
    _add(client, "用户要求回答先给结论")

    status = client.get("/api/v1/memory").json()["status"]

    assert status["items"] == 1
    assert status["last_changed_at"], "有条目就该有'上次更新'时间"


# ----------------------------------------------------------- 已删除的端点


@pytest.mark.parametrize(
    "method,path",
    [
        ("post", "/memory/recall"),
        ("post", "/memory/remember"),
        ("post", "/memory/forget"),
        ("get", "/memory/archive"),
        ("get", "/memory/changes"),
        ("post", "/memory/restore"),
        ("post", "/memory/group"),
        ("post", "/memory/migrate"),
        ("post", "/memory/draft/organize"),
        ("post", "/memory/probe"),
    ],
)
def test_the_archive_era_endpoints_are_gone(
    client: TestClient, workspace, method: str, path: str
) -> None:
    """档案制那一套端点**不该以任何形态存在**。

    留一个"返回错误码"的路由也算留了一条实现路径（它会被 OpenAPI 列出来、
    被客户端当成"有这个东西但坏了"），所以断言 404/405。
    """
    call = getattr(client, method)
    response = call(f"/api/v1{path}") if method == "get" else call(f"/api/v1{path}", json={})
    assert response.status_code in (404, 405), f"{method} {path}"


def test_file_level_write_endpoints_are_gone(client: TestClient, workspace) -> None:
    """``PUT`` / ``DELETE /memory/files/{path}`` 是**绕过条目级判据的后门**。

    整份覆盖能一次写进一大段没人审过的内容，所以这两个方法整个删掉：
    记忆的写入只有 ``POST /memory/items``（外加界面上的条目级编辑）。
    """
    put = client.put("/api/v1/memory/files/SOUL.md", json={"content": "# 我改了\n"})
    delete = client.delete("/api/v1/memory/files/SOUL.md")

    assert put.status_code in (404, 405)
    assert delete.status_code in (404, 405)
    assert "我是 KYLAB" in (workspace / "SOUL.md").read_text(encoding="utf-8")


# ------------------------------------------------------------------- 读文件


def test_read_file_roundtrip(client: TestClient, workspace) -> None:
    """读原文（含 frontmatter）——人设文件与旧档案的只读查看靠它。"""
    body = client.get("/api/v1/memory/files/PROFILE.md").json()

    assert body["content"].startswith("---")
    assert "用户叫小又" in body["content"]
    assert body["name"] == "PROFILE.md"


def test_reading_works_even_when_memory_is_disabled(client: TestClient, workspace) -> None:
    """**关着记忆也能读自己的文件**：要求"先打开一个开关才能读自己的文本文件"
    是没道理的。

    对照：``GET /memory/items?query=`` 关着时 422（见下一条）。
    """
    _disable(client)

    assert client.get("/api/v1/memory").json()["status"]["enabled"] is False
    assert client.get("/api/v1/memory/files/SOUL.md").status_code == 200


@pytest.mark.parametrize(
    "bad",
    ["../backend.env", "daily/../../x.md", "C:foo.md", "notes.txt", "a.md:stream"],
)
def test_path_escape_never_reaches_a_file(client: TestClient, workspace, bad: str) -> None:
    """越界/非法路径一律拒。**这是读端点唯一的安全边界**：路径由前端给出。

    这里断言的是"**没有 200**"而不是某个具体码，因为两条防线各自生效：

    - ``../backend.env`` 这类会被 HTTP 客户端**先归一化**（httpx 把它折成
      ``/api/v1/memory/backend.env``），于是根本没匹配上路由 → 404；
    - 但**裸客户端**（``curl --path-as-is``）能把未归一化的路径送到处理器，
      那时 ``safe_path`` 必须拦住它——那一条在
      ``tests/unit/services/test_memory_files.py`` 里逐条钉着。
    """
    response = client.get(f"/api/v1/memory/files/{bad}")
    assert response.status_code != 200, response.text
    assert response.status_code in (404, 422), response.text


# --------------------------------------------------------------- 条目读写


def test_search_requires_memory_enabled(client: TestClient, workspace) -> None:
    """关着时**明确报错**，不返回空结果——返回空会让模型以为"没有相关记忆"，
    然后基于错误前提继续推理。

    断言 ``code`` 与那句话（而不是只断言状态码）：这一层的价值全在"说清为什么"。
    """
    _disable(client)

    response = client.get("/api/v1/memory/items", params={"query": "先给结论"})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"
    assert "未启用长期记忆" in response.json()["message"]


def test_list_and_search_round_trip(client: TestClient, workspace) -> None:
    """列表报全部（最近改的在前）、带 ``query`` 时检索。

    检索用的是**同一个说法**：测试环境没配嵌入模型，走的是无语义的词面兜底
    （见模块头），所以"换个说法也能命中"不是这一层能担保的事。
    """
    _enable(client)
    _add(client, "用户要求回答先给结论")
    _add(client, "用户的内网有一台 L20")

    listed = client.get("/api/v1/memory/items").json()
    assert listed["total"] == 2
    assert {item["text"] for item in listed["items"]} == {
        "用户要求回答先给结论",
        "用户的内网有一台 L20",
    }
    assert listed["note"] == "", "列全部不是检索，不该带那句提醒"
    assert all(item["id"] for item in listed["items"]), "每条都要有 id（界面按它改删）"

    found = client.get("/api/v1/memory/items", params={"query": "先给结论"}).json()
    assert found["items"], f"这条就在库里，必须能查到：{found}"
    assert "先给结论" in found["items"][0]["text"]
    assert found["items"][0]["score"] is not None
    # 那句话必须提醒这是记忆、不是知识库原文（与 MCP 同一句）
    assert "长期记忆" in found["note"]


def test_search_returns_empty_for_a_noise_query(client: TestClient, workspace) -> None:
    """**开着时返回空是诚实的答案**（检索确实跑过了），与"关着时返回空"不是一回事。"""
    _enable(client)
    _add(client, "用户要求回答先给结论")

    body = client.get("/api/v1/memory/items", params={"query": "合唱团的排练时间安排"}).json()

    assert body["items"] == []


def test_create_returns_the_action_and_the_receipt(client: TestClient, workspace) -> None:
    """写入返回 ``action`` 与 ``receipt``：界面与模型用的是**同一句话**。

    四种动作在这一条里一次走完：added → existing（同一条再记一次）→
    replaced（带 ``replaces`` 更正）→ rejected（超单条上限）。
    """
    _enable(client)
    fact = "用户要求在周五先复盘"

    added = _add(client, fact)
    assert added["action"] == "added"
    assert fact in added["receipt"]
    assert added["section"] == "长期偏好与风格"
    assert added["item_id"]

    again = _add(client, fact)
    assert again["action"] == "existing"
    assert "已经有了" in again["receipt"]

    corrected = _add(client, "用户要求在周五先复盘，再定下周计划", replaces=fact)
    assert corrected["action"] == "replaced"
    assert "改成" in corrected["receipt"]
    assert corrected["replaced"] == fact

    # 501 字是**协议层**挡的（见下一条），所以这里走 500 字的边界：服务层放行
    assert _add(client, "长" * 500)["action"] == "added"

    # 更正过的那条在库里，长的那条也在（它是一条独立的事实）
    texts = [item["text"] for item in client.get("/api/v1/memory/items").json()["items"]]
    assert "用户要求在周五先复盘，再定下周计划" in texts
    assert "用户要求在周五先复盘" not in texts


def test_create_does_not_require_the_switch(client: TestClient, workspace) -> None:
    """**「记住」与检索不是同口径**：记忆的读写不看那道闸，它只管注入与检索。

    对照：``GET /memory/items?query=`` 关着时仍然 422（见上面那条）。
    """
    _disable(client)

    body = _add(client, "项目代号叫 kylab")

    assert body["action"] == "added"
    # 关着也读得到（读的是本机存储，不是提示词）
    items = client.get("/api/v1/memory/items").json()
    assert [item["text"] for item in items["items"]] == ["项目代号叫 kylab"]


def test_create_rejects_an_overlong_payload_at_the_transport_layer(
    client: TestClient, workspace
) -> None:
    """501 字以上是**协议层**挡的（与 service 的常量同源）。

    它是让请求别白读一遍的粗护栏；真正的单条上限也是 500，由服务层以**回执**
    拒绝（见上一条）——两层同一个数，所以这里只能断言 422。
    """
    _enable(client)
    response = client.post("/api/v1/memory/items", json={"content": "字" * 501})
    assert response.status_code == 422


def test_create_rejects_sensitive_content(client: TestClient, workspace) -> None:
    """敏感信息**绝不进记忆**：它每轮都进上下文。"""
    _enable(client)

    body = _add(client, "用户的令牌是 sk-abcdefghijklmno")

    assert body["action"] == "rejected"
    assert "不进记忆" in body["receipt"]
    assert client.get("/api/v1/memory/items").json()["items"] == []


def test_patch_edits_in_place_and_keeps_the_id(client: TestClient, workspace) -> None:
    """改一条按 id 走（id 不变，历史里多一步）。"""
    _enable(client)
    item_id = _add(client, "用户要求回答简短")["item_id"]

    body = client.patch(
        f"/api/v1/memory/items/{item_id}",
        json={"content": "用户要求回答简短，先给结论"},
    ).json()

    assert body["action"] == "replaced"
    assert body["item_id"] == item_id
    assert body["replaced"] == "用户要求回答简短"
    items = client.get("/api/v1/memory/items").json()["items"]
    assert [item["id"] for item in items] == [item_id]
    assert items[0]["text"] == "用户要求回答简短，先给结论"


def test_patch_can_change_only_the_section(client: TestClient, workspace) -> None:
    """``content`` 留空 = 只改分区标签。"""
    _enable(client)
    item_id = _add(client, "用户要求回答简短")["item_id"]

    body = client.patch(
        f"/api/v1/memory/items/{item_id}", json={"section": "工具与环境"}
    ).json()

    assert body["section"] == "工具与环境"
    items = client.get("/api/v1/memory/items").json()["items"]
    assert items[0]["section"] == "工具与环境"
    assert items[0]["text"] == "用户要求回答简短"


def test_patch_and_delete_report_a_missing_item(client: TestClient, workspace) -> None:
    """拿一个不存在的 id 改 / 删 → 404（而不是静默成功）。"""
    _enable(client)

    patched = client.patch("/api/v1/memory/items/不存在", json={"content": "x"})
    deleted = client.delete("/api/v1/memory/items/不存在")

    assert patched.status_code == 404
    assert deleted.status_code == 404


def test_delete_removes_the_item_and_keeps_its_history(client: TestClient, workspace) -> None:
    """删掉之后列表里没有了，**历史还在**（mem0 自己的 ``history.db``）。

    历史是只读的：v0.57 没有"还原"这条路，它留着是为了让人看清"这条以前是什么"。
    """
    _enable(client)
    item_id = _add(client, "用户要求回答简短")["item_id"]
    client.patch(f"/api/v1/memory/items/{item_id}", json={"content": "用户要求回答很短"})

    body = client.delete(f"/api/v1/memory/items/{item_id}").json()
    assert body["action"] == "forgotten"
    assert body["text"] == "用户要求回答很短"
    assert client.get("/api/v1/memory/items").json()["items"] == []

    history = client.get(f"/api/v1/memory/items/{item_id}/history").json()
    events = [row["event"] for row in history["items"]]
    assert events == ["ADD", "UPDATE", "DELETE"]
    assert history["items"][0]["new"] == "用户要求回答简短"
    assert history["items"][1]["old"] == "用户要求回答简短"
    assert history["items"][-1]["deleted"] is True


# ------------------------------------------------------------------- 迁移


def test_import_legacy_moves_entries_and_never_touches_the_file(
    client: TestClient, workspace
) -> None:
    """旧档案搬进新库：**旧文件一个字节都不动**、重跑净改动为零。"""
    before = (workspace / "PROFILE.md").read_bytes()

    report = client.post("/api/v1/memory/import-legacy").json()

    assert report["skipped"] is False
    assert report["changed"] is True
    assert report["imported"] == 4, report
    assert (workspace / "PROFILE.md").read_bytes() == before

    texts = [item["text"] for item in client.get("/api/v1/memory/items").json()["items"]]
    assert "用户叫小又，称呼「小又」即可。" in texts
    assert "用户的内网有一台 L20。" in texts
    assert report["source"] == "PROFILE.md"

    # 再跑一次：跳过、净改动为零
    again = client.post("/api/v1/memory/import-legacy").json()
    assert again["skipped"] is True
    assert again["imported"] == 0
    assert len(client.get("/api/v1/memory/items").json()["items"]) == 4


def test_import_legacy_is_a_no_op_without_an_old_archive(client: TestClient) -> None:
    """没有旧 ``PROFILE.md``（新装的实例）时不报错：搬 0 条是最常见的一种回答。"""
    report = client.post("/api/v1/memory/import-legacy").json()

    assert report["entries"] == 0
    assert report["imported"] == 0
    assert report["skipped"] is False


# ------------------------------------------------------------------- 别的


def test_the_settings_group_matches_the_new_keys(client: TestClient, workspace) -> None:
    """设置里「长期记忆」那一组的键就是这一套（界面按后端给的字段渲染）。

    钉住它是因为字段名一旦漏出去，界面会自动把它渲染成一个输入框
    ——用户会看到一个填了也没用的格子（``memory.capture_model`` 就是这样退场的）。
    """
    groups = client.get("/api/v1/settings").json()["groups"]
    memory_group = next(item for item in groups if item["key"] == "memory")
    keys = [field["key"] for field in memory_group["fields"]]

    assert keys == [
        "memory.enabled",
        "memory.infer",
        "memory.inject_limit_chars",
        "memory.search_top_k",
        "memory.workspace",
        "memory.persona_files",
    ]
    assert all("base_url" not in key and "service_scope" not in key for key in keys)
    # 旧的那几项（定时捕获 / 整理 / 向量 / 自动捕获）连字段都不该在——留着会让设置页
    # 显示几个"改了没有任何效果"的开关
    assert not any(
        "capture_every" in key or "dream" in key or "vector" in key or key == "memory.capture"
        for key in keys
    )
