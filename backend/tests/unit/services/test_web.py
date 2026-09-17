"""联网（v0.22）。

镜像同构：``app/services/web.py`` → 本文件。

**这一组的重点是"挡得住"**：URL 是**模型给的**，而模型可能正被一段网页内容牵着走
（提示注入的目标往往就是"让它去访问某个地址"）。所以内网、本机、云元数据地址
必须挡在发请求之前——**不是挡在拿到结果之后**，那时候请求已经发出去了。

抓取与搜索的结果解析用 respx 造响应（不打真网络）：这一层要测的是"我们怎么处理
各种返回"，而不是"某个站点今天在不在"。
"""

from __future__ import annotations

import httpx
import pytest
import respx

from app.core.exceptions import InvalidRequestError, UpstreamError
from app.services import web

# ------------------------------------------------------------------ 内网与协议


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000/api/v1/health",  # 本机（KYLAB 自己）
        "http://localhost/admin",  # 同一件事，另一个写法
        "http://192.168.31.18:54321/",  # 局域网里的 PG
        "http://10.0.0.5/",  # 私有段
        "http://172.16.0.1/",  # 私有段
        "http://169.254.169.254/latest/meta-data/",  # 云厂商元数据（凭据）
        "http://[::1]/",  # IPv6 环回
        "http://0.0.0.0/",
    ],
)
def test_private_and_local_addresses_are_refused(url: str) -> None:
    """内网地址一律拒绝。

    这不是"严谨一点"的事：这台机器上有 PG、MinIO 与 KYLAB 自己的管理接口，
    放行一个 `http://127.0.0.1:8000/api/v1/...` 就等于给了模型一个
    "以本地可信身份调用内部接口"的能力。
    """
    with pytest.raises(InvalidRequestError, match=r"内网|本机"):
        web.check_public_url(url)


def test_only_http_and_https() -> None:
    """``file://`` 是任意文件读取，其它协议更没边。"""
    for url in ("file:///etc/passwd", "ftp://example.com/x", "data:text/html,x"):
        with pytest.raises(InvalidRequestError, match="只支持 http/https"):
            web.check_public_url(url)


def test_missing_host_is_refused() -> None:
    with pytest.raises(InvalidRequestError, match="没有主机名"):
        web.check_public_url("http:///path")


def test_public_hosts_pass() -> None:
    assert web.check_public_url("https://example.com/a?b=1") == "https://example.com/a?b=1"


def test_a_domain_resolving_to_both_public_and_private_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """一个域名解析出多个地址时，**全都得是公网**。

    只查第一个的话，攻击者把内网地址放在第二条 A 记录上就能过。
    """

    def fake_getaddrinfo(host, port):  # type: ignore[no-untyped-def]
        return [
            (2, 1, 6, "", ("93.184.216.34", 0)),
            (2, 1, 6, "", ("127.0.0.1", 0)),
        ]

    monkeypatch.setattr(web.socket, "getaddrinfo", fake_getaddrinfo)

    with pytest.raises(InvalidRequestError, match=r"内网|本机"):
        web.check_public_url("https://sneaky.example.com/")


def test_unresolvable_host_is_left_to_the_request(monkeypatch: pytest.MonkeyPatch) -> None:
    """解析不出来 ≠ 内网：**不要**把它说成「内网地址」。

    断网时把所有域名都判成内网，用户看到的是一句完全对不上原因的话，
    而真正的原因（没有网）被藏起来了。交给请求去失败，那时错误更准。
    """

    def boom(host, port):  # type: ignore[no-untyped-def]
        raise web.socket.gaierror("name resolution failed")

    monkeypatch.setattr(web.socket, "getaddrinfo", boom)

    assert web.check_public_url("https://nope.invalid/") == "https://nope.invalid/"


# ------------------------------------------------------------------ 抓取


def _html(title: str, body: str) -> str:
    return (
        f"<html><head><title>{title}</title></head><body>"
        f"<nav><a href='/'>首页</a><a href='/a'>关于</a></nav>"
        f"<article><h1>{title}</h1><p>{body}</p></article>"
        f"<footer>版权所有</footer></body></html>"
    )


@respx.mock
def test_fetch_extracts_article_and_title() -> None:
    """抓回来的应当是**正文**（Markdown），而不是整页 HTML 带导航与页脚。"""
    respx.get("https://news.example.com/a").mock(
        return_value=httpx.Response(
            200, html=_html("今日要闻", "第一段正文。"), headers={"content-type": "text/html"}
        )
    )

    title, body = web.fetch_url("https://news.example.com/a")

    assert title == "今日要闻"
    assert "第一段正文" in body
    assert "版权所有" not in body, "页脚不该进正文"
    assert "<p>" not in body, "应当是 Markdown 而不是 HTML"


@respx.mock
def test_fetch_follows_redirects_but_checks_every_hop() -> None:
    """**重定向要跟，但每一跳都重新校验**。

    公网地址 302 到 `http://127.0.0.1:8000` 是绕过内网检查最常用的手法——
    用 ``follow_redirects=True`` 就没有"每一跳"这个位置可以检查。
    """
    respx.get("https://news.example.com/go").mock(
        return_value=httpx.Response(302, headers={"location": "http://127.0.0.1:8000/secret"})
    )

    with pytest.raises(InvalidRequestError, match=r"内网|本机"):
        web.fetch_url("https://news.example.com/go")


