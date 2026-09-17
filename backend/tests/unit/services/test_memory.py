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
from app.services.memory import (
    AGENTS_FILE,
    CORE_MEMORY_FILE,
    PROFILE_FILE,
    SOUL_FILE,
    MemoryService,
    _hits_of,
    _normalize,
)


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

    def get_int(self, key: str) -> int:
        """与真实实现同一口径：解析不了返回 0，由调用方回落到默认值。

        替身的形状**必须和真的一样**，否则测的是替身的行为、不是产品的——
        这条在别处踩过（假的 `Msg` 少一个字段，于是"测试绿、真调用崩"）。
        """
        try:
            return int(self.get(key))
        except ValueError:
            return 0


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

    hits, _links = service.recall("偏好")

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

    hits, links = service.recall("偏好")
    assert hits == [] and links == []


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


def test_prompt_block_still_works_when_disabled(tmp_path: Path) -> None:
    """**关掉记忆服务，文件照旧注入**（这条原先断言的是相反的行为）。

    那个开关管的是"过去的对话会不会被召回、会不会自动沉淀"，而
    `MEMORY.md` / `SOUL.md` 是磁盘上的普通文件——`memory_files` 的模块头
    自己就写着"看自己的文本文件不该先要求另一个进程活着"。

    实测逼出来的：用户的实例上记忆服务是关的，于是人设既不播种也不注入，
    整个功能是死的，界面上还写着"没启用"。
    """
    service = _service(tmp_path, **{"memory.enabled": "false"})
    (tmp_path / "memory").mkdir(parents=True)
    (tmp_path / "memory" / CORE_MEMORY_FILE).write_text("- 有内容", encoding="utf-8")

    block = service.prompt_block()

    assert "有内容" in block
    assert "长期记忆" in block


# ----------------------------------------------------- 真实返回（从活服务抓的）

#: 这条不是编的：把 ReMe 真跑起来、写两份记忆文件、调 POST /search 拿到的**原始返回**。
#: 第一版的容错解析会在这份数据上直接报"认不出结构"——分数在 scores.score 里、
#: 结果列表在 metadata.results 里，两个位置当时都猜错了。
REAL_SEARCH_RESPONSE = {
    "answer": "========== digest/wiki/锂价敏感性.md:5-9 [score=2.7236] ==========\n…",
    "success": True,
    "metadata": {
        "results": [
            {
                "id": "f2343cef20b6",
                # 原文照抄、不折行：这是服务的真实输出，改了就不再是"实测证据"了
                "text": "## 当前判断\n\n锂价下跌通常缓解材料成本，但净影响取决于售价联动速度与高價庫存减值。",  # noqa: E501
                "metadata": {},
                "path": "digest/wiki/锂价敏感性.md",
                "start_line": 5,
                "end_line": 9,
                "scores": {"keyword": 2.7236328125, "score": 2.7236328125},
            },
            {
                "id": "ca3bea6afb29",
                "text": "# 碳酸锂\n\n需求从整车销量传导到电池排产，再影响碳酸锂需求。",
                "metadata": {},
                "path": "digest/wiki/碳酸锂.md",
                "start_line": 5,
                "end_line": 8,
                "scores": {"keyword": 0.6965709328651428, "score": 0.6965709328651428},
            },
        ],
        "link_expansion": {
            "digest/wiki/锂价敏感性.md": {
                "outlinks": [
                    {
                        "path": "digest/wiki/碳酸锂.md",
                        "meta": {"name": "碳酸锂", "description": "电池上游关键原料。"},
                        "anchors": [],
                    }
                ],
                "inlinks": [],
            },
            "digest/wiki/碳酸锂.md": {
                "outlinks": [],
                "inlinks": [{"path": "digest/wiki/锂价敏感性.md", "meta": {"name": "锂价敏感性"}}],
            },
        },
    },
}


