"""日志初始化。"""

import logging
import sys

_LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s | %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
_HANDLER_TAG = "_kylab_stdout_handler"


def setup_logging(level: str = "INFO") -> None:
    """配置根日志器，应用启动时调用一次。

    **只清理自己上次装的 handler**，而不是 ``root.handlers.clear()``：
    后者会把宿主进程（uvicorn、pytest 的 caplog、容器日志采集）装的 handler 一并摘掉，
    表现为"日志莫名其妙没了"。幂等：重复调用不会叠加输出。
    """
    _force_utf8_streams()

    root = logging.getLogger()
    for handler in [item for item in root.handlers if getattr(item, _HANDLER_TAG, False)]:
        root.removeHandler(handler)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT))
    setattr(handler, _HANDLER_TAG, True)  # 给 handler 打标记，便于下次识别并替换

    root.addHandler(handler)
    root.setLevel(level.upper())


def _force_utf8_streams() -> None:
    """把 stdout / stderr 切到 UTF-8。

    **这是个中文项目，而中文 Windows 的默认控制台编码是 GBK（cp936）。**
    实测：日志里出现一个中文文件名（`团队名单.csv`）就会让
    ``StreamHandler.emit`` 抛 ``UnicodeEncodeError``，logger 打出
    "--- Logging error ---" 加一长串调用栈。

    **它不会让进程崩溃**（``logging`` 自己吞掉了异常），所以这不是"致命 bug"——
    但它的实际伤害很像致命 bug：

    - 日志里看到的是一串乱码（``锟斤拷``）加一段无关的栈，**真正的那条业务日志没了**；
    - 那段栈会进 stderr，而编排/CI/采集器常常把"stderr 有输出"当成失败信号
      或者至少当成噪声——**在被误导这一点上，它与真崩溃等价**；
    - 触发条件偏偏是"出问题的时候"：文件名带中文、错误信息带中文。
      也就是说，**最需要日志的那一刻，日志最不可靠**。

    ``errors="replace"`` 而不是默认的 ``strict``：万一还有编不出来的字符
    （比如终端字体不支持的生僻字），宁可显示成 ``?`` 也不要再抛一次。
    日志的价值在"能读"，不在"一字不差"。
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            # 被重定向成非 TextIOWrapper（某些容器/CI 的管道）时没有这个接口，跳过
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):  # pragma: no cover - 已关闭的流等边缘情况
            continue
