"""``app/core/exceptions.py`` 的单元测试。

镜像同构：``app/core/exceptions.py`` → ``tests/unit/core/test_exceptions.py``。
对外错误信封（``{code, message}``）是前端消费的契约，字段名必须稳定。
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


def test_base_error_defaults_to_500() -> None:
    error = KylabError()
    assert error.code == "internal_error"
    assert error.http_status == 500
    assert error.detail == "服务内部错误"


def test_subclasses_carry_their_own_status() -> None:
    assert (NotFoundError().code, NotFoundError().http_status) == ("not_found", 404)
    assert (ConflictError().code, ConflictError().http_status) == ("conflict", 409)
    assert (InvalidRequestError().code, InvalidRequestError().http_status) == (
        "invalid_request",
        422,
    )


def test_custom_message_overrides_default() -> None:
    error = NotFoundError("会话 conv_9 不存在")
    assert error.detail == "会话 conv_9 不存在"
    assert str(error) == "会话 conv_9 不存在"


def test_all_errors_share_the_base_type() -> None:
    """services 层只需捕获 KylabError 就能覆盖所有领域错误。"""
    for error in (NotFoundError(), ConflictError(), InvalidRequestError()):
        assert isinstance(error, KylabError)


@pytest.mark.parametrize("error_class", [NotFoundError, ConflictError, InvalidRequestError])
def test_every_error_has_a_machine_readable_code(error_class: type[KylabError]) -> None:
    code = error_class().code
    assert code and code.islower() and " " not in code


def test_the_envelope_is_registered_for_domain_errors() -> None:
    """领域异常统一折成 ``{code, message}`` 那封信（前端按 ``code`` 分支）。

    这条走真处理器（注册到一张最小的 app 上再发一次请求），不是读常量。
    """
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/boom")
    def _boom() -> None:
        raise InvalidRequestError("参数不对")

    with TestClient(app) as client:
        response = client.get("/boom")

    assert response.status_code == 422
    body = response.json()
    assert body == {"code": "invalid_request", "message": "参数不对"}
