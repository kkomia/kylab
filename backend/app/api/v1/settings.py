"""设置端点（凭据与模型）：读写运行期配置 + 连接测试。

设计口径见《界面信息架构草案》§3：

- **读取**只给掩码与"是否已配置"，永不回显明文；
- **写入**留空表示不改动密钥，显式清空才删除；
- **测试连接**是"编辑动作的一部分"，所以结果就返回给弹窗，不另开一层页面。

测试连接刻意做得很轻：只验证"凭据能不能用、模型在不在、维度对不对"，
不做一次真实解析或索引——否则用户点一下"测试"就消耗掉一次配额。
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends

from app.api.auth import require_console
from app.api.v1.schemas import (
    SettingsPatchIn,
    SettingsPatchOut,
    SettingsViewOut,
    TestConnectionOut,
)
from app.core.services import Services, get_services
from app.services.api_key import Caller
from app.services.runtime_config import SECRET_KEYS

router = APIRouter(tags=["settings"])

_PROBE_TEXT = "kylab 连接测试"
_TEST_TIMEOUT_SECONDS = 30.0


@router.get("/settings", response_model=SettingsViewOut, summary="运行期配置（密钥打码）")
async def read_settings(
    services: Services = Depends(get_services),
    _: Caller = Depends(require_console),
) -> SettingsViewOut:
    view = services.runtime.describe()
    return SettingsViewOut.model_validate(
        {
            "groups": view["groups"],
            "embedding_model_id": services.embedder.model_id,
            "embedding_dim": services.embedder.dim,
            "embedding_is_development": services.embedder.is_development,
            "rerank_enabled": services.reranker.enabled,
        }
    )


@router.patch("/settings", response_model=SettingsPatchOut, summary="更新运行期配置")
async def update_settings(
    payload: SettingsPatchIn,
    services: Services = Depends(get_services),
    _: Caller = Depends(require_console),
) -> SettingsPatchOut:
    values = {item.key: item.value for item in payload.values}
    unknown = [key for key in values if key not in _KNOWN_KEYS]
    if unknown:
        # 拒绝未知键而不是静默忽略：拼错一个键却"保存成功"是最难查的一类问题
        return SettingsPatchOut(updated=0, rejected=unknown)

    services.runtime.set(values)
    return SettingsPatchOut(updated=len(values), rejected=[])


@router.post(
    "/settings/test/{target}",
    response_model=TestConnectionOut,
    summary="连通性测试（embedding / mineru / paddleocr）",
)
async def test_connection(
    target: str,
    services: Services = Depends(get_services),
    _: Caller = Depends(require_console),
) -> TestConnectionOut:
    if target == "embedding":
        return _test_embedding(services)
    if target == "mineru":
        return _test_mineru(services)
    if target == "paddleocr":
        return _test_paddleocr(services)
    if target == "llm":
        return _test_llm(services)
    return TestConnectionOut(ok=False, detail=f"不支持的目标：{target}")


# --------------------------------------------------------------------- 各目标


def _test_embedding(services: Services) -> TestConnectionOut:
    """真发一次最小请求：维度声明错了必须在这里暴露，而不是等摄入时炸。"""
    config = services.runtime.embedding()
    if not config.is_configured:
        return TestConnectionOut(ok=False, detail="尚未配置 API Key 或模型 ID")

    try:
        vectors = services.embedder.embed([_PROBE_TEXT])
    except Exception as exc:
        # 第三方错误文案要原样给用户看：401、额度不足、维度不符的处理方式完全不同
        return TestConnectionOut(ok=False, detail=str(exc))

    if not vectors:
        return TestConnectionOut(ok=False, detail="端点返回了空结果")
    actual = len(vectors[0])
    if actual != config.dim:
        return TestConnectionOut(
            ok=False,
            detail=(
                f"模型实际输出 {actual} 维，设置里写的是 {config.dim} 维；"
                "维度不符会污染向量空间"
            ),
        )
    return TestConnectionOut(
        ok=True,
        detail=f"{config.model_id} 可用，维度 {actual}",
    )


def _test_mineru(services: Services) -> TestConnectionOut:
    """只验鉴权：故意发一个不存在的 batch_id，401 说明 token 有问题，其他都算通过。"""
    config = services.runtime.mineru()
    if not config.is_configured:
        return TestConnectionOut(ok=False, detail="尚未配置 API Token")

    url = f"{config.endpoint}/extract-results/batch/kylab-connection-test"
    try:
        response = httpx.get(
            url,
            headers={"Authorization": f"Bearer {config.token}"},
            timeout=_TEST_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        return TestConnectionOut(ok=False, detail=f"无法连接 MinerU：{exc}")

    if response.status_code == 401:
        return TestConnectionOut(ok=False, detail="Token 无效或已过期（90 天不可续期）")
    return TestConnectionOut(ok=True, detail="Token 可用（未消耗解析额度）")


def _test_paddleocr(services: Services) -> TestConnectionOut:
    """同样只验鉴权：查询一个不存在的 job，401/403 才算失败。"""
    config = services.runtime.paddleocr()
    if not config.is_configured:
        return TestConnectionOut(ok=False, detail="尚未配置 API Token")

    try:
        response = httpx.get(
            f"{config.endpoint}/kylab-connection-test",
            headers={"Authorization": f"bearer {config.token}"},
            timeout=_TEST_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        return TestConnectionOut(ok=False, detail=f"无法连接 PaddleOCR：{exc}")

    if response.status_code in (401, 403):
        return TestConnectionOut(ok=False, detail="Token 无效或已过期")
    return TestConnectionOut(ok=True, detail="Token 可用（未消耗解析额度）")


def _test_llm(services: Services) -> TestConnectionOut:
    """真发一次最小对话：这是唯一能验证"模型会不会说话"的办法。

    只看鉴权是不够的——推理模型在 max_tokens 不够时 `content` 会是空的，
    那正是最需要被测出来的坑（实测过）。
    """
    config = services.runtime.llm()
    if not config.is_configured:
        return TestConnectionOut(ok=False, detail="尚未配置 API Key 或模型 ID")

    try:
        answer = services.chat.probe()
    except Exception as exc:  # 第三方错误文案要原样给用户看
        return TestConnectionOut(ok=False, detail=str(exc))

    if not answer.strip():
        return TestConnectionOut(
            ok=False,
            detail="模型返回了空内容：若是推理模型，请关闭「深度思考」或调大最大回复长度",
        )
    return TestConnectionOut(ok=True, detail=f"{config.model_id} 可用（回复：{answer[:20]}）")


_KNOWN_KEYS = frozenset(
    {
        "embedding.base_url",
        "embedding.api_key",
        "embedding.model_id",
        "embedding.dim",
        "embedding.batch_size",
        "rerank.base_url",
        "rerank.api_key",
        "rerank.model_id",
        "mineru.endpoint",
        "mineru.token",
        "mineru.model_version",
        "paddleocr.endpoint",
        "paddleocr.token",
        "paddleocr.model",
        "llm.base_url",
        "llm.api_key",
        "llm.model_id",
        "llm.temperature",
        "llm.max_tokens",
        "llm.enable_thinking",
        "chat.system_prompt",
        "chat.top_k",
    }
)

# 密钥键必须都在已知键里，否则设置页"保存成功"但值写不进去
_MISSING_SECRET_KEYS = SECRET_KEYS - _KNOWN_KEYS
if _MISSING_SECRET_KEYS:  # pragma: no cover - 配置写错时立刻炸，而不是线上才发现
    raise RuntimeError(f"以下密钥键未登记：{sorted(_MISSING_SECRET_KEYS)}")
