"""应用生命周期与启动装配（集成）。

守的是"服务起来的时候存储是否真的准备好了"——这一条不测，M1 的装配就只是纸面功夫。
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.storage import STORAGE_SUBDIRS, reset_stores


@pytest.fixture
def wired_app(monkeypatch, tmp_path):
    """把数据目录指到临时目录，并清掉配置与装配的缓存，避免串到别的测试。"""
    monkeypatch.setenv("KYLAB_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    reset_stores()
    try:
        from app.main import create_app

        yield create_app(), tmp_path / "data"
    finally:
        reset_stores()
        get_settings.cache_clear()


def test_lifespan_initializes_storage_on_startup(wired_app) -> None:
    app, data_dir = wired_app

    with TestClient(app) as client:
        assert client.get("/api/v1/health").status_code == 200

    assert (data_dir / "kylab.db").is_file(), "启动后应已建库并跑完迁移"
    for subdir in STORAGE_SUBDIRS:
        assert (data_dir / subdir).is_dir()


def test_startup_is_repeatable(wired_app) -> None:
    """重启（再来一次 lifespan）不应因迁移重复执行而失败。"""
    app, data_dir = wired_app

    for _ in range(2):
        with TestClient(app) as client:
            assert client.get("/api/v1/health").status_code == 200

    assert (data_dir / "kylab.db").is_file()


def test_docs_and_openapi_are_versioned(wired_app) -> None:
    app, _ = wired_app
    with TestClient(app) as client:
        assert client.get("/api/v1/docs").status_code == 200
        paths = client.get("/api/v1/openapi.json").json()["paths"]
    assert all(path.startswith("/api/v1") for path in paths)


def test_data_directory_is_respected(monkeypatch, tmp_path) -> None:
    """``KYLAB_DATA_DIR`` 必须真的生效（否则会把数据写到仓库里）。"""
    target = tmp_path / "custom-data"
    monkeypatch.setenv("KYLAB_DATA_DIR", str(target))
    get_settings.cache_clear()
    reset_stores()
    try:
        from app.main import create_app

        with TestClient(create_app()) as client:
            assert client.get("/api/v1/health").status_code == 200
        assert Path(target, "kylab.db").is_file()
    finally:
        reset_stores()
        get_settings.cache_clear()
