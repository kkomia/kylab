# NAS 部署（应用层）

这台 NAS（`192.168.31.18`）上的 kylab 分两层，**各自独立管理**：

| 层 | 内容 | 位置 | 谁管 |
| --- | --- | --- | --- |
| 存储层 | PostgreSQL 17 + pgvector（54321）、MinIO（9000/9001） | `/vol1/1000/docker/kylab/`（库数据）、`/vol1/1000/docker/1panel/.../minio/`（对象） | 前者一份单服务 compose；后者 1Panel |
| 应用层 | 后端（FastAPI）+ 前端（nginx） | `/vol1/1000/docker/kylab/app/` + `/vol1/1000/docker/kylab/src/` + `/vol1/1000/docker/kylab/data/` | **本目录这份 compose** |

两层都挂在同一个 docker 网络 `1panel-network` 上，应用层按容器名
（`kylab-postgres` / `kylab-minio`）连过去——**不改存储层的任何配置，也不占宿主机的
54321/9000 端口**。

## 目录布局（服务器上）

```
/vol1/1000/docker/kylab/
├── docker-compose.yml        # 存储层：postgres（原有的，别动）
├── pgdata/                   # PG 数据目录（原有的，别动）
├── src/                      # 本项目源码（git archive 解开，不含 .venv/node_modules）
├── app/
│   ├── docker-compose.yml    # 应用层（就是这份文件）
│   └── .env                  # 凭据：PG 口令 + MinIO 密钥（**不入库**，见下）
└── data/                     # 后端 /data：DuckDB 表格副本、日志、回退原件（持久化）
```

## 起 / 停 / 升级

```bash
cd /vol1/1000/docker/kylab/app
docker compose up -d --build        # 构建并起（首次约几分钟）
docker compose logs -f backend      # 看后端日志
docker compose ps                   # 状态（backend 应显示 healthy）
docker compose down                 # 停掉（**不动存储层**）
```

升级：把新源码替换 `/vol1/1000/docker/kylab/src/`，再 `docker compose up -d --build`。

界面：`http://192.168.31.18:8081`（首次打开会让你创建管理员账号）。
接口文档：`http://192.168.31.18:8081/api/v1/docs`；健康检查：`/api/v1/health`（不鉴权）。

## `.env`（在服务器上，不进仓库）

`app/.env` 只有四项，值与本机 `/vol1/1000/docker/kylab/docker-compose.yml` 里的一致：

```ini
KYLAB_PG_PASSWORD=<与存储层 compose 里的一致>
KYLAB_S3_ACCESS_KEY=<MinIO 的 access key>
KYLAB_S3_SECRET_KEY=<MinIO 的 secret key>
KYLAB_S3_BUCKET=kylab
```

**为什么不把这些写进仓库**：仓库里那份 `deploy/docker-compose.yml` 用的是占位默认值
（`kylab-dev-secret` 之类），真实凭据只活在这台机器的 `.env` 里。`.env` 不要提交。

## 持久化

| 数据 | 落在哪 | 备份方式 |
| --- | --- | --- |
| 元数据 / 向量 / 全文 | `kylab-postgres` 的 `/vol1/1000/docker/kylab/pgdata` | **`pg_dump`**，不要直接拷运行中的 data 目录 |
| 原件 / Markdown / 图片 | `kylab-minio` 的 `/vol1/1000/docker/1panel/data/1panel/apps/minio/minio/data` | 拷目录即可（对象是只写不改的） |
| 表格副本（DuckDB）、日志 | `/vol1/1000/docker/kylab/data`（bind mount） | 拷目录，或整卷备份 |

容器重建、`docker compose down` 都不会动这三处。

## 与开发环境共用同一套存储（要清楚这一点）

按用户要求，部署实例连的是**开发时那一套** PG 库与 MinIO 桶（同一个 `kylab`）。
也就是说 NAS 上的实例与本机开发实例看到的**是同一份数据**。

- 两边都开着 `KYLAB_RUN_WORKER=true` 不会重复处理任务（任务队列靠租约认领），
  只是有一份冗余；只想留一边处理队列就把另一边的 `KYLAB_RUN_WORKER` 设成 `false`；
- 想让部署实例单独一份数据：先建好新库与新桶，再改 `app/.env` 里的
  `KYLAB_PG_DB` / `KYLAB_S3_BUCKET`（compose 里已经把这两个读成变量）。
