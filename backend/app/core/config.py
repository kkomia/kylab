"""全局配置。

约定（工程规范 §6）：
- 密钥只从环境变量读取，模板见 ``backend/.env.example``，禁止入库；
- 用户级配置（解析节点、API Key、模型登记）运行期落**本机 SQLite**。

**两级配置，别混**：

1. **引导级**（本文件）：连不上就起不来的东西——数据目录、本机库文件路径、
   接的那台知识库提供者的地址与凭据。它们**只能来自环境变量**，因为"把凭据存进
   自己的库"是鸡生蛋。
2. **运行期级**（``app_settings`` 表）：可以在界面上改、改完即刻生效的东西——
   解析节点 token、模型登记、推荐问题开关。这些落库，带掩码，不回显明文。

这个进程只有**本机**一种形态（会话与设置落 ``<data_dir>/kylab.db``，知识库在别处）。
原先的"服务器档"——PostgreSQL + 对象存储 + DuckDB——随知识库产品剥离一起拆掉了，
所以这里不再有 deployment / database_url / s3_* 那几组配置。
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
    app_version: str = "0.1.1"
    host: str = "127.0.0.1"
    port: int = 8000
    log_level: str = "INFO"
    data_dir: Path = Path("./data")
    cors_origins: str = "http://127.0.0.1:5173"

    run_worker: bool = True
    """应用启动时是否拉起本机消费者（定时任务到点跑 + 本机库空闲维护）。

    测试里关掉它，改为手动驱动，避免时序不确定。
    """

    worker_lease_seconds: int = 60
    """任务租约时长（秒）。本机消费者不认领队列，但负载面板与排障文案仍读它。"""
    worker_concurrency: int = 1
    """本机允许同时跑几件事（1–8，默认 1）。

    本机没有摄取队列，这个数只影响负载面板报的"并发槽位"与定时任务的排队观感。
    **默认 1**：并发要花 CPU 与内存，而"默认炸内存"比"默认慢"更糟。
    """

    local_db: Path | None = None
    """本机库文件（默认 ``<data_dir>/kylab.db``）。

    给了就落这个路径（导入、排障、把库放到另一个盘上都靠它），不给就用数据目录下的默认名。
    """

    server_url: str | None = None
    """那台机器的 API 基址（含 ``/api/v1``），例如 ``http://nas:8000/api/v1``。

    两件事读它：**旧会话导入**的来源（`services/legacy_import.py`），以及
    知识库提供者地址的默认值（``kb_url`` 不填时继承它）。
    不设 = 这台机器这次没接别处：检索会走"知识库不可用"那条**如实报错**的路，
    而不是悄悄回退（本机根本没有那些表）。
    """

    token: str | None = None
    """那台机器的用户会话令牌（与桌面壳、前端用的是同一把）。

    名字就叫 ``token`` 是跟着环境变量 ``KYLAB_TOKEN`` 走的——壳起边车时读的就是它
    （``app/sidecar.py`` 的 ``--token`` 默认值）。**不落库、不进日志**：它是通往别处的
    凭据，本机库里只放会话数据。
    """

    kb_url: str | None = None
    """**知识库提供者**的地址覆盖（含 ``/api/v1``），例如 ``http://另一台nas:8000/api/v1``。

    而且**默认空 = 继承 ``server_url``**——绝大多数部署一个字都不用填。它存在的理由
    是两件事：**排障**（临时指到另一个地址看看）与**多入口**（知识库在另一台机器上）。
    **凭据不跟着走**：``kb_token`` 不填时仍用 ``token``，要连另一台得先有它的钥匙。

    运行期那一处的覆盖键是 ``provider.knowledge.base_url``（设置页可改、改完即刻生效：
    提供者客户端每次调用现取目标，见 ``services/knowledge_provider.py``）。
    """

    kb_token: str | None = None
    """知识库提供者的凭据覆盖。**默认空 = 继承 ``token``**（壳领的那把）。

    与 ``token`` 同一条纪律：**不落库、不进日志**——它只从引导级（环境变量 / 壳）来，
    本机库里存不下它，设置面板也只显示"配没配"。
    """

    device_id: str = ""
    """**这台机器的设备身份**（桌面壳生成的 UUID v4）。

    它从哪来：壳在登录那一刻生成一次、写进自己的 ``config.json``，之后**每次起边车都
    用 ``--device-id`` 传下来**（``app/sidecar.py::main`` 的默认值读 ``KYLAB_DEVICE_ID``）。
    所以本机后端这一侧只需要"接住它"，不需要任何生成逻辑。

    **绝不自动生成**：快照按 ``<device_id>-<ts>-<hash8>`` 命名，恢复点按"哪台设备"分组
    ——编一个 id 会让同一台机器在远端长出两套互不相认的恢复点，而"恢复时该信哪一份"
    就没有答案了。没有它时服务层**如实拒绝打快照**（``BackupSnapshotService.create``
    那句"还有设备身份"），而不是降级成匿名。

    **它不是凭据**：写进日志/状态页没有危害（它只是一个不透明的机器标签），
    但它同样不进本机库的 ``app_settings``——它是引导级的事实，不是用户可改的设置。
    """

    url_signing_secret: str | None = None
    """下载签名 URL 的密钥。

    浏览器里 ``<img>`` 与下载链接带不了 Authorization 头，所以"有权访问"这件事
    要编码进 URL 本身——这就是签名 URL 的全部理由。
    不配也起得来：组合根会在装配时生成一条落进 ``app_settings``（见
    ``core/signing.ensure_url_signing_secret``）。这里是给不想落库的部署用的
    环境变量入口。
    """

    # 云端解析节点
    mineru_token: str | None = None
    paddleocr_token: str | None = None
    github_token: str | None = None
    """浏览 GitHub 上的技能源时用的 token（可选）。

    **不给也能用**：看公开仓库不需要认证，只是匿名配额是 60 次/小时/IP。
    给了就提到 5000 次/小时——常逛技能市场时值得配一个只读的细粒度 token。
    """
    questions_concurrency: int = 4
    """出题同时发几批（默认 4）。留给历史配置的兼容项，本机那条链路不再用它。"""

    mineru_daily_page_quota: int = 1000
    """MinerU 每日**优先额度**的页数（官方口径 1000 页/天，超出后不再保证速度）。

    它的意义在于解释"为什么解析忽然变慢"：额度用尽不是报错，是**降级排队**，
    用户只会看到"卡住不动"。负载面板把「今日已用 / 额度」显示出来，
    这种"看起来卡住"就有了可核查的原因。配额是云端政策、会变，所以做成配置。
    """

    # Embedding（模型切换规则见架构设计 v0.2 §6.4）
    #
    # **模型的地址 / 密钥 / 名称 / 维度不在这里**：它们属于"注册了哪个模型"，
    # 统一由模型注册表（供应商 → 模型）承担，见 services/model_registry.py。
    # 这里是**行为参数**，不是模型身份。
    embedding_batch_size: int = 32
    embedding_protocol: str = "openai"
    """嵌入协议（``openai`` / ``wemm``），默认 ``openai``——既有部署一位不变。

    只作为 ``.env`` 里的**引导值**（``KYLAB_EMBEDDING_PROTOCOL``）：部署时预设一次，
    之后以设置页里的值为准（与批大小同一条规则）。**地址不在 .env 里**：那台服务
    的 ``base_url`` 是"注册了哪个供应商"的一部分，由模型注册表承担——本机部署示例见
    ``backend/.env.example``。
    """

    dev_embedding: bool = False
    """开发用确定性嵌入（哈希）开关，**默认关闭，生产不要开**。

    关闭时"没配嵌入模型"就是**没配**：界面上如实说明。
    打开它才会退回无语义的词面哈希——这个开关存在的唯一理由是离线开发与测试
    需要一条不联网的链路，而不是给产品留一条"看起来能用"的假路径。
    """

    # 对话模型（采样与思考开关；地址 / 密钥 / 模型名同样由注册表决定）
    llm_temperature: float = 0.3
    llm_enable_thinking: bool = True
    """思考开关，**默认开**：主流模型默认都思考，关掉是例外而不是常态。

    不同供应商用不同字段表达它（DeepSeek 认 ``thinking.type``、Qwen 认
    ``enable_thinking``），翻译见 ``services/thinking.py``。
    """
    llm_thinking_effort: str = "medium"
    """思考强度（low / medium / high），同样按方言翻译或丢弃。"""

    # ---- 长期记忆 ----
    #
    # 这里的**两项只是 .env 引导值**：记忆的开关与落点本来由运行期配置
    # （数据库 ``app_settings`` / 设置页）持有，加这一层是为了让离线部署能在
    # .env 里一次写清。优先级仍是"库 > 这里 > 代码默认"，
    # 见 services/runtime_config.py 的三层优先级。
    #
    # 默认值一律留 ``None``（= 没设），这样不设时**回落到代码默认**而不是
    # 在配置层再抄一份——两处各写一份默认值迟早会分叉。
    memory_enabled: bool | None = None
    """是否启用长期记忆。**默认（代码里的）是关**：开着它，对话收尾会真的调一次
    模型去做自动沉淀，升级之后默默开始烧 token 是最不该有的默认。
    注意开关管的是"召回与自动沉淀"；``MEMORY.md`` / 人设那几份文件的读写
    与注入不受它影响（见 services/memory.py）。"""
    memory_workspace: str | None = None
    """记忆工作区目录，**相对数据目录**。不设时用代码默认 ``memory``。"""

    # ---- agent 模式 ----
    #
    # 与记忆那两项同一条口径：这里**只是 .env 引导值**，真正的值在运行期配置
    # （``app_settings`` 的 ``chat.mode``——输入框那一排的控件改的就是它）。
    chat_mode: str | None = None
    """Agent 模式四档 ``plan / build / edit / yolo``（枚举与语义见 ``services/modes.py``）。
    不设时用代码默认 ``build``。"""

    @property
    def cors_origin_list(self) -> list[str]:
        """把逗号分隔的 CORS 白名单拆成列表。"""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    """带缓存的配置单例，供依赖注入使用。"""
    return Settings()
