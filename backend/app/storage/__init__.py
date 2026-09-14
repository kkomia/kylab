"""存储抽象层。

``base.py`` 定义 ``MetaStore`` / ``VectorStore`` / ``FullTextStore`` /
``ObjectStore`` / ``TabularStore`` 接口，实现按存储分目录平级放置：

- ``postgres_impl/`` —— 元数据 + 向量(pgvector) + 全文(tsvector)，v0.12 起唯一主实现；
- ``local_impl/``    —— 本地文件系统对象存储；
- ``s3_impl/``       —— S3 兼容对象存储（MinIO / AWS）；
- ``duckdb_impl/``   —— 表格型文档的结构化副本。

SQLite 实现已于 v0.12 退役删除。
"""
