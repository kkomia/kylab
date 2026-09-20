"""定时任务端点（v0.33）。

镜像同构：``app/api/v1/schedules.py`` → 本文件。

这一组钉住的是**这个产品面能不能被正常使用**：

1. **建得出、列得出、改得动、删得掉**（含"改时间要重算下次"——
   不重算的话"把每天 9 点改成 18 点"会等到下一个 9 点才生效，而用户以为改好了）；
2. **时间说得清**：响应里带人话描述与服务器时区（cron 按服务器时区解释，
   不把时区回给界面的话，"每天 9 点"是哪个 9 点就成了猜）；
3. **立即跑一次真的进了队列**（它不是装饰：新建之后最想确认的就是"它会跑成什么样"）；
4. **越权一律 404**（与知识库/工作区同一口径：403 会暴露"这个 id 存在"）。
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.core.exceptions import NotFoundError
from app.core.services import get_services
from tests.conftest import admin_client as admin_session


@pytest.fixture
def client():
    with admin_session() as test_client:
        yield test_client


def _create(client: TestClient, **overrides: object) -> dict:  # type: ignore[type-arg]
    payload = {
        "name": "每日早报",
        "prompt": "把昨天的构建日志汇总成三条结论",
        "kind": "cron",
        "cron": "0 9 * * *",
    }
    payload.update(overrides)
    response = client.post("/api/v1/scheduled-tasks", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


# ------------------------------------------------------------------ 建 / 列


def test_create_returns_the_next_run_and_a_readable_schedule(client: TestClient) -> None:
    item = _create(client)
    assert item["kind"] == "cron"
    assert item["enabled"] is True
    assert item["next_run_at"]
    assert item["schedule_text"] == "每天 09:00"
    assert item["run_count"] == 0
    assert item["conversation_id"] is None  # 没跑过就不该先占一条会话


def test_list_carries_the_server_timezone(client: TestClient) -> None:
    """cron 按**服务器本地时间**解释，所以界面必须能把这件事说出来。"""
    _create(client)
    payload = client.get("/api/v1/scheduled-tasks").json()
    assert payload["timezone"]
    assert len(payload["items"]) == 1


def test_create_once_task_with_a_future_time(client: TestClient) -> None:
    when = datetime.now().astimezone() + timedelta(hours=3)
    item = _create(client, kind="once", cron="", run_at=when.isoformat())
    assert item["kind"] == "once"
    assert "跑一次" in item["schedule_text"]


# ------------------------------------------------------------------ 校验


def test_a_time_in_the_past_is_rejected(client: TestClient) -> None:
    """不建"永远不会跑"的记录：那种记录在界面上表现为"建好了但一直没动"。"""
    when = datetime.now().astimezone() - timedelta(hours=1)
    response = client.post(
        "/api/v1/scheduled-tasks",
        json={"name": "过期", "prompt": "跑", "kind": "once", "run_at": when.isoformat()},
    )
    assert response.status_code == 422
    assert "已经过去" in response.json()["message"]


def test_bad_cron_is_rejected_with_a_readable_reason(client: TestClient) -> None:
    response = client.post(
        "/api/v1/scheduled-tasks",
        json={"name": "坏的", "prompt": "跑", "kind": "cron", "cron": "0 25 * * *"},
    )
    assert response.status_code == 422
    assert "小时" in response.json()["message"]


def test_empty_prompt_is_rejected(client: TestClient) -> None:
    response = client.post(
        "/api/v1/scheduled-tasks", json={"name": "空的", "prompt": "  ", "cron": "0 9 * * *"}
    )
    assert response.status_code == 422


# ------------------------------------------------------------------ 改


def test_changing_the_time_recomputes_the_next_run(client: TestClient) -> None:
    item = _create(client)
    before = item["next_run_at"]
    updated = client.patch(
        f"/api/v1/scheduled-tasks/{item['id']}", json={"cron": "0 18 * * *"}
    ).json()
    assert updated["schedule_text"] == "每天 18:00"
    assert updated["next_run_at"] != before


def test_disabling_clears_the_next_run(client: TestClient) -> None:
    """停用还挂着下次时间，会让人以为它还会跑（而它不会）。"""
    item = _create(client)
    disabled = client.patch(f"/api/v1/scheduled-tasks/{item['id']}", json={"enabled": False}).json()
    assert disabled["enabled"] is False
    assert disabled["next_run_at"] is None
    reenabled = client.patch(f"/api/v1/scheduled-tasks/{item['id']}", json={"enabled": True}).json()
    assert reenabled["next_run_at"]


def test_delete_removes_the_schedule(client: TestClient) -> None:
    item = _create(client)
    assert client.delete(f"/api/v1/scheduled-tasks/{item['id']}").status_code == 204
    assert client.get("/api/v1/scheduled-tasks").json()["items"] == []


def test_unknown_id_is_404(client: TestClient) -> None:
    assert client.patch("/api/v1/scheduled-tasks/sched_none", json={}).status_code == 404
    assert client.delete("/api/v1/scheduled-tasks/sched_none").status_code == 404


# ------------------------------------------------------------------ 立即跑一次


def test_run_now_enqueues_a_real_task(client: TestClient) -> None:
    item = _create(client)
    payload = client.post(f"/api/v1/scheduled-tasks/{item['id']}/run").json()
    assert payload["task_id"].startswith("task_")
    tasks = client.get("/api/v1/tasks").json()["items"]
    assert any(task["kind"] == "scheduled" for task in tasks)


def test_run_now_does_not_move_the_schedule(client: TestClient) -> None:
    """手动跑一次**不改变周期**——否则点一下"立即跑"就把每天 9 点挪到了别处。"""
    item = _create(client)
    client.post(f"/api/v1/scheduled-tasks/{item['id']}/run")
    again = client.get("/api/v1/scheduled-tasks").json()["items"][0]
    # 比**时刻**而不是比字符串：同一时刻可以写成 +08:00 也可以写成 Z
    assert datetime.fromisoformat(again["next_run_at"]) == datetime.fromisoformat(
        item["next_run_at"]
    )


# ------------------------------------------------------------------ 归属


def test_members_only_see_their_own_schedules(client: TestClient) -> None:
    """成员看不见、也改不动别人的定时任务（**404 而不是 403**）。"""
    item = _create(client)
    services = get_services()
    other = services.users.create(name="乙")
    assert services.schedules.list(owner_id=other.id) == []
    with pytest.raises(NotFoundError):
        services.schedules.get(item["id"], owner_id=other.id)
