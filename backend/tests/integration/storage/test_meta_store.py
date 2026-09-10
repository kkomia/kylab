"""``SqliteMetaStore`` 的行为测试（集成）。

覆盖架构里靠元数据兑现的承诺：文件去重（§6.3）、断点续跑的任务租约（§4）、
回收站 7 天（§6.2）、embedding 模型锁（§6.4）、大文件切分（§4.2）。
"""

from datetime import UTC, datetime, timedelta

import pytest

from app.models.enums import (
    ApiKeyPermission,
    DataSourceKind,
    DocumentStage,
    TaskKind,
    TaskState,
    TrashKind,
)
from app.storage.base import (
    ApiKeyRecord,
    ChunkRecord,
    DataSourceRecord,
    DocumentPartRecord,
    DocumentRecord,
    ImageRecord,
    KnowledgeBaseRecord,
    ParseResultRecord,
    TaskRecord,
    TrashRecord,
    WebhookRecord,
)
from app.storage.sqlite_impl.meta_store import SqliteMetaStore


def utc_now() -> datetime:
    """本地时间助手（不从 conftest 导入，避免测试模块之间互相耦合）。"""
    return datetime.now(UTC)


def _chunk(chunk_id: str, ordinal: int, *, document_id: str = "doc_1", kb_id: str = "kb_1",
           text: str = "正文", image_ids: tuple[str, ...] = ()) -> ChunkRecord:
    return ChunkRecord(
        chunk_id=chunk_id,
        document_id=document_id,
        knowledge_base_id=kb_id,
        part_id=None,
        ordinal=ordinal,
        text=text,
        content_hash=f"h-{chunk_id}",
        heading_path="第1章 > 1.1",
        page=ordinal + 1,
        image_ids=image_ids,
    )


def _task(task_id: str, *, state: TaskState = TaskState.PENDING, attempts: int = 0,
          max_attempts: int = 5, next_run_at=None, document_id: str | None = None) -> TaskRecord:
    """document_id 默认为 None：并非所有任务都挂文档（如数据源拉取）。"""
    return TaskRecord(
        id=task_id,
        kind=TaskKind.PARSE,
        state=state,
        payload={"stage": "parsing"},
        document_id=document_id,
        attempts=attempts,
        max_attempts=max_attempts,
        next_run_at=next_run_at,
    )


# --------------------------------------------------------------------- 知识库


def test_create_and_get_knowledge_base(store: SqliteMetaStore) -> None:
    record = store.create_knowledge_base(
        KnowledgeBaseRecord(id="kb_9", name="研究库", embedding_model_id="BAAI/bge-m3",
                            embedding_dim=1024)
    )
    assert record.created_at is not None

    loaded = store.get_knowledge_base("kb_9")
    assert loaded is not None
    assert (loaded.name, loaded.embedding_dim, loaded.chunk_strategy) == ("研究库", 1024, "fixed")
    assert store.get_knowledge_base("nope") is None


def test_list_knowledge_bases_returns_all(store: SqliteMetaStore, kb) -> None:
    store.create_knowledge_base(
        KnowledgeBaseRecord(id="kb_2", name="第二个", embedding_model_id="m", embedding_dim=768)
    )
    assert {item.id for item in store.list_knowledge_bases()} == {"kb_1", "kb_2"}


def test_update_knowledge_base_embedding(store: SqliteMetaStore, kb) -> None:
    """架构 §6.4：允许换 endpoint，模型 ID 与维度随库更新。"""
    store.update_knowledge_base_embedding(
        "kb_1", model_id="BAAI/bge-m3", dim=1024, base_url="http://127.0.0.1:11434/v1"
    )
    loaded = store.get_knowledge_base("kb_1")
    assert loaded is not None
    assert loaded.embedding_base_url == "http://127.0.0.1:11434/v1"


# --------------------------------------------------------------------- 文档与去重


def test_get_document_by_hash_finds_duplicate(store: SqliteMetaStore, kb, document) -> None:
    """架构 §6.3：上传前先按 hash 查重，命中则提醒"检测到相同文件"。"""
    found = store.get_document_by_hash("kb_1", "hash-1")
    assert found is not None
    assert found.id == document.id
    assert store.get_document_by_hash("kb_1", "other") is None


