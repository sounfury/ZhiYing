"""
日志配置。

标准 logging，统一 format 即可。
不做 request_id 中间件（§2.2.3 明确 P2 才考虑）。
"""
from __future__ import annotations

import logging
import sys


_FMT = "[%(asctime)s] %(levelname)-7s %(name)s | %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"

_configured = False


def setup_logging(debug: bool = False) -> None:
    """初始化全局日志。应在进程启动时调一次（main.py / CLI 入口）。"""
    global _configured
    if _configured:
        return

    level = logging.DEBUG if debug else logging.INFO

    # 根 handler → stderr
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(_FMT, _DATEFMT))

    root = logging.getLogger()
    root.setLevel(level)
    # 清掉可能已有的 handler，避免重复输出
    root.handlers.clear()
    root.addHandler(handler)

    # 应用日志器
    app_logger = logging.getLogger("zhiying")
    app_logger.setLevel(level)

    # 第三方库降噪
    for noisy in ("httpx", "httpcore", "openai", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _configured = True
    app_logger.debug("Logging initialized (level=%s)", logging.getLevelName(level))


def get_logger(name: str) -> logging.Logger:
    """获取 zhiying 命名空间下的 logger。"""
    if not name.startswith("zhiying"):
        name = f"zhiying.{name}"
    return logging.getLogger(name)