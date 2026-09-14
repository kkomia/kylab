"""全局配置。

约定（工程规范 §6）：
- 密钥只从环境变量读取，模板见 ``backend/.env.example``，禁止入库；
- 用户级配置（解析节点、API Key、模型登记）运行期落**数据库**，M1 起接管。

**两级配置，别混**（v0.12 起明确）：

1. **引导级**（本文件）：连不上就起不来的东西——数据库连接串、对象存储凭据、
   数据目录。它们**只能来自环境变量**，因为"把数据库连接串存进数据库"是鸡生蛋。
2. **运行期级**（``app_settings`` 表）：可以在网页上改、改完即刻生效的东西——
   解析节点 token、模型登记、推荐问题开关。这些落库，带掩码，不回显明文。
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
    app_version: str = "0.1.0"
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

    # ---- 存储后端（引导级：只能在环境变量里给）----------------------------
    #
    # v0.12 起存储改为 **PostgreSQL（元数据 + 向量 + 全文）+ 对象存储（原件）
    # + DuckDB（表格副本）**，SQLite 退役。装配点仍只有一处：
    # ``core/storage.py::build_stores()``，它按这里的配置构造实现并在启动时校验。

    database_url: str | None = None
    """PostgreSQL 连接串，例如 ``postgresql://kylab:secret@postgres:5432/kylab``。

    **必填**（SQLite 已于 v0.12 退役）。这里声明成可选只是为了"缺配置"能由
    ``build_stores()`` 给一句可操作的报错，而不是在构造 Settings 时就抛一句
    pydantic 的字段错误——前者能告诉运维该填什么。
    启动时会校验连通性、``vector`` 扩展与 schema 版本，失败即退出。
    """

    s3_endpoint: str | None = None
    """S3 兼容对象存储的端点（MinIO 形如 ``http://minio:9000``）。

    留空时原件落本地文件系统（``data_dir/{originals,markdown,images}``）——
    测试与本地开发需要这条不联网的路径。
    与 ``database_url`` 同一原则：这是引导级配置，不能存库。
    """
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_bucket: str = "kylab"
    s3_region: str = "us-east-1"
    """MinIO 不校验 region，但 S3 SDK 需要一个非空值。"""
    s3_secure: bool = False
    """是否用 HTTPS 连对象存储。容器内网互通时为假（MinIO 默认 http）。"""
    s3_prefix: str = ""
    """桶内的 key 前缀，便于一个桶放多套环境。留空即桶根。"""

    # 鉴权（M4 T4.4；《架构设计 v0.2》§3.2）
    #
    # v0.11：**鉴权永远生效**，没有开关也没有第二种管理员凭据。
    # 第一次打开时唯一能调的是 /auth/status 与 /auth/setup（先建管理员账号），
    # 之后一律用会话令牌或 API Key。原先的 KYLAB_AUTH_ENABLED 与
    # KYLAB_CONSOLE_TOKEN 都已取消——"还没配"与"忘了配"在代码上无法区分，
    # 于是"没配就放行"等于"无账号即裸奔"。

    url_signing_secret: str | None = None
    """下载签名 URL 的密钥。

    浏览器里 ``<img>`` 与下载链接带不了 Authorization 头，所以"有权访问"这件事
    要编码进 URL 本身——这就是签名 URL 的全部理由。
    首次 ``POST /auth/setup`` 会自动生成一条落库；这里是给不想落库的部署用的
    环境变量入口。
    """

    # 云端解析节点（M2 启用）
    mineru_token: str | None = None
    paddleocr_token: str | None = None

    # Embedding（M2 启用；模型切换规则见架构设计 v0.2 §6.4）
    #
    # **模型的地址 / 密钥 / 名称 / 维度不在这里**：它们属于"注册了哪个模型"，
    # 统一由模型注册表（供应商 → 模型）承担，见 services/model_registry.py。
    # 这里是**行为参数**，不是模型身份。
    embedding_batch_size: int = 32

    dev_embedding: bool = False
    """开发用确定性嵌入（哈希）开关，**默认关闭，生产不要开**。

    关闭时"没配嵌入模型"就是**没配**：建库被拒、向量通道跳过，界面上如实说明。
    打开它才会退回无语义的词面哈希——这个开关存在的唯一理由是离线开发与测试
    需要一条不联网的链路，而不是给产品留一条"看起来能用"的假路径。
    """

    # 对话模型（M6 快速检索问答）
    # 地址 / 密钥 / 模型名同样由注册表决定，这里只留采样与思考开关
    llm_temperature: float = 0.3
    llm_enable_thinking: bool = True
    """思考开关，**默认开**：主流模型默认都思考，关掉是例外而不是常态。

    不同供应商用不同字段表达它（DeepSeek 认 ``thinking.type``、Qwen 认
    ``enable_thinking``），翻译见 ``services/thinking.py``。
    """
    llm_thinking_effort: str = "medium"
    """思考强度（low / medium / high），同样按方言翻译或丢弃。"""

    @property
    def cors_origin_list(self) -> list[str]:
        """把逗号分隔的 CORS 白名单拆成列表。"""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    """带缓存的配置单例，供依赖注入使用。"""
    return Settings()