def test_duplicate_document_in_same_kb_is_rejected(store: SqliteMetaStore, kb, document) -> None:
    with pytest.raises(Exception, match="UNIQUE constraint failed"):
        store.create_document(
            DocumentRecord(
                id="doc_dup",
                knowledge_base_id="kb_1",
                name="副本.md",
                source_kind=DataSourceKind.UPLOAD,
                content_hash="hash-1",
                stage=DocumentStage.UPLOADED,
            )
        )


def test_update_document_stage_records_error(store: SqliteMetaStore, document) -> None:
    store.update_document_stage("doc_1", DocumentStage.PARSING)
    assert store.get_document("doc_1").stage is DocumentStage.PARSING  # type: ignore[union-attr]

    store.update_document_stage("doc_1", DocumentStage.FAILED, error="云端额度耗尽")
    loaded = store.get_document("doc_1")
    assert loaded is not None
    assert loaded.error == "云端额度耗尽"


def test_list_documents_is_newest_first(store: SqliteMetaStore, kb, document) -> None:
    store.create_document(
        DocumentRecord(
            id="doc_2",
            knowledge_base_id="kb_1",
            name="b.md",
            source_kind=DataSourceKind.UPLOAD,
            content_hash="hash-2",
            stage=DocumentStage.UPLOADED,
        )
    )
    ids = [item.id for item in store.list_documents("kb_1")]
    assert ids[0] == "doc_2" and set(ids) == {"doc_1", "doc_2"}


# --------------------------------------------------------------------- 子文件


def test_document_parts_are_ordered_by_index(store: SqliteMetaStore, document) -> None:
    """架构 §4.2：大文件按页范围切子文件，顺序必须稳定。"""
    store.create_document_parts(
        [
            DocumentPartRecord(id="part_2", document_id="doc_1", part_index=2, page_start=401,
                               page_end=600, stage=DocumentStage.UPLOADED),
            DocumentPartRecord(id="part_1", document_id="doc_1", part_index=1, page_start=201,
                               page_end=400, stage=DocumentStage.UPLOADED),
        ]
    )
    parts = store.list_document_parts("doc_1")
    assert [part.part_index for part in parts] == [1, 2]
    assert parts[0].page_start == 201

    store.update_part_stage("part_1", DocumentStage.INDEXED)
    assert store.list_document_parts("doc_1")[0].stage is DocumentStage.INDEXED


# --------------------------------------------------------------------- chunk


def test_replace_chunks_stores_order_and_image_anchors(store: SqliteMetaStore, kb,
                                                       document) -> None:
    """架构 §7：图片不入向量库，只在 chunk 元数据里记锚点。"""
    store.replace_chunks(
        "doc_1",
        [_chunk("c2", 1, image_ids=("img_1", "img_2")), _chunk("c1", 0)],
    )
    chunks = list(store.iter_chunks("doc_1"))
    assert [chunk.chunk_id for chunk in chunks] == ["c1", "c2"]
    assert tuple(chunks[1].image_ids) == ("img_1", "img_2")
    assert chunks[0].heading_path == "第1章 > 1.1"
    assert store.count_chunks("doc_1") == 2
    assert store.count_kb_chunks("kb_1") == 2


def test_replace_chunks_removes_previous_version(store: SqliteMetaStore, kb, document) -> None:
    """增量更新语义：整体替换而非叠加。"""
    store.replace_chunks("doc_1", [_chunk("c1", 0), _chunk("c2", 1)])
    store.replace_chunks("doc_1", [_chunk("c3", 0)])

    chunks = list(store.iter_chunks("doc_1"))
    assert [chunk.chunk_id for chunk in chunks] == ["c3"]
    assert store.count_kb_chunks("kb_1") == 1


def test_get_chunks_batch_returns_requested_ids(store: SqliteMetaStore, kb, document) -> None:
    """检索时向量只给得出 chunk_id，正文得靠批量回表取。"""
    store.replace_chunks("doc_1", [_chunk("c1", 0), _chunk("c2", 1), _chunk("c3", 2)])

    chunks = store.get_chunks(["c1", "c3"])
    assert {chunk.chunk_id for chunk in chunks} == {"c1", "c3"}
    assert store.get_chunks([]) == []
    assert store.get_chunks(["missing"]) == []


