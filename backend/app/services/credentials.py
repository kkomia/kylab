"""旧明文收编：把本机库里那几处凭据搬进系统钥匙串（M5 阶段 6，方案 §4.2 / §4.3）。

## 搬哪几处、不搬哪几处（方案 §4.2 那张表）

**收编这两处**（读路径也跟着改道了，见 ``runtime_config`` / ``model_registry``）：

1. ``app_settings['web.search_api_key']`` → ``kylab:setting:web.search_api_key``
   （联网搜索真的在读它；迁完**删掉库里那一行**）；
2. ``model_providers.api_key`` → ``kylab:model_provider:<id>``
   （模型注册表在读；迁完**清列**，行本身留着）。

**壳侧那一处**（``config.json.api_key`` → ``kylab:nas_token:<origin>``）由壳自己迁
（方案 §4.2 #1：首次运行读到明文 → 写钥匙串 → 清 ``config.json`` 那一栏）；
这一层只把读写备好（:meth:`CredentialsService.nas_token` 三个方法），供壳与阶段 8 用。

**只登记、不迁**（这里一行代码都没有——留在库里是**有意的**，不是漏了）：

- ``mineru.token`` / ``paddleocr.token`` —— 本机档不解析文档，没人读它；
- ``mcp_servers.env`` / ``headers`` —— 本机档没接 MCP，且任意键值对可能超单条上限；
- NAS 服务端引导级（PG 口令 / S3 密钥 / 解析 token）—— 那是服务器档的家当，
  **不进本机钥匙串**（R14 的边界）。

这份清单写在这里，是为了让下一个人不必重新判一遍"哪些该收、哪些不该收"。

## 四条纪律

1. **逐项幂等**：钥匙串里已经有同一个值 → 跳过（顺手把库里那份重复的清掉）；
   **库里已经空了 → 那一项根本不出现**（"没什么可迁"不是"跳过了一项"）；
2. **先写钥匙串、后清库**：顺序反过来的话，一次崩在中间就永久丢了一把钥匙
   （而"库里还有明文"至少是可重跑的状态）；
3. **失败不清明文**（§4.3-5）：那一条进 ``failed``、库里那份原样留着，
   下次可以重跑——"不清就不算迁完"；
4. **清页**：迁移完在源库上收一次空闲页（见 :meth:`CredentialsService._shrink`
   那段"能做的与做不到的"）。

## 过渡态可观测（§4.2 末段）

**不静默迁移**：改用户的存储位置要有意识。所以有一个能读到的数
（:meth:`CredentialsService.status` → ``pending_migration``）与一个显式入口
（端点 ``POST /local/secrets/migrate``、面板按钮、CLI
``python -m app.services.credentials migrate``）——迁移完成前"库里有值、钥匙串没有"
是唯一允许的中间态，而它就等于 ``pending_migration > 0``。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.core.exceptions import SecretStoreUnavailable
from app.services.runtime_config import mask_secret
from app.services.secrets import (
    SecretStore,
    model_provider_target,
    nas_token_target,
    normalize_origin,
    platform_store,
    setting_target,
)
from app.storage.base import ModelProviderRecord, StoreBundle

__all__ = [
    "MIGRATED_SETTING_KEYS",
    "REGISTERED_ONLY_CELLS",
    "CredentialsService",
    "MigrationReport",
    "main",
]

logger = logging.getLogger(__name__)

MIGRATED_SETTING_KEYS: tuple[str, ...] = ("web.search_api_key",)
"""``app_settings`` 里**真的会被搬走**的那几个键（收编档）。

加一个新键之前先回答两个问题：**谁在读它**（本机档上真的有人读吗）、
它会不会超过钥匙串单条上限（2560 字节）。答不上来就进
:data:`REGISTERED_ONLY_CELLS`——"只登记"是一个正当结论，不是待办。
"""

REGISTERED_ONLY_CELLS: tuple[tuple[str, str], ...] = (
    ("app_settings", "mineru.token"),
    ("app_settings", "paddleocr.token"),
    ("mcp_servers", "env"),
    ("mcp_servers", "headers"),
)
"""**只登记、不迁**的那几处（方案 §4.2）与理由——这份清单是给读代码的人看的。

