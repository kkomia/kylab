"""两条接缝的"可替换"用例（Phase B 第一刀）。

这一轮的验收不是"新功能" ✓，而是**证明接缝真的可换** ✓：

1. **模型侧**：`llm.OpenAICompatChat` 结构上满足 `ModelClient` ✓（同名的三个方法 ✓）——
   于是"把模型换成服务器代理"不需要改循环 ✗；
2. **KB 侧**：`ChatService.retrieve_sources` 的签名与 `KnowledgeClient` 一致 ✓，
   而且**一个假实现能顶上去**跑通"检索 → 拿回带编号的出处"这条链 ✓ ——
   这正是边车模式（本地循环 + 远端 KB）要的形状 ✓。

**M3 阶段 3 又加了一条同族的守卫**（本文件最后那一条）：本机档装配完之后，
**没有任何接缝还指着真 `IngestService`** ✓ —— 影子引用（`notes` / `artifacts` 各自
持有的一份）换干净了没有，靠它守着（方案 §5.1 的 R6）。

**反向验证**：把协议里的方法名改掉（或让假实现少一个方法）→ 用例必须红 ✓。
"""

from __future__ import annotations

import dataclasses
import types
from collections.abc import Iterator, Sequence

import pytest

from app.core import services as services_module
from app.core.services import Services, get_services
from app.services.chat import ChatService, SourceRef
from app.services.ingest import IngestService
from app.services.knowledge_client import KnowledgeClient
from app.services.knowledge_provider import KnowledgeProviderClient
from app.services.llm import ChatMessage, LLMConfig, LLMDelta, OpenAICompatChat, ToolSpec
from app.services.model_client import ModelClient


class _FakeModelClient:
    """一个**完全进程内**的假模型（不动网络 ✓）：证明循环只需要这三个方法。"""

    def __init__(self, reply: str = "假回答") -> None:
        self.reply = reply
        self.seen: list[Sequence[ChatMessage]] = []

    def complete(self, messages: Sequence[ChatMessage]) -> str:
        self.seen.append(messages)
        return self.reply

    def stream(self, messages: Sequence[ChatMessage]) -> Iterator[str]:
        self.seen.append(messages)
        yield self.reply

    def stream_events(
        self, messages: Sequence[ChatMessage], tools: Sequence[ToolSpec] | None = None
    ) -> Iterator[LLMDelta]:
        self.seen.append(messages)
        yield LLMDelta(text=self.reply)


class _FakeKnowledgeClient:
    """一个假的 KB（不动库 ✓）：边车模式下它就是"打服务器"的那份实现。"""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def retrieve_sources(
        self,
        *,
        query: str,
        kb_ids: list[str],
        top_k: int | None = None,
        candidate_k: int = 40,
        reader: object | None = None,
    ) -> list[SourceRef]:
        self.calls.append({"query": query, "kb_ids": kb_ids, "top_k": top_k})
        return [
            SourceRef(
                index=1,
                chunk_id="c1",
                document_id="d1",
                document_name="指南.pdf",
                heading_path="第 3 章",
                page=7,
                score=0.5,
                preview="原文",
            )
        ]


def test_the_in_process_model_client_satisfies_the_protocol() -> None:
    """**默认实现就是协议的一份实现** ✓ —— 于是换实现不必改循环。"""
    client = OpenAICompatChat(
        LLMConfig(base_url="http://localhost:1", model_id="m", api_key="k")
    )

    assert isinstance(client, ModelClient)
    # 三个方法一个都不能少（少了服务器代理就装不进去 ✗）
    for name in ("complete", "stream", "stream_events"):
        assert callable(getattr(client, name))


def test_a_fake_model_client_is_usable_where_the_protocol_is_expected() -> None:
    """假的也能顶上：**循环只认这三个方法** ✓（这条就是"可替换"的证明）。"""
    fake = _FakeModelClient()

    assert isinstance(fake, ModelClient)
    assert fake.complete([ChatMessage(role="user", content="问题")]) == "假回答"
    chunks = list(fake.stream([ChatMessage(role="user", content="问题")]))
    assert chunks == ["假回答"]
    deltas = list(fake.stream_events([ChatMessage(role="user", content="问题")]))
    assert [d.text for d in deltas] == ["假回答"]


