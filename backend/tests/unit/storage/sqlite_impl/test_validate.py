"""``sqlite_impl/validate.py`` 的单元测试：运维自检入口的退出码与结论。

镜像同构：``app/storage/sqlite_impl/validate.py``
→ ``tests/unit/storage/sqlite_impl/test_validate.py``。

``validate`` 是"部署后、排查库通不通"的那条命令，它自己的退出码就是它的契约：
**0 = 本机库可用，非 0 = 明确说明哪儿不对**。所以这里查的是退出码与那句话，
而不是把它的输出整段抄下来比对（那样每改一个字都要动用例）。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.storage.sqlite_impl import validate as validate_module
from app.storage.sqlite_impl.validate import DB_FILENAME, main

pytestmark = pytest.mark.local


def test_fresh_directory_passes_and_builds_the_library(tmp_path: Path, capsys) -> None:
    data_dir = tmp_path / "data"
    assert main(["--data-dir", str(data_dir)]) == 0
    output = capsys.readouterr().out
    assert "结论：本机库可用" in output
    assert "journal_mode = wal" in output
    assert (data_dir / DB_FILENAME).exists()


def test_existing_library_is_checked_in_place(tmp_path: Path, capsys) -> None:
    """第二次跑是**校验已有库**，不是重建（幂等）。"""
    data_dir = tmp_path / "data"
    assert main(["--data-dir", str(data_dir)]) == 0
    capsys.readouterr()
    assert main(["--data-dir", str(data_dir)]) == 0
    assert "schema 版本 = 1" in capsys.readouterr().out


def test_non_strict_sqlite_is_refused(tmp_path: Path, monkeypatch, capsys) -> None:
    """内置 SQLite 太老时**明确报错**，不降级（与 ``Database`` 同一道闸）。"""
    monkeypatch.setattr(sqlite3, "sqlite_version", "3.36.0")
    monkeypatch.setattr(sqlite3, "sqlite_version_info", (3, 36, 0))
    assert main(["--data-dir", str(tmp_path)]) == 1
    assert "STRICT 表不可用" in capsys.readouterr().out


def test_schema_newer_than_the_app_is_reported(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.setattr(validate_module, "SCHEMA_VERSION", 999)
    assert main(["--data-dir", str(tmp_path)]) == 1
    assert "应用期望" in capsys.readouterr().out


def test_missing_data_dir_argument_is_rejected() -> None:
    with pytest.raises(SystemExit, match="后面要跟一个路径"):
        main(["--data-dir"])


def test_falls_back_to_the_configured_data_dir(tmp_path: Path, monkeypatch, capsys) -> None:
    """没给 ``--data-dir`` 时取 ``KYLAB_DATA_DIR``，并且**把它打印出来**。"""
    monkeypatch.setenv("KYLAB_DATA_DIR", str(tmp_path / "配置的目录"))
    from app.core.config import get_settings

    get_settings.cache_clear()
    assert main([]) == 0
    assert str(tmp_path / "配置的目录") in capsys.readouterr().out