def test_replace_chunks_with_empty_list_clears(store: SqliteMetaStore, kb, document) -> None:
    store.replace_chunks("doc_1", [_chunk("c1", 0)])
    store.replace_chunks("doc_1", [])
    assert store.count_chunks("doc_1") == 0


# --------------------------------------------------------------------- 图片 / 解析产物


def test_images_are_upserted_and_listed_by_page(store: SqliteMetaStore, document) -> None:
    store.add_images(
        [
            ImageRecord(image_id="img_1", document_id="doc_1", storage_path="data/images/1.png",
                        page=3, bbox="10,20,30,40"),
            ImageRecord(image_id="img_2", document_id="doc_1", storage_path="data/images/2.png",
                        page=1),
        ]
    )
    store.add_images(
        [ImageRecord(image_id="img_1", document_id="doc_1",
                     storage_path="data/images/1-v2.png", page=3, caption="架构图")]
    )

    images = store.list_images("doc_1")
    assert [image.image_id for image in images] == ["img_2", "img_1"]
    assert images[1].storage_path == "data/images/1-v2.png"
    assert images[1].caption == "架构图"


def test_parse_result_is_idempotent_and_keeps_probe_meta(store: SqliteMetaStore, document) -> None:
    """重新解析应覆盖产物，而不是留下多份（架构 §6：解析产物分层持久化）。"""
    store.save_parse_result(
        ParseResultRecord(
            document_id="doc_1",
            part_id=None,
            parser_name="MinerUCloudParser",
            markdown_path="data/markdown/doc_1.md",
            probe_meta={"coverage": 0.98, "route": "text"},
        )
    )
    store.save_parse_result(
        ParseResultRecord(
            document_id="doc_1",
            part_id=None,
            parser_name="PaddleOCRApiParser",
            markdown_path="data/markdown/doc_1-v2.md",
            probe_meta={"coverage": 0.02, "route": "ocr"},
        )
    )

    loaded = store.get_parse_result("doc_1")
    assert loaded is not None
    assert loaded.parser_name == "PaddleOCRApiParser"
    assert loaded.probe_meta["route"] == "ocr"
    assert loaded.part_id is None


# --------------------------------------------------------------------- 任务队列（断点续跑）


def test_claim_task_marks_running_and_counts_attempt(store: SqliteMetaStore) -> None:
    store.enqueue_task(_task("t1"))
    claimed = store.claim_task(owner="worker-1", lease_seconds=60)

    assert claimed is not None
    assert claimed.state is TaskState.RUNNING
    assert claimed.attempts == 1
    assert claimed.lease_owner == "worker-1"
    assert claimed.lease_expires_at is not None


def test_claim_task_returns_none_when_queue_is_empty(store: SqliteMetaStore) -> None:
    assert store.claim_task(owner="worker-1", lease_seconds=60) is None


def test_claimed_task_cannot_be_claimed_twice(store: SqliteMetaStore) -> None:
    """并发消费者之间不能双领：领取是单条原子语句。"""
    store.enqueue_task(_task("t1"))
    assert store.claim_task(owner="worker-1", lease_seconds=60) is not None
    assert store.claim_task(owner="worker-2", lease_seconds=60) is None


def test_claim_task_respects_next_run_at(store: SqliteMetaStore) -> None:
    """指数退避：未到重试时间的任务不该被领走。"""
    store.enqueue_task(_task("t1", next_run_at=utc_now() + timedelta(minutes=5)))
    assert store.claim_task(owner="worker-1", lease_seconds=60) is None


def test_heartbeat_requires_lease_owner(store: SqliteMetaStore) -> None:
    store.enqueue_task(_task("t1"))
    store.claim_task(owner="worker-1", lease_seconds=60)

    assert store.heartbeat_task("t1", owner="worker-1", lease_seconds=60) is True
    assert store.heartbeat_task("t1", owner="worker-2", lease_seconds=60) is False


