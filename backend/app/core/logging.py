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
    root = logging.getLogger()
    for handler in [item for item in root.handlers if getattr(item, _HANDLER_TAG, False)]:
        root.removeHandler(handler)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT))
    setattr(handler, _HANDLER_TAG, True)  # 给 handler 打标记，便于下次识别并替换

    root.addHandler(handler)
    root.setLevel(level.upper())
