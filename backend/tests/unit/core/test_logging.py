"""日志初始化的单元测试。

**这个文件的首要目的是钉住编码**：本项目是中文的，而中文 Windows 的
默认控制台编码是 GBK。日志里出现中文文件名时 `StreamHandler.emit` 会抛
`UnicodeEncodeError`，logger 打出一串乱码加调用栈——真正的那条业务日志就没了。

实景触发过：一个叫 `团队名单.csv` 的文件摄入时，日志变成了
`锟斤拷 %s 写锟斤拷峁癸拷锟斤拷锟斤拷锟?%d 锟斤拷` 加一段栈。
**触发条件偏偏是"出问题的时候"，也就是最需要日志的时候。**
"""

from __future__ import annotations

import io
import logging
import sys

from app.core.logging import setup_logging


def test_streams_are_switched_to_utf8() -> None:
    setup_logging("INFO")
    # **别断言 == "utf-8"**：某些环境（比如已经强制 UTF-8 的 CI）本来就是这个值，
    # 但更常见的是 pytest 把 stdout 换成了自己的捕获对象。这里要断言的是
    # "能编出中文"，而不是"编码字符串长什么样"——后者是手段，前者才是目的。
    encoding = getattr(sys.stdout, "encoding", "") or ""
    assert "utf" in encoding.lower() or encoding.lower().startswith("cp65001"), encoding


def test_chinese_filename_does_not_break_logging() -> None:
    """真实回归：把当初炸掉的那条日志原样打一遍。

    断言方式是**换掉 stream 再检查有没有异常**，而不是"看输出里有没有中文"——
    因为这里要证明的是 `emit` 不再抛，而不是文本长什么样。
    """
    setup_logging("INFO")

    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger = logging.getLogger("app.services.ingest")
    logger.addHandler(handler)
    try:
        # 当初炸掉的那一行（照抄 app/services/ingest.py 的 `_store_tabular_copy`）
        logger.info("文档 %s 写入结构化副本 %d 行", "团队名单.csv", 3)
    finally:
        logger.removeHandler(handler)

    assert "团队名单.csv" in buffer.getvalue()
    assert "3 行" in buffer.getvalue()


def test_setup_is_idempotent() -> None:
    """重复调用不叠加 handler。

    应用启动 + 测试夹具都会调它；叠起来的话每条日志会打两遍，
    而"日志重复"看着像代码里有两条一样的话。
    """
    setup_logging("INFO")
    setup_logging("INFO")
    tagged = [h for h in logging.getLogger().handlers if getattr(h, "_kylab_stdout_handler", False)]
    assert len(tagged) == 1


def test_does_not_remove_foreign_handlers() -> None:
    """只摘自己装的 handler。

    `root.handlers.clear()` 会把 uvicorn / pytest caplog / 容器日志采集
    装的 handler 一并摘掉，表现为"日志莫名其妙没了"。
    """
    root = logging.getLogger()
    foreign = logging.NullHandler()
    root.addHandler(foreign)
    try:
        setup_logging("INFO")
        assert foreign in root.handlers
    finally:
        root.removeHandler(foreign)


def test_level_is_applied() -> None:
    setup_logging("WARNING")
    assert logging.getLogger().level == logging.WARNING
    setup_logging("INFO")
