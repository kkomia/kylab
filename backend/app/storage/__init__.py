"""存储抽象层。

``base.py`` 定义 ``MetaStore`` / ``VectorStore`` / ``FullTextStore`` /
``ObjectStore`` / ``TabularStore`` 接口，实现按存储分目录平级放置：

- ``sqlite_impl/`` —— 元数据（会话/笔记/设置/工作区/…），落 ``<data_dir>/kylab.db``。
  另含**四块本机独有**的方法族（都不在 ``MetaStore`` 上，各自登记在 ``sqlite_impl``
  的同名常量里）：旧会话导入台账（``imports`` / ``import_items``，
  ``LOCAL_LEDGER_METHODS``）、知识库元数据快照（``kb_meta_cache``，
  ``LOCAL_CACHE_METHODS``）、快照打包与读回（``LOCAL_SNAPSHOT_METHODS``）、
  备份待传队列（``backup_snapshots``，``LOCAL_BACKUP_METHODS``）；
- ``split_impl/``    —— 按域分流的 ``RouterMetaStore``：本机域走 sqlite_impl，
  知识库域转给 KB 侧实现（那三个"不可用"仓储也在这里：本机不持有向量 / 全文 / 表格）；
- ``local_impl/``    —— 本地文件系统对象存储。

**只有这一套**：服务器档那三份实现（``postgres_impl`` / ``s3_impl`` /
``duckdb_impl``）随知识库产品剥离一起删了，所以装配不再有"按档分流"这一步。
"""
