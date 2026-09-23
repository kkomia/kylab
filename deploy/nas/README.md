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

构建很慢（`uv sync`）时不要挂在 SSH 会话上：服务器上有一个 `app/build.sh`，
它把构建放到脱离会话的后台跑、日志落 `app/build.log`：

```bash
cd /vol1/1000/docker/kylab/app && setsid nohup ./build.sh > build.log 2>&1 < /dev/null &
tail -f build.log        # 另开一个会话看进度
```

升级：把新源码替换 `/vol1/1000/docker/kylab/src/`，再 `docker compose up -d --build`。

### 前端换成 React 版之后（P5，开发计划 §12.234/§12.236）

**从这台 Windows 直接部署（一条命令，只问一次密码）**——在仓库目录里用 Git Bash 跑：

```bash
sh deploy/nas/deploy-from-windows.sh            # 默认 react 分支、默认 NAS 地址
sh deploy/nas/deploy-from-windows.sh react 192.168.31.18   # 也可以显式给
```

**先看一眼它要干什么**（不碰网络）：`sh deploy/nas/deploy-from-windows.sh --dry-run`
——打印分支与自证结果、归档大小（约 11 MB）、**将要执行的那一条 ssh 完整命令**、
以及远端那一步会做的事（判源码形态 → 只重建 frontend → `up -d` → 核对 200 与 `#root`）。

它把下面那两条 ssh 合成**一次连接**（所以只问一次密码），并在传之前先自证
"这次要传的确实是新前端"（`frontend/src/features` 在不在）——传一份旧的过去再构建，
最后只会得到一个老界面，而那种失败最难看出来（页面 200、没有报错）。跑完它自己
curl NAS 并认 `#root`/`#app`。

<details>
<summary>展开：手工的两条命令（脚本做的就是这两步）</summary>


```bash
# ① 把 react 分支的源码推到 NAS 的 src/（archive 覆盖；NAS 上那份本来就不是 git 检出）
git archive --format=tar react | ssh kkomia@192.168.31.18   "mkdir -p /vol1/1000/docker/kylab/src && tar -x -C /vol1/1000/docker/kylab/src --overwrite"

# ② 在 NAS 上跑升级脚本（只重建前端 + 核对 #root）
ssh kkomia@192.168.31.18   "cd /vol1/1000/docker/kylab/app && sh /vol1/1000/docker/kylab/src/deploy/nas/update-frontend.sh react"
```

两条都会在**你这边的终端**里问 NAS 的密码（OpenSSH 的交互式认证，密码不经我的脚本、也不落地）。
第 ② 条的输出会打印 `首页 HTTP：200` 与 `已确认是 React 前端（挂载点 #root）`。
源码用 archive 覆盖是刻意的：NAS 的 `src/` 从来不是 git 检出，"git pull" 那条路在那边不存在。

</details>

**NAS 上一条命令的版本**（已经登录在 NAS 上时）：`sh /vol1/1000/docker/kylab/src/deploy/nas/update-frontend.sh react`

它先看源码形态（这台 NAS 的 `src/` 是 **`git archive` 解开的、不含 `.git`**，
所以"先 pull 再构建"在这里会失败）：
- `src/frontend/src/features/` 在 → 是新前端，继续；**顺便**发现 `.git` 才做 `fetch/pull`（加分项，不是前提）；
- 还是 `src/views/ChatView.vue`（旧 Vue）→ **不构建**，直接打印三条换源码的路子（本机 archive 过去 /
  NAS 上 clone / 只覆盖 `frontend/` 这一棵）并退出码 2 —— 免得白构建一次却发现界面还是老的；
- 两者都不是 → 提示路径不对，退出码 2。

源码 OK 之后还会先过两道守卫，再做事：
- `$APP/docker-compose.yml` 不在 → 提示路径不对并退出码 2（免得在一台机器上瞎构建）；
- `docker info` 不通（最常见的是 `/var/run/docker.sock` 权限）→ **直接把该敲的那一行打出来**
  （`sudo sh <脚本> react`）并退出码 3，而不是丢一个 `permission denied` 让人猜。

然后是三件事：**只重建 frontend**（后端不重建）→ `up -d frontend` →
核对首页 200 **并认一次 `#root`/`#app`**（镜像没真换掉时页面会安静地还是旧版）。
（这几条分支都用临时目录模拟跑过：源码形态三档、app 缺失、docker 不可用。）

> 构建走的是 **npmmirror**（`deploy/nas/docker-compose.yml` 给前端构建传了
> `NPM_REGISTRY`，与后端那份 `UV_INDEX_URL` 同一个理由：这台机器到境外带宽极差）。
> 换机器部署时不用改 Dockerfile——它默认仍是官方源。

下面那三步是它展开后的手工版。



**compose 与路径都不用改**（迁移时就是按"新前端接管 `frontend/`"做的：
`context: ../frontend`、镜像名 `kylab-frontend`、`frontend/nginx.conf` 与 `Dockerfile` 都还在原位）。
只要源码换到含 P5 的那个提交，然后**只重建前端**这一个服务：

```bash
cd /vol1/1000/docker/kylab/src && git fetch && git checkout react && git pull
cd /vol1/1000/docker/kylab/app
docker compose build frontend          # 只重建前端（后端不动，几秒到一分钟）
docker compose up -d frontend
curl -s -o /dev/null -w '%{http_code}
' http://127.0.0.1:8081/   # 期望 200
```

镜像里的构建要点（排查用）：前端镜像用 **pnpm**（`corepack enable` + `packageManager: pnpm@11.21.0`
钉版本），`.dockerignore` 排掉了 `node_modules`——**别把它删掉**：pnpm 装的是平台相关依赖
（esbuild 的 win32 二进制、`@tailwindcss/oxide-win32`），带进 Linux 镜像会以"本机能建、镜像里报平台错"收场。
`docker compose logs -f frontend` 看 nginx 日志；构建慢就照上面那节用 `app/build.sh` 脱会话跑。

构建完可以就地验两件事（v0.1.1，见《开发计划》§12.224 第 9、12 条）：

```bash
# 1) 镜像里真的带了仓库自带的 5 个技能（走 KYLAB_SKILLS_DIR=/app/skills，见 backend/Dockerfile）
docker compose exec -T backend python -c "from pathlib import Path; from app.services.skills import SkillService; print(sorted(r.name for r in SkillService(Path('/data')).list() if r.source=='builtin'))"
#    期望：['kylab-delegate', 'kylab-knowledge-base', 'kylab-memory', 'kylab-office-export', 'kylab-web']

# 2) 记忆/人设模板已经在数据目录里铺好（启动时幂等补的，落在挂载卷上）
ls -l /vol1/1000/docker/kylab/data/memory
#    期望：AGENTS.md / MEMORY.md / PROFILE.md / SOUL.md
```

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
