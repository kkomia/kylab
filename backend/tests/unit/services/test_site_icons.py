"""站点图标代理：白名单 / 公网校验 / 位图嗅探 / 磁盘缓存（D11-②）。

镜像同构：``app/services/site_icons.py`` → ``tests/unit/services/test_site_icons.py``。

要紧的四组：

1. **不许当跳板**：不在已知表里的域名不代为抓取；每一跳（含重定向）都过一遍
   ``web.check_public_url``（本仓唯一那处"是不是公网地址"的判断）；
2. **只收位图**：SVG 明确拒收（它和我们同源，被打开就是同源脚本执行面）；
3. **缓存**：抓一次、之后从磁盘发；失败记一段时间；过期重抓、抓不到继续用旧的；
4. **超限/超时不算图**：宁可退回字母牌，也不缓存半截 PNG。

一个外部请求都不发：抓取那一层全被替换成假的。
"""

from __future__ import annotations

import time

import httpx
import pytest

from app.core.exceptions import InvalidRequestError
from app.services import site_icons
from app.services.site_icons import (
    CACHE_MAX_FILES,
    MAX_ICON_BYTES,
    SiteIcon,
    SiteIconService,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

DOMAIN = "github.com"


@pytest.fixture
def service(tmp_path) -> SiteIconService:  # type: ignore[no-untyped-def]
    return SiteIconService(tmp_path)


@pytest.fixture
def fetched(monkeypatch) -> list[str]:  # type: ignore[no-untyped-def]
    """把"真的去抓"换成假的，返回被请求过的域名（用来断言"没抓"）。"""
    calls: list[str] = []

    def fake_fetch(self, host: str) -> SiteIcon | None:  # type: ignore[no-untyped-def]
        calls.append(host)
        return SiteIcon(content=PNG, media_type="image/png", kind="png")

    monkeypatch.setattr(SiteIconService, "_fetch", fake_fetch)
    return calls


# ------------------------------------------------------------------ 域名校验


def test_normalize_domain_lowercases_and_trims() -> None:
    assert site_icons.normalize_domain(" GitHub.com. ") == "github.com"


@pytest.mark.parametrize(
    "raw",
    [
        "https://github.com",
        "github.com/favicon.ico",
        "github.com:443",
        "git hub.com",
        "github..com",
        "",
    ],
)
def test_normalize_domain_refuses_anything_that_is_not_a_host(raw: str) -> None:
    """入参要拼进 URL，宽松解析就是把外部字符串塞进请求里。"""
    with pytest.raises(InvalidRequestError):
        site_icons.normalize_domain(raw)


def test_unknown_domain_is_refused_without_any_request(service: SiteIconService, fetched) -> None:  # type: ignore[no-untyped-def]
    """不在已知表里 → 422，而且**一次请求都不发**（别当抓取跳板）。"""
    with pytest.raises(InvalidRequestError, match="不在已知站点表"):
        service.icon("evil.example.com")
    assert fetched == []


def test_www_host_is_accepted_and_maps_to_the_bare_domain() -> None:
    """表里存的是裸域名；`www.` 这种主机也认（归到裸域名那一条）。

    （这一条原来是"`www.` 该被拒"，D11-② 支持子域之后反过来——真实结果里
    `www.` 开头的主机很常见，拒掉只会让那些站点的 logo 白白退化成字母牌。）
    """
    assert site_icons.allowed_root("www.github.com") == "github.com"


@pytest.mark.parametrize(
    ("host", "root"),
    [
        ("en.wikipedia.org", "wikipedia.org"),
        ("mp.weixin.qq.com", "weixin.qq.com"),
        ("icq.ifeng.com", "ifeng.com"),
        ("news.ycombinator.com", "ycombinator.com"),
        ("github.com", "github.com"),
    ],
)
def test_subdomains_map_to_the_table_entry(host: str, root: str) -> None:
    """真实结果里出现的是具体主机（`en.wikipedia.org` / `icq.ifeng.com`），
    归到表里的根域：同一个站点只抓一次、只缓存一份（前端那条 422 就是这么来的）。"""
    assert site_icons.allowed_root(host) == root


@pytest.mark.parametrize("host", ["notgithub.com", "github.com.evil.com", "example.com"])
def test_lookalike_hosts_are_not_matched(host: str) -> None:
    assert site_icons.allowed_root(host) is None


def test_subdomain_uses_the_same_cache_entry(service: SiteIconService, fetched) -> None:  # type: ignore[no-untyped-def]
    assert service.icon("en.wikipedia.org") is not None
    assert service.icon("zh.wikipedia.org") is not None

    assert fetched == ["wikipedia.org"], "两个语言版本只该抓一次（缓存按根域）"
    assert (service._root / "wikipedia.org.png").is_file()


# ------------------------------------------------------------------ 位图嗅探


@pytest.mark.parametrize(
    ("raw", "kind"),
    [
        (PNG, "png"),
        (b"\xff\xd8\xff\xe0" + b"\x00" * 8, "jpeg"),
        (b"GIF89a" + b"\x00" * 8, "gif"),
        (b"\x00\x00\x01\x00" + b"\x00" * 8, "ico"),
        (b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 4, "webp"),
    ],
)
def test_sniff_recognises_bitmaps(raw: bytes, kind: str) -> None:
    assert site_icons._sniff(raw) == kind


@pytest.mark.parametrize("raw", [SVG, b"<html></html>", b"", b"not an image"])
def test_sniff_refuses_everything_else(raw: bytes) -> None:
    """**SVG 明确拒收**：它和我们同源，被直接打开就是一个同源脚本执行面。"""
    assert site_icons._sniff(raw) is None


def test_svg_from_the_site_is_thrown_away(service: SiteIconService, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(SiteIconService, "_get_bytes", lambda self, url: SVG)
    assert service._fetch("github.com") is None


# ------------------------------------------------------------------ 公网校验


def test_internal_address_is_never_fetched(service: SiteIconService, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """内网地址在**发请求之前**就被拒；连接那一层根本不会被调用。"""
    called: list[str] = []
    monkeypatch.setattr(SiteIconService, "_get_bytes", lambda self, url: called.append(url) or PNG)

    def refuse(url: str) -> str:
        raise InvalidRequestError("这个地址指向本机或内网")

    monkeypatch.setattr(site_icons, "check_public_url", refuse)

    assert service._fetch_one("https://github.com/favicon.ico") is None
    assert called == []


def test_redirect_to_an_internal_address_is_dropped(service: SiteIconService, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """公网地址 302 到内网是最常见的绕过手法：**每一跳都重新校验**。

    这种候选按"没拿到"处理（不是调用方写错了），不该把 422 甩给前端。
    """
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            302, headers={"location": "http://127.0.0.1:8000/favicon.ico"}
        )
    )
    monkeypatch.setattr(site_icons, "shared_client", lambda: httpx.Client(transport=transport))

    assert service._fetch_one("https://github.com/favicon.ico") is None


def test_non_image_content_type_is_not_downloaded(service: SiteIconService, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, headers={"content-type": "text/html"}, content=b"<html>"
        )
    )
    monkeypatch.setattr(site_icons, "shared_client", lambda: httpx.Client(transport=transport))

    assert service._get_bytes("https://github.com/favicon.ico") is None


def test_oversized_icon_is_dropped_not_truncated(service: SiteIconService, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """半截 PNG 在界面上就是"图片坏了"，还会被缓存下来——宁可没有。"""
    big = PNG + b"\x00" * (MAX_ICON_BYTES + 10)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, headers={"content-type": "image/png"}, content=big)
    )
    monkeypatch.setattr(site_icons, "shared_client", lambda: httpx.Client(transport=transport))

    assert service._get_bytes("https://github.com/favicon.ico") is None


