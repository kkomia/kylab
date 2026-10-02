"""``/local/backup`` 那一族的整条链（M5 阶段 4A，方案 §7 A 的前两行 + R12）。

这条用例回答的是"**界面上按一下「立即备份」会得到什么**"：本机档的真 app
（``app.main.create_app``，本机档挂的就是 ``local_router`` 那张白名单）+ 假 NAS
（``httpx.MockTransport``，绝不打真网络）+ 真的本机库与真的打包器（SQLite 落在
``tmp_path``）。**不需要 PostgreSQL**（``local`` 这个 marker 的全部意义）。

覆盖：

① **断网也能打**（§7 A 第一行）：传输全失败 → 202 + 队列多一行 + ``last_error`` 有原因 +
   包落在 ``backup/pending/``。那一行的状态是 ``failed``（端点在请求线程里顺手试了一次），
   而**入队那一步是 ``pending``**——两档都算入队成功（阶段 3 定案的口径）；
② **连不上也要给本机那一半**（§7 A 第二行）：``GET /local/backup`` 的 ``provider`` 说
   ``unavailable`` + 原因，而 ``backlog`` / ``snapshots`` 如实报队里那几份；
③ **联网后补传**：把地址改好（或传输修好）之后跑一轮队列节拍 → 那一行变 ``uploaded``、
   本地包删掉（§7 A 第三行的端到端那一半由 ``test_backup_queue.py`` 逐格钉）；
④ **五个端点的错误映射**：没有设备身份 → 400 + 那句人话（R12）；PATCH 白名单四键
   （凭据类键与未知键 422）；恢复点 404 如实回；删不掉（连不上）→ 503 而不是 500；
⑤ **恢复点清单是透传**：ready 时 ``items`` / ``total`` / ``quota`` 原样给，且**30s 缓存**
   （两次 GET 只打一次 NAS）。
"""

from __future__ import annotations

import contextlib
import hashlib
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.services import get_services, reset_services
from app.core.storage import get_stores, reset_stores
from app.services import backup_provider, runtime_config
from app.services.backup_provider import PROTOCOL_VERSION

pytestmark = pytest.mark.local

NAS = "http://nas.test/api/v1"
TOKEN = "kylab_sk_not_a_real_key_but_must_not_leak"
DEVICE = "3f1c8b2e-0a4d-4a77-9d55-2c6a1b7e9f01"
BASE = "/api/v1/local/backup"
SEGMENT = "2026-10-05T08-03-00Z-ab12cd34"


def _snapshot_item() -> dict[str, Any]:
    """NAS 侧一份恢复点的形状（``BackupSnapshotOut``，只挑界面要的几列）。"""
    return {
        "snapshot_id": SEGMENT,
        "device_id": DEVICE,
        "device_name": "小又的笔记本",
        "created_at": "2026-10-05T08:03:00Z",
        "bytes": 11477,
        "sha256": "a" * 64,
        "kind": "manual",
        "schema_version": 3,
        "app_version": "0.1.1",
        "counts": {"conversations": 2, "messages": 9},
        "skipped": [],
        "encryption": "none",
    }