@respx.mock
def test_fetch_records_the_final_url() -> None:
    """出处要给**最终地址**：跳转之后的那一页才是读到的那一页。"""
    respx.get("https://short.example.com/x").mock(
        return_value=httpx.Response(301, headers={"location": "https://real.example.com/final"})
    )
    respx.get("https://real.example.com/final").mock(
        return_value=httpx.Response(
            200, html=_html("真正的页面", "内容在此。"), headers={"content-type": "text/html"}
        )
    )

    title, body = web.fetch_url("https://short.example.com/x")

    assert title == "真正的页面" and "内容在此" in body


@respx.mock
def test_fetch_refuses_non_textual_content() -> None:
    """图片、压缩包不是"网页正文"：解码出来的东西毫无意义。"""
    respx.get("https://files.example.com/a.zip").mock(
        return_value=httpx.Response(
            200, content=b"PK\x03\x04", headers={"content-type": "application/zip"}
        )
    )

    with pytest.raises(UpstreamError, match="不是网页正文"):
        web.fetch_url("https://files.example.com/a.zip")


@respx.mock
def test_fetch_reports_http_errors_and_too_many_redirects() -> None:
    respx.get("https://news.example.com/404").mock(return_value=httpx.Response(404))
    with pytest.raises(UpstreamError, match="HTTP 404"):
        web.fetch_url("https://news.example.com/404")

    respx.get("https://loop.example.com/").mock(
        return_value=httpx.Response(302, headers={"location": "https://loop.example.com/"})
    )
    with pytest.raises(UpstreamError, match="重定向次数过多"):
        web.fetch_url("https://loop.example.com/")


@respx.mock
def test_fetch_truncates_long_pages_and_says_so() -> None:
    """超长正文截断**并说明**：悄悄截断会让模型以为文章就那么长。"""
    long_text = "字" * (web.MAX_FETCH_CHARS + 500)
    respx.get("https://news.example.com/long").mock(
        return_value=httpx.Response(
            200, html=_html("长文", long_text), headers={"content-type": "text/html"}
        )
    )

    _title, body = web.fetch_url("https://news.example.com/long")

    assert "已截断" in body
    assert len(body) < web.MAX_FETCH_CHARS + 200


# ------------------------------------------------------------------ 搜索


@respx.mock
def test_search_parses_tavily_shape() -> None:
    respx.post("https://api.tavily.com/search").mock(
        return_value=httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "某条新闻",
                        "url": "https://news.example.com/a",
                        "content": "摘要内容",
                        "published_date": "2026-09-17",
                    }
                ]
            },
        )
    )

    hits = web.search_web("今天的新闻", api_key="key-1", provider="tavily", limit=3)

    assert [hit.url for hit in hits] == ["https://news.example.com/a"]
    assert hits[0].title == "某条新闻" and hits[0].snippet == "摘要内容"


@respx.mock
def test_search_parses_bocha_shape() -> None:
    """另一家的形状不同（``data.webPages.value``）——两家都要认。"""
    respx.post("https://api.bochaai.com/v1/web-search").mock(
        return_value=httpx.Response(
            200,
            json={"data": {"webPages": {"value": [{"name": "标题", "url": "https://x.example.com"}]}}},
        )
    )

    hits = web.search_web("新闻", api_key="key-1", provider="bocha")

    assert hits and hits[0].url == "https://x.example.com"


def test_search_without_a_key_says_where_to_configure_it() -> None:
    """**没配密钥要说清去哪配**，不是返回空结果。

    空结果会被模型读成"网上没有这件事"——那是比报错坏得多的一种失败。
    """
    with pytest.raises(InvalidRequestError) as excinfo:
        web.search_web("新闻", api_key="")

    message = str(excinfo.value)
    assert "设置" in message and "Tavily" in message
    assert "web_fetch" in message, "顺带告诉它还有不需要密钥的那条路"


def test_search_rejects_unknown_provider() -> None:
    with pytest.raises(InvalidRequestError, match="不认识的搜索供应商"):
        web.search_web("新闻", api_key="k", provider="google")


@respx.mock
def test_search_reports_quota_and_auth_errors_with_the_body() -> None:
    """401 是密钥错、429 是额度：模型改不了，但**用户能**——所以话要说全。"""
    respx.post("https://api.tavily.com/search").mock(
        return_value=httpx.Response(429, text="rate limit exceeded")
    )

    with pytest.raises(UpstreamError) as excinfo:
        web.search_web("新闻", api_key="k")

    assert "429" in str(excinfo.value) and "rate limit" in str(excinfo.value)


@respx.mock
def test_search_unknown_shape_returns_empty_not_an_error() -> None:
    """认不出结构时回空列表（与记忆层相反）：对模型的下一步来说，
    "没搜到"与"格式变了"要做的事一样（换个词再搜），而抛错会把整轮打断。"""
    respx.post("https://api.tavily.com/search").mock(
        return_value=httpx.Response(200, json={"unexpected": True})
    )

    assert web.search_web("新闻", api_key="k") == []
