"""站点图标代理（D11-②，2026-09-29 用户："网页 logo 要显示站点**真实的** logo"）。

**为什么要经过我们的后端，而不是让浏览器去 `https://<域名>/favicon.ico`**：

1. **隐私**：浏览器直连等于在用户渲染这一行时，把他的 IP / UA / 访问时刻交给那家站点——
   而用户只是问了一句话。经过后端之后，向第三方发请求的是**服务器**，浏览器只跟我们自己的源说话；
2. **稳定与离线**：图标落盘缓存，之后一直从本地发。第三方站点慢 / 挂 / 改 robots，
   都不会让这一行变慢或闪；
3. **一次抓好、多处复用**：同一个站点在好几个步骤、好几条会话里出现，只抓一次。

**边界（每条都有用例钉着）**：

- 只允许 ``ALLOWED_DOMAINS`` 里的域名**及其子域**（`en.wikipedia.org`、`mp.weixin.qq.com`
  都归到表里的根域；与前端 ``model/webSites.ts`` 的已知站点表同一份：两处漂了只会退化成
  字母牌，不会出错，但也别让它们漂）；
- **每个候选地址都过** ``web.check_public_url``（本仓唯一那处"是不是公网地址"的判断）——
  这条接口收的是用户数据里来的域名，绝不能让内网地址借它当跳板（SSRF）；
- 只接受**位图**（png / jpeg / gif / ico / webp，按魔数嗅探）：**SVG 明确拒收**——
  它和我们同源，被打开就是一个同源脚本执行面（会话令牌就在 localStorage 里）；
- 体积上限、缓存条数上限、正负缓存都有 TTL；取不到就**没有图标**（前端退回字母牌），
  不抛给用户、不在页面上留空位。
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.core.exceptions import InvalidRequestError
from app.core.http import shared_client
from app.services.web import check_public_url

__all__ = ["ALLOWED_DOMAINS", "SiteIcon", "SiteIconService", "allowed_root", "normalize_domain"]

logger = logging.getLogger(__name__)

#: 允许取图标的站点。**与前端 `frontend/src/features/chat/model/webSites.ts` 那张表同一份**：
#: 那边决定"显示成什么"，这边决定"允许抓谁"。两边漂了的后果只是退化成字母牌（不报错），
#: 所以按"两张表要一起动"的纪律维护。
ALLOWED_DOMAINS: frozenset[str] = frozenset(
    {
        # 代码 / 学术 / 百科
        "github.com",
        "gitlab.com",
        "gitee.com",
        "stackoverflow.com",
        "developer.mozilla.org",
        "npmjs.com",
        "python.org",
        "nodejs.org",
        "react.dev",
        "arxiv.org",
        "wikipedia.org",
        "nature.com",
        "sciencedirect.com",
        "ieee.org",
        "acm.org",
        "springer.com",
        "jstor.org",
        # AI / 厂商官方
        "openai.com",
        "anthropic.com",
        "huggingface.co",
        # 常见中文站点
        "zhihu.com",
        "baidu.com",
        "juejin.cn",
        "csdn.net",
        "cnblogs.com",
        "segmentfault.com",
        "infoq.cn",
        "sspai.com",
        "36kr.com",
        "bilibili.com",
        "weixin.qq.com",
        "qq.com",
        "163.com",
        "sina.com.cn",
        "sohu.com",
        "ifeng.com",
        "people.com.cn",
        "xinhuanet.com",
        "thepaper.cn",
        "caixin.com",
        # 英文社区 / 媒体
        "medium.com",
        "reddit.com",
        "ycombinator.com",
    }
)

#: 依次试的路径。**apple-touch-icon 在前**：它是给"放到主屏"用的 180×180 实心图标，
#: 看起来才是 logo；`favicon.ico` 常见 16×16 或多尺寸打包，缩到 14px 时常常糊成一团。
ICON_PATHS: tuple[str, ...] = ("/apple-touch-icon.png", "/favicon.ico")

#: 白名单**按长度倒序**：子域要归到最具体的那一条（`developer.mozilla.org` 先于 `mozilla.org`）。
_ALLOWED_SORTED: tuple[str, ...] = tuple(sorted(ALLOWED_DOMAINS, key=len, reverse=True))


def allowed_root(host: str) -> str | None:
    """把主机名归到白名单里的那一条；不在表里就回 ``None``。

    **接受子域**（`en.wikipedia.org` → `wikipedia.org`、`icq.ifeng.com` → `ifeng.com`）：
    前端是从网址里取域名的（`webSites.ts` 也是后缀匹配），真实结果里出现的是
    `mp.weixin.qq.com`、`en.wikipedia.org` 这种具体主机。归到根域之后，
    同一个站点的图标只抓一次、只缓存一份。
    """
    for key in _ALLOWED_SORTED:
        if host == key or host.endswith(f".{key}"):
            return key
    return None

#: 允许的位图种类 → 服务时用的 media type。**没有 svg**（理由见模块说明）。
_KINDS: dict[str, str] = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "ico": "image/x-icon",
    "webp": "image/webp",
}

#: 单个图标的字节上限。真实的 touch icon 在 10–80KB，256KB 已经宽裕。
MAX_ICON_BYTES = 256 * 1024

#: 目录里最多留多少个图标文件（正 + 负缓存一起算）。超了删最旧的。
CACHE_MAX_FILES = 200

#: 图标缓存多久算过期（秒）。图标是低频变化的东西，30 天够了；
#: 过期后**重新抓一次**，抓不到就继续用旧的（见 `icon`）。
CACHE_TTL_SECONDS = 30 * 24 * 3600

#: "这个站点抓不到"记多久（秒）。不记的话每次渲染都会去撞一个挂掉的站点。
MISS_TTL_SECONDS = 6 * 3600

#: 单个候选地址的墙钟上限（秒）。图标是最不重要的东西，不值得让页面等它。
FETCH_TIMEOUT_SECONDS = 6.0

#: 跟几跳。与 `services/web` 同一套纪律：**每一跳都重新校验地址**。
_MAX_REDIRECTS = 3

_USER_AGENT = "kylab/0.1 (+site icon)"

#: 前缀。放在 `<data_dir>/site-icons/` 下，与 skills / plugins / workspaces 同一层。
DIRNAME = "site-icons"


def normalize_domain(raw: str) -> str:
    """把入参收拾成可比对的域名：小写、去尾部点。**不做后缀匹配**（那是前端的事）。

    只接受"看着像域名"的字符串：大写字母、空格、斜杠、带协议的一律拒绝——
    这个参数会拼进 URL，宽松解析就是把外部字符串塞进请求里。
    """
    domain = (raw or "").strip().lower().rstrip(".")
    if not domain:
        raise InvalidRequestError("缺少参数：domain")
    if "/" in domain or ":" in domain or " " in domain:
        raise InvalidRequestError(f"domain 只能是域名：{raw}")
    if not all(part and part.replace("-", "").isalnum() for part in domain.split(".")):
        raise InvalidRequestError(f"domain 只能是域名：{raw}")
    return domain


@dataclass(frozen=True, slots=True)
class SiteIcon:
    """一枚可以直接发出去的图标。"""

    content: bytes
    media_type: str
    kind: str


class SiteIconService:
    """带磁盘缓存的站点图标抓取。

    **无状态**（除了根目录）：缓存全在磁盘上，所以每个请求 new 一个也不心疼，
    不必在组合根里占一个字段（见 `api/v1/site_icons.py` 的说明）。
    """

    def __init__(self, data_dir: Path, *, timeout: float = FETCH_TIMEOUT_SECONDS) -> None:
        self._root = Path(data_dir) / DIRNAME
        self._timeout = timeout

    # ------------------------------------------------------------------ 读

    def icon(self, domain: str) -> SiteIcon | None:
        """取一枚图标；**不在允许表里（含子域）就抛 422**，在表里但取不到就回 ``None``。

        为什么把这两种分开：前者是"这个接口就不该被这样调"（写错了 / 在探），
        后者是"这个站点暂时没有图标"（正常的降级路径）。前端两种都退回字母牌。

        子域归到白名单里的根域（见 `allowed_root`），**缓存也按根域存**：
        `en.wikipedia.org` 与 `zh.wikipedia.org` 用的是同一枚维基图标。
        """
        host = normalize_domain(domain)
        root = allowed_root(host)
        if root is None:
            raise InvalidRequestError(
                f"不在已知站点表里，不代为抓取：{host}。"
                "（这张表与前端 model/webSites.ts 同一份口径）"
            )

        cached = self._read_cached(root, ttl=CACHE_TTL_SECONDS)
        if cached is not None:
            return cached
        if self._miss_is_fresh(root):
            return None
        # 过期了也先留着旧的：抓失败时继续用手上这一份，比"突然没有 logo"好
        stale = self._read_cached(root, ttl=None)

        fetched = self._fetch(root)
        if fetched is None:
            self._note_miss(root)
            return stale
        self._store(root, fetched)
        return fetched

    def _read_cached(self, host: str, *, ttl: int | None) -> SiteIcon | None:
        path = self._find_cached(host)
        if path is None:
            return None
        if ttl is not None and time.time() - path.stat().st_mtime > ttl:
            return None
        kind = path.suffix.lstrip(".")
        try:
            return SiteIcon(content=path.read_bytes(), media_type=_KINDS[kind], kind=kind)
        except (OSError, KeyError):
            logger.warning("读图标缓存失败：%s", path, exc_info=True)
            return None

    def _find_cached(self, host: str) -> Path | None:
        for kind in _KINDS:
            candidate = self._root / f"{host}.{kind}"
            if candidate.is_file():
                return candidate
        return None

    def _miss_is_fresh(self, host: str) -> bool:
        marker = self._root / f"{host}.miss"
        if not marker.is_file():
            return False
        return time.time() - marker.stat().st_mtime <= MISS_TTL_SECONDS

    def _note_miss(self, host: str) -> None:
        try:
            self._root.mkdir(parents=True, exist_ok=True)
            (self._root / f"{host}.miss").write_bytes(b"")
            # 抓到图标之后这个标记就没意义了：读到图标时顺手清掉，免得它一直躺在那里
            self._prune()
        except OSError:
            logger.warning("写图标缺失标记失败：%s", host, exc_info=True)

    def _store(self, host: str, icon: SiteIcon) -> None:
        try:
            self._root.mkdir(parents=True, exist_ok=True)
            target = self._root / f"{host}.{icon.kind}"
            # 先写临时文件再改名：另一个请求正好读到半截文件时不会拿到坏字节
            temp = target.with_suffix(f".{icon.kind}.part")
            temp.write_bytes(icon.content)
            temp.replace(target)
            (self._root / f"{host}.miss").unlink(missing_ok=True)
            # 换了种类（比如原来缓存的是 ico、这次拿到 png）时把旧的删掉，免得两份都在
            for kind in _KINDS:
                if kind != icon.kind:
                    (self._root / f"{host}.{kind}").unlink(missing_ok=True)
            self._prune()
        except OSError:
            logger.warning("写图标缓存失败：%s", host, exc_info=True)

    def _prune(self) -> None:
        """条数上限：超了删最旧的。**这是缓存不是档案**，删掉最多再抓一次。"""
        try:
            files = sorted(self._root.iterdir(), key=lambda item: item.stat().st_mtime)
        except OSError:
            return
        for item in files[: max(0, len(files) - CACHE_MAX_FILES)]:
            try:
                item.unlink()
            except OSError:
                logger.debug("清理图标缓存失败：%s", item, exc_info=True)

    # ------------------------------------------------------------------ 抓

    def _fetch(self, host: str) -> SiteIcon | None:
        """按候选路径依次抓；第一个拿到合格位图的就用它。"""
        for path in ICON_PATHS:
            for candidate_host in (host, f"www.{host}"):
                icon = self._fetch_one(f"https://{candidate_host}{path}")
                if icon is not None:
                    return icon
        return None

    def _fetch_one(self, url: str) -> SiteIcon | None:
        try:
            target = check_public_url(url)
        except InvalidRequestError:
            logger.info("站点图标候选地址不是公网地址，跳过：%s", url)
            return None
        try:
            raw = self._get_bytes(target)
        except (httpx.HTTPError, OSError) as exc:
            logger.info("站点图标抓取失败（%s）：%s", url, exc)
            return None
        except InvalidRequestError:
            # 初始地址是公网的，但**某一跳重定向到了内网**：`_get_bytes` 每一跳都重新校验，
            # 这种候选按"没拿到"处理（不是调用方写错了），继续试下一个候选
            logger.info("站点图标的某一跳跳到了非公网地址，跳过：%s", url)
            return None
        if raw is None:
            return None
        kind = _sniff(raw)
        if kind is None:
            logger.info("站点图标不是认识的位图，丢弃：%s", url)
            return None
        return SiteIcon(content=raw, media_type=_KINDS[kind], kind=kind)

    def _get_bytes(self, target: str) -> bytes | None:
        """取字节，**手工跟重定向、每一跳重新校验**（与 `services/web` 同一套纪律）。

        与那一处的区别只有两点：这里要的是**字节**（不是解码后的正文），
        以及**只收位图**（`content-type` 不像图片就直接放弃，不必等它下完）。

        **超限与超时都回 ``None`` 而不是半截字节**：一个被截断的 PNG 在界面上就是
        "图片坏了"，比干脆退回字母牌难看得多，也更难查（服务端还把它缓存下来了）。
        """
        deadline = time.monotonic() + self._timeout
        current = target
        for _ in range(_MAX_REDIRECTS + 1):
            with shared_client().stream(
                "GET", current, headers={"User-Agent": _USER_AGENT}, timeout=self._timeout
            ) as response:
                if response.is_redirect:
                    location = response.headers.get("location") or ""
                    if not location:
                        return None
                    current = check_public_url(str(httpx.URL(current).join(location)))
                    continue
                if response.status_code >= 400:
                    return None
                declared = (response.headers.get("content-type") or "").lower()
                if declared and not declared.startswith("image/"):
                    return None
                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_bytes():
                    chunks.append(chunk)
                    total += len(chunk)
                    if total >= MAX_ICON_BYTES:
                        logger.info("站点图标超过 %d 字节，放弃：%s", MAX_ICON_BYTES, current)
                        return None
                    if time.monotonic() > deadline:
                        logger.info("站点图标读取超时，放弃：%s", current)
                        return None
                return b"".join(chunks)
        return None


def _sniff(raw: bytes) -> str | None:
    """按魔数认位图；认不出来就是 ``None``（**不信 content-type**：那是第三方说了算的）。"""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if raw.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if raw.startswith(b"\x00\x00\x01\x00"):
        return "ico"
    if len(raw) > 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None
