# 代码质检报告（M2 异步消费者 + M4 核心 REST API）

- 范围：`6399ead..523944a`（M2 任务消费者、M4 知识库/文档/检索/任务端点）
- 日期：2026-09-10
- 依据规范：项目工程规范 v0.3 / 前端设计规范 v0.3 / 架构设计 v0.2
- 结论：**有条件通过**（无 P0；1 项 P1 待修，见下表 Q2）

## 问题清单

| 级别 | 位置（文件:行） | 规则 | 问题描述 | 修复建议 |
|------|----------------|------|----------|----------|
| P1 | `backend/app/api/v1/search.py:49-76` | 分层纪律（协议层只做适配） | 逐字段手抄 `SearchHitOut` / `ChannelStatOut`，与本次修掉的 `documents.py` 是同一类漏点：`SearchHit` 加字段时响应会静默丢字段 | 与 `DocumentOut` 一致，给 `SearchHitOut` / `ChannelStatOut` 加 `from_attributes=True`，改用 `model_validate(hit)` |
| P1 | `backend/app/services/documents.py:81-84` | 架构承诺 / 性能 | `get_task()` 拉全表再在 Python 里线性查找；`list_documents` 里每个文档一次 `count_chunks`，属于 N+1 | 给 `MetaStore` 加 `count_chunks_by_documents(ids)` 一次查完；`get_task` 走 SQL 主键查询 |
| P2 | `backend/app/api/v1/documents.py:48-50` | 安全 / 资源占用 | 上传先 `await file.read()` 全量读进内存再判大小，200MB 上限意味着单请求峰值 200MB；且超限时已经读完 | 改为分块读并累计字节数，超过上限立即 413 中断 |
| P2 | `backend/app/api/v1/search.py:28-34` | 分层纪律 | 手工把 `MetadataFilterIn` 逐字段翻译成 `MetadataFilter`，可改为同一套 `model_validate` 思路 | 让 `MetadataFilter` 自己接受 schema，或给 schema 加 `to_service()` |
| P2 | `backend/app/core/services.py:56` | 组合根完整性 | 解析器清单硬编码 `[PlainTextParser()]`，与"逐文件动态路由"这一核心差异化能力的接线还差云端解析器 | 保持现状可接受（M6 接 MinerU/PaddleOCR 时在此追加），但要在计划书里标注为未完成项 |
| P3 | 提交 `523944a` | 提交信息准确性 | 提交信息里提到的"协议层不再手抄响应字段"实际落在上一个提交 `807d185`（当时改动已 stage） | 无需重写历史，此处记录以免日后追溯困惑 |

## 自动化检查结果

- ruff：通过（`app/` + `tests/` 全绿）
- emoji 扫描：通过（后端、前端均 0 处）
- 分层纪律与测试位置：通过（L1 曾在开发期命中 `app/api/v1/documents.py` import `app.storage.base`，已改为 `from_attributes` 校验后消除）
- pytest：422 通过 / 0 失败（`not bench and not cloud`），`app/` 覆盖率 **100%**
- eslint + prettier：通过
- vue-tsc 类型检查：通过
- vitest：4 通过 / 0 失败
- 前端生产构建：通过
- `scripts/ci.ps1` 九步门禁：**全绿**

## 人工审查覆盖（六组）

### 一、分层纪律
- ✓ `api/v1/*` 无业务判断、无 storage/parsers/workers 直连（L1 机械检查 + 人工复核）
- ✓ `services/` 无 SQL 字面量、无 `sqlite_impl` import（L2）
- ✓ `parsers/` 无相互 import（L3）
- ✓ 新增存储方法都加在 `sqlite_impl/`，接口仍只声明在 `storage/base.py`
- ✗ P1 `search.py` 手抄字段（见上表）

### 二、命名
- ✓ Python 命名规范；API 路径 kebab-case 且全部带 `/api/v1/` 前缀
- ✓ 本轮无新增 MCP 工具、无新增解析器实现、无前端组件
- ✓ 文档命名 `<主题>-v<主.次>.md`，旧版本保留

### 三、测试
- ✓ 测试只在 `backend/tests/{unit,integration}/`；镜像同构；新增目录带 `__init__.py`
- ✓ 新增功能均有测试：worker 生命周期/续租/租约易主/关停收尾、REST 端点、上传上限
- ✓ 集成测试用临时 SQLite，`KYLAB_DATA_DIR` 隔离，未触碰开发库
- ✓ 无 >5MB 夹具；无 `cloud`/`bench` 标记误用

### 四、安全
- ✓ 无 token/密钥入库；`.gitignore` 覆盖 `.env`、`*.db`、`data/`
- ✗ 上传幂等键、签名 URL、API Key 鉴权（kb 范围 + 只读/读写）**尚未实现**——沿用 M4 的显式延后决定，列入 M7 前必须补齐项
- ⚠ 服务默认监听本机；投入局域网前必须先有鉴权，否则等于把知识库裸奔在网段里

### 五、前端风格
- 本轮未改前端，逐项不适用；emoji 扫描与 eslint 仍全绿

### 六、架构承诺
- ✓ 任务状态机 `uploaded→…→indexed` / `failed` 与架构 §4 一致
- ✓ 失败可重试（指数退避 2/4/8…上限 60s）、断点续跑（`_resume_stage` 按产物判定）
- ✓ 租约机制保证多消费者不重复执行；租约易主后拒绝写终态
- ✗ >1000 页强制切分、扫描件页级路由、模型切换校验、级联删除、chunk 级增量更新：分属 M2 云端解析器与 M6，未到验收点

## 开发期自查发现并修复的真实缺陷（非清单项）

1. **任务终态可被过期消费者覆盖**：`finish_task` / `reschedule_task` 原为无条件 UPDATE。租约被回收后，原消费者跑完仍会把任务改成"成功/失败"，并清掉新主人的租约。已加 `owner` 条件更新 + 正反两路测试。
2. **关停会丢半截摄入**：`await asyncio.to_thread(...)` 被取消不会让线程停下，原实现关停时直接返回，文档会停在写了一半的状态。现在取消到达后先等线程收尾。
3. **续租循环靠"正常返回"叫停兄弟任务是不成立的**：`asyncio.TaskGroup` 的子任务正常返回**不会**取消兄弟任务（已用最小脚本验证），租约被抢后续租循环返回、消费循环却继续领新任务。改为显式置位 `stopping`。
4. **续租异常带走整个消费者**：续租循环在 TaskGroup 内，一次存储抖动会让 `run_forever` 抛 `ExceptionGroup` 退出，而线程里的摄入还在跑。已改为记日志跳过本轮。
5. **协议层越过 services 直连存储**：`api/v1/documents.py` import `app.storage.base`，被 L1 规则拦下（规则本身此前修过一次假阴性，这次是真命中）。
6. **`logging.setup_logging()` 摘掉宿主 handler**：原实现 `root.handlers.clear()` 会让 uvicorn/pytest 的 handler 一起消失，表现为"日志莫名没了"；已改为只清理自己打的标记。
7. **覆盖率误判**：`TestClient` 在自己的线程里跑生命周期，未声明 `coverage.run.concurrency = ["thread"]` 时那几行统计不到，会误以为没覆盖。

## 结论

无 P0 阻塞项；P1 两项（`search.py` 手抄字段、`DocumentService` N+1 查询）限期修复，均不影响当前功能正确性。**有条件通过**，允许继续推进 M5 前端页面；上述 P1/P2 与安全组未完成项一并转入下一轮修复清单。
