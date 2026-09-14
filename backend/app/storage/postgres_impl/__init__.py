"""PostgreSQL 存储实现（v0.12 起，SQLite 退役）。

与 ``sqlite_impl/`` 平级，由 ``app/core/storage.py::build_stores()`` 装配。
装配点唯一，``services/`` 只依赖 ``app/storage/base.py`` 的接口，
所以切换存储不需要动业务层（``scripts/check_layering.py`` 的 L2 规则守着这条边界）。

当前落地进度（分块推进，每一步都独立可验证）：
- ``connection.py``  连接池与事务上下文 —— 完成
- ``schema.py``      schema 基线创建与启动校验 —— 完成
- ``validate.py``    运维自检入口 —— 完成
- ``meta_store.py``  173 个仓储方法 —— 待办（大头）
- ``vector_store.py`` / ``fulltext_store.py``（pgvector / tsvector）—— 待办
- ``object_store.py``（S3/MinIO）—— 待办

在此之前后端仍跑 SQLite（``database_url`` 未配置时回落到 ``sqlite_impl``）。
"""