def test_finish_task_releases_lease(store: SqliteMetaStore) -> None:
    store.enqueue_task(_task("t1"))
    store.claim_task(owner="worker-1", lease_seconds=60)
    store.finish_task("t1", TaskState.SUCCEEDED)

    finished = store.list_tasks(TaskState.SUCCEEDED)[0]
    assert finished.lease_owner is None
    assert finished.lease_expires_at is None


def test_reclaim_requeues_expired_task_with_budget_left(store: SqliteMetaStore) -> None:
    """进程崩溃后：超时任务回到 PENDING，实现断点续跑（架构 §4）。"""
    store.enqueue_task(_task("t1"))
    store.claim_task(owner="worker-crashed", lease_seconds=1)

    later = utc_now() + timedelta(minutes=10)
    assert store.reclaim_expired_tasks(now=later) == 1

    requeued = store.list_tasks(TaskState.PENDING)
    assert [task.id for task in requeued] == ["t1"]
    assert requeued[0].lease_owner is None
    # 重新领取时 attempts 继续累加，体现"重试了几次"
    reclaimed = store.claim_task(owner="worker-2", lease_seconds=60)
    assert reclaimed is not None and reclaimed.attempts == 2


def test_reclaim_fails_task_that_exhausted_retries(store: SqliteMetaStore) -> None:
    store.enqueue_task(_task("t1", attempts=5, max_attempts=5))
    store.claim_task(owner="worker-1", lease_seconds=1)

    later = utc_now() + timedelta(minutes=10)
    assert store.reclaim_expired_tasks(now=later) == 1

    failed = store.list_tasks(TaskState.FAILED)
    assert [task.id for task in failed] == ["t1"]
    assert "最大重试次数" in (failed[0].error or "")


def test_reclaim_ignores_live_lease(store: SqliteMetaStore) -> None:
    store.enqueue_task(_task("t1"))
    store.claim_task(owner="worker-1", lease_seconds=600)
    assert store.reclaim_expired_tasks() == 0


def test_task_can_reference_an_existing_document(store: SqliteMetaStore, kb, document) -> None:
    store.enqueue_task(_task("t1", document_id="doc_1"))
    assert store.list_tasks()[0].document_id == "doc_1"


def test_task_referencing_missing_document_is_rejected(store: SqliteMetaStore) -> None:
    """外键约束生效：任务不能挂到不存在的文档上（也是级联删除可信的前提）。"""
    with pytest.raises(Exception, match="FOREIGN KEY constraint failed"):
        store.enqueue_task(_task("t1", document_id="doc_not_exist"))


def test_tasks_follow_document_deletion(store: SqliteMetaStore, kb, document) -> None:
    """文档删除后其任务一并消失，避免留下永远跑不通的孤儿任务。"""
    store.enqueue_task(_task("t1", document_id="doc_1"))
    store.delete_document("doc_1")
    assert store.list_tasks() == []


# --------------------------------------------------------------------- 数据源 / 凭据 / webhook


def test_data_source_keeps_config_and_etag(store: SqliteMetaStore, kb) -> None:
    """架构 §10：定时拉取靠 etag 做变更检测。"""
    store.create_data_source(
        DataSourceRecord(id="ds_1", knowledge_base_id="kb_1", kind=DataSourceKind.RSS,
                         name="技术日报", config={"url": "https://example.com/feed"}, etag="W/abc")
    )
    sources = store.list_data_sources("kb_1")
    assert sources[0].config["url"] == "https://example.com/feed"
    assert sources[0].etag == "W/abc"
    assert sources[0].enabled is True


def test_api_key_is_stored_and_looked_up_by_hash(store: SqliteMetaStore, kb) -> None:
    """架构 §3.2：key 绑定知识库范围与只读/读写权限。"""
    store.create_api_key(
        ApiKeyRecord(id="key_1", name="只读客户端", key_hash="sha256:deadbeef",
                     permission=ApiKeyPermission.READONLY, knowledge_base_ids=("kb_1",))
    )
    loaded = store.get_api_key_by_hash("sha256:deadbeef")
    assert loaded is not None
    assert loaded.permission is ApiKeyPermission.READONLY
    assert tuple(loaded.knowledge_base_ids) == ("kb_1",)
    assert store.get_api_key_by_hash("sha256:nope") is None


