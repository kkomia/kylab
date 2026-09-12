"""常见供应商预设（"添加供应商"时一键填好地址与常见模型）。

**解决的是什么**：登记一个供应商，最会填错的是**接口地址**——各家都不一样，
而且同一家的"原生地址"和"OpenAI 兼容地址"常常不是一个（百炼要加
``/compatible-mode/v1``、Gemini 要加 ``/v1beta/openai/``）。让用户去翻文档抄地址，
是纯粹的摩擦。

**只放事实，不放代码**：这里是一条条"名称 + 地址 + 常见模型 ID"的数据。
模型清单是**便利快照**（取自 models.dev 的公开数据，2026-09），会过时——
所以它只是候选建议，**真正的权威来源仍然是上游探测**（``/providers/{id}/available-models``）：
用户点开「添加模型」时既能选这里的建议，也能选探测回来的，还能直接手写。

**只列 OpenAI 兼容端点**：我们的对话客户端只实现 ``/chat/completions``
（见 ``services/llm.py``）。原生协议（Anthropic Messages、Gemini generateContent）
不在这里——列出来用户配了也用不了，比不列更糟。走兼容层的会在 ``hint`` 里说明。
"""

from __future__ import annotations

from dataclasses import dataclass, field

__all__ = ["PROVIDER_PRESETS", "PresetModel", "ProviderPreset"]


@dataclass(frozen=True, slots=True)
class PresetModel:
    """预设里的一条模型建议。``dim`` 只有向量化模型才有意义。"""

    model_id: str
    label: str = ""
    capabilities: tuple[str, ...] = ("chat",)
    dim: int | None = None


@dataclass(frozen=True, slots=True)
class ProviderPreset:
    """一家常见供应商。``base_url`` 一律是 **OpenAI 兼容**地址。"""

    id: str
    label: str
    kind: str
    base_url: str
    hint: str = ""
    models: tuple[PresetModel, ...] = field(default_factory=tuple)


PROVIDER_PRESETS: tuple[ProviderPreset, ...] = (
    ProviderPreset(
        id="deepseek",
        label="深度求索 DeepSeek",
        kind="llm",
        base_url="https://api.deepseek.com",
        hint="推理模型默认思考；密钥在 platform.deepseek.com 申请。",
        models=(
            PresetModel("deepseek-flash", "DeepSeek Flash"),
            PresetModel("deepseek-v4-pro", "DeepSeek V4 Pro"),
            PresetModel("deepseek-v4-flash", "DeepSeek V4 Flash"),
        ),
    ),
    ProviderPreset(
        id="dashscope",
        label="阿里云百炼（通义千问）",
        kind="llm",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        hint="中国大陆地址；国际站是 dashscope-intl.aliyuncs.com。思考开关走 enable_thinking。",
        models=(
            PresetModel("qwen3.8-max", "Qwen3.8 Max"),
            PresetModel("qwen3.8-flash", "Qwen3.8 Flash"),
            PresetModel("qwen3.7-plus", "Qwen3.7 Plus"),
        ),
    ),
    ProviderPreset(
        id="moonshot",
        label="月之暗面 Kimi",
        kind="llm",
        base_url="https://api.moonshot.cn/v1",
        hint="中国大陆地址；国际站是 api.moonshot.ai。",
        models=(
            PresetModel("kimi-k3", "Kimi K3"),
            PresetModel("kimi-k2.6", "Kimi K2.6"),
        ),
    ),
    ProviderPreset(
        id="zhipu",
        label="智谱 GLM",
        kind="llm",
        base_url="https://open.bigmodel.cn/api/paas/v4",
        hint="思考开关走 thinking.type。",
        models=(
            PresetModel("glm-5.3", "GLM-5.3"),
            PresetModel("glm-5.3-flash", "GLM-5.3 Flash"),
            PresetModel("glm-5.2", "GLM-5.2"),
        ),
    ),
    ProviderPreset(
        id="siliconflow",
        label="硅基流动 SiliconFlow",
        kind="llm",
        base_url="https://api.siliconflow.cn/v1",
        hint="一个地址同时提供对话、向量化与重排；下面的建议里带能力标记。",
        models=(
            PresetModel("deepseek-ai/DeepSeek-V4-Flash", "DeepSeek V4 Flash"),
            PresetModel("zai-org/GLM-5.2", "GLM-5.2"),
            PresetModel("Qwen/Qwen3.6-27B", "Qwen3.6 27B"),
            PresetModel("BAAI/bge-m3", "BGE-M3（向量化）", ("embedding",), 1024),
            PresetModel("BAAI/bge-reranker-v2-m3", "BGE Reranker v2 M3（重排）", ("rerank",), None),
        ),
    ),
    ProviderPreset(
        id="openai",
        label="OpenAI",
        kind="llm",
        base_url="https://api.openai.com/v1",
        hint="o 系 / GPT-5 系没有真正的「关闭思考」，强度走 reasoning_effort。",
        models=(
            PresetModel("gpt-5.6", "GPT-5.6"),
            PresetModel("gpt-5.5", "GPT-5.5"),
            PresetModel(
                "text-embedding-3-small", "Embedding 3 Small（向量化）", ("embedding",), 1536
            ),
            PresetModel(
                "text-embedding-3-large", "Embedding 3 Large（向量化）", ("embedding",), 3072
            ),
        ),
    ),
    ProviderPreset(
        id="anthropic",
        label="Anthropic Claude（OpenAI 兼容层）",
        kind="llm",
        base_url="https://api.anthropic.com/v1",
        hint="走 Anthropic 的 OpenAI 兼容层；其原生 Messages 协议本产品不支持。",
        models=(
            PresetModel("claude-opus-4-8", "Claude Opus 4.8"),
            PresetModel("claude-sonnet-4-6", "Claude Sonnet 4.6"),
        ),
    ),
    ProviderPreset(
        id="gemini",
        label="Google Gemini（OpenAI 兼容层）",
        kind="llm",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        hint="注意地址以 /openai/ 结尾；思考走 thinking_config / thinking_level。",
        models=(
            PresetModel("gemini-3.8-flash", "Gemini 3.8 Flash"),
            PresetModel("gemini-3.7-flash", "Gemini 3.7 Flash"),
        ),
    ),
    ProviderPreset(
        id="xai",
        label="xAI Grok",
        kind="llm",
        base_url="https://api.x.ai/v1",
        models=(
            PresetModel("grok-4.6", "Grok 4.6"),
            PresetModel("grok-4.5", "Grok 4.5"),
        ),
    ),
    ProviderPreset(
        id="ollama",
        label="Ollama（本地）",
        kind="llm",
        base_url="http://localhost:11434/v1",
        hint="本机先 ollama pull 拉好模型；可用模型随本机而定，建议用「探测」而非这里的建议。",
    ),
    # 「自定义」不在这里：选择器本身就有「自定义（手动填写）」这一项，
    # 再加一个同义条目只会让人在两个"自定义"之间犹豫。
)
