"""斜杠命令：内置表、自定义 md、优先级与参数替换（P1-2，开发计划 §12.225）。

镜像同构：``app/services/commands.py`` → 本文件。

这一层的错法都偏安静，逐条钉住：

1. **文件名即命令名**（ZCode）：不合法的名字要**带着原因留在列表里**，
   而不是静默消失——"我放的文件为什么不生效"是最难查的一类问题；
2. **优先级内置 > 用户 > 仓库，first match wins**：被遮蔽的要能看出**被谁**遮蔽；
3. **参数两条占位符 + 那条兜底追加**（ZCode）：``$ARGUMENTS`` / ``$1..$N``，
   一个占位符都没写却带了参数时自动追加——它省掉的是"命令没收到参数"的困惑；
4. **``/`` 开头的输入永不静默降级**（DSH）：认不出的也当成命令（由协议层回一句
   "没有这个命令"），不返回 ``None``。
"""

from __future__ import annotations

from pathlib import Path

from app.services.commands import (
    BUILTIN_COMMANDS,
    COMMAND_NAME_RE,
    CommandService,
    ModeWatch,
    TurnControl,
    builtin_names,
    modes_text,
    parse,
    render,
    split_args,
)


def _service(tmp_path: Path, *, repo: Path | None = None) -> CommandService:
    """一个把两条发现源都指到临时目录的服务（**不去读仓库里真实的那两个目录**）。"""
    return CommandService(tmp_path / "data", builtin_dir=repo or (tmp_path / "repo"))


