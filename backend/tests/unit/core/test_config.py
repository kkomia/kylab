"""``app/core/config.py`` 的单元测试。

镜像同构：``app/core/config.py`` → ``tests/unit/core/test_config.py``（工程规范 §5.1）。
"""

from app.core.config import API_VERSION, Settings, get_settings


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
