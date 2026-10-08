# KYLAB

**跑在你自己电脑上的本机 Agent**：对话与工具循环、沙箱、笔记与记忆、技能与插件、
工作区、定时任务、Office 交付都在本机跑；数据落本机 SQLite，不依赖任何服务器。
模型由本机持 key 直连供应商（DeepSeek 等）。

当前迭代形态是 **web 端**：本机后端 + Vite 前端。版本与逐条变更见[变更记录](CHANGELOG.md)。

## 它是什么

- **对话是主入口，主流程是工具循环**：SSE 流式回答；读工作区里的文件、在沙箱里跑命令、
  联网搜索与取页、对表格副本跑只读 SQL、挂定时任务、派生子 Agent。
  工具能碰哪些目录按会话与工作区范围收口；上下文超限自动压缩，
  撞上步数或时间上限可以接着上一轮继续，不用从头再来。
- **对话右端常驻一列面板**：「文件」是这条会话的文件区，做成一棵可就地展开的树，点开即预览；
  「网页」分原页嵌入与读我们抓回来的正文两档，默认档由一次探测决定、用户可以覆盖。
  面板是页面的一部分，不是浮层——左边照旧能读能滚。
- **笔记与记忆**：笔记是富文本（图文混排、待办、粘贴图片），Markdown 落库为唯一事实源；
  记忆是一份落在磁盘上的 Markdown 档案（人设 + 长期事实），关掉记忆服务也读得到、改得动。
- **能力层**：技能（`SKILL.md` 渐进式展开）与外部 MCP 服务，准入分
  allow / deny / ask / sandbox 四档——`ask` 档会真的停下来问你，
  等不到人就如实回"没有回应"，不和"用户拒绝了"混成一句话。
- **工作区与沙箱**：工作区（项目）→ 会话的归属链；沙箱给执行类工具一个受限目录，
  没有隔离就拒绝执行。两者是两件事。
- **到点自己做事**：定时任务（cron / 一次性）在任务中心里，到点跑一轮问答、结果落进一条会话。
- **Office 交付**：docx / xlsx / pptx / pdf 产出能直接发出去的文件，
  交付物与正文一起在收尾时出现。
- **数据在哪**：会话、消息、事件、产物、笔记、记忆、设置全在本机
  `%APPDATA%\com.kylab.desktop\kylab.db`（SQLite + WAL），工作区与记忆是同目录下的文件。
  长期凭据（模型 key）进系统钥匙串，库里存空、日志不落。

**不做**：可视化编排 / 工作流引擎 / 文档协作编辑器；不做跨机实时同步——跨机流动走备份恢复。

## 怎么跑

桌面壳这一轮暂停（留到大版本再封装），所以这里只讲 web 这一条路。
前置：Python 3.12（依赖用 uv 管）、Node 20+。

```sh
# 终端 1：本机后端（边车）——对话 + 全部本机数据，:8765
sh scripts/dev-sidecar.sh

# 终端 2：前端，:5173
pnpm --dir frontend install
pnpm --dir frontend dev
```

打开 http://127.0.0.1:5173 就是完整产品。Windows 上 `.sh` 有同名 `.ps1`。

- **边车就是本机后端**：`sh scripts/dev-sidecar.sh` 把它起在 `127.0.0.1:8765`，只监听本机，
  对话与全部本机数据都在它身上。
- **模型**由本机持 key 直连：在设置里配模型与 key，key 进系统钥匙串。
- 数据默认落在壳的真实数据目录（与壳同一个库、同一批会话）；想用一份隔离开的数据
  （不碰壳里那份）设 `KYLAB_DATA_DIR`。
- **端口占着会明确拒绝启动**，不静默换端口——两个实例同时在跑会表现成
  "我改了后端，界面却还是旧行为"。
- `scripts/dev-backend.sh`（:8000）是**服务器档**的开发后端，
  只有要改 NAS 侧那份旧单体时才起。

门禁脚本：`sh scripts/check-backend.sh`、`sh scripts/check-frontend.sh`、`sh scripts/ci.sh`。

## 仓库结构

```
kylab/
├── backend/               Python 后端（FastAPI）：本机档入口 app/sidecar.py、
│                          服务器档入口 app/main.py，共用同一份业务层；见 backend/README.md
├── frontend/              React 19 + Vite + TS 的 Web 界面（当前迭代形态）
├── desktop/               Tauri 2 桌面壳（这一轮暂停）
├── shell/                 壳内置的引导页：把前端从本地资源拉起来，拉不起来时给换服务器入口
├── skills/                官方技能产物（SKILL.md）
├── scripts/               开发 / 门禁 / 生成脚本（dev-*.sh、check-*.sh、ci.sh…）
├── docs/                  规范 / 设计 / 计划与记录 / 归档（清单见 docs/README.md）
├── deploy/                旧部署产物，本机形态用不到
├── tests/e2e/             跨端 E2E 的落点，目前是占位
├── .github/workflows/     GitHub Actions 门禁（保留备将来镜像）
└── .workflow/             Gitee Go 门禁（默认承载）
```

**铁律**：任何文件都有唯一归属目录，不允许在仓库根目录散落临时文件。

## 工程质量门禁

CI 在 **Gitee Go**（`.workflow/kylab-ci.yml`）；GitHub Actions 版保留备将来镜像。
两处调用**同一批脚本**，所以不存在"本地绿、CI 红"的分叉。按改动范围跑对应那一个：

| 只改什么 | 跑什么 |
| --- | --- |
| 后端 | `sh scripts/check-backend.sh`——ruff + emoji + 分层纪律 + API 文档与类型同步 + pytest |
| 前端 | `sh scripts/check-frontend.sh`——eslint + prettier + tsc + vitest + 生产构建 + emoji |
| 跨端 / 收尾 | `sh scripts/ci.sh`——规范检查 + 后端测试 + 前端测试与构建 |

- 改一处时用 `python scripts/affected_tests.py --run` 按反向依赖图挑该跑的用例；
  一个大版块收尾才跑真全量，报告里给全量自己的数字。
- 后端门禁要一个带 pgvector 的测试库（`KYLAB_TEST_DATABASE_URL`），没配会直接报错——
  静默变绿比跳过更糟。只想跑本机档那一半（不需要 PG）：
  `cd backend && uv run pytest tests -q -m local`。

三条分层铁律由 `scripts/check_layering.py` 机械核查，不靠 review 记忆：

1. `api/`、`mcp_server/` 只做协议适配，禁写业务逻辑；
2. `services/` 禁止直接写 SQL，存储访问只能经 `storage/` 的 Repository 接口；
3. `parsers/` 各实现只依赖 `base.py` 的 `ParseResult`，实现之间禁止互相 import。

## 贡献

- 分支：`main` 保护，集成分支 `develop`，功能分支 `feat/<简述>`，修复 `fix/<简述>`；
- 提交信息：`<类型>: <简述>`，类型限 `feat/fix/docs/test/refactor/chore`；
- 合并前 CI 必须全绿（**CI 是最终裁判**，本地通过不算数）；
- 新增文件先查《[项目工程规范 v0.6](docs/规范/项目工程规范-v0.6.md)》§7 决策树，
  测试按 §5.1 对号入座；文档该放哪一类见 [`docs/README.md`](docs/README.md)。

## 许可

[MIT](LICENSE)