它同时是一份"我们想过这件事"的证据：将来谁要收编其中一处，先删掉这里的一行，
再去改 :data:`MIGRATED_SETTING_KEYS` / 加一条新的迁移动作。
"""

_ITEM_SETTING = "setting"
_ITEM_PROVIDER = "model_provider"


@dataclass(slots=True)
class MigrationReport:
    """迁移结果：**逐项**说清"迁了 / 跳过了（为什么）/ 失败了（为什么）"。

    ``store`` 是 ``available`` / ``unavailable``（与 :meth:`CredentialsService.status`
    同一个词表）；``pending_migration`` 是**跑完之后**还剩几处——成功是 0，
    有失败的就是失败的那几处（那个数就是"可重跑"的判据）。
    """

    store: str
    migrated: list[dict[str, str]] = field(default_factory=list)
    skipped: list[dict[str, str]] = field(default_factory=list)
    failed: list[dict[str, str]] = field(default_factory=list)
    pending_migration: int = 0

    @property
    def ok(self) -> bool:
        """一处都没失败才算成功（**没有任何明文时也算**：本来就没得迁）。"""
        return not self.failed

    def as_dict(self) -> dict[str, Any]:
        return {
            "store": self.store,
            "migrated": self.migrated,
            "skipped": self.skipped,
            "failed": self.failed,
            "pending_migration": self.pending_migration,
        }


@dataclass(slots=True)
class _Item:
    """一条待迁的明文：名字（报告里那一项）+ 值 + 钥匙串里的名字 + **怎么清掉库里那份**。"""

    item: str
    value: str
    target: str
    clear: Callable[[], None]


class CredentialsService:
    """把本机库里那几处明文凭据收进系统钥匙串（方案 §4.2）。

    它是**显式动作**的服务：没有任何调用点会顺手调它（不静默迁移），
    三个入口（端点 / 面板 / CLI）都落在 :meth:`migrate` 上。
    """

    def __init__(self, stores: StoreBundle, secrets: SecretStore) -> None:
        self._stores = stores
        self._secrets = secrets

    # ------------------------------------------------------------------ 读

    def status(self) -> dict[str, Any]:
        """``GET /local/secrets`` 的那两个字段（**只报数与可用性，绝不回显秘密**）。

        ``pending_migration`` 在钥匙串不可用的档上恒为 0——那种机器上"等着迁"这件事
        根本不存在（库就是凭据的家，R14 的服务器档与 §4.5 的 CI 边界都是这一支）。
        """
        return {"store": self._store_word(), "pending_migration": self.pending()}

    def pending(self) -> int:
        """库里还有几处明文等着迁（**不可用时恒 0**，理由见 :meth:`status`）。"""
        if not self._secrets.available():
            return 0
        return len(self._items())

    # ------------------------------------------------------------------ 迁

    def migrate(self) -> MigrationReport:
        """把待迁的明文逐项搬进钥匙串，迁一项清一项；**返回报告**（不抛逐项失败）。

        钥匙串**整条不可用**时抛 :class:`SecretStoreUnavailable`（端点翻成 503）：
        那种情况下"逐项失败"没有意义——一项都写不进去，而报告里 N 条一模一样的
        "写不进去"比一句"这台机器没有钥匙串"难懂得多。
        """
        if not self._secrets.available():
            raise SecretStoreUnavailable(
                "这台机器没有可用的系统钥匙串（Windows 凭据管理器）："
                "凭据只能留在本机库里，做不到「收进钥匙串」这一步。"
                "（Linux 桌面 / 容器 / CI 都属于这一档，方案 §4.5 的边界）"
            )
        report = MigrationReport(store=self._store_word())
        for item in self._items():
            try:
                self._move(item, report)
            except Exception as exc:  # 写不进去 → **不清明文**，如实报，下次可重跑
                reason = str(exc) or exc.__class__.__name__
                report.failed.append({"item": item.item, "reason": reason})
                logger.warning("这一项没迁成（%s）：%s", item.item, reason)
        if report.migrated or report.skipped:
            self._shrink()
        report.pending_migration = self.pending()
        logger.info(
            "凭据收编：迁了 %d、跳过 %d、失败 %d（还剩 %d 处明文）",
            len(report.migrated),
            len(report.skipped),
            len(report.failed),
            report.pending_migration,
        )
        return report

    def _move(self, item: _Item, report: MigrationReport) -> None:
        """搬一条：**先写钥匙串、后清库**（顺序反了会在崩溃时永久丢钥匙）。"""
        existing = self._secrets.get(item.target)
        if existing == item.value:
            # 幂等：上一次已经迁过，只剩库里这份重复的
            item.clear()
            report.skipped.append(
                {"item": item.item, "reason": "钥匙串里已经是同一个值；库里那份重复的已清掉"}
            )
            return
        if existing is not None:
            # 钥匙串里有一份**不一样**的：用户在这之后又改过（新值只落钥匙串），
            # 所以以钥匙串为准，库里那份是旧的。**不覆盖钥匙串**（那会把用户的新值抹掉）。
            item.clear()
            report.skipped.append(
                {
                    "item": item.item,
                    "reason": "钥匙串里已有一份不同的值（以钥匙串为准）；库里那份旧的已清掉",
                }
            )
            return
        self._secrets.set(item.target, item.value)
        item.clear()
        report.migrated.append({"item": item.item, "reason": ""})

    def _shrink(self) -> None:
        """清页：把腾出来的那些页真的交还给系统（方案 §4.3-3）。

        **做得到与做不到的，都写在这里**（做不到的那一半要登记，不假装收编了）：

        - 做得到：``MetaStore.vacuum()``。``VACUUM`` 重建整份库文件，被删的行与被清的列
          连同它们占过的页一起消失——判据是"库文件原始字节里 grep 哨兵串 0 命中"
          （``tests/unit/services/test_credentials.py`` 那条，与阶段 2 的擦洗同一手法）；
        - 做不到：``PRAGMA secure_delete = ON`` 与 ``wal_checkpoint(TRUNCATE)``。
          前者是**每连接**的 PRAGMA，后者要把 ``-wal`` 收进主库——两件事都住在
          ``storage/sqlite_impl/``，而 ``services/`` 不许 import ``sqlite3``（L2），
          ``MetaStore.vacuum()`` 是这一层唯一够得到的维护入口。

        现场影响（量过，见阶段 6 报告的偏离一节）：本次运行期间 ``-wal`` 里还留着
        那几帧旧明文，边车退出时 ``Database.close()`` 会做一次
        ``wal_checkpoint(TRUNCATE)`` 把它收干净（关库之后整个数据目录 0 命中）。
        要在**不重启**的前提下就做到"两个文件都干净"，落点是 storage 层加一个
        ``secure_erase(...)``（``secure_delete`` + 删 + ``VACUUM`` + 收 WAL 一次做完）
        ——那属于 ``storage/**``，留给阶段 8 的物证那一轮。
        """
        self._stores.meta.vacuum()

    # ------------------------------------------------------------------ 待迁清单

    def _items(self) -> list[_Item]:
        """库里还剩哪些明文（**只有非空的才算**：空串不是秘密）。

        "库里已空 → skip" 在报告里表现为**那一项根本不出现**：没有明文就没有待迁项，
        而报告是给"要不要再跑一次"用的判据——把一堆"没什么可迁"的行列进去，
        真正的失败会淹在里面。
        """
        found: list[_Item] = []
        for key in MIGRATED_SETTING_KEYS:
            value = self._stores.meta.get_setting(key)
            if not (value or "").strip():
                continue
            found.append(
                _Item(
                    item=f"{_ITEM_SETTING}:{key}",
                    value=value,
                    target=setting_target(key),
                    clear=_DeleteSetting(self._stores, key),
                )
            )
        for record in self._stores.meta.list_model_providers():
            value = (record.api_key or "").strip()
            if not value:
                continue
            found.append(
                _Item(
                    item=f"{_ITEM_PROVIDER}:{record.id}",
                    value=value,
                    target=model_provider_target(record.id),
                    clear=_ClearProviderKey(self._stores, record),
                )
            )
        return found

    def _store_word(self) -> str:
        return "available" if self._secrets.available() else "unavailable"

    # ------------------------------------------------------------------ NAS 钥匙（壳侧那半）

    def nas_token(self, origin: str) -> str | None:
        """读 NAS 长期钥匙（``kylab:nas_token:<origin>``）；``None`` = 没配。

        给**壳侧那半**与阶段 8 的对拍用（壳启动时自己也会读同一把），
        后端这条路本身不需要它——边车的 ``--token`` 仍然从引导级来（R3/R14：
        令牌不进 HTTP 请求体、不落库）。
        """
        return self._secrets.get(nas_token_target(origin))

    def set_nas_token(self, origin: str, token: str) -> None:
        """写 NAS 长期钥匙（壳侧首次运行把 ``config.json`` 里那份明文迁进来时用）。"""
        self._secrets.set(nas_token_target(origin), token)

    def delete_nas_token(self, origin: str) -> None:
        """删 NAS 长期钥匙（退出登录 / 换 NAS 时用）。"""
        self._secrets.delete(nas_token_target(origin))


class _DeleteSetting:
    """清掉库里那一行（``app_settings``：**删行**而不是写空——方案 §4.2 的原话）。"""

    __slots__ = ("_key", "_stores")

    def __init__(self, stores: StoreBundle, key: str) -> None:
        self._stores = stores
        self._key = key

    def __call__(self) -> None:
        self._stores.meta.delete_setting(self._key)


class _ClearProviderKey:
    """清掉 ``model_providers.api_key`` 那一列（**清列**，行本身要留着）。"""

    __slots__ = ("_record", "_stores")

    def __init__(self, stores: StoreBundle, record: ModelProviderRecord) -> None:
        self._stores = stores
        self._record = record

    def __call__(self) -> None:
        # 拿一条新的记录再清：`_items()` 到清这一下之间可能有别的写入
        # （迁移是秒级的显式动作，但"读旧值再整行写回"会顺手把别的字段带回旧版本）
        fresh = self._stores.meta.get_model_provider(self._record.id)
        if fresh is None:  # pragma: no cover - 迁移期间被删掉了
            return
        fresh.api_key = ""
        self._stores.meta.update_model_provider(fresh)


# ------------------------------------------------------------------ CLI


def _local_stores(data_dir: Path) -> StoreBundle:
    """CLI 这条路的装配：**按本机档**建库（与 ``legacy_import`` / ``backup_restore``
    那两处同一手法）。

    环境变量四个与 ``sidecar.pin_local_deployment`` 一模一样（``KYLAB_DATABASE_URL``
    **设空串**而不是删掉——本机 ``.env`` 里真的配了它，删掉会让它"复活"）。
    """
    from app.core.config import get_settings
    from app.core.storage import build_stores

    os.environ["KYLAB_DEPLOYMENT"] = "local"
    os.environ["KYLAB_DATABASE_URL"] = ""
    os.environ["KYLAB_DATA_DIR"] = str(data_dir)
    get_settings.cache_clear()
    return build_stores(get_settings())


def _parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        prog="python -m app.services.credentials",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=(
            "把本机库里的旧明文凭据收进 Windows 凭据管理器（M5 阶段 6）。\n"
            "\n"
            "  status     这台机器有没有钥匙串、还有几处明文等着迁（不改任何东西）\n"
            "  migrate    逐项搬进钥匙串并清掉库里那份（幂等，可重跑）\n"
            "  nas-token  NAS 长期钥匙（kylab:nas_token:<origin>）的读 / 写 / 删\n"
            "\n"
            "边车在跑的时候也能跑：迁移是「写钥匙串 + 清库」两步，不碰库文件本身。\n"
            "清页那一步会 VACUUM 一次（几 GB 的库可能要几十秒）。"
        ),
    )


def _build(data_dir: Path) -> CredentialsService:
    return CredentialsService(_local_stores(data_dir), platform_store())


def main(argv: Sequence[str] | None = None) -> int:
    """CLI 入口：``status`` 只看不动、``migrate`` 真迁、``nas-token`` 读写壳那把钥匙。"""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = _parser()
    parser.add_argument("command", choices=("status", "migrate", "nas-token"), help="要做什么")
    parser.add_argument("--data-dir", required=True, help="本机数据目录（库就在它下面）")
    parser.add_argument("--origin", default="", help="nas-token：NAS 地址（如 http://nas:8090）")
    parser.add_argument("--set", default="", help="nas-token：写这一把（与 --delete 互斥）")
    parser.add_argument("--delete", action="store_true", help="nas-token：删掉那一条")
    parser.add_argument(
        "--show",
        action="store_true",
        help="nas-token：把值打出来（默认只打掩码；跨侧对拍时用它）",
    )
    args = parser.parse_args(argv)
    # nas-token 不需要库（它只碰钥匙串）——但为了与另外两个子命令同一套装配，仍然建库：
    # "边车在跑的时候也能跑"是这三个命令共同的前提，多开一条连接不值得省。
    service = _build(Path(args.data_dir))
    try:
        if args.command == "status":
            return _status_command(service)
        if args.command == "migrate":
            return _migrate_command(service)
        return _nas_token_command(service, args)
    except SecretStoreUnavailable as exc:
        print(f"这台机器收不了：{exc}", file=sys.stderr)
        return 1


def _nas_token_command(service: CredentialsService, args: argparse.Namespace) -> int:
    """``nas-token``：壳那半写的那把钥匙，后端这一侧读得到吗（阶段 8 的对拍用这一条）。"""
    origin = (args.origin or "").strip()
    if not origin:
        print("要给出 NAS 地址：--origin http://nas:8090", file=sys.stderr)
        return 1
    if args.set and args.delete:
        print("--set 与 --delete 只能给一个", file=sys.stderr)
        return 1
    if args.set:
        service.set_nas_token(origin, args.set)
        print(f"已写入 kylab:nas_token:{normalize_origin(origin)}")
        return 0
    if args.delete:
        service.delete_nas_token(origin)
        print(f"已删除 kylab:nas_token:{normalize_origin(origin)}")
        return 0
    value = service.nas_token(origin)
    if value is None:
        print(f"{normalize_origin(origin)}：没配（壳还没登录过，或者那把钥匙没迁进来）")
        return 1
    print(value if args.show else mask_secret(value), end="\n")
    return 0


def _status_command(service: CredentialsService) -> int:
    status = service.status()
    print(json.dumps(status, ensure_ascii=False, indent=2))
    if status["store"] == "unavailable":
        print("本机没有可用的系统钥匙串：凭据只能留在本机库里", file=sys.stderr)
        return 0
    print(f"还有 {status['pending_migration']} 处明文等着迁（跑 migrate 收编）")
    return 0


def _migrate_command(service: CredentialsService) -> int:
    report = service.migrate()
    print(json.dumps(report.as_dict(), ensure_ascii=False, indent=2))
    for item in report.failed:
        print(f"没迁成：{item['item']}（{item['reason']}）", file=sys.stderr)
    print(
        f"迁了 {len(report.migrated)}、跳过 {len(report.skipped)}、失败 {len(report.failed)}；"
        f"还剩 {report.pending_migration} 处明文"
    )
    return 0 if report.ok else 1


if __name__ == "__main__":  # pragma: no cover - 进程入口
    raise SystemExit(main())