def test_hits_match_the_real_service_response() -> None:
    hits = _hits_of(REAL_SEARCH_RESPONSE)

    assert [hit.path for hit in hits] == ["digest/wiki/锂价敏感性.md", "digest/wiki/碳酸锂.md"]
    first = hits[0]
    assert first.text.startswith("## 当前判断")
    # 分数在 scores.score 里；行号是"渐进式展开"的入口
    assert first.score == pytest.approx(2.7236, rel=1e-3)
    assert (first.start_line, first.end_line) == (5, 9)


def test_links_match_the_real_service_response() -> None:
    from app.services.memory import _links_of

    links = _links_of(REAL_SEARCH_RESPONSE)

    pairs = {(item.path, item.direction) for item in links}
    assert ("digest/wiki/碳酸锂.md", "out") in pairs
    assert ("digest/wiki/锂价敏感性.md", "in") in pairs
    assert next(item for item in links if item.direction == "out").name == "碳酸锂"


# --------------------------------------------------------------------- 捕获


def test_capture_sends_messages_and_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """捕获的请求体：``messages``（每条要 role / name / content）+ ``session_id``。

    ``name`` 是实测踩出来的：ReMe 那侧收的是 agentscope 的 ``Msg``，
    缺 ``name`` 会被它自己的校验拒掉（报 ``1 validation error for Msg``）。
    """
    service = _service(tmp_path)
    seen: dict[str, object] = {}

    def fake_post(url, *, json, timeout):  # type: ignore[no-untyped-def]
        seen.update({"url": url, "json": json})
        return _FakeResponse({"success": True, "answer": "记下了", "metadata": {"created": True}})

    monkeypatch.setattr("app.services.memory.httpx.post", fake_post)

    result = service.capture(
        [
            {"role": "user", "name": "用户", "content": "以后简短点"},
            {"role": "assistant", "name": "助手", "content": "好"},
        ],
        session_id="conv_1",
    )

    assert seen["url"] == "http://reme.test/auto_memory"
    assert seen["json"]["session_id"] == "conv_1"
    assert len(seen["json"]["messages"]) == 2
    assert result["created"] is True
    assert result["summary"] == "记下了"


def test_capture_rejects_messages_without_a_name(tmp_path: Path) -> None:
    """缺 ``name`` 要在**我们这边**就拦住：不然错误会以"记忆服务 422"的形式出现，
    而真正的原因（谁说的没给）藏在它的校验信息里。"""
    service = _service(tmp_path)

    with pytest.raises(InvalidRequestError) as excinfo:
        service.capture([{"role": "user", "content": "没给名字"}], session_id="conv_1")

    assert "role / name / content" in str(excinfo.value)


def test_capture_requires_a_session_id(tmp_path: Path) -> None:
    """没有 session_id 就没法回溯来源对话——那是记忆可信度的锚点。"""
    service = _service(tmp_path)

    with pytest.raises(InvalidRequestError):
        service.capture(
            [{"role": "user", "name": "用户", "content": "x"}],
            session_id="   ",
        )


def test_capture_rejects_empty_messages(tmp_path: Path) -> None:
    service = _service(tmp_path)

    with pytest.raises(InvalidRequestError):
        service.capture([], session_id="conv_1")


# --------------------------------------------------------------------- 节流


class _FakeMeta:
    def __init__(self) -> None:
        self.enqueued: list = []

    def enqueue_task(self, record):  # type: ignore[no-untyped-def]
        self.enqueued.append(record)
        return record


class _FakeStores:
    def __init__(self) -> None:
        self.meta = _FakeMeta()


def _service_with_stores(tmp_path: Path, **values: str) -> tuple[MemoryService, _FakeStores]:
    stores = _FakeStores()
    base = {"memory.enabled": "true", "memory.base_url": "http://reme.test"}
    base.update(values)
    service = MemoryService(_FakeRuntime(base), tmp_path, stores=stores)  # type: ignore[arg-type]
    return service, stores


TURN = [
    {"role": "user", "name": "用户", "content": "问"},
    {"role": "assistant", "name": "KYLAB", "content": "答"},
]


