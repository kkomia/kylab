"""``app/core/config.py`` 的单元测试。

镜像同构：``app/core/config.py`` → ``tests/unit/core/test_config.py``（工程规范 §5.1）。

这些用例全是"读一遍配置对象"，不建库、不碰磁盘——配置错了要在构造那一刻就报出来。
"""

import pytest

from app.core.config import API_VERSION, Settings, get_settings

pytestmark = pytest.mark.local


def test_api_version_is_v1() -> None:
    """路径版本前缀是对外契约，改动需按工程规范 §3.2 走版本升级。"""
    assert API_VERSION == "v1"


def test_defaults_are_local_and_safe() -> None:
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    assert settings.app_name == "kylab"
    assert settings.host == "127.0.0.1"
    assert settings.data_dir.name == "data"


def test_cors_origin_list_splits_and_trims() -> None:
    settings = Settings(_env_file=None, cors_origins="http://a.test, http://b.test ,")  # type: ignore[call-arg]
    assert settings.cors_origin_list == ["http://a.test", "http://b.test"]


def test_secret_defaults_are_empty() -> None:
    """凭据类配置不得有硬编码默认值（工程规范 §6：密钥禁止入库）。"""
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    assert settings.mineru_token is None
    assert settings.paddleocr_token is None
    # 模型凭据（embedding / llm 的 key）已归注册表，连字段都不在这里了（v0.8）
    assert not hasattr(settings, "embedding_api_key")
    assert not hasattr(settings, "llm_api_key")


def test_get_settings_is_cached() -> None:
    assert get_settings() is get_settings()


def test_the_server_deployment_fields_are_gone() -> None:
    """服务器档那几组配置（部署档 / 连接串 / 对象存储 / 备份桶）**字段都不在了**。

    环境里若还留着同名变量会被静默忽略（`Settings` 是 ``extra="ignore"``），
    所以"删掉字段"这件事要有一条用例写着——否则某天有人把它们加回来也没人发现。
    """
    settings = Settings(_env_file=None)  # type: ignore[call-arg]

    for gone in ("deployment", "database_url", "s3_endpoint", "backup_bucket"):
        assert not hasattr(settings, gone)


def test_the_local_db_path_can_be_overridden(tmp_path) -> None:  # type: ignore[no-untyped-def]
    target = tmp_path / "elsewhere" / "kylab.db"
    settings = Settings(_env_file=None, local_db=target)  # type: ignore[call-arg]

    assert settings.local_db == target
    assert Settings(_env_file=None).local_db is None  # type: ignore[call-arg]
