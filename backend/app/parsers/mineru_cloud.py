"""MinerU 云端解析（M2 T2.5）。

接口来自官方文档 <https://mineru.net/apiManage/docs>，走**标准 API**（`/api/v4`，需要 token）：

1. ``POST /file-urls/batch`` 换取签名上传地址（一次最多 50 个文件）；
2. ``PUT`` 文件本体到该地址（**不要带 Content-Type**，否则签名校验失败）；
3. ``GET /extract-results/batch/{batch_id}`` 轮询，``state=done`` 时拿到 ``full_zip_url``；
4. 下载 zip，取出其中的 Markdown 与图片。

几个必须记住的约束（踩了就报错，不是猜的）：

- 单文件 ≤ 200MB、≤ 200 页，超限由架构 §4.2 的切分器在本地先切开；
- 每日 1000 页优先额度，超了会退化为低优先级而不是直接失败；
- 鉴权失败走的是**另一套信封**（``{"success":false,"msgCode":"A0202"}``），
  业务接口才是 ``{"code":0,...}``——两套都要认，否则 401 会变成"未知错误"。

实现只依赖 ``parsers/base.py`` 的 ``ParseResult``（工程规范 §3.3 的 L3 规则）。
"""

from __future__ import annotations

import io
import logging
import time
import zipfile
from dataclasses import dataclass, field

import httpx

from app.parsers.base import ParseError, ParseResult, ParserProvider, ProbeKind, ProbeResult

__all__ = ["MinerUCloudParser", "MinerUConfig"]

logger = logging.getLogger(__name__)

#: 官方文档列出的业务错误码 → 给人看的处置建议
ERROR_HINTS: dict[str, str] = {
    "A0202": "MinerU Token 无效，请到设置页重新填写",
    "A0211": "MinerU Token 已过期（90 天不可续期），请重新申请",
    "-60005": "文件超过 200MB，需要先在本地切分",
    "-60006": "文件超过 200 页，需要先在本地切分（架构 §4.2）",
    "-60018": "MinerU 当日额度已用尽，请明天再试或改用 PaddleOCR",
    "-60010": "MinerU 解析失败，可重试或改用 PaddleOCR",
    "-60002": "MinerU 不支持该文件格式",
}

POLL_INTERVAL_SECONDS = 5.0
"""轮询间隔：官方示例用的就是 5 秒，再密没有意义、只会白耗额度。"""

POLL_DEADLINE_SECONDS = 1800.0
"""轮询总时限（30 分钟）。

**必须有这个上限**：云端任务若永远停在 ``running``（服务侧卡死、任务丢失、
网络半通），无界 ``while True`` 会让摄入线程永久阻塞——心跳继续续租，
任务永远占着队列，worker 看起来"活着"却再也消费不了别的任务。
超时按 ``ParseError`` 抛出去，让任务走正常的失败终态与重试退避。
200 页以内的文件官方通常在几分钟内完成，30 分钟足够宽松。
"""

TERMINAL_STATES = frozenset({"done", "failed"})


@dataclass(frozen=True, slots=True)
class MinerUConfig:
    """运行期配置快照（来自设置页，不来自 .env）。"""

    token: str
    endpoint: str = "https://mineru.net/api/v4"
    model_version: str = "vlm"
    timeout_seconds: float = 60.0

    @property
    def is_configured(self) -> bool:
        return bool(self.token)


@dataclass(slots=True)
class _ImageRef:
    """zip 里的图片占位：解包时统一改名、写入对象存储后再回填 Markdown。"""

    name: str
    data: bytes
    content_type: str = "image/jpeg"


@dataclass(slots=True)
class ParsedZip:
    """从 zip 里取出的产物。"""

    markdown: str
    images: list[_ImageRef] = field(default_factory=list)