def _write(root: Path, name: str, body: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{name}.md"
    path.write_text(body, encoding="utf-8")
    return path


# --------------------------------------------------------------------- 解析


def test_only_a_leading_slash_makes_it_a_command() -> None:
    """判定只有一条：第一个词以 ``/`` 开头（大小写不敏感，照 ZCode 的归一化）。"""
    assert parse("帮我看下 /tmp 目录") is None
    assert parse("") is None
    assert parse("/mode plan") == parse("/Mode plan")
    assert parse("/mode plan").name == "mode"  # type: ignore[union-attr]
    assert parse("/mode plan").args == "plan"  # type: ignore[union-attr]


def test_a_lone_slash_asks_for_help() -> None:
    """只有一个 ``/``：按 ``/help`` 处理（与各家终端里的补全一致）。"""
    parsed = parse("/")
    assert parsed is not None and parsed.name == "help"


def test_an_unknown_slash_line_is_still_a_command() -> None:
    """**``/`` 行永不静默降级**（DSH）：认不出的也返回命令，由协议层答"没有这个命令"。

    返回 ``None`` 的话它会变成一次普通提问——用户以为自己在用命令，模型却在猜
    他想说什么，而"那句话到底被谁读了"他根本看不出来。
    """
    parsed = parse("/znou")
    assert parsed is not None and parsed.name == "znou"


# --------------------------------------------------------------------- 内置表


def test_the_builtin_table_covers_the_six_commands_of_this_round() -> None:
    """内置六条：``/help`` ``/compact`` ``/new`` ``/stop`` ``/mode`` ``/skill``。

    每条都要有 ``summary``（菜单那一行）与 ``usage``（``/help <命令>`` 的用法行）
    ——ZCode 那张表就是这四个字段，缺一个界面上就会少一句话。
    """
    assert builtin_names() == ("help", "compact", "new", "stop", "mode", "skill")
    for record in BUILTIN_COMMANDS:
        assert record.summary, record.name
        assert record.usage.startswith(f"/{record.name}"), record.name
        assert record.source == "builtin"


def test_only_skill_is_not_short_circuited_among_builtins() -> None:
    """六条里只有 ``/skill`` 要过模型（它重写这一轮的提示，照 ZCode）。

    这一条直接决定界面往哪条路发：短路类不建回答气泡，改写类按普通一轮处理。
    """
    short = {record.name for record in BUILTIN_COMMANDS if record.short_circuit}
    assert short == {"help", "compact", "new", "stop", "mode"}


def test_modes_text_lists_all_four_modes() -> None:
    """``/mode`` 不带参数时列的四档与 ``services/modes`` 同一份（不另抄清单）。"""
    text = modes_text()
    for name in ("plan", "build", "edit", "yolo"):
        assert f"（{name}）" in text


# --------------------------------------------------------------------- 参数替换


def test_arguments_and_positional_placeholders(tmp_path: Path) -> None:
    """``$ARGUMENTS`` 给全部原样，``$1``…``$N`` 按空白切（ZCode 的两种占位符）。"""
    service = _service(tmp_path)
    body = "---\ndescription: 评审\n---\n先看 $1，再看 $2。\n用户说：$ARGUMENTS"
    record = _load_one(service, "review.md", body)
    assert render(record, "甲 乙") == "先看 甲，再看 乙。\n用户说：甲 乙"


def test_a_missing_positional_becomes_an_empty_string(tmp_path: Path) -> None:
    """给了 ``$2`` 而没有第二个参数：替成空串，**不报错**（照 ZCode 的宽松口径）。"""
    service = _service(tmp_path)
    record = _load_one(service, "two.md", "只写 $2 一个占位符")
    assert render(record, "只有一个") == "只写  一个占位符"


def test_arguments_are_appended_when_the_body_has_no_placeholder(tmp_path: Path) -> None:
    """**有参数但正文没有占位符时自动追加**（ZCode 那条兜底，第 3 条）。

    没有它，用户会得到"命令好像没收到我的参数"——那是命令这个功能上最常见的困惑。
    """
    service = _service(tmp_path)
    record = _load_one(service, "sum.md", "把这段总结成三句话。")
    assert render(record, "第一段 第二段") == "把这段总结成三句话。\n\n用户参数：第一段 第二段"
    # 没有参数就不追加（不留一个空的"用户参数："）
    assert render(record, "") == "把这段总结成三句话。"


def test_split_args_is_whitespace_only() -> None:
    """不做引号解析（ZCode 就没有这一层）：要带空格的整段用 ``$ARGUMENTS``。"""
    assert split_args('  甲   "乙 丙"  ') == ["甲", '"乙', '丙"']


# --------------------------------------------------------------------- 发现与优先级


def test_a_md_file_in_the_user_dir_becomes_a_command(tmp_path: Path) -> None:
    """**放进来一个 md 文件就是一条命令**（文件名即命令名，零注册、零重启）。"""
    service = _service(tmp_path)
    body = "---\ndescription: 发版\nargument-hint: <版本号>\n---\n按 $1 发版"
    _write(service.user_dir, "release", body)
    record = service.find("release")
    assert record is not None
    assert record.summary == "发版"
    assert record.usage == "/release <版本号>"
    assert record.source == "user"
    assert record.argument_hint == "<版本号>"
    assert record.body == "按 $1 发版"


def test_a_bad_file_name_is_dropped_with_a_reason_instead_of_vanishing(tmp_path: Path) -> None:
    """名字不合法：**丢弃并记原因**，而且那条仍然在列表里（照 ZCode 的正则）。

    静默消失等于把"为什么我放的文件不生效"变成一个查不出的问题。
    """
    service = _service(tmp_path)
    _write(service.user_dir, "Bash_Tool", "正文")
    record = service.any_named("bash_tool")
    assert record is not None, "被丢弃的那条也要出现在列表里"
    assert record.error, "必须带上原因"
    assert not record.usable
    # 名字不合法就调不到
    assert service.find("bash_tool") is None


def test_the_name_pattern_is_zcodes() -> None:
    """命令名的正则是**逐字照抄 ZCode** 的那一条。"""
    assert COMMAND_NAME_RE.pattern == r"^[a-z0-9][a-z0-9_:-]{0,63}$"
    assert COMMAND_NAME_RE.match("review:code")
    assert not COMMAND_NAME_RE.match("_private")
    assert not COMMAND_NAME_RE.match("A")


def test_builtin_beats_user_and_user_beats_repo(tmp_path: Path) -> None:
    """优先级：**内置 > 用户 > 仓库**，重名 first match wins（照 ZCode 的去重顺序）。

    被遮蔽的那条**留在列表里并记下"被谁遮蔽"**——与插件列表同一套做法。
    """
    service = _service(tmp_path)
    _write(service.user_dir, "mode", "用户放的 mode")  # 与内置同名 → 被内置遮蔽
    _write(service.user_dir, "deploy", "用户放的 deploy")
    _write(service.builtin_dir, "deploy", "仓库自带的 deploy")  # 被用户那份遮蔽
    _write(service.builtin_dir, "onboard", "仓库自带的 onboard")

    resolved = service.find("mode")
    assert resolved is not None and resolved.is_builtin, "同名时内置的那条生效"

    # 列表里三条都要在：生效的那条 + 两条被遮蔽的（各带 shadowed_by）
    listed = {item.name: item for item in service.list() if item.name in {"mode", "deploy"}}
    assert listed["mode"].shadowed_by == "mode"
    assert listed["mode"].source == "user"
    assert listed["deploy"].shadowed_by == "deploy"
    assert listed["deploy"].source == "repo"
    assert service.find("deploy") is not None
    assert service.find("deploy").body == "用户放的 deploy"  # type: ignore[union-attr]
    assert service.find("onboard") is not None


def test_the_catalog_only_has_usable_commands(tmp_path: Path) -> None:
    """菜单与 ``/help`` 吃的是 ``catalog()``：被遮蔽的与坏掉的都不该出现在菜单里。"""
    service = _service(tmp_path)
    _write(service.user_dir, "help", "想顶掉内置的 help")
    _write(service.user_dir, "Bad_Name", "名字不合法")
    names = [item.name for item in service.catalog()]
    assert "bad_name" not in names
    assert names.count("help") == 1
    assert service.catalog()[0].is_builtin


def test_read_failures_do_not_raise(tmp_path: Path) -> None:
    """读不出来的文件也不抛错（一条命令写坏了不该让整个列表 500）。"""
    service = _service(tmp_path)
    service.user_dir.mkdir(parents=True, exist_ok=True)
    # 非 UTF-8 内容：UnicodeDecodeError 是 ValueError 的子类，**不是 OSError**
    (service.user_dir / "broken.md").write_bytes(b"\xff\xfe\x00\x00bad")
    record = service.any_named("broken")
    assert record is not None and record.error


# --------------------------------------------------------------------- 模式观测


def test_mode_watch_reports_the_previous_mode_once() -> None:
    """档换过就报一次上一档；同一档连着几轮不重复报（P1-1 遗留 #6）。"""
    watch = ModeWatch(lambda _conversation_id: "build")
    assert watch.observe("c1", "build") is None, "第一次遇到：基线就是 build，没换"
    assert watch.observe("c1", "yolo") == "build"
    assert watch.observe("c1", "yolo") is None, "同一档不重复报"
    assert watch.observe("c1", "plan") == "yolo"


def test_mode_watch_without_a_baseline_stays_silent() -> None:
    """日志里查不到上一档时**不报**：宁可不记，也不写一个猜的 previousMode。"""
    watch = ModeWatch(lambda _conversation_id: None)
    assert watch.observe("c1", "yolo") is None
    assert watch.observe("c1", "plan") == "yolo"


def test_mode_watch_note_syncs_without_comparing() -> None:
    """``note`` 只同步、不比较：``/mode`` 那条路自己已经记过事件了。"""
    watch = ModeWatch()
    watch.observe("c1", "build")
    watch.note("c1", "yolo")
    assert watch.observe("c1", "yolo") is None
    # 没有会话时什么都不做（脚本、无状态调用）
    assert watch.observe("", "plan") is None


# --------------------------------------------------------------------- 停止登记


def test_turn_control_reports_whether_a_turn_was_running() -> None:
    """``/stop`` 要能回答"当时确实有一轮在跑吗"——没有就是没有，不假装（P1-2）。"""
    turns = TurnControl()
    assert turns.request_stop("c1") is False, "没有一轮在跑时不该说'已停止'"
    turns.begin("c1")
    assert turns.running("c1")
    assert turns.request_stop("c1") is True
    assert turns.stop_requested("c1"), "标记要一直可读（流那边会问不止一次）"
    turns.end("c1")
    assert not turns.running("c1")
    assert not turns.stop_requested("c1"), "收工之后标记要清掉"


def test_turn_control_clears_a_stale_stop_on_the_next_turn() -> None:
    """上一轮留下的停止标记不许影响下一轮（``begin`` 时清掉）。"""
    turns = TurnControl()
    turns.begin("c1")
    turns.request_stop("c1")
    turns.end("c1")
    turns.begin("c1")
    assert not turns.stop_requested("c1")


def _load_one(service: CommandService, file_name: str, body: str):  # type: ignore[no-untyped-def]
    """往用户目录写一个 md 并取回它（参数替换那几条用例的共用夹具）。"""
    _write(service.user_dir, file_name.removesuffix(".md"), body)
    record = service.find(file_name.removesuffix(".md"))
    assert record is not None
    return record