def test_bitmap_is_fetched_through_the_real_path(service: SiteIconService, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """正向：正常的 200 + image/png 一路走到 `SiteIcon`（这条走的是真 `_get_bytes`）。"""
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, headers={"content-type": "image/png"}, content=PNG)
    )
    monkeypatch.setattr(site_icons, "shared_client", lambda: httpx.Client(transport=transport))

    icon = service._fetch_one("https://github.com/favicon.ico")

    assert icon is not None
    assert (icon.kind, icon.media_type) == ("png", "image/png")
    assert icon.content == PNG


# ------------------------------------------------------------------ 磁盘缓存


def test_icon_is_fetched_once_then_served_from_disk(service: SiteIconService, fetched) -> None:  # type: ignore[no-untyped-def]
    first = service.icon(DOMAIN)
    second = service.icon(DOMAIN)

    assert first is not None and second is not None
    assert (first.content, first.media_type) == (PNG, "image/png")
    assert second.content == PNG
    assert fetched == [DOMAIN], "第二次应当直接吃磁盘缓存，不再抓"
    assert (service._root / f"{DOMAIN}.png").is_file()


def test_missing_icon_is_remembered(service: SiteIconService, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """抓不到记一段时间：否则每一次渲染都会去撞一个挂掉的站点。"""
    calls: list[str] = []

    def fake_fetch(self, host: str):  # type: ignore[no-untyped-def]
        calls.append(host)
        return None

    monkeypatch.setattr(SiteIconService, "_fetch", fake_fetch)

    assert service.icon(DOMAIN) is None
    assert service.icon(DOMAIN) is None
    assert calls == [DOMAIN]
    assert (service._root / f"{DOMAIN}.miss").is_file()


def test_expired_icon_is_refetched(service: SiteIconService, fetched, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    assert service.icon(DOMAIN) is not None
    target = service._root / f"{DOMAIN}.png"
    stale = time.time() - site_icons.CACHE_TTL_SECONDS - 60
    import os

    os.utime(target, (stale, stale))

    def jpeg(self, host: str) -> SiteIcon:  # type: ignore[no-untyped-def]
        return SiteIcon(content=b"\xff\xd8\xff\xe0newer", media_type="image/jpeg", kind="jpeg")

    monkeypatch.setattr(SiteIconService, "_fetch", jpeg)

    refreshed = service.icon(DOMAIN)

    assert refreshed is not None
    assert refreshed.kind == "jpeg"
    assert (service._root / f"{DOMAIN}.png").exists() is False, "换种类时旧文件要删掉"


def test_stale_icon_survives_a_failed_refetch(  # type: ignore[no-untyped-def]
    service: SiteIconService, fetched, monkeypatch
) -> None:
    """过期了也先留着旧的：抓失败时继续用手上那一份，比"突然没有 logo"好。"""
    assert service.icon(DOMAIN) is not None
    target = service._root / f"{DOMAIN}.png"
    stale = time.time() - site_icons.CACHE_TTL_SECONDS - 60
    import os

    os.utime(target, (stale, stale))
    monkeypatch.setattr(SiteIconService, "_fetch", lambda self, host: None)

    kept = service.icon(DOMAIN)

    assert kept is not None
    assert kept.content == PNG


def test_cache_is_capped_and_prunes_the_oldest(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """这是缓存不是档案：超了就删最旧的，删掉最多再抓一次。"""
    service = SiteIconService(tmp_path)
    service._root.mkdir(parents=True, exist_ok=True)
    import os

    for index in range(CACHE_MAX_FILES + 5):
        path = service._root / f"site{index}.com.png"
        path.write_bytes(PNG)
        stamp = time.time() - (CACHE_MAX_FILES + 5 - index)
        os.utime(path, (stamp, stamp))

    service._prune()

    left = sorted(item.name for item in service._root.iterdir())
    assert len(left) == CACHE_MAX_FILES
    assert "site0.com.png" not in left, "最旧的那几个该被删"
    assert f"site{CACHE_MAX_FILES + 4}.com.png" in left