class MinerUCloudParser(ParserProvider):
    """MinerU 标准 API。只处理"需要版面还原"的文档。"""

    name = "MinerUCloudParser"

    #: 自带文本层的纯文本类文件交给本地解析器，不必花云端额度
    NATIVE_SUFFIXES = (".md", ".markdown", ".txt", ".text", ".csv", ".json", ".log")

    def __init__(
        self,
        config: MinerUConfig,
        *,
        client: httpx.Client | None = None,
        poll_interval: float = POLL_INTERVAL_SECONDS,
    ) -> None:
        self._config = config
        self._client = client
        self._poll_interval = poll_interval

    @property
    def description(self) -> str:
        return f"MinerU（{self._config.model_version}）"

    # ------------------------------------------------------------------ 路由

    def supports(self, *, filename: str, mime_type: str | None, probe: ProbeResult) -> bool:
        """支持 PDF / Office / 图片；但纯文本类且探测证实有文本层时让给本地解析器。

        ``probe.kind == TEXT`` 且后缀本身可直读 → 不必上云，省额度也更快。
        """
        if not self._config.is_configured:
            return False

        lowered = (filename or "").lower()
        if lowered.endswith(self.NATIVE_SUFFIXES):
            return False

        if lowered.endswith((".pdf", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".jp2")):
            return True
        if lowered.endswith((".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx")):
            return True

        # 后缀不认识时看探测结论：明确是文字型就别上云
        return probe.kind in {ProbeKind.SCANNED, ProbeKind.MIXED}

    # ------------------------------------------------------------------ 解析

    def parse(
        self,
        *,
        content: bytes,
        filename: str,
        mime_type: str | None = None,
        probe: ProbeResult | None = None,
    ) -> ParseResult:
        if not self._config.is_configured:
            raise ParseError("MinerU 未配置 Token，请到设置页填写后再试", stage="parsing")

        client = self._client or httpx.Client(timeout=self._config.timeout_seconds)
        owns_client = self._client is None
        try:
            upload_url, batch_id = self._request_upload_url(client, filename)
            self._put_file(client, upload_url, content)
            zip_bytes = self._poll_zip(client, batch_id)
        finally:
            if owns_client:
                client.close()

        parsed = self._extract_zip(zip_bytes)
        if not parsed.markdown.strip():
            raise ParseError("MinerU 返回的 Markdown 为空", stage="parsing")

        return ParseResult(
            markdown=parsed.markdown,
            parser_name=self.name,
            page_count=probe.page_count if probe else None,
            probe=probe,
            image_ids=[image.name for image in parsed.images],
        )

    # ------------------------------------------------------------------ 步骤

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._config.token}"}

    def _request_upload_url(self, client: httpx.Client, filename: str) -> tuple[str, str]:
        response = client.post(
            f"{self._config.endpoint}/file-urls/batch",
            headers={**self._headers(), "Content-Type": "application/json"},
            json={
                "files": [{"name": filename or "document.pdf"}],
                "model_version": self._config.model_version,
            },
        )
        data = _unwrap(response, action="申请上传地址")
        try:
            return data["file_urls"][0], data["batch_id"]
        except (KeyError, IndexError) as exc:
            raise ParseError(f"MinerU 上传地址响应缺少字段：{exc}", stage="parsing") from exc

    def _put_file(self, client: httpx.Client, upload_url: str, content: bytes) -> None:
        # 关键：不要设置 Content-Type，MinerU 的签名校验会因此失败
        response = client.put(upload_url, content=content)
        if response.status_code not in (200, 201, 204):
            raise ParseError(
                f"MinerU 文件上传失败（HTTP {response.status_code}）", stage="parsing"
            )

    def _poll_zip(self, client: httpx.Client, batch_id: str) -> bytes:
        url = f"{self._config.endpoint}/extract-results/batch/{batch_id}"
        deadline = time.monotonic() + POLL_DEADLINE_SECONDS
        while True:
            response = client.get(url, headers=self._headers())
            data = _unwrap(response, action="查询解析结果")
            results = data.get("extract_result") or []
            if not results:
                raise ParseError("MinerU 未返回解析结果", stage="parsing")

            item = results[0]
            state = item.get("state")
            if state == "done":
                zip_url = item.get("full_zip_url")
                if not zip_url:
                    raise ParseError("MinerU 标记完成但未给出结果包地址", stage="parsing")
                download = client.get(zip_url)
                if download.status_code != 200:
                    raise ParseError(
                        f"MinerU 结果包下载失败（HTTP {download.status_code}）", stage="parsing"
                    )
                return download.content
            if state == "failed":
                raise ParseError(
                    f"MinerU 解析失败：{item.get('err_msg') or '未提供原因'}", stage="parsing"
                )
            if time.monotonic() >= deadline:
                # 不 raise 到调用方之外：让任务按正常失败路径退避重试
                raise ParseError(
                    f"MinerU 解析超过 {POLL_DEADLINE_SECONDS / 60:.0f} 分钟仍未完成"
                    f"（当前状态：{state or '未知'}），已放弃等待",
                    stage="parsing",
                )
            time.sleep(self._poll_interval)

    def _extract_zip(self, payload: bytes) -> ParsedZip:
        """取出 Markdown 与图片。

        zip 里的图片以相对路径出现在 Markdown 中（``images/xxx.jpg``），
        这里改成 ``images/<文件名>`` 这样的**可预测名字**，由调用方写入对象存储后
        再把 Markdown 里的链接换成图片 ID —— 解析器不碰存储（分层纪律）。
        """
        try:
            archive = zipfile.ZipFile(io.BytesIO(payload))
        except zipfile.BadZipFile as exc:
            raise ParseError(f"MinerU 结果包不是有效 zip：{exc}", stage="parsing") from exc

        with archive:
            names = archive.namelist()
            markdown_name = next((n for n in names if n.lower().endswith(".md")), None)
            if markdown_name is None:
                raise ParseError("MinerU 结果包里没有 Markdown 文件", stage="parsing")

            images = [
                _ImageRef(name=name.rsplit("/", 1)[-1], data=archive.read(name))
                for name in names
                if name.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".bmp"))
            ]
            return ParsedZip(
                markdown=archive.read(markdown_name).decode("utf-8", errors="replace"),
                images=images,
            )


def _unwrap(response: httpx.Response, *, action: str) -> dict:
    """剥掉 MinerU 的两套信封，失败时给出**可处置**的错误。

    业务接口：``{"code":0,"data":{...}}``；
    鉴权网关：``{"success":false,"msgCode":"A0202","msg":"..."}``。
    """
    try:
        body = response.json()
    except ValueError as exc:
        raise ParseError(
            f"MinerU {action}失败（HTTP {response.status_code}，响应不是 JSON）", stage="parsing"
        ) from exc

    if response.status_code == 401 or body.get("success") is False:
        code = str(body.get("msgCode") or body.get("code") or "")
        hint = ERROR_HINTS.get(code, body.get("msg") or "鉴权失败")
        raise ParseError(f"MinerU {action}失败：{hint}", stage="parsing")

    code = body.get("code")
    if code not in (0, None):
        hint = ERROR_HINTS.get(str(code), body.get("msg") or "未提供原因")
        raise ParseError(f"MinerU {action}失败（{code}）：{hint}", stage="parsing")

    data = body.get("data")
    if not isinstance(data, dict):
        raise ParseError(f"MinerU {action}响应缺少 data 字段", stage="parsing")
    return data
