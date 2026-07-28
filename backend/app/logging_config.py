"""
日志配置。

标准 logging，统一 format 即可。
不做 request_id 中间件（§2.2.3 明确 P2 才考虑）。
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path


_FMT = "[%(asctime)s] %(levelname)-7s %(name)s | %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"

_configured = False


def setup_logging(debug: bool = False) -> None:
    """初始化全局日志。应在进程启动时调一次（main.py / CLI 入口）。"""
    global _configured
    if _configured:
        return

    level = logging.DEBUG if debug else logging.INFO
    formatter = logging.Formatter(_FMT, _DATEFMT)

    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()

    # stderr handler（终端实时可见）
    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(formatter)
    root.addHandler(stderr_handler)

    # 文件 handler → backend/logs/app.log
    # 从 logging_config.py 上溯两层到 backend/ 根
    log_dir = Path(__file__).resolve().parent.parent / "logs"
    log_dir.mkdir(exist_ok=True)
    file_handler = logging.FileHandler(log_dir / "app.log", encoding="utf-8")
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)

    # 应用日志器
    app_logger = logging.getLogger("zhiying")
    app_logger.setLevel(level)

    # 第三方库降噪
    for noisy in ("httpx", "httpcore", "openai", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _configured = True
    app_logger.debug("Logging initialized (level=%s, file=%s)", logging.getLevelName(level), log_dir / "app.log")


def get_logger(name: str) -> logging.Logger:
    """获取 zhiying 命名空间下的 logger。"""
    if not name.startswith("zhiying"):
        name = f"zhiying.{name}"
    return logging.getLogger(name)