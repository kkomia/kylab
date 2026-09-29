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

from pathlib import Path

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
    WRAP_UP_NOTE,
    PromptContext,
    build_system_prompt,
    converge_note,
    default_contributors,
)


class _FakeRuntime:
    """只实现 MemoryService 用到的那几个读接口。

    **形状必须和真的一样**（`get_bool` 的名字别写错）——替身少了方法，
    测出来的就是替身的行为而不是产品的。这里踩过一次：少了 `get_bool`
    三条用例直接 AttributeError。
    """

    def __init__(self, enabled: bool, **extra: str) -> None:
        self._values = {"memory.enabled": "true"} if enabled else {}
        self._values.update(extra)

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
    """空块不留空行。

    这里**显式给一张单来源的表**：默认表里现在还有两段常驻规矩
    （§12.338 后续的澄清 / 检索收敛），它们不是空块——用默认表断言"只剩基础"
    会把那两段一起判成多余（它们各自的用例在下面那一组）。
    """
    only_base = [(PRIORITY_BASE, "base", lambda ctx: ctx.base)]

    text = build_system_prompt(PromptContext(base="只有基础"), only_base)

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


def test_persona_block_opens_with_a_do_follow_this_instruction() -> None:
    """四份文件前面要有一句**"这是我的设定，请照着做"**（用户实测的"全程没生效"）。

    原先它们只有来源标签：标签回答"它是什么"，但"所以要照着做"一句都没有——
    要求散在通用 base 提示词里，模型完全可以把这几段当资料读完就算。
    这里钉三件事：总起句在最前、它写着"照此说话做事"、以及**冲突时以对方当下为准**
    （只靠 MEMORY.md 那句"可能过时"不够：人格与规程也会被当成过期的资料）。
    """
    text = build_system_prompt(
        PromptContext(
            base="底",
            persona=((SOUL_FILE, "我很克制"), (CORE_MEMORY_FILE, "他偏好中文")),
        )
    )

    assert "请始终照此说话做事" in text
    # 总起句排在**所有文件之前**，而不是被塞在某一份后面
    assert text.index("请始终照此说话做事") < text.index("【你的人格")
    # 冲突的优先级说清（文件是快照，对方当下说的才是新事实）
    assert "以他此刻说的为准" in text
    # 它不能变成一次"逐字转述"练习
    assert "不要向对方复述文件原文" in text
    # 总起句与 MEMORY.md 那句各说一次，不重复同一句措辞（那句原样留在记忆那份的标签里）
    assert text.count("可能已经过时") == 1


def test_no_persona_files_no_dangling_instruction() -> None:
    """一份文件都没有时，**总起句也不出现**：空喊一句"请遵守以下设定"比不写更糟。

    与上一条同理，显式给一张单来源的表：要钉的是"人设这一块自身不产生悬空的话"，
    而不是"默认表里只有基础提示词"（默认表还带着两段常驻规矩）。
    """
    only_base = [(PRIORITY_BASE, "base", lambda ctx: ctx.base)]

    assert build_system_prompt(PromptContext(base="底"), only_base) == "底"
    # 文件存在但内容为空（只有空白）时同样不带总起句
    assert (
        build_system_prompt(PromptContext(base="底", persona=((SOUL_FILE, "  \n"),)), only_base)
        == "底"
    )


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


def test_dropping_memory_from_the_persona_list_drops_its_stale_warning(
    tmp_path,  # type: ignore[no-untyped-def]
) -> None:
    """把 ``MEMORY.md`` 从注入清单里去掉之后，**那句"可能过时"的声明也一起没了**。

    不能只去掉正文、留一句悬空的声明——那读起来像"下面有一份会过时的东西"，
    而下面什么都没有。这条同时钉住"这份文件确实没进提示词"。
    """
    service = MemoryService(
        _FakeRuntime(True, **{"memory.persona_files": "SOUL.md"}),  # type: ignore[arg-type]
        tmp_path,
    )
    service.seed_persona()
    (service.workspace_for(None) / SOUL_FILE).write_bytes("我的人格".encode())
    (service.workspace_for(None) / CORE_MEMORY_FILE).write_bytes("记过的事".encode())

    text = build_system_prompt(
        PromptContext(base="底", persona=tuple(service.persona_texts()))
    )

    assert "我的人格" in text
    assert "记过的事" not in text, "它不在注入清单里"
    assert "可能已经过时" not in text, "悬空的声明比不写更糟"


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
    """首次对话把缺的补上，**已存在的绝不覆盖**（那可能是用户写了几天的东西）。

    四份都补——``MEMORY.md`` 从 v0.1.1 起也在这份清单里
    （原先它要等第一次 ``remember`` 才出现，新部署的「记忆」页因此看不到它）。
    """
    service = MemoryService(_FakeRuntime(True), tmp_path)  # type: ignore[arg-type]

    created = service.seed_persona("u1")

    assert sorted(created) == sorted(
        [SOUL_FILE, PROFILE_FILE, AGENTS_FILE, CORE_MEMORY_FILE]
    )
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


