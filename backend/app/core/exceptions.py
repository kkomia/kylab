"""统一领域异常与错误响应映射。

分层约定（工程规范 §3.3）：``api/`` 与 ``mcp_server/`` 不写业务判断；
业务错误一律以本模块的领域异常从 ``services/`` 抛出，由处理器统一转成响应体。
"""

import logging

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)


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


class UnsupportedContentError(KylabError):
    """请求的东西现在拿不到（还没解析完、格式不支持）。

    与 ``NotFoundError`` 分开：文件在、只是"还没到时候"，或者参数不受支持——
    回 404 会让调用方以为文档不见了，进而去重新上传。
    """

    code = "unsupported_content"
    http_status = status.HTTP_409_CONFLICT
    message = "该内容当前不可用"


class PayloadTooLargeError(KylabError):
    """上传内容超过限额。

    单列一类而不是并进 ``InvalidRequestError``：413 对调用方的含义是
    "东西太大，切分/压缩再试"，422 是"请求本身写错了"——下一步动作不同。
    用 ``HTTP_413_CONTENT_TOO_LARGE`` 而不是旧的 ``REQUEST_ENTITY_TOO_LARGE``：
    后者在当前 starlette 里已弃用，会在每次请求时打一条 DeprecationWarning。
    """

    code = "payload_too_large"
    http_status = status.HTTP_413_CONTENT_TOO_LARGE
    message = "上传内容超过限额"


class UpstreamError(KylabError):
    """外部依赖出错（解析节点、embedding、对话模型）。

    单列一类是因为**处置方式不同**：它几乎总是"凭据不对 / 额度用尽 / 服务抖动"，
    用户看到文案就知道该去设置页还是该重试；混进 500 里就只剩一句"服务内部错误"。
    """

    code = "upstream_error"
    http_status = status.HTTP_502_BAD_GATEWAY
    message = "外部服务调用失败"


class UnauthorizedError(KylabError):
    """未提供凭据或凭据无效。

    与 ``ForbiddenError`` 分开：401 表示"你是谁我不知道"（该去拿凭据），
    403 表示"我知道你是谁，但你不能碰这个"（凭据没错，是授权范围不够）。
    这两句给用户的下一步动作完全不同，混成一个状态码就说不清了。
    """

    code = "unauthorized"
    http_status = status.HTTP_401_UNAUTHORIZED
    message = "缺少或无效的凭据"

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message)
        # RFC 7235：401 必须带 WWW-Authenticate，否则客户端不知道该用哪种方案
        self.headers = {"WWW-Authenticate": 'Bearer realm="kylab"'}


class ForbiddenError(KylabError):
    """凭据有效，但授权范围不够（权限不足或越界访问其他知识库）。"""

    code = "forbidden"
    http_status = status.HTTP_403_FORBIDDEN
    message = "凭据权限不足"

    def __init__(
        self, message: str | None = None, *, headers: dict[str, str] | None = None
    ) -> None:
        super().__init__(message)
        self.headers = headers or {}


#: 未走领域异常的旁路（FastAPI 自带的请求校验 422、Starlette 自己的 404/405 等）
#: 也要折成同一形状，否则对接方按 ``code`` 分支会拿到 undefined。
_STATUS_TO_CODE: dict[int, str] = {
    400: "invalid_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "invalid_request",
    409: "conflict",
    413: "payload_too_large",
    422: "invalid_request",
    502: "upstream_error",
}


def _validation_message(exc: RequestValidationError) -> str:
    """把 pydantic 的第一条校验错误折成一句人话。

    默认响应体是 ``{"detail": [{"loc": [...], "msg": "..."}]}``——形状不对，
    而且前端只读 ``message``。这里取第一条并带上字段路径，够定位即可；
    不把整个数组塞进 message（那会变成一坨 JSON 文本）。
    """
    errors = exc.errors()
    if not errors:
        return InvalidRequestError.message
    first = errors[0]
    location = ".".join(str(part) for part in first.get("loc", ()) if part != "body")
    message = str(first.get("msg", InvalidRequestError.message))
    return f"{location}: {message}" if location else message


def register_exception_handlers(app: FastAPI) -> None:
    """把领域异常注册为统一的 JSON 错误响应。"""

    @app.exception_handler(KylabError)
    async def _handle_kylab_error(_: Request, exc: KylabError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.http_status,
            content={"code": exc.code, "message": exc.detail},
            headers=getattr(exc, "headers", None),
        )

    # 知识库不可用 → 503（M2 §2.2「知识库不可用的如实报错」）。
    #
    # **提供者不可用时也走它**（M3 阶段 3）：本机档的入库整条走提供者客户端，而
    # "没配 / 连不上 / 被拒"在那边一律折成 `KnowledgeBaseUnavailable`（见
    # `services/knowledge_provider.py` 的两条口径）——两个面（HTTP 端点与工具循环）
    # 共用这一个 503 信封，不另开一套错误语义。
    #
    # **惰性 import，不在模块级**：`app.storage.sqlite_impl.meta_store` 反过来 import 本模块
    # 拿 `ConflictError`（"storage → core"这个方向本来就存在），模块级 import 回去会把
    # 两边的依赖拉成双向的，而双向依赖的下一次改动就是循环 import。
    #
    # **503 而不是 500**：本机档没有知识库数据源（在 NAS 上，M3 接提供者），
    # 这是"这个部署现在没有这个能力"，不是"我们出错了"——500 会把"等 M3 / 去服务器上做"
    # 这条出路藏起来。**也不是空结果**：`Unavailable*Store` 抛异常正是为了不假装查过。
    from app.storage.split_impl import KnowledgeBaseUnavailable

    @app.exception_handler(KnowledgeBaseUnavailable)
    async def _handle_knowledge_base_unavailable(
        _: Request, exc: KnowledgeBaseUnavailable
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "code": "knowledge_base_unavailable",
                "message": str(exc) or "知识库当前不可用",
            },
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=InvalidRequestError.http_status,
            content={"code": InvalidRequestError.code, "message": _validation_message(exc)},
        )

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http_exception(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        # 覆盖 FastAPI 默认的 ``{"detail": ...}``：包括未匹配到路由的 404。
        # 状态码映射不出来的（极少）退回 internal_error，但**保留原始文案**，
        # 免得一句"服务内部错误"把真正的原因吞掉。
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "code": _STATUS_TO_CODE.get(exc.status_code, "internal_error"),
                "message": str(exc.detail),
            },
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        """**兜底：没被认领的异常也要留下完整栈**（D16，2026-09-29 实测的洞）。

        之前 500 只回一句 ``Internal Server Error``、日志里**一条 traceback 都没有** ——
        "报错但没有栈"等于没法排障（那次排查只能靠排除法，代价很大）。
        这里只补日志，响应形状与 FastAPI 默认那条保持一致，
        免得下游解析器因为换形状而二次受伤。
        """
        logger.exception("服务端未处理异常：%s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500, content={"code": "internal_error", "message": "服务端出错了"}
        )