def test_capture_is_throttled_to_every_n_turns(tmp_path: Path) -> None:
    """**节流**：不是每一轮都沉淀。

    ReMe 的设计是"每累计 5 个用户回合触发一次"，但**它的服务不管累计**——
    每次调用就是一次 LLM 调用。每轮都沉淀等于每轮多花一次模型调用，
    而省 token 是这个项目反复强调的事。
    """
    service, stores = _service_with_stores(tmp_path, **{"memory.capture_every": "3"})

    for turn in (1, 2, 4, 5):
        assert service.enqueue_capture(TURN, session_id="c1", turn_count=turn) is False
    assert stores.meta.enqueued == [], "没到回合也入队了"

    assert service.enqueue_capture(TURN, session_id="c1", turn_count=3) is True
    assert len(stores.meta.enqueued) == 1
    task = stores.meta.enqueued[0]
    assert task.kind.value == "memory"
    assert task.payload["session_id"] == "c1"
    assert task.payload["messages"] == TURN


def test_capture_every_one_means_every_turn(tmp_path: Path) -> None:
    service, stores = _service_with_stores(tmp_path, **{"memory.capture_every": "1"})

    assert service.enqueue_capture(TURN, session_id="c1", turn_count=1) is True
    assert service.enqueue_capture(TURN, session_id="c1", turn_count=2) is True
    assert len(stores.meta.enqueued) == 2


def test_capture_is_off_when_memory_is_disabled(tmp_path: Path) -> None:
    service, stores = _service_with_stores(
        tmp_path, **{"memory.enabled": "false", "memory.capture_every": "1"}
    )

    assert service.enqueue_capture(TURN, session_id="c1", turn_count=1) is False
    assert stores.meta.enqueued == []


def test_capture_without_stores_is_a_noop(tmp_path: Path) -> None:
    """没接存储时不入队、也不报错——recall / remember / 注入都不需要数据库，
    所以 MemoryService 允许没有 stores 地构造。"""
    service = _service(tmp_path)

    assert service.enqueue_capture(TURN, session_id="c1", turn_count=5) is False


def test_capture_every_falls_back_when_the_setting_is_garbage(tmp_path: Path) -> None:
    """设置被写坏时回落到默认 5，而不是除零或每轮都沉淀。"""
    service, stores = _service_with_stores(tmp_path, **{"memory.capture_every": "abc"})

    assert service.enqueue_capture(TURN, session_id="c1", turn_count=5) is True
    assert len(stores.meta.enqueued) == 1


# ------------------------------------------------------------------ 连通性检查
#
# 这一组是**补上来的**：probe 原先一条用例都没有，而它当时是坏的——
# `MemoryStatus(**{**base.__dict__, ...})` 在 `slots=True` 的记录上会抛
# AttributeError（slots 类没有 __dict__），于是"启用且服务活着"这条路径 500。
# 唯一沾到 probe 的接口测试断言的是**成员访问被拒**（403），压根没走到实现里。
# 教训不是"漏了一条用例"，而是"只测失败分支"会让整条成功路径无人看守。


def test_probe_reports_reachable_when_the_service_answers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "app.services.memory.httpx.post", lambda *a, **k: _FakeResponse({"status": "ok"})
    )
    service = _service(tmp_path)

    result = service.probe()

    assert result.reachable is True
    assert "服务正常" in result.detail
    # 其余字段要保持 status() 的那份，不能因为拼装而丢
    assert result.enabled is True
    assert result.workspace == str(service.workspace)


