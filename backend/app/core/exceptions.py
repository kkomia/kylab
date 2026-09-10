"""统一领域异常与错误响应映射。

分层约定（工程规范 §3.3）：``api/`` 与 ``mcp_server/`` 不写业务判断；
业务错误一律以本模块的领域异常从 ``services/`` 抛出，由处理器统一转成响应体。
"""

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse


class KylabError(Exception):
    """领域异常基类。"""

    code = "internal_error"
    http_status = status.HTTP_500_INTERNAL_SERVER_ERROR
    message = "服务内部错误"

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.message)
        self.detail = message or self.message


class NotFoundError(KylabError):
    """资源不存在。"""

    code = "not_found"
    http_status = status.HTTP_404_NOT_FOUND
    message = "资源不存在"


class ConflictError(KylabError):
    """状态冲突，如重复入库、非法状态迁移。"""

    code = "conflict"
    http_status = status.HTTP_409_CONFLICT
    message = "资源冲突"


class InvalidRequestError(KylabError):
    """请求参数不合法。"""

    code = "invalid_request"
    # 直接写字面量：starlette 在新版本里把 HTTP_422_UNPROCESSABLE_ENTITY 改名了
    http_status = 422
    message = "请求参数不合法"


def register_exception_handlers(app: FastAPI) -> None:
    """把领域异常注册为统一的 JSON 错误响应。"""

    @app.exception_handler(KylabError)
    async def _handle_kylab_error(_: Request, exc: KylabError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.http_status,
            content={"code": exc.code, "message": exc.detail},
        )
