"""长期记忆服务（v0.14）。

镜像同构：``app/services/memory.py`` → 本文件。

这里测三件事，都是"错了会静默误导模型"的那类：

1. **关着的时候必须报错**，不能返回空——返回空会让模型以为"没有相关记忆"，
   然后基于错误前提继续推理；
2. **记住要合并去重**，否则同一件事被记很多遍，而 MEMORY.md 每轮都要注入上下文，
   越记越长等于越记越贵；
3. **召回解析要容错但不能装懂**：认不出返回结构时报错，而不是返回空列表。

用假的 runtime 而不是真配置服务：这几条都是记忆自身的逻辑，
不该依赖数据库（也就能在没有 PG 时跑起来）。``_post`` 用 monkeypatch 打桩，
不碰网络。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.exceptions import InvalidRequestError, UpstreamError
from app.services.memory import CORE_MEMORY_FILE, MemoryService, _hits_of, _normalize


class _FakeRuntime:
    """只实现 MemoryService 用到的那两个读接口。"""

    def __init__(self, values: dict[str, str]) -> None:
        self._values = values

    def get(self, key: str) -> str:
        return self._values.get(key, "")

    def get_bool(self, key: str, *, default: bool = False) -> bool:
        raw = self._values.get(key)
        if raw is None or not raw.strip():
            return default
        return raw.strip().lower() in {"1", "true", "yes", "on"}


def _service(tmp_path: Path, **values: str) -> MemoryService:
    base = {
        "memory.enabled": "true",
        "memory.base_url": "http://reme.test",
        "memory.workspace": "memory",
    }
    base.update(values)
    return MemoryService(_FakeRuntime(base), tmp_path)  # type: ignore[arg-type]


# --------------------------------------------------------------------- 关着时


def test_disabled_recall_raises_instead_of_returning_empty(tmp_path: Path) -> None:
    service = _service(tmp_path, **{"memory.enabled": "false"})

    with pytest.raises(InvalidRequestError) as excinfo:
        service.recall("随便问问")

    message = str(excinfo.value)
    assert "未启用" in message
    # 报错要说清**怎么打开**，否则用户只知道失败、不知道下一步
    assert "设置" in message


def test_disabled_remember_raises(tmp_path: Path) -> None:
    service = _service(tmp_path, **{"memory.enabled": "false"})

    with pytest.raises(InvalidRequestError):
        service.remember("用户偏好简短回答")


def test_core_text_is_empty_when_disabled_instead_of_raising(tmp_path: Path) -> None:
    """注入路径例外：它是"有就带上"，缺了不该让对话失败。"""
    service = _service(tmp_path, **{"memory.enabled": "false"})

    assert service.core_text() == ""


# --------------------------------------------------------------------- 记住


def test_remember_creates_memory_file_with_template(tmp_path: Path) -> None:
    service = _service(tmp_path)

    result = service.remember("用户偏好简短回答", tags=["偏好"])

    assert result["saved"] is True
    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert "## 核心长期记忆" in body
    assert "- 用户偏好简短回答 #偏好" in body
    # frontmatter 按 ReMe 那一族的约定留着（summary / read_when）
    assert "read_when:" in body


def test_remember_is_idempotent(tmp_path: Path) -> None:
    """同一件事记第二遍要说明"已经有了"，而不是写第二条。

    否则 MEMORY.md 会长成一串重复句，而它每轮都要注入上下文。
    """
    service = _service(tmp_path)
    service.remember("用户偏好简短回答")

    again = service.remember("用户偏好简短回答")

    assert again["saved"] is False
    assert again["entries"] == 1
    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert body.count("用户偏好简短回答") == 1


def test_remember_dedupe_ignores_added_tags(tmp_path: Path) -> None:
    """同一句话加不加标签都算同一条——标签只是筛选用，不该造成第二条记忆。"""
    service = _service(tmp_path)
    service.remember("用户偏好简短回答")

    again = service.remember("用户偏好简短回答", tags=["偏好"])

    assert again["saved"] is False


def test_remember_appends_after_existing_entries(tmp_path: Path) -> None:
    service = _service(tmp_path)
    service.remember("第一条")
    service.remember("第二条")

    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert body.index("第一条") < body.index("第二条")


def test_remember_preserves_hand_written_sections(tmp_path: Path) -> None:
    """**只重建「核心长期记忆」那一节**：其余小节可能有人手写的内容。

    重写整份文件会把它们抹掉——而用户手写过的东西被悄悄删掉是最不该发生的事。
    """
    workspace = tmp_path / "memory"
    workspace.mkdir(parents=True)
    (workspace / CORE_MEMORY_FILE).write_text(
        "---\nsummary: x\n---\n\n## 核心长期记忆\n\n- 旧条目\n\n"
        "## 工具设置\n\n- ssh 别名：dev → 192.168.1.9\n",
        encoding="utf-8",
    )
    service = _service(tmp_path)

    service.remember("新条目")

    body = (workspace / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert "- 新条目" in body and "- 旧条目" in body
    assert "ssh 别名：dev → 192.168.1.9" in body, "手写的小节被抹掉了"


def test_remember_rejects_overlong_content(tmp_path: Path) -> None:
    """超长的应该走笔记那条路：MEMORY.md 每轮都注入，撑爆它等于每轮都在付费。"""
    service = _service(tmp_path)

    with pytest.raises(InvalidRequestError) as excinfo:
        service.remember("长" * 501)

    assert "笔记" in str(excinfo.value)


def test_remember_rejects_blank_content(tmp_path: Path) -> None:
    service = _service(tmp_path)

    with pytest.raises(InvalidRequestError):
        service.remember("   ")


# --------------------------------------------------------------------- 召回


def test_recall_flattens_a_common_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = _service(tmp_path)
    hit = {"text": "用户偏好简短回答", "path": "digest/personal/a.md", "score": 0.8}
    monkeypatch.setattr(
        "app.services.memory.httpx.post",
        lambda *a, **k: _FakeResponse({"data": {"results": [hit]}}),
    )

    hits = service.recall("偏好")

    assert len(hits) == 1
    assert hits[0].text == "用户偏好简短回答"
    assert hits[0].path == "digest/personal/a.md"
    assert hits[0].score == 0.8


def test_recall_posts_to_the_job_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """接口面：ReMe 是 `POST /<job 名>`，路径由 job 名直接拼出来（设计文档 §3.1）。"""
    service = _service(tmp_path)
    seen: dict[str, object] = {}

    def fake_post(url, *, json, timeout):  # type: ignore[no-untyped-def]
        seen.update({"url": url, "json": json})
        return _FakeResponse([])

    monkeypatch.setattr("app.services.memory.httpx.post", fake_post)

    service.recall("偏好", limit=3)

    assert seen["url"] == "http://reme.test/search"
    assert seen["json"] == {"query": "偏好", "limit": 3}


def test_recall_returns_empty_only_when_the_provider_says_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """认出来了、而且确实是空的——**这才该返回空**。"""
    service = _service(tmp_path)
    monkeypatch.setattr(
        "app.services.memory.httpx.post", lambda *a, **k: _FakeResponse({"results": []})
    )

    assert service.recall("偏好") == []


def test_recall_raises_when_the_shape_is_unrecognized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """认不出结构要报错。**这条是自我审查时补的**：

    只判"列表非空却认不出"会漏掉"整个返回都不是我们认识的样子"，
    那种情况会静默返回空列表，而模型会当成"记忆里没有"。
    """
    service = _service(tmp_path)
    monkeypatch.setattr(
        "app.services.memory.httpx.post", lambda *a, **k: _FakeResponse({"unexpected": {"a": 1}})
    )

    with pytest.raises(UpstreamError) as excinfo:
        service.recall("偏好")

    assert "结构" in str(excinfo.value)


def test_recall_raises_when_the_service_is_unreachable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import httpx

    service = _service(tmp_path)

    def boom(*a, **k):  # type: ignore[no-untyped-def]
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr("app.services.memory.httpx.post", boom)

    with pytest.raises(UpstreamError) as excinfo:
        service.recall("偏好")

    assert "连不上" in str(excinfo.value)


def test_recall_clamps_the_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service = _service(tmp_path)
    seen: dict[str, object] = {}

    def fake_post(url, *, json, timeout):  # type: ignore[no-untyped-def]
        seen.update(json)
        return _FakeResponse([])

    monkeypatch.setattr("app.services.memory.httpx.post", fake_post)

    service.recall("偏好", limit=9999)

    assert seen["limit"] == 20, "上限要生效，否则会把上下文塞爆"


# --------------------------------------------------------------------- 解析单元


@pytest.mark.parametrize(
    "payload",
    [
        {"results": [{"content": "甲"}]},
        {"hits": [{"snippet": "甲"}]},
        [{"body": "甲"}],
        {"data": [{"text": "甲"}]},
    ],
)
def test_hits_accept_the_common_spellings(payload: dict) -> None:
    """字段名做容错是**刻意的**：ReMe 的响应 schema 尚未钉死。

    钉死之前宁可多认几种拼法，也不要因为字段名不同就"召回到零条"。
    但"多认几种"必须有边界——所以下面那条测试同样重要。
    """
    assert [hit.text for hit in _hits_of(payload)] == ["甲"]


def test_normalize_ignores_tags_but_not_text() -> None:
    assert _normalize("- 甲 #x") == _normalize("- 甲 #y")
    assert _normalize("- 甲") != _normalize("- 乙")


class _FakeResponse:
    def __init__(self, payload: object, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.text = str(payload)

    def json(self) -> object:
        return self._payload


# --------------------------------------------------------------------- 注入


def test_prompt_block_frames_soul_and_memory_separately(tmp_path: Path) -> None:
    """人格与记忆分开写，且**标明记忆来自过去的对话**。

    不标注来源的话模型会把记忆当成"用户这一轮说的话"——而记忆可能已经过时，
    用户当下说的才是准的。所以块里带一句"冲突时以用户当下为准"。
    """
    service = _service(tmp_path)
    service.remember("用户偏好简短回答")
    (tmp_path / "memory" / "SOUL.md").write_text("你说话直接，不寒暄。", encoding="utf-8")

    block = service.prompt_block()

    assert "SOUL.md" in block and "你说话直接" in block
    assert "MEMORY.md" in block and "用户偏好简短回答" in block
    assert "以用户当下为准" in block, "没有出处说明，模型会把它当成用户刚说的话"


def test_prompt_block_is_empty_without_files(tmp_path: Path) -> None:
    assert _service(tmp_path).prompt_block() == ""


def test_prompt_block_is_empty_when_disabled(tmp_path: Path) -> None:
    service = _service(tmp_path, **{"memory.enabled": "false"})
    (tmp_path / "memory").mkdir(parents=True)
    (tmp_path / "memory" / CORE_MEMORY_FILE).write_text("- 有内容", encoding="utf-8")

    assert service.prompt_block() == ""