def test_probe_reports_the_error_without_raising(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """服务没起时 probe 要**回一句人话**，而不是把异常抛给调用方——
    它是设置页的「测试连接」，报错正是它的产出。"""
    import httpx

    monkeypatch.setattr(
        "app.services.memory.httpx.post",
        lambda *a, **k: (_ for _ in ()).throw(httpx.ConnectError("连不上")),
    )
    service = _service(tmp_path)

    result = service.probe()

    assert result.reachable is False
    assert "记忆服务" in result.detail or "连不上" in result.detail
    assert result.enabled is True


def test_probe_on_a_disabled_layer_does_not_touch_the_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """关着时**一次网络都不打**：没启用就没有"连不连得上"这回事，
    打过去只会让设置页在一个纯本地判断上等超时。"""

    def boom(*_a, **_k):  # type: ignore[no-untyped-def]
        raise AssertionError("关着的时候不该发请求")

    monkeypatch.setattr("app.services.memory.httpx.post", boom)
    service = _service(tmp_path, **{"memory.enabled": "false"})

    result = service.probe()

    assert result.enabled is False
    # 关着时 `reachable` 是 **None**（"没这回事"），不是 False（"连不上"）：
    # 一个没启用的层不存在"连不连得上"，界面因此只显示"未启用"而不是警示色。
    assert result.reachable is None
    assert result.detail == "未启用"


def test_remember_keeps_the_sections_own_prose(tmp_path: Path) -> None:
    """那条"记什么、别记什么"的说明**不能被第一条记忆挤掉**。

    它是从 QwenPaw 的 MEMORY.md 照抄来的，里面有一条安全约定：
    「除非明确要求，不要记录密码、令牌或其他敏感信息」。这条规矩写在**文件里**
    才起作用（模型每轮都读到它），而第一版的重写逻辑只保留 `- ` 条目行——
    第一条记忆落盘的那一刻，这段话就被静默删掉了，且**没人会再去重新发现它**。
    """
    service = _service(tmp_path)

    service.remember("对方偏好简短的答复")

    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert "不要记录密码、令牌或其他敏感信息" in body
    assert "不要把每日流水或整段会话记录复制到这里" in body
    # 条目本身也在，且没被当成"散文"留在上面
    assert "- 对方偏好简短的答复" in body
    # 再记一条：说明还在，条目累加
    service.remember("项目代号叫 kylab")
    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert "不要记录密码、令牌或其他敏感信息" in body
    assert "- 对方偏好简短的答复" in body and "- 项目代号叫 kylab" in body


def test_remember_does_not_rewrite_line_endings(tmp_path: Path) -> None:
    """整份重写要**按字节写**：`write_text` 在 Windows 上会把换行改成 CRLF。

    后果不只是"文件变脏"：这份文件每次都在被 read/compare（去重、注入），
    换行在多轮之间来回翻会让 diff 与哈希都不稳定。
    """
    service = _service(tmp_path)
    service.remember("第一条")

    raw = (tmp_path / "memory" / CORE_MEMORY_FILE).read_bytes()

    assert b"\r\n" not in raw


def test_untouched_legacy_templates_are_upgraded(tmp_path: Path) -> None:
    """**还在用旧模板的实例要能看到新模板**，改过的文件一个字也不动。

    v0.21 把三份模板换成了 QwenPaw 那套有内容的写法，而 `seed_persona` 的原则是
    "已存在的一律不动"——照字面执行的话，已经在跑的部署永远看不到新模板，
    除非用户自己去删文件（而他并不知道该删）。

    判据是**逐字节相同**：那才是"我们写下去之后没人动过"。所以第三条断言
    （只改了一个标题的文件）与第二条（真正的旧模板）必须表现不同——
    这是"宁可漏升级、不可误覆盖"的落点。
    """
    from app.services.memory import _LEGACY_TEMPLATES

    workspace = tmp_path / "memory"
    workspace.mkdir(parents=True)
    (workspace / SOUL_FILE).write_bytes(_LEGACY_TEMPLATES[SOUL_FILE].encode("utf-8"))
    (workspace / AGENTS_FILE).write_bytes(
        _LEGACY_TEMPLATES[AGENTS_FILE].replace("## 工作方式", "## 我自己的工作方式").encode()
    )
    service = _service(tmp_path)

    service.seed_persona()

    # 旧模板 → 换成新的（有内容的那份）
    assert "真心帮忙" in (workspace / SOUL_FILE).read_text(encoding="utf-8")
    # 动过一个字的 → 原样不动
    assert "我自己的工作方式" in (workspace / AGENTS_FILE).read_text(encoding="utf-8")
    # 缺的那份照旧补上
    assert (workspace / PROFILE_FILE).exists()
    # 幂等：第二次没有可升级的
    assert service.seed_persona() == []
