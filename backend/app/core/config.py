"""全局配置。

约定（工程规范 §6）：
- 密钥只从环境变量读取，模板见 ``backend/.env.example``，禁止入库；
- 用户级配置（解析节点、API Key、embedding 模型）运行期落 SQLite，M1 起接管。
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

API_VERSION = "v1"
"""对外 API 主版本，所有路径前缀 ``/api/v1``（工程规范 §3.2）。"""


class Settings(BaseSettings):
    """进程级配置，环境变量前缀 ``KYLAB_``。"""

    model_config = SettingsConfigDict(
        env_prefix="KYLAB_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "kylab"
    app_version: str = "0.0.1"
    host: str = "127.0.0.1"
    port: int = 8000
    log_level: str = "INFO"
    data_dir: Path = Path("./data")
    cors_origins: str = "http://127.0.0.1:5173"
    slow_query_ms: int = 500
    """超过该耗时的检索留一条 WARNING（架构 §12 可观测性）。"""

    run_worker: bool = True
    """应用启动时是否内嵌任务消费者。测试里关掉它，改为手动驱动，避免时序不确定。"""
    worker_lease_seconds: int = 60
    """任务租约时长：worker 执行期间按 1/3 周期续租，崩溃后由超时回收兜底。"""

    @property
    def db_path(self) -> Path:
        """SQLite 主库文件（元数据 + 向量 + 全文同库，架构 §8.1）。"""
        return self.data_dir / "kylab.db"

    # 云端解析节点（M2 启用）
    mineru_token: str | None = None
    paddleocr_token: str | None = None

    # Embedding（M2 启用；模型切换规则见架构设计 v0.2 §6.4）
    embedding_base_url: str = "https://api.siliconflow.cn/v1"
    embedding_api_key: str | None = None
    embedding_model: str | None = None
    embedding_dim: int = 256
    """默认值对应开发兜底实现；换成真实模型时必须改成其真实维度（如 bge-m3 为 1024）。"""
    embedding_batch_size: int = 32

    # Rerank（M3 启用；不配置则跳过重排，架构 §5）
    rerank_base_url: str = "https://api.siliconflow.cn/v1"
    rerank_api_key: str | None = None
    rerank_model: str | None = None

    @property
    def cors_origin_list(self) -> list[str]:
        """把逗号分隔的 CORS 白名单拆成列表。"""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    """带缓存的配置单例，供依赖注入使用。"""
    return Settings()