def test_webhook_round_trip(store: SqliteMetaStore) -> None:
    store.create_webhook(
        WebhookRecord(id="wh_1", url="https://example.com/hook",
                      events=("document.indexed",), secret="s3cr3t")
    )
    hooks = store.list_webhooks()
    assert tuple(hooks[0].events) == ("document.indexed",)
    assert hooks[0].enabled is True


# --------------------------------------------------------------------- 回收站 / 设置


def test_trash_keeps_original_for_retention_window(store: SqliteMetaStore, document) -> None:
    """架构 §6.2：原文进回收站保留 7 天。"""
    store.add_to_trash(
        TrashRecord(id="tr_1", document_id="doc_1", kind=TrashKind.ORIGINAL,
                    storage_path="data/originals/doc_1.pdf",
                    expires_at=utc_now() + timedelta(days=7))
    )
    assert [item.id for item in store.list_trash()] == ["tr_1"]
    assert store.purge_expired_trash() == []


def test_purge_expired_trash_returns_and_removes_due_items(
    store: SqliteMetaStore, document
) -> None:
    store.add_to_trash(
        TrashRecord(id="tr_old", document_id="doc_1", kind=TrashKind.ORIGINAL,
                    storage_path="data/originals/old.pdf",
                    expires_at=utc_now() - timedelta(days=1))
    )
    store.add_to_trash(
        TrashRecord(id="tr_new", document_id="doc_1", kind=TrashKind.IMAGE,
                    storage_path="data/images/new.png",
                    expires_at=utc_now() + timedelta(days=7))
    )

    purged = store.purge_expired_trash()
    assert [item.id for item in purged] == ["tr_old"]
    assert purged[0].storage_path == "data/originals/old.pdf"
    assert [item.id for item in store.list_trash()] == ["tr_new"]


def test_settings_upsert(store: SqliteMetaStore) -> None:
    assert store.get_setting("mineru_token") is None
    store.set_setting("mineru_token", "v1")
    store.set_setting("mineru_token", "v2")
    assert store.get_setting("mineru_token") == "v2"


# --------------------------------------------------------------------- 级联


def test_deleting_document_cascades_to_parts_chunks_and_images(store: SqliteMetaStore, kb,
                                                               document) -> None:
    store.create_document_parts(
        [DocumentPartRecord(id="part_1", document_id="doc_1", part_index=1, page_start=1,
                            page_end=200, stage=DocumentStage.UPLOADED)]
    )
    store.replace_chunks("doc_1", [_chunk("c1", 0, image_ids=("img_1",))])
    store.add_images(
        [ImageRecord(image_id="img_1", document_id="doc_1", storage_path="data/images/1.png")]
    )

    store.delete_document("doc_1")

    assert store.count_chunks("doc_1") == 0
    assert store.list_document_parts("doc_1") == []
    assert store.list_images("doc_1") == []


def test_deleting_knowledge_base_removes_everything_inside(store: SqliteMetaStore, kb,
                                                           document) -> None:
    """架构 §6.2 级联删除在库一级同样成立。"""
    store.replace_chunks("doc_1", [_chunk("c1", 0)])
    store.delete_knowledge_base("kb_1")

    assert store.list_knowledge_bases() == []
    assert store.list_documents("kb_1") == []
    assert store.count_kb_chunks("kb_1") == 0


# --------------------------------------------------------------------- 空输入与未命中路径


def test_empty_inputs_are_no_ops(store: SqliteMetaStore, document) -> None:
    """批量写入收到空列表时应直接返回，不产生空事务。"""
    store.create_document_parts([])
    store.add_images([])
    assert store.list_document_parts("doc_1") == []
    assert store.list_images("doc_1") == []


def test_iter_chunks_on_document_without_chunks_returns_empty(store: SqliteMetaStore,
                                                              document) -> None:
    assert list(store.iter_chunks("doc_1")) == []


def test_get_parse_result_returns_none_when_absent(store: SqliteMetaStore, document) -> None:
    assert store.get_parse_result("doc_1") is None
    assert store.get_parse_result("doc_not_exist") is None