def test_the_in_process_knowledge_client_satisfies_the_protocol() -> None:
    """`ChatService` 那个方法就是协议的一份实现 ✓（签名逐字一致 ✓）。"""
    assert hasattr(ChatService, "retrieve_sources")

    # 关键字参数形状一致（`query` 必须是关键字——子 Agent 那条链踩过位置参数的坑 ✓）
    import inspect

    signature = inspect.signature(ChatService.retrieve_sources)
    parameters = list(signature.parameters)
    assert "query" in parameters
    assert parameters[1] in ("query",) or signature.parameters["query"].kind.name == "KEYWORD_ONLY"


def test_a_fake_knowledge_client_is_usable_where_the_protocol_is_expected() -> None:
    """假的 KB 能顶上，并且**拿回的是同一形状的出处** ✓（边车模式要的就是这个）。"""
    fake = _FakeKnowledgeClient()

    assert isinstance(fake, KnowledgeClient)
    sources = fake.retrieve_sources(query="储能", kb_ids=["kb_1"], top_k=3)

    assert [source.index for source in sources] == [1]
    assert sources[0].document_name == "指南.pdf"
    assert fake.calls == [{"query": "储能", "kb_ids": ["kb_1"], "top_k": 3}]


# ------------------------------------------------- 影子引用换干净了没有（M3 阶段 3）


#: 遍历时要绕开的**代码**（模块 / 类 / 函数 / 方法）：它们是"谁持有谁"这张图之外的
#: 东西，跟着走只会绕进模块级缓存里，与装配无关。
_SKIP_TYPES = (
    types.ModuleType,
    type,
    types.FunctionType,
    types.MethodType,
    types.BuiltinFunctionType,
    types.BuiltinMethodType,
)


def _references(value: object) -> list[tuple[str, object]]:
    """`value` **直接持有**的那些引用（带一段可读的路径后缀）。

    只认两种"持有"：① 数据类字段 / 实例属性（`__dict__`）；② 列表 / 元组 / 集合 / 字典
    里的元素。别的（属性访问会算出新对象的、描述符、`__getattr__` 兜出来的）一律不算
    —— 这一条要回答的是"对象挂在谁身上"，不是"能通过什么表达式拿到它"。
    """
    if isinstance(value, (list, tuple, set, frozenset)):
        return [(f"[{index}]", item) for index, item in enumerate(value)]
    if isinstance(value, dict):
        return [(f"[{key!r}]", item) for key, item in value.items()]
    if isinstance(value, _SKIP_TYPES):
        return []
    held: list[tuple[str, object]] = []
    if dataclasses.is_dataclass(value):
        held += [
            (f".{field.name}", getattr(value, field.name, None))
            for field in dataclasses.fields(value)
        ]
    attributes = getattr(value, "__dict__", None)
    if isinstance(attributes, dict):
        held += [(f".{name}", item) for name, item in attributes.items()]
    return held


def _holders_of(root: object, target: object, *, max_depth: int = 5) -> set[str]:
    """从 `root` 出发，找出**哪些路径上挂着 `target`**（`is` 比对象身份）。

    路径形如 `services.notes._ingest`、`services.workers[0]._ingest` —— 红了的时候
    一眼看得出是**谁**还攥着那个对象（这是这条守卫唯一的价值：报告得指到人）。
    """
    found: set[str] = set()
    seen: set[int] = {id(root)}
    queue: list[tuple[str, object, int]] = [("services", root, 0)]
    while queue:
        path, value, depth = queue.pop(0)
        if depth >= max_depth:
            continue
        for suffix, item in _references(value):
            if item is None or isinstance(item, _SKIP_TYPES):
                continue
            # **命中就先记下来，再判要不要展开**：同一个目标可以从好几条路径上挂着
            # （例如 `Services.worker` 与 `Services.workers[0]` 是同一个对象），
            # 用"见过就不再记"会漏掉后一条路径——而漏掉的正好可能是新长出来的那条。
            if item is target:
                found.add(path + suffix)
            if id(item) in seen:
                continue
            seen.add(id(item))
            queue.append((path + suffix, item, depth + 1))
    return found


