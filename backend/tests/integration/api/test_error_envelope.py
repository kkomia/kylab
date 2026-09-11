"""领域异常到 HTTP 响应的映射（集成）。

这是前端依赖的错误信封契约：``{"code": ..., "message": ...}``，
且 HTTP 状态码必须与异常类型对应。
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.exceptions import (
    ConflictError,
    InvalidRequestError,
    KylabError,
    NotFoundError,
    register_exception_handlers,
)


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/not-found")
    async def _not_found() -> None:
        raise NotFoundError("知识库不存在")

    @app.get("/conflict")
    async def _conflict() -> None:
        raise ConflictError("检测到相同文件")

    @app.get("/invalid")
    async def _invalid() -> None:
        raise InvalidRequestError("top_k 必须大于 0")

    @app.get("/generic")
    async def _generic() -> None:
        raise KylabError()

    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    ("path", "status", "code", "message"),
    [
        ("/not-found", 404, "not_found", "知识库不存在"),
        ("/conflict", 409, "conflict", "检测到相同文件"),
        ("/invalid", 422, "invalid_request", "top_k 必须大于 0"),
        ("/generic", 500, "internal_error", "服务内部错误"),
    ]
    )
def test_error_envelope(client: TestClient, path: str, status: int, code: str,
                        message: str) -> None:
    response = client.get(path)
    assert response.status_code == status
    assert response.json() == {"code": code, "message": message}
