# Kimi 桌面端本地存储调研 v0.1

> 日期：2026-10-01
> 方法：只读盘点本机 `AppData/Roaming/kimi-desktop/`（1.6 GB）及关联目录，
> 不 dump 聊天正文与凭据值（凭据只记位置与形态）。
> 目的：为《架构设计 v0.3》的**本地存储分层**与**性能契约**提供实证参照。
> 相关：《[架构设计 v0.3](../../设计/架构设计-v0.3.md)》§5、§6。

---

## 1. 总表：数据分类 → 存储技术

| 类别 | 存储技术 | 位置 | 大小 |
| --- | --- | --- | --- |
| 网页资源缓存 | Chromium Simple Cache / V8 Code Cache | `Cache/Cache_Data`、`Code Cache/{js,wasm}` | 41 MB + **133 MB** |
| 内嵌浏览器分区 | 独立 session partition 一套缓存 | `Partitions/kimi-work-browser-v1/` | 55 MB |
| 用户态 | safeStorage（DPAPI）/ Local Storage / IndexedDB / OPFS / Cookies | `bridge-store/token-store.json`、`Local Storage/leveldb`、`IndexedDB/`、`File System/` | 合计 ~2.5 MB |
| 应用态 | **34 个小 JSON（一文件一关注点）** + 共享 KV 8 个 | `kimi-agent/*.json`、`bridge-store/*.json` | 3.1 MB + 15 KB |
| 会话与消息 | **只有索引与影子状态，没有正文**（详见 §2） | `kimi-agent/conversation-*.json`、`Session Storage/`（加密） | KB 级 |
| 会话索引（Agent 侧） | **SQLite（STRICT 表 + 迁移记录）** | `daimon-share/daimon/agents/main/sessions/hosted-logical/conversations.sqlite` | 241 KB |
| 日志 | 文本 20 MiB 硬上限滚动 + 按天 SQLite 索引 | `logs/main.log(.old)`、`daimon/logs/index/events-*.sqlite` | ≤26 MB |
| 更新器 | electron-updater 缓存（**两份安装包不清**） | `Local/kimi-desktop-updater/` | **866 MB** |
| 本地运行时 | CPython 3.12 + uv + Git + Kimi Code + 364 node_modules | `daimon-bundle/` + `daimon-share/daimon/runtime/` | **1.3 GB** |

## 2. 关键结论一：它的流畅感靠什么

**本地不存聊天正文**（没有任何 conversation/message 类 store；唯一存消息的 SQLite 属于已废弃的旧版应用）。切菜单/切对话的流畅来自四件事：

1. **壳与字节码落盘**：`Code Cache/js` 119 MB / 4173 文件（V8 编译产物），二启不下载不编译——最大单一来源；
2. **切对话是 SPA 原地路由**（日志 `isInPlace=true`），无页面级重载；
3. **本地元数据先画骨架**：每个对话的 status / unread / model / contextUsage / archive 等躺在小 JSON 里，侧边栏与徽标首帧即出，正文流式填充；
4. **主/渲染进程共享 KV**（主题/语言/升级策略），首帧零 IPC。

**推论**：它是"骨架本地 + 正文联网"。本地优先产品不必也不能抄这条路——正文在本机时，"切对话"可以做到比它更快（磁盘命中 vs 流式填充）。

## 3. 关键结论二：首屏代价转移到了哪里

转移到**磁盘**与**首次安装的网络**：

- `Code Cache` 133 MB：把 V8 编译成本前置成磁盘字节；
- 常驻运行时 1.3 GB + 安装包堆积 866 MB（两份完整安装包，与 1.2 GB 安装目录重复）；
- `bundle.json` 标明 `pythonRuntime.mode = "online_uv_sync"`、自带 wheel 数为 0——**装完第一次还要联网同步 Python 依赖**才能真正可用；
- 启动时要先拉起 daimon 控制服务器（WebSocket），渲染进程连上才 ready。

## 4. 关键结论三：满分作业与反面教材

**满分作业（daimon 侧 `conversations.sqlite`）**：

- `STRICT` 表；`schema_metadata` 记录从旧 JSON 的迁移过程，迁移前自动备份到 `migration-backup/`；
- `conversations` 存列表所需一切（标题/状态/首轮摘要/工作区路径），**正文按 `kernel_records_path` 引用外部**；
- 三个 `(agent_id, …, updated_at_ms DESC)` 最近序覆盖索引——列表页零排序扫描。

**反面教材（`kimi-agent/*.json`）**：

- 同一 key 空间在 5 个 JSON 里各存一遍，改一个会话要重写整个文件（O(N) 写放大，崩溃一废全废）；
- `file-edit-journal.json` 把 before/after 全文塞进单个 3.1 MB JSON，随对话数线性膨胀——Kimi 自己在 daimon 侧已用 SQLite 修掉这套，**抄修正后的，别抄病**。

## 5. 抄 / 不抄清单

**照抄（7 条）**：

1. 应用态小 JSON 一文件一关注点、独立原子写（崩溃最多丢一个维度）；
2. 进程外共享 KV 放主/渲染进程同读的小设置；
3. 加密文件自描述（首字段 `"encryption": "safeStorage.v1"`），换方案老文件自识别；
4. 日志文本 20 MiB 硬上限滚动（整个目录永 ≤26 MB、可直接 grep）+ 按天 SQLite 结构化索引；
5. 窗口几何单独一个文件，坏了删了自动重建；
6. 能力实体按目录分片（`blueprint/automations/<uuid>/…`），可增量备份/单独删除/单独传走；
7. 缓存层完全可弃，运行时有内容戳校验，坏了可重建。

**不抄（6 条）**：

1. 消息正文/会话列表全在服务端、本地只有影子索引（= 把"切对话必须联网"焊进架构）；
2. 集合型数据放 JSON 大对象（写放大，见 §4）；
3. 1.3 GB 内嵌运行时（我们的边车 ~25 MB，天然没有这个负担）；
4. 更新器缓存两份安装包不清（留一份回滚包足够）；
5. 同一应用三套凭据策略（safeStorage / 明文 TOML api_key / 明文 JWT in Local Storage）——**要反着抄：秘密只进系统钥匙串**；
6. 首装后还要联网同步依赖才能用（打包必须自包含）。

**看到但别学**：会话级状态清理/压实偏弱（`Session Storage` 同 key 加密 blob 反复堆积、`DIPS-wal` 766 KB）；离线消息队列 `message-queues/` 建好了但常年为空——机制在、场景没打。