class FakeNas:
    """一台**假 NAS**：按路径回答 + 记下每一次请求（与 ``test_local_kb_cache_api`` 同一手法）。

    ``fail`` 一置就是"连不上"（每一发都抛 ``ConnectError``）——那正是"断网也能打快照"
    那两条用例要的那一档。``seen`` 是"缓存有没有省下请求"的唯一判据。
    """

    def __init__(self) -> None:
        self.seen: list[httpx.Request] = []
        self.fail: Exception | None = None
        self.delete_status = 200
        self.list_payload: dict[str, Any] = {
            "items": [_snapshot_item()],
            "total": 1,
            "quota": {
                "policy": "keep_n",
                "keep": 30,
                "quota_bytes": 10,
                "used_bytes": 11477,
                "snapshots": 1,
            },
        }
        self.transport = httpx.MockTransport(self._dispatch)

    # ---------------------------------------------------------------- 假 NAS 的答法
    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.fail is not None:
            raise self.fail
        path = request.url.path
        if path.endswith("/backup/handshake"):
            return httpx.Response(
                200,
                json={
                    "provider": "backup",
                    "protocol_version": PROTOCOL_VERSION,
                    "app_version": "0.1.1",
                    "api_version": "v1",
                    "capabilities": {
                        "snapshot": {"available": True, "max_blob_bytes": 2147483648},
                        "retention": {"keep": 30, "quota_bytes": 10, "used_bytes": 11477},
                    },
                    "caller": {"kind": "api_key", "is_admin": False},
                    "devices": [{"device_id": DEVICE, "snapshots": 1, "bytes": 11477}],
                    "server_time": "2026-10-05T08:00:00Z",
                },
            )
        if path.endswith("/backup/snapshots"):
            return httpx.Response(200, json=self.list_payload)
        if path.endswith("/blob") and request.method == "PUT":
            return httpx.Response(
                201,
                json={
                    "snapshot_id": SEGMENT,
                    "bytes": len(request.read()),
                    "sha256": hashlib.sha256(request.read()).hexdigest(),
                },
            )
        if path.endswith("/manifest") and request.method == "PUT":
            return httpx.Response(201, json={"snapshot_id": SEGMENT, "bytes": 1, "sha256": "x"})
        if request.method == "DELETE":
            if self.delete_status >= 400:
                return httpx.Response(self.delete_status, text="这条路径上没有恢复点可删")
            return httpx.Response(self.delete_status, json={"removed": 2})
        return httpx.Response(404, text="没有这个端点")

    def _dispatch(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        return self.handler(request)

    def list_calls(self) -> int:
        return sum(1 for request in self.seen if request.url.path.endswith("/backup/snapshots"))


@pytest.fixture
def nas() -> FakeNas:
    return FakeNas()


@contextlib.contextmanager
def _local_app(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    server_url: str = NAS,
    token: str = TOKEN,
    device_id: str = DEVICE,
) -> Iterator[TestClient]:
    """本机档的真 app（``local_router`` 那张白名单就挂在这个进程上）。

    那几个环境变量显式置空/置值：``.env`` 里真有可能配着别的东西，而用例不该看它
    （与 ``test_local_kb_cache_api._local_app`` 同一手法）。
    """
    monkeypatch.setenv("KYLAB_DEPLOYMENT", "local")
    monkeypatch.setenv("KYLAB_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("KYLAB_DATABASE_URL", "")
    monkeypatch.setenv("KYLAB_SERVER_URL", server_url)
    monkeypatch.setenv("KYLAB_TOKEN", token)
    monkeypatch.setenv("KYLAB_KB_URL", "")
    monkeypatch.setenv("KYLAB_KB_TOKEN", "")
    monkeypatch.setenv("KYLAB_DEVICE_ID", device_id)
    # **把自动快照关掉**（只在这一族用例里）：组合根起来时队列线程会立刻跑一轮，
    # 而"从没有过备份"按判据是到期——于是它会和下面手动那一份抢同一个 pending 目录，
    # 让"目录里只有我这一份"这类断言时红时绿。自动快照那几条判据在
    # `tests/unit/services/test_backup_queue.py` 里逐格钉着，这里不需要它出场。
    #
    # 关的是**默认值那一格**（`every_hours` 的回落链是"库里的键 → 代码默认值"）：
    # 只改这一个字典就够，键名与白名单一个字不动——于是 PATCH 那几条用例仍然在
    # 真的那个键上验（先前改过一次键名，那会让"PATCH 写进去了吗"当场问错地方）。
    monkeypatch.setitem(runtime_config.DEFAULTS, "provider.backup.every_hours", "0")
    get_settings.cache_clear()
    reset_services()
    reset_stores()
    from app.main import create_app

    try:
        with TestClient(create_app()) as client:
            yield client
    finally:
        # reset_services 会把那一个 backup-upload 守护线程停掉（它按节拍碰数据目录）
        reset_services()
        reset_stores()
        get_settings.cache_clear()


def _attach(nas: FakeNas, monkeypatch: pytest.MonkeyPatch) -> backup_provider.BackupProviderClient:
    """把假 NAS 接到**进程级那一个**提供者客户端上（真客户端代码、假传输）。"""
    provider = get_services().backup_provider
    assert provider is not None, "本机档必须装配出备份提供者客户端（组合根那一段）"
    monkeypatch.setattr(provider, "_transport", nas.transport)
    return provider


def _take_snapshot(client: TestClient) -> dict[str, Any]:
    response = client.post(f"{BASE}/snapshots")
    assert response.status_code == 202, response.text
    return response.json()


# ------------------------------------------------------------------ ① 断网也能打


def test_a_snapshot_can_be_taken_while_the_transport_is_dead(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """§7 A 第一行：传输全失败 → **202** + 队列多一行 + 原因可见 + 包落在 pending 里。

    那一行落到 ``failed`` 是"端点顺手试了一次"的结果（阶段 3 定案：``pending`` =
    还没试过、``failed`` = 试过且失败，两档都算入队成功）。而**包确实在盘上**——
    这正是"断网也不丢"的全部意义。
    """
    with _local_app(tmp_path, monkeypatch) as client:
        _attach(nas, monkeypatch)
        nas.fail = httpx.ConnectError("NAS 连不上（用例）")

        body = _take_snapshot(client)

        row = body["snapshot"]
        assert row["state"] == "failed", "试过一次、失败了——那也是入队成功"
        assert row["kind"] == "manual"
        assert "连不上" in row["last_error"]
        assert row["attempts"] == 1 and row["next_attempt_at"]
        assert body["backlog"]["queued"] == 1 and body["backlog"]["bytes"] > 0

        pending = Path(get_settings().data_dir) / "backup" / "pending"
        assert [item.name for item in pending.iterdir()] == [f"{row['id']}.tar.gz"]

        # 队列那一读看得到同一行（一个来源）
        listed = client.get(BASE).json()
        assert [item["id"] for item in listed["snapshots"]] == [row["id"]]
        assert listed["backlog"]["queued"] == 1


def test_the_local_half_is_served_when_the_provider_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """§7 A 第二行：``state=unavailable`` **且**队列计数如实（"备份是本地动作"）。

    提供者那一段是"连不上 + 原因"，本机那一段是"有一份还没传上去"——两件事互不掩盖。
    """
    with _local_app(tmp_path, monkeypatch) as client:
        _attach(nas, monkeypatch)
        nas.fail = httpx.ConnectError("NAS 连不上（用例）")
        _take_snapshot(client)

        body = client.get(BASE).json()

        assert body["provider"]["state"] == "unavailable"
        assert "连不上" in body["provider"]["reason"]
        assert body["provider"]["available"] is False
        assert body["backlog"]["queued"] == 1 and body["backlog"]["failed"] == 1
        assert len(body["snapshots"]) == 1
        assert "capabilities" not in body["provider"], (
            "不 ready 时那几段键都不出现（回空对象会让界面去猜）"
        )


def test_the_snapshot_uploads_after_the_network_comes_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """§7 A 第三行的端到端那一半：断网入队 → 网络回来 → 下一轮节拍就传上去。

    （逐格那几张表在 ``test_backup_queue.py``；这里是"两个组合根对象真的接在一起了"。）
    """
    with _local_app(tmp_path, monkeypatch) as client:
        _attach(nas, monkeypatch)
        stores = get_stores()
        nas.fail = httpx.ConnectError("NAS 连不上（用例）")
        row = _take_snapshot(client)["snapshot"]
        pending = Path(get_settings().data_dir) / "backup" / "pending"
        assert (pending / f"{row['id']}.tar.gz").exists()

        nas.fail = None  # 网络回来了
        services = get_services()
        assert services.backup_queue is not None
        # 第一次失败已经排了 60 秒退避——把"下一次"清掉，等价于"刚好 60 秒过去了"
        # （真等 60 秒不是这条用例要证明的事；退避那几档由 test_backup_queue.py 逐格钉）
        assert stores.backup_queue is not None
        stores.backup_queue.mark_backup_snapshot(row["id"], "pending", clear_next_attempt=True)
        report = services.backup_queue.sweep()

        assert report.uploaded == 1
        assert not (pending / f"{row['id']}.tar.gz").exists(), "传成之后本地那份包要删掉"
        after = client.get(BASE).json()
        assert after["snapshots"][0]["state"] == "uploaded"
        assert after["snapshots"][0]["remote_device_id"] == DEVICE
        assert after["backlog"]["queued"] == 0


# ------------------------------------------------------------------ ② PATCH 白名单


def test_patch_writes_the_four_whitelisted_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """四个键逐个落进 ``app_settings``，并且写完**立刻重探**（这一下就回最新整包）。"""
    with _local_app(tmp_path, monkeypatch) as client:
        _attach(nas, monkeypatch)

        body = client.patch(
            f"{BASE}",
            json={
                "base_url": NAS,
                "enabled": True,
                "include_workspace": True,
                "every_hours": 6,
            },
        ).json()

        runtime = get_services().runtime
        assert runtime.get("provider.backup.base_url") == NAS
        assert runtime.get("provider.backup.enabled") == "1"
        assert runtime.get("provider.backup.include_workspace") == "1"
        assert runtime.get("provider.backup.every_hours") == "6"
        assert body["provider"]["state"] == "ready"
        assert body["provider"]["capabilities"]["snapshot"]["available"] is True


def test_patch_refuses_credentials_and_unknown_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """R3/R14：**凭据类键一个都不收**（``extra="forbid"``），未知键与非法值同样 422。"""
    with _local_app(tmp_path, monkeypatch) as client:
        _attach(nas, monkeypatch)

        for payload in (
            {"token": "kylab_sk_x"},
            {"api_key": "x"},
            {"whatever": 1},
            {"every_hours": -1},
            {"enabled": "也许"},
        ):
            response = client.patch(f"{BASE}", json=payload)
            assert response.status_code == 422, f"{payload} 该被 422 挡住"

        runtime = get_services().runtime
        assert runtime.get("provider.backup.enabled") in ("", "1", "0")
        assert "kylab_sk_x" not in json.dumps(client.get(BASE).json(), ensure_ascii=False), (
            "凭据不会出现在响应里"
        )


def test_patch_can_turn_the_provider_off_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """``enabled=false`` → ``unconfigured`` + 那句"关掉只影响传不传得出去"。"""
    with _local_app(tmp_path, monkeypatch) as client:
        _attach(nas, monkeypatch)

        body = client.patch(f"{BASE}", json={"enabled": False}).json()

        assert body["provider"]["state"] == "unconfigured"
        assert "被关掉了" in body["provider"]["reason"]
        assert "本机打快照" in body["provider"]["reason"]


# ------------------------------------------------------------------ ③ 设备身份（R12）


def test_a_missing_device_identity_refuses_with_that_sentence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """R12：壳没传 ``--device-id`` → **400 + 那句人话**，绝不编一个 id。"""
    with _local_app(tmp_path, monkeypatch, device_id="") as client:
        _attach(nas, monkeypatch)

        response = client.post(f"{BASE}/snapshots")

        assert response.status_code == 400, response.text
        body = response.json()
        assert "设备身份" in body["message"] and "登录一次" in body["message"]
        assert body["code"] == "invalid_request"
        # 没有设备身份时**一份都不该打出来**
        pending = Path(get_settings().data_dir) / "backup" / "pending"
        assert not pending.exists() or not list(pending.iterdir())


# ------------------------------------------------------------------ ④ 恢复点清单


def test_points_pass_through_the_nas_and_are_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """ready 时 ``items`` / ``total`` / ``quota`` **原样透传**，且 30s 缓存省下一次往返。"""
    with _local_app(tmp_path, monkeypatch) as client:
        _attach(nas, monkeypatch)

        first = client.get(f"{BASE}/points").json()
        second = client.get(f"{BASE}/points").json()

        assert first["available"] is True and first["state"] == "ready"
        assert [item["snapshot_id"] for item in first["items"]] == [SEGMENT]
        assert first["total"] == 1
        assert first["quota"]["keep"] == 30 and first["quota"]["used_bytes"] == 11477
        assert first == second
        assert nas.list_calls() == 1, "30s 内第二次读不该再打 NAS"

        refreshed = client.get(f"{BASE}/points", params={"refresh": 1}).json()
        assert refreshed["available"] is True and nas.list_calls() == 2


def test_points_report_the_state_instead_of_failing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """连不上 → **200 + available=false + 原因**（不是 500，也不是"还没有恢复点"）。"""
    with _local_app(tmp_path, monkeypatch) as client:
        _attach(nas, monkeypatch)
        nas.fail = httpx.ConnectError("NAS 连不上（用例）")

        response = client.get(f"{BASE}/points")

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["state"] == "unavailable" and body["available"] is False
        assert "连不上" in body["reason"]
        assert body["items"] == [] and body["total"] == 0
        assert nas.list_calls() == 0, "状态已经不 ready，列表一个请求都不该发"


def test_points_say_unconfigured_before_anything_is_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """没配地址 → ``unconfigured`` + 那句"去哪儿填"（零请求）。"""
    with _local_app(tmp_path, monkeypatch, server_url="", token="") as client:
        _attach(nas, monkeypatch)

        body = client.get(f"{BASE}/points").json()

        assert body["state"] == "unconfigured" and body["available"] is False
        assert "provider.backup.base_url" in body["reason"] or "server" in body["reason"]
        assert nas.seen == []


# ------------------------------------------------------------------ ⑤ 删除


def test_delete_passes_through_and_reports_the_object_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """删一个恢复点：服务端回几个就报几个（整份删 = 2）。"""
    with _local_app(tmp_path, monkeypatch) as client:
        _attach(nas, monkeypatch)

        response = client.delete(f"{BASE}/points/{DEVICE}/{SEGMENT}")

        assert response.status_code == 200, response.text
        assert response.json() == {"removed": 2}
        assert nas.seen[-1].method == "DELETE"
        assert nas.seen[-1].url.path.endswith(f"/backup/snapshots/{DEVICE}/{SEGMENT}")


def test_delete_reports_a_missing_point_as_404(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """服务端 404（本来就没什么可删）→ 本机也 **404 如实回**（不伪造成功）。"""
    with _local_app(tmp_path, monkeypatch) as client:
        _attach(nas, monkeypatch)
        nas.delete_status = 404

        response = client.delete(f"{BASE}/points/{DEVICE}/{SEGMENT}")

        assert response.status_code == 404
        assert "没有恢复点可删" in response.json()["message"]


def test_delete_when_unreachable_is_502_not_500(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nas: FakeNas
) -> None:
    """连不上 → **502 + 原因**（"外部依赖出错"，不是 500 也不是"你请求写错了"）。

    为什么是 502 而不是知识库那条 503：那一条的映射住在 ``app.storage.base``，而
    **L1 规则禁止协议层 import 存储**（`check_layering.py` 的 L1 判据之一）。
    要一条"备份提供者不可用 → 503"，得在 ``core/exceptions.py`` 里加一类异常
    （那份文件在白名单之外，见阶段 4 报告的偏离）。
    """
    with _local_app(tmp_path, monkeypatch) as client:
        _attach(nas, monkeypatch)
        nas.fail = httpx.ConnectError("NAS 连不上（用例）")

        response = client.delete(f"{BASE}/points/{DEVICE}/{SEGMENT}")

        assert response.status_code == 502, response.text
        assert "连不上" in response.json()["message"]


# ------------------------------------------------------------------ ⑥ 装配与服务器档


def test_the_three_backup_services_are_one_process_wide_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """组合根建的那三件都在，而且队列的上传者**就是**那个提供者客户端（同一个对象）。"""
    with _local_app(tmp_path, monkeypatch) as client:
        assert client.get(f"{BASE}").status_code == 200
        services = get_services()

        assert services.backup_snapshot is not None
        assert services.backup_provider is not None
        assert services.backup_queue is not None
        assert services.backup_queue is get_services().backup_queue, "进程级单例"
        assert services.backup_queue.worker is not None, "队列的线程在组合根里起好了"
        assert services.backup_queue.worker.name == "backup-upload"


def test_the_backup_family_lives_only_on_the_local_router() -> None:
    """这一族**只挂在本机档那张白名单上**（服务器档那一档自己就是备份的目的地）。

    不建 app 来判：服务器档要有 PG 才能起来，而这条判据问的是**路由归属**——把 router
    装进一个空 ``FastAPI`` 再读 OpenAPI 就够了（`api/v1/router.py` 的"不挂清单"是同一
    条纪律，那条清单一改这里就红）。
    """
    from fastapi import FastAPI

    from app.api.v1.router import api_router, local_router

    def paths_of(router: Any) -> set[str]:
        probe = FastAPI()
        probe.include_router(router, prefix="/api/v1")
        return set(probe.openapi()["paths"])

    local_paths = paths_of(local_router)
    assert {f"{BASE}", f"{BASE}/points", f"{BASE}/snapshots"} <= local_paths
    assert f"{BASE}/points/{{device_id}}/{{snapshot_id}}" in local_paths
    assert {path for path in paths_of(api_router) if path.startswith("/api/v1/local/")} == set()