def test_persona_does_not_depend_on_the_memory_service_switch(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """**记忆服务关着，人设照样工作。**

    这一条是实测逼出来的：人设原先跟 `core_text` / `soul_text` 共用同一道
    `if not self.enabled` 闸门，而用户的实例上记忆服务是关的——于是人设文件
    既不播种也不注入，功能整个是死的，界面上还写着"没启用"。

    那四个文件是**磁盘上的普通文件**（`memory_files` 的模块头自己就写着
    "看自己的文本文件不该先要求另一个进程活着"）。那个开关管的是另一半：
    过去的对话会不会被召回、会不会自动沉淀。
    """
    service = MemoryService(_FakeRuntime(False), tmp_path)  # type: ignore[arg-type]

    assert service.seed_persona("u1") == [
        SOUL_FILE,
        PROFILE_FILE,
        AGENTS_FILE,
        CORE_MEMORY_FILE,
    ]
    assert [name for name, _text in service.persona_texts("u1")] == [
        SOUL_FILE,
        PROFILE_FILE,
        AGENTS_FILE,
        CORE_MEMORY_FILE,
    ]
    assert "【你的人格" in service.prompt_block("u1")


def test_persona_files_are_listed_and_editable_through_the_memory_layer(
    tmp_path,
) -> None:  # type: ignore[no-untyped-def]
    """人设文件的**编辑入口是白捡的**：它们落在记忆工作区里，而那一页本来就在列文件。

    这条钉的是这个复用关系本身——如果哪天把核心文件从 ``scan`` 里排掉，
    用户就再也改不了自己的人格了（而那是这一层存在的全部理由）。
    """
    from app.services import memory_files

    service = MemoryService(_FakeRuntime(True), tmp_path)  # type: ignore[arg-type]
    service.seed_persona("u1")

    listed = {Path(item.path).name: item for item in memory_files.scan(service.workspace_for("u1"))}

    assert set(listed) == {SOUL_FILE, PROFILE_FILE, AGENTS_FILE, CORE_MEMORY_FILE}
    for name, item in listed.items():
        # 核心文件：**不参与检索、但会被注入**——正是人设该有的两条属性
        assert item.kind == "core", name
        assert item.retrievable is False, name
    # 改得动（走的是同一个安全路径解析）
    memory_files.write_file(service.workspace_for("u1"), SOUL_FILE, "改过的人格")
    assert (service.workspace_for("u1") / SOUL_FILE).read_text(encoding="utf-8") == "改过的人格"

def test_persona_files_and_core_files_cannot_drift() -> None:
    """两份清单必须一致：`memory.py` 决定"注入哪些"，`memory_files.py` 决定"哪些算核心"。

    分成两处是**依赖方向**逼的（memory 依赖 memory_files，反过来会成环），
    所以用这条用例把它们钉在一起——少列一个的后果是那份文件不进注入、
    还可能被当成普通文件检索进去，而用户看到的现象只是"我改了它但好像没生效"。
    """
    from app.services import memory_files

    assert set(memory_files.CORE_FILES) == {name for name, _label in PERSONA_FILES}


# --------------------------------------------------- 人设文件的模板（照抄 QwenPaw）


def test_templates_are_qwenpaw_shaped_not_empty_skeletons(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """模板里要有**内容**，不能只是几个空标题。

    空壳（`## 我是谁` / `## 我的准则`）看着整齐，但它对新 Agent 一点用没有：
    它得先猜"这里该写什么"。QwenPaw 的那几份写的是**行为约束**
    （别演、先自己查、对外谨慎对内大胆），每一条都能落成具体动作——
    这正是抄它们的理由。
    """
    service = MemoryService(_FakeRuntime(True), tmp_path)  # type: ignore[arg-type]
    service.seed_persona("u1")
    texts = dict(service.persona_texts("u1"))

    # 人格里那几条准则在
    assert "真心帮忙" in texts[SOUL_FILE]
    assert "先自己想办法" in texts[SOUL_FILE]
    # 规程里要说清"先问一声"的边界，以及技能与检索该用哪个工具
    assert "先问一声" in texts[AGENTS_FILE]
    assert "list_skills" in texts[AGENTS_FILE] and "search" in texts[AGENTS_FILE]
    # 资料文件留白（这是要人去填的）
    assert "名字" in texts[PROFILE_FILE]


def test_templates_carry_the_frontmatter_the_memory_layer_needs(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """三份文件都要带 `summary` 与 `read_when`。

    这不是装饰：它是 ReMe 那一族的约定（记忆文件靠这两个字段被检索与按需读取）。
    少了它，人设文件在检索那一侧就是"没有元数据的普通文件"。
    """
    service = MemoryService(_FakeRuntime(True), tmp_path)  # type: ignore[arg-type]
    service.seed_persona("u1")

    for name, text in service.persona_texts("u1"):
        assert text.startswith("---\n"), name
        head = text.split("---")[1]
        assert "summary:" in head, name
        assert "read_when:" in head, name


def test_templates_have_no_emoji(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """**照抄不能把 emoji 一起抄进来**（这个项目禁 emoji）。

    QwenPaw 的 AGENTS.md 里有整节表情回应的内容，SOUL/AGENTS 里也有表情符号；
    它们的取向与我们的规范正好相反，所以抄的时候要剥掉。
    这一条挡住的是"下次再照抄一版时把 emoji 带回来"——那时候
    `scripts/scan_emoji.py` 才会红，而它在 CI 里、离改的人很远。
    """
    service = MemoryService(_FakeRuntime(True), tmp_path)  # type: ignore[arg-type]
    service.seed_persona("u1")

    for name, text in service.persona_texts("u1"):
        for char in text:
            code = ord(char)
            assert not (
                0x1F300 <= code <= 0x1FAFF  # 各种表情与符号
                or 0x2600 <= code <= 0x27BF  # 杂项符号（含 ✅ ✗ ➜ 一类）
                or code in {0xFE0F, 0x2B50, 0x2049, 0x203C}
            ), f"{name} 里有 emoji：{char!r} (U+{code:04X})"


# ------------------------------------------- 记忆指导的注入位置（照 QwenPaw）


def _persona_of(*names: str) -> tuple[tuple[str, str], ...]:
    return tuple((name, f"{name} 正文") for name in names)


def test_memory_guidance_is_injected_only_when_the_service_gives_one() -> None:
    """服务层给空串时（记忆未启用），提示词里一个字都不该多出来。"""
    without = build_system_prompt(PromptContext(base="底", persona=_persona_of(AGENTS_FILE)))
    with_guidance = build_system_prompt(
        PromptContext(base="底", persona=_persona_of(AGENTS_FILE), memory_guidance="记忆指导正文")
    )

    assert "记忆指导正文" not in without
    assert "记忆指导正文" in with_guidance


def test_memory_guidance_lands_inside_the_agents_section() -> None:
    """挂在**操作规程那一份之内**，而不是末尾单列（照 QwenPaw 拼进 AGENTS.md）。

    "什么时候去查记忆"是做事规程的一部分；单列成一块会让模型把它读成
    另一份待读的资料，而不是"我该怎么干活"。
    """
    text = build_system_prompt(
        PromptContext(
            base="底",
            persona=_persona_of(SOUL_FILE, PROFILE_FILE, AGENTS_FILE, CORE_MEMORY_FILE),
            memory_guidance="记忆指导正文",
        )
    )

    assert text.index(f"{AGENTS_FILE} 正文") < text.index("记忆指导正文")
    assert text.index("记忆指导正文") < text.index(f"{CORE_MEMORY_FILE} 正文")


def test_memory_guidance_survives_a_missing_agents_file() -> None:
    """没有 `AGENTS.md` 时退化成独立一块——总比把整段指导丢掉好。"""
    text = build_system_prompt(
        PromptContext(base="底", persona=_persona_of(SOUL_FILE), memory_guidance="记忆指导正文")
    )

    assert "记忆指导正文" in text


def test_the_guidance_rides_with_the_agents_section() -> None:
    """「长期记忆怎么用」挂在**操作规程那一份的末尾**（照 QwenPaw 的做法）。

    它属于"这类活怎么干"，不是待读的资料；顺序固定是刻意的——同一份提示词每轮
    要是排得不一样，任何"比对两轮提示词差在哪"的排查都会失效。
    """
    text = build_system_prompt(
        PromptContext(
            base="底",
            persona=_persona_of(AGENTS_FILE),
            memory_guidance="记忆指导正文",
        )
    )

    assert text.index(f"{AGENTS_FILE} 正文") < text.index("记忆指导正文")
    # 紧挨着：两者之间不该插进别的东西（这一份就是一个整块）
    assert "记忆指导正文" in text.split(f"{AGENTS_FILE} 正文")[1]


def test_the_bootstrap_is_the_last_block_even_after_the_skills() -> None:
    """首次引导是**独立一块、排在整份提示词的最后**（v0.52）。

    **为什么不能拼在 ``AGENTS.md`` 末尾**（原先那样做）：后面还跟着知识库提示词、
    记忆块、**技能目录**、摘要——而技能目录本身就是一份能力清单。实测（用户在界面上
    只发了一句"你好"）：模型照那份清单回了一串"联网、笔记、记忆这些都正常"，
    **没做引导**，而引导块当时确实在提示词里。机制没错，是话说在了没人听的地方。

    所以这里钉的是**位置**：技能正文之后、整份提示词的收尾。
    """
    text = build_system_prompt(
        PromptContext(
            base="底",
            persona=_persona_of(AGENTS_FILE),
            memory_guidance="记忆指导正文",
            skills="技能正文",
            summary="摘要正文",
            bootstrap="引导正文",
        )
    )

    assert text.index("技能正文") < text.index("引导正文"), "要在技能目录之后"
    assert text.index("摘要正文") < text.index("引导正文"), "要在摘要之后"
    assert text.rstrip().endswith("引导正文"), "而且它就是最后一段"


def test_the_bootstrap_is_absent_when_the_service_says_nothing() -> None:
    """服务层判"人设已经填过"时给空串，提示词里就一个字都不该多出来。"""
    text = build_system_prompt(
        PromptContext(base="底", persona=_persona_of(AGENTS_FILE), skills="技能正文")
    )

    assert "引导正文" not in text


def test_the_persona_lead_forbids_chasing_placeholder_fields() -> None:
    """D26：文件里写着「待确认」「待补」这类占位词时，**不许每一轮都去追问对方**。

    实测（2026-09-28 走查）：那份 `PROFILE.md` 的用户资料三行写着「待确认」（模型自己
    早先这么填的），于是每轮注入之后模型都把它当成"还没做完的事"，见面就问"怎么称呼你"
    —— 那天 17 条新会话里 14 条出现了这种追问，而记忆 bootstrap 那条路实测根本不再注入。

    规则写在**总起句**里（只要有文件进来就注入），与 `memory._PROFILE_TEMPLATE`
    那句提示一前一后挡住它。这条用例是**对着渲染结果**钉的，不是对着常量名。
    """
    persona = [("PROFILE.md", "# 用户资料\n\n- **怎么称呼他：** 待确认\n")]
    text = build_system_prompt(PromptContext(base="底", persona=persona))

    assert "没填的字段就当没填" in text
    assert "追问" in text
    # 点名那几个占位词：不点名的话，模型未必把「待补」也当成同一类
    assert "待确认" in text and "待补" in text


# ------------------------------------------------- 这一轮怎么做事（§12.338 后续两条政策）


def test_the_default_prompt_carries_both_conduct_blocks() -> None:
    """两段常驻规矩**在默认提示词里**，而且顺序是"先决定要不要问，再决定查多少"。

    走查实测（§12.338）：D-03 一句没问就跑 39 步、B-06 为一本不存在的书搜了 9 次。
    两条都不是能力问题，是**没有判据**——所以它们必须常驻（不是只在某个分支里）。
    """
    text = build_system_prompt(PromptContext(base="底"))

    assert "什么时候先问一句" in text
    assert "检索什么时候算够" in text
    # 顺序：澄清在检索之前（先决定要不要问，再决定查多少）
    assert text.index("什么时候先问一句") < text.index("检索什么时候算够")


def test_the_clarify_block_asks_only_when_both_conditions_hold() -> None:
    """判据的**形状**要能照着判：歧义大 + 代价高，两条**同时**成立才问。

    只有一半就问，会把日常小事变成问卷；一条判据都写不出的话，
    模型只能凭感觉（实测就是"有时问 4 句、有时一句不问"）。
    """
    text = build_system_prompt(PromptContext(base="底"))

    assert "歧义大" in text and "代价高" in text
    assert "两条同时成立" in text or "两条都成立" in text
    # 不澄清时的另一半：**必须写明假设**（只写"可以问"等于把假设那一半丢掉）
    assert "假设" in text and "直接开跑" in text
    # 明确的需求不许反问（用户拍板的边界）
    assert "不许再问" in text


def test_the_search_block_says_when_to_stop() -> None:
    """"够用就停"要给出**可判定的停点**，而不是"搜到满意为止"。

    三类停点各自对应一次实测浪费：重复同参（B-06 / Z-01）、零命中一直搜（B-06 9 次）、
    以及没有"够了"的定义（Z-01 搜了 35 次）。
    """
    text = build_system_prompt(PromptContext(base="底"))

    assert "同一个查询不要重复发" in text
    assert "2 个相互独立" in text, "同一事实两个独立来源就该停"
    assert "零命中" in text and "没有找到" in text, "零命中要换路子，换不动就如实说没找到"
    assert "最多再试两轮" in text


def test_the_budget_notes_are_not_part_of_the_system_prompt() -> None:
    """预算提示那两段**不进** system prompt：它们只在预算那一刻插进对话（见 `tool_loop`）。

    常驻的话模型每一轮都读到"预算用尽"，正常任务会被它带着提前收口。
    """
    text = build_system_prompt(PromptContext(base="底"))

    assert "【预算提醒】" not in text
    assert "【收尾要求" not in text


def test_converge_note_reports_the_real_numbers() -> None:
    """提醒里给的是**具体数字**：含糊说"快没时间了"，模型换算不出"该收口了"。"""
    note = converge_note(steps_left=6, seconds_left=42.7)

    assert "还剩 6 步" in note
    assert "42 秒" in note
    assert "收尾" in note


def test_converge_note_without_numbers_still_says_the_budget_is_nearly_gone() -> None:
    """两个数都不给时也要说得出"预算快用完了"（别拼出"【预算提醒】。"这种空句）。"""
    note = converge_note()

    assert "预算" in note and "收尾" in note
    assert note.count("还剩") == 0


def test_wrap_up_note_demands_four_things_and_forbids_a_dangling_ending() -> None:
    """收尾清单：做成了什么 / 没做成什么 / 为什么 / 下一步；并**明确禁掉悬着的收尾**。

    G-03 / K-03 的原文都是"我再跑一次补完"——那一轮已经结束了，
    那句话对用户没有任何可执行的信息。
    """
    for fragment in ("做成了什么", "没做成", "原因", "下一步"):
        assert fragment in WRAP_UP_NOTE, fragment
    assert "我再跑一次补完" in WRAP_UP_NOTE, "要拿它当反例点名"
    assert "悬着" in WRAP_UP_NOTE