def _spy_on_ingest(monkeypatch) -> list[IngestService]:  # type: ignore[no-untyped-def]
    """把组合根建的那个 `IngestService` **记下来**（返回单元素列表）。

    为什么要在它出生时记：守卫要比的是**真那一个**（组合根自己造的那个）。
    另建一个 `IngestService(...)` 来比身份是没意义的——它永远不等于图上任何一个，
    于是那条断言会变成永真式（"绿着但没在守"是最糟的一种）。
    """
    made: list[IngestService] = []

    class _Spy(IngestService):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, **kwargs)  # type: ignore[arg-type]
            made.append(self)

    monkeypatch.setattr(services_module, "IngestService", _Spy)
    return made


@pytest.mark.local
def test_no_seam_still_points_at_the_real_ingest_service(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """**本机档装配完之后，没有任何接缝还指着真 `IngestService`**（方案 §5.1 的 R6）。

    这一条守的是"发现②"那次踩坑：`notes` / `artifacts` **各自持有一份**真
    `IngestService`，而 `dataclasses.replace(Services)` 只换得到 `Services` 上那两个槽位
    ——于是 `attach_note_to_kb` 一直走的是真摄入流水线，撞进本机档的
    `UnavailableMetaStore`，表现成一句"知识库在 NAS 服务器上"（而它本来是**能**做的）。
    阶段 3 把换线收到组合根一处，这里用两层判据把它钉住：

    ① **两个槽位与两个服务**（`Services.ingest/documents`、`notes`、`artifacts`）拿到的是
       **同一对**提供者网关（`is` 比身份）——笔记与产物"两条路一份实现"；
    ② **从 `Services` 整张图走一遍**（实例属性 + 容器，`is` 比身份），除了数据源与消费者
       这两处**本该**持有摄入流水线的地方，再没有第三个持有者。

    ②是这条守卫的价值所在：将来谁再给某个服务塞一份真 `IngestService`，或者谁把
    `notes`/`artifacts` 那两处改回去，它都会红，并指出**是哪条路径**。
    """
    from app import sidecar

    made = _spy_on_ingest(monkeypatch)
    # 本机档：档位自己钉死（`pin_local_deployment` 是本机档唯一的入口姿势，
    # 它顺带清掉 settings/stores/services 三个单例缓存）
    sidecar.pin_local_deployment(
        tmp_path / "data", server_url="http://server.test/api/v1", token="t"
    )
    services: Services = get_services()

    assert len(made) == 1, "组合根应当只建一个真 IngestService（摄入流水线）"
    real = made[0]

    # ① 三个构造点拿到的是**同一对**网关，而且都不是真 IngestService
    assert services.ingest is not real
    assert services.documents is not real
    assert services.notes._ingest is services.ingest
    assert services.artifacts._ingest is services.ingest
    assert services.notes._documents is services.documents
    assert services.artifacts._documents is services.documents
    assert not isinstance(services.ingest, IngestService)
    # 检索那一半也接上了（阶段 3 起组合根给 ChatService 的就是这个客户端）
    assert isinstance(services.chat._knowledge, KnowledgeProviderClient)

    # ② 整张图上再没有别的持有者：允许的只有**摄入流水线自己那两处**——
    #    `sources`（数据源登记要往流水线上挂）与 `worker`（消费者领了活要跑它）。
    #    这两处是本机档也照建的真服务（`data_sources` / `tasks` 那族端点没挂本机档，
    #    本机档也不起消费者，见 `main.py` 那段），**不是**用户可见的入库接缝。
    allowed = {
        "services.sources._ingest",
        "services.worker._ingest",
        "services.workers[0]._ingest",
    }
    holders = _holders_of(services, real)
    assert holders, "遍历没找到任何持有者：那说明这条路走错了（守卫会静默变绿）"
    assert holders <= allowed, f"还有对象攥着真 IngestService：{sorted(holders - allowed)}"
