"""提示词贡献者与人设文件（P1）。

这一层的价值不在"拼起来了"，而在**三条约定**——它们是加来源时不用回头读整段代码的前提：

1. 顺序由优先级决定（是数据，不是注释里的一句话）；
2. 空块跳过；
3. **单个贡献者抛异常只跳过它自己** —— 某个来源读文件失败在真实部署里一定会发生，
   而"人设读不出来导致整轮对话失败"是完全不可接受的因果关系。

人设文件那一侧还有一条：`MEMORY.md` 要带"可能已经过时、以对方当下为准"的声明，
否则模型会把记忆当成对方这一轮说的话。
"""

from __future__ import annotations

from app.services.memory import (
    AGENTS_FILE,
    CORE_MEMORY_FILE,
    PERSONA_FILES,
    PROFILE_FILE,
    SOUL_FILE,
    MemoryService,
)
from app.services.prompt import (
    PRIORITY_BASE,
    PRIORITY_PERSONA,
    PromptContext,
    build_system_prompt,
    default_contributors,
)


class _FakeRuntime:
    """只实现 MemoryService 用到的那几个读接口。

    **形状必须和真的一样**（`get_bool` 的名字别写错）——替身少了方法，
    测出来的就是替身的行为而不是产品的。这里踩过一次：少了 `get_bool`
    三条用例直接 AttributeError。
    """

    def __init__(self, enabled: bool) -> None:
        self._values = {"memory.enabled": "true"} if enabled else {}

    def get(self, key: str) -> str:
        return self._values.get(key, "")

    def get_bool(self, key: str, *, default: bool = False) -> bool:
        raw = self._values.get(key)
        if raw is None or not raw.strip():
            return default
        return raw.strip().lower() in {"1", "true", "yes", "on"}

    def get_int(self, key: str) -> int:
        return 0


# ------------------------------------------------------------------ 三条约定


def test_order_comes_from_the_priority_numbers() -> None:
    """**把表打乱传进去，输出仍是升序**：顺序是数据，别处不该再排一次。"""
    shuffled = list(reversed(default_contributors()))

    text = build_system_prompt(
        PromptContext(base="底", kb_prompt="库", skills="技", summary="摘"), shuffled
    )

    assert text.index("底") < text.index("库") < text.index("技") < text.index("摘")


def test_empty_fragments_are_skipped_without_blank_lines() -> None:
    text = build_system_prompt(PromptContext(base="只有基础"))

    assert text == "只有基础"


def test_one_broken_contributor_only_costs_itself() -> None:
    """一个来源炸了，其余照常拼上——这是这一层存在的理由之一。"""

    def boom(_context: PromptContext) -> str:
        raise RuntimeError("人设目录读不动")

    table = [
        (PRIORITY_BASE, "base", lambda ctx: ctx.base),
        (PRIORITY_PERSONA, "persona", boom),
        (PRIORITY_PERSONA + 10, "skills", lambda ctx: ctx.skills),
    ]

    text = build_system_prompt(PromptContext(base="底", skills="技"), table)

    assert "底" in text and "技" in text


def test_blank_contributions_do_not_leave_gaps() -> None:
    """贡献者返回空白（只有空格）也算空 —— 否则会拼出两个空行。"""
    table = [
        (PRIORITY_BASE, "base", lambda ctx: ctx.base),
        (PRIORITY_BASE + 10, "blank", lambda ctx: "   \n  "),
        (PRIORITY_BASE + 20, "skills", lambda ctx: ctx.skills),
    ]

    assert build_system_prompt(PromptContext(base="底", skills="技"), table) == "底\n\n技"


# ------------------------------------------------------------------ 人设块


def test_persona_block_labels_each_file() -> None:
    """每份前面标出**它是什么**：模型才知道哪句是"该怎么说话"、哪句是"已知的事实"。"""
    text = build_system_prompt(
        PromptContext(
            base="底",
            persona=(
                (SOUL_FILE, "我很克制"),
                (PROFILE_FILE, "他叫老王"),
                (AGENTS_FILE, "先问再做"),
            ),
        )
    )

    assert "【你的人格（SOUL.md）】" in text
    assert "【身份与对方（PROFILE.md）】" in text
    assert "【操作规程（AGENTS.md）】" in text


def test_memory_is_marked_as_possibly_stale() -> None:
    """**只有记忆带这句**：它是四份里唯一会过时的。"""
    text = build_system_prompt(
        PromptContext(
            base="底",
            persona=((SOUL_FILE, "我很克制"), (CORE_MEMORY_FILE, "他偏好中文")),
        )
    )

    assert "可能已经过时" in text
    assert "以他当下的为准" in text
    # 人格那份不该带（它不会因为时间而失效）
    soul_part = text.split("【你的人格")[1].split("【长期记忆")[0]
    assert "可能已经过时" not in soul_part


def test_persona_files_have_a_fixed_order() -> None:
    """四份人设的顺序固定：越靠前越像"身份"，越靠后越像"数据"。"""
    assert [name for name, _label in PERSONA_FILES] == [
        SOUL_FILE,
        PROFILE_FILE,
        AGENTS_FILE,
        CORE_MEMORY_FILE,
    ]


# ------------------------------------------------------------------ 人设文件落盘


def test_seeding_writes_templates_then_leaves_them_alone(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """首次对话把缺的补上，**已存在的绝不覆盖**（那可能是用户写了几天的东西）。"""
    service = MemoryService(_FakeRuntime(True), tmp_path)  # type: ignore[arg-type]

    created = service.seed_persona("u1")

    assert sorted(created) == sorted([SOUL_FILE, PROFILE_FILE, AGENTS_FILE])
    # 第二次不再新建
    assert service.seed_persona("u1") == []
    # 用户改过的内容不会被覆盖
    target = service.workspace_for("u1") / SOUL_FILE
    target.write_bytes("我自己写的人格".encode())
    service.seed_persona("u1")
    assert target.read_text(encoding="utf-8") == "我自己写的人格"


def test_persona_texts_are_per_account(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """按账号取：**甲的人设不该出现在乙的提示词里**（与记忆同一条隔离要求）。"""
    service = MemoryService(_FakeRuntime(True), tmp_path)  # type: ignore[arg-type]
    service.seed_persona("u1")
    (service.workspace_for("u1") / PROFILE_FILE).write_bytes("甲的资料".encode())
    service.seed_persona("u2")

    assert any(text == "甲的资料" for _name, text in service.persona_texts("u1"))
    assert not any(text == "甲的资料" for _name, text in service.persona_texts("u2"))


def test_persona_is_empty_when_memory_is_off(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """记忆层关着时人设也不注入（它们住同一处、同一开关）。"""
    service = MemoryService(_FakeRuntime(False), tmp_path)  # type: ignore[arg-type]

    assert service.persona_texts("u1") == []
    assert service.seed_persona("u1") == []
