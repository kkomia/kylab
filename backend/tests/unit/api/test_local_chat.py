"""对话侧四条只读端点的**响应形状**回归（提取自 ``chat.py`` / ``stats.py``）。

## 这一份为什么存在

这四条原先住在 ``api/v1/chat.py`` 与 ``api/v1/stats.py`` 里，本机档靠"按原路径薄重声明"
挂出来；那两个模块整体删掉时，它们搬进了 ``api/v1/local_chat.py`` 成为真实现。
搬家的风险只有一个：**形状悄悄变了**——前端的类型是照着 OpenAPI 生成的
（``frontend/src/api/schema.d.ts``），少一个字段不会报错，只会让那一页某个数字永远是空。

所以这里钉两件：

1. **HTTP 真打一次**，逐条对返回体的键集（不是"状态码 200 就算过"）；
2. **OpenAPI 里的形状**也钉一份——路由改坏了会 404/422，而组件被改瘦了不会。

这条"提取前后一致"的判据人工核过一遍：提取前后把四条路径的 OpenAPI 片段与
``components.schemas`` 里对应的那几个模型序列化后比对，``parameters`` / ``requestBody``
/ ``responses`` 完全相同（差别只有 ``tags`` 与文档串）。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

#: 四条路径 → 成功响应里必须出现的键（顶层）。
EXPECTED_TOP_LEVEL = {
    "/api/v1/chat/commands": {"items", "total", "user_dir", "builtin_dir"},
    "/api/v1/stats/usage": {
        "days",
        "total",
        "by_day",
        "by_kind",
        "by_model",
        "reported_calls",
        "estimated_calls",
        "unreported_calls",
        "estimated_tokens",
    },
    "/api/v1/chat/context-usage": {
        "items",
        "used",
        "total",
        "ratio",
        "compress_at",
        "compress_budget",
        "estimated",
        "note",
    },
    "/api/v1/conversations/{conversation_id}/events": {"items"},
}

#: 这四条都必须挂在白名单那张表上（它们读的都是本机库里的东西）。
LOCAL_PATHS = frozenset(EXPECTED_TOP_LEVEL)


def test_the_four_reads_are_on_the_local_router() -> None:
    """问**路由归属**：把 router 装进一个空 app 再读 OpenAPI 就够了。"""
    from fastapi import FastAPI

    from app.api.v1.router import local_router

    probe = FastAPI()
    probe.include_router(local_router, prefix="/api/v1")
    paths = set(probe.openapi()["paths"])
    assert paths >= LOCAL_PATHS


def test_response_shapes_survive_the_extraction(local_client: TestClient) -> None:
    """真打一次：四条端点的键集与提取前一致。"""
    created = local_client.post("/api/v1/conversations", json={"title": "形状回归"})
    assert created.status_code == 201, created.text
    conversation_id = created.json()["id"]

    bodies = {
        "/api/v1/chat/commands": local_client.get("/api/v1/chat/commands"),
        "/api/v1/stats/usage": local_client.get("/api/v1/stats/usage"),
        "/api/v1/chat/context-usage": local_client.get(
            "/api/v1/chat/context-usage", params={"conversation_id": conversation_id}
        ),
        "/api/v1/conversations/{conversation_id}/events": local_client.get(
            f"/api/v1/conversations/{conversation_id}/events"
        ),
    }

    for path, response in bodies.items():
        assert response.status_code == 200, (path, response.text)
        assert set(response.json()) == EXPECTED_TOP_LEVEL[path], (path, response.json())


def test_the_generated_schemas_still_carry_the_same_fields() -> None:
    """OpenAPI 里那几个模型的字段集也钉一份。

    路由级的用例只证明"这次调用回了什么"；模型被改瘦（少一个字段且给了默认值）时
    HTTP 仍然 200，只有对着组件看才发现。
    """
    from app.main import create_app

    schemas = create_app().openapi()["components"]["schemas"]

    def fields(name: str) -> set[str]:
        return set(schemas[name]["properties"])

    assert fields("CommandListOut") == {"items", "total", "user_dir", "builtin_dir"}
    assert fields("ContextUsageOut") == {
        "items",
        "used",
        "total",
        "ratio",
        "compress_at",
        "compress_budget",
        "estimated",
        "note",
    }
    assert fields("SessionEventListOut") == {"items"}
    assert fields("UsageOut") == EXPECTED_TOP_LEVEL["/api/v1/stats/usage"]
