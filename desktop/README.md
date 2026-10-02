# KYLAB 桌面壳

一个**进壳**的桌面客户端：后端跑在你的 NAS 上，**界面打包在壳里**、从磁盘读出
（自定义协议 `app://`），所以首屏不付网络代价、点哪都不再等 NAS 发包。壳里
**没有服务端**：所有 `/api/**` 仍转发到配置里的那台服务器（会话与知识库还在 NAS 上，
把这一层搬回本机是 M2/M3 的事）。

界面分三级，按优先级取（规格 §5.4）：**热更新下来的那份 → 包内兜底那份（打包时的
`frontend/dist`）→ 编译进 exe 的引导页**。前端日常迭代只发服务器（见下面「前端热更新」），
用户的壳下次启动自动换上新界面，**不用重发壳**。

选型与取舍见《[桌面端套壳调研 v0.1](../docs/调研/桌面端套壳调研-v0.1.md)》，
路线与验收口径见《[架构设计 v0.3](../docs/设计/架构设计-v0.3.md)》§6.2 / §9 的 M1 行，
落地规格见《[Tauri 壳资源分离与前端热更新](../docs/规范/Tauri-壳资源分离与前端热更新-实现规格-v0.1.md)》。
最初的套壳落地记录见《[开发计划](../docs/计划与记录/开发计划-v0.1.md)》§12.207。

## 三条行为约定

1. **配过一次就一直用它**。地址落在 `config.json`；之后每次启动直接连它，
   不再让用户看配置页。**只有用户在「更换服务器」里主动改，那个地址才会变**——
   连不上（NAS 没开机、网断了）也不清空它。
2. **先探活再导航**。启动时先问一句 `{地址}/api/v1/health`，通了才把窗口指过去
   （指到本地那份界面上）；不通就留在配置页上，把原因分三类说清楚：**连不上**
   （拒绝/超时/域名解析不了）、**不是 KYLAB**（那个地址上跑的是别的服务）、
   **版本不配**（接口版本不是 v1）。不这么做的话，用户得到的是 WebView 自己的
   错误页——那上面没有返回入口的提示。**断网时看到的是这张"连不上"的状态页**，
   不是白屏、也不是一份假装还能用的离线界面（离线只读是后面 M 的事）。
3. **只加载你的服务器**。导航白名单只放行本地界面与配置里那个源；回答里的外链
   （`target="_blank"`）一律交给系统浏览器。壳不该变成没有地址栏的浏览器。

## 跑起来

```powershell
# 前置：Rust 工具链（本机用 rustup 的 msvc 档）+ VS 2022 生成工具 + WebView2 运行时
cd desktop/src-tauri
cargo run              # 开发态：直接起窗口
cargo run --release    # 快得多，推荐
```

首次打开是配置页：填 `http://<NAS 的 IP>:8000`（局域网里没写协议也认），
点「连接并进入」。之后每次打开都直接进界面。

**窗口开多大是问显示器要的，不是写死的**（v0.34）：取当前屏幕工作区的 92% 宽、
16:10 的比例，夹在 1488–1680 宽之间（高度再夹进工作区）。下限那个 1488 是实测值——
笔记页编辑器里那行工具栏在 1280 的视口下会折成两行，到 1488 才是一行，而壳里
窗口宽度就是视口宽度。**用户自己拖动窗口不在这个约束里**：拖窄是他的选择
（窄到 900 以下时笔记页本来就有设计过的单列布局），但默认打开的那一屏不该有一处排版是坏的。

**改地址 / 重新加载 / 在浏览器里打开 / 打开配置与日志 / 退出**都在**托盘图标**上
（右键弹出；左键单击把窗口叫到前面）。窗口里**没有菜单栏**——系统标题栏下面直接就是
应用界面：菜单栏是系统画的原生控件、样式改不了，挂了它窗口顶上就会叠三条横杠
（标题栏 + 菜单栏 + 应用自己的头部），这正是 v0.30 改掉的那处。macOS 例外：
那里必须挂应用菜单，否则 ⌘C / ⌘V 是死的。

「连接 → 在浏览器里打开」等入口**用系统浏览器打开同一台服务器**——壳出问题时这是个逃生门。

## 界面从哪儿来（进壳 + 热更）

壳里的页面有三级，协议层按优先级逐个试（`resources.rs::candidates`，规格 §5.4）：

| 优先级 | 那份 | 落点 | 什么时候用它 |
| --- | --- | --- | --- |
| 1 | **热更新下来的** | `<app_data_dir>/frontend-resources/v<版本>/dist/` | 后台同步装过之后，日常都是它 |
| 2 | **包内兜底** | `<exe 旁>/frontend-dist/`（打包时的 `frontend/dist`） | 全新安装、还没同步过；热更新那份坏了/被删了 |
| 3 | **引导页** | 编译进 exe（`shell/src/`） | 前两级都没有时：只剩一个能重连、能换服务器的页面 |

- **打开不再从 NAS 拉 UI**：文档与每个 chunk/样式/字体都走自定义协议 `app://`，
  从磁盘读（Windows 上它的源是 `http://app.localhost`）；只有 `/api/**` 转发到
  配置里那台服务器。切页面因此不再有网络往返——那是这一版量最大的一处体感；
- **取不到就顺延**：`current` 指向的版本目录被删 → 目录里最新的一版 → 包内兜底 →
  引导页；某个文件读不出来（半截、被删）也是顺延，而不是把坏文件喂给 WebView。
  带扩展名的资源取不到就是 404，**只有看起来像前端路由的路径**（无扩展名）才会回退
  到 `index.html`；
- **缓存头**：`index.html` 每次问一次（`no-cache`），带内容 hash 的 `assets/*` 一年不过期
  （Vite 产物天生带 hash）——否则"发了新版还看到旧界面"就成了新 bug。

### 前端热更新（服务器发新版 → 壳下次启动换上新界面）

```
壳启动（后台线程，不挡首屏）
  └─ GET {服务器}/api/v1/app/frontend/manifest   # backend/app/api/v1/frontend.py 出
        ├─ 已是最新 → 什么都不做
        └─ 有新版 → 下载 zip（**最多 3 次**）→ 校验 sha256 + 大小 → 解压到 staging
                    → 检查含 index.html → 移到 v<版本>/ → **原子切 current 指针**
                    → 只留当前 + 上一版；**下一次启动生效**
```

三条纪律，照着看代码时别搞混：

1. **更新不打断当前这一屏**：装好就落盘、切指针，不重载、不弹窗；已经打开的文档照旧，
   下一次启动（或托盘里的「重新加载」）用上新版。**指针是全局的**——协议层每个请求按
   当时的 `current` 取文件，所以同一次启动里"后加载的 chunk"可能来自新版；
   真发生换版时，旧版仍留着（"只留当前 + 上一版"那条），缺哪个文件都能退回上一版取；
2. **失败只记一行日志**（"资源更新：这次跳过（原因）"）：NAS 没开、断网、校验不过
   都是常态，绝不能让壳起不来；
3. **sha256 不符就整包丢弃**，不进正式目录（zip 解压还挡了路径穿越：`enclosed_name`）。

要让它真的热更，服务器那半边得在（`GET /api/v1/app/frontend/manifest` 与
`/package`，由 `backend/app/api/v1/frontend.py` 从部署上的 `frontend/dist` 现打，
**不需要手工 bump 版本号**：版本就是内容指纹）。断网或服务器没开时这一路整段跳过。

**改前端 → 让壳换上**：`pnpm --dir frontend build` → 把 `frontend/dist` 部署上去
（后端那两个端点直接读它）→ 用户下次启动壳就换上了。**不用重发壳、也不用用户操作**。

## 边车（本地 Python 运行时）

**连接成功之后，壳会把边车起起来**：对话轮次的模型调用与工具执行在本机跑
（`frontend/src/api/sidecar.ts` 默认就走它），知识库与模型凭据仍走服务器。
**从 M2 起，边车那台上还挂着"本机权威面"**：会话 / 笔记 / 设置 / 模型注册 / 工作区 /
定时任务 / MCP / 记忆落 `kylab.db`（`%APPDATA%\com.kylab.desktop`），界面直连边车打它们
（`/api/v1/conversations` 这些，见 `frontend/src/api/sidecar.ts` 的 `LOCAL_PATHS`），
**不再绕道 NAS**；网页端与没装壳的浏览器里读的仍然是服务器那份（界面顶栏那条状态写着
现在是哪一种）。

```
<resource_dir>\sidecar-runtime\Scripts\python.exe -m app.sidecar
    --server {base}/api/v1 --token {系统钥匙串里的 API Key} --port 8765
    --workspace <壳数据目录>\workspace --data-dir <壳数据目录>
    --device-id {config.json 里的 device_id}
```

`--device-id` 是**这台电脑的身份**（壳首次登录时生成一次、此后不再换，落
`config.json` 的 `device_id`）：备份按设备对齐恢复点，边车没有它就如实拒（绝不编一个）。
手工起边车时省略它也能跑，只是备份那条链会拒绝工作。

三件必须知道的事：

1. **端口优先抢 8765，顺延也能用**。前端那份基址常量是构建期的
   （`frontend/src/api/sidecar.ts::DEFAULT_SIDECAR_BASE = http://127.0.0.1:8765`），
   壳只在 8765 被占时才顺延到 8766–8769；**顺延之后前端会自己问壳要真实地址**
   （启动时 `invoke('sidecar_info')`，M2 阶段 4 接的），所以不必再重建前端对齐。
   真连不上时顶栏那条状态会写明原因（"本机后端未启动：……；会话数据在本机，未回退服务器"）
   ——会话**不许**静默换到服务器（那会让用户以为会话丢了），这一点写死在
   `frontend/src/api/sidecar.ts` 的 `resolveLocalBase` 里；
2. **`--token` 只在命令行上传**：argv 同机器上的别的进程**看得到**，所以壳**不把它写进日志** ✗
   （日志里只有端口、工作区、钥匙的名字/前缀）。真要在多用户机器上防这一手，
   得让边车支持"从文件描述符读 token"，那是后置项；
3. **不留孤儿 python**：正常退出（托盘退出 / 关窗）走 `RunEvent::Exit` 里的 `stop()`；
   壳**崩了**这一路靠 Windows 的 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）——
   壳进程一没，边车跟着被收走。

### 库在哪 / 备份认哪一份 / 导入回滚从哪进（M2 阶段 6 补的三句）

1. **库在哪**：`%APPDATA%\com.kylab.desktop\kylab.db`（壳把数据目录当 `--data-dir` 传给边车，
   `-wal` / `-shm` 与它同目录）。"我的会话、笔记、设置在哪"这个问题的答案就是**这一个文件**；
2. **备份认哪一份**：整份备份 = 拷 `kylab.db`（连着 `-wal`；最稳是停掉壳再拷）。
   另外两处**别认错**：schema 升级前自动拍的备份在
   `%APPDATA%\com.kylab.desktop\migration-backup\<时间戳>-v<旧>→v<新>\kylab.db`，
   导入回滚的快照在 `%APPDATA%\com.kylab.desktop\import-rollback\<批次 id>\<会话>.ndjson`
   ——前者是"升级出问题时回退用的"，后者是"撤销一次导入用的"；
3. **导入 / 回滚从哪进**：本机后端上 `POST /api/v1/local/import`（`{"dry_run":true}` 先看会怎么处理）→
   轮询 `GET /api/v1/local/import/<批次 id>` → 撤销 `POST /api/v1/local/import/<批次 id>/rollback`；
   不在壳里也能导：`python -m app.services.legacy_import --server … --token … --data-dir …`。
   界面上这三笔账写在**顶栏那条状态条的第二行**（导入了几批 / 有几笔没跑完 / 有多少文件引用没随导入）。
   逐条说明（含两条回退开关与常见问题）见[《部署与运行 v0.3》§2.4](../docs/规范/部署与运行-v0.3.md)。

### 出包前先造运行时

**`build/` 被 gitignore**，所以打包前必须先造出边车运行时，否则包里没有它、
装出来的壳连不上边车：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-sidecar-runtime.ps1 -Offline
```

- `tauri.conf.json` 的 `bundle.resources` 把 `../../build/sidecar-runtime` 映射成包内
  `sidecar-runtime\`；
- **绿色版**（`target/release/kylab-desktop.exe`）要**连 `sidecar-runtime\` 一起拷**——
  单拷 exe 的话界面能用、对话会回退到服务器那条链；
- **哪一份运行时生效看目录，日志里会写**（`边车运行时：…` 那一行）：壳先在 **exe 旁边**找
  （`target/<profile>/sidecar-runtime` —— `tauri build` 会把 `build/sidecar-runtime` 拷到那儿），
  找不到再退到仓库根的 `build/sidecar-runtime`。**坑**：只要跑过一次 `tauri build`，
  `target/release/` 里就留着一份旧拷贝，它会**优先**被用上——改完运行时要么重跑
  `build-sidecar-runtime.ps1`，要么把那份拷贝同步/删掉（2026-09-30 实测踩过）。
- 为什么是 `build/` 而不是 `dist/`（2026-09-29 搬家）：`dist/` 这个名字在前后端工具链里到处都是
  （`frontend/dist/` 是前端产物），仓库根再放一份边车运行时容易看错。

### 已知限制（v0.1）

- **桌面壳只给管理员用**：领钥匙打的是 `POST /api/v1/api-keys`，而它按设计**只认管理员**
  （`backend/app/api/v1/api_keys.py` 的纪律：能签发钥匙的接口如果也能被钥匙打开，
  一把泄露的只读密钥就能给自己再发一把读写密钥）。成员登录会成功、领钥匙拿 403，
  界面会如实说明。**后置项**：服务端将来开一条"只能给自己发、且必须限定知识库范围"的
  设备钥匙端点，成员才能用桌面壳；
- **流式回答经壳转发时不是逐字的**：Tauri 的自定义协议响应是**一次性**的
  （`respond` 收整包），所以走**服务器**那条链（`/turn/stream`）时文字会等流结束一次到位。
  走**边车**那条链（默认那条，直连 `127.0.0.1:<壳定的那个端口>`）不经过协议层，逐字照旧。
  要治服务器那条链有两条路（Phase 2/3 选一条，见 `resources.rs::proxy` 的说明）；
- **壳转发的 `/api/**` 放行五个动词**：`GET` / `POST` / `PATCH` / `PUT` / `DELETE`
  （2026-10-04 补齐：原先只有 GET/POST，于是**服务器面**上"改名/删除会话、改设置、
  增删笔记、绑模型"这些一路 405，见 `resources.rs::proxy` 里那段说明与那条用例）。
  本机权威面不走这条路（直连边车），OPTIONS/HEAD/TRACE 一律拦在壳里；
- **断网只到"连不上"状态页**：界面资源全在本地，会话等数据自 M2 起也落本机库，
  但**进界面这一步仍然要 NAS**（登录 + 领钥匙都在服务器上），知识库那半也还在那边
  ——服务器探不通就停在配置页说清原因，不做"离线只读快照"（那是架构设计 §5 的 L4，
  划给后面的 M）；
- **本仓库的 `cargo test` 需要一个工作区内的临时目录**（某些受限会话不让写 `%TEMP%`，
  于是 `config` / `resources` / `logfile` 那些写盘的用例会报 `Os code 5 拒绝访问`）：

  ```powershell
  $env:TEMP='E:\gitlab\kylab\.shots\tmp'; $env:TMP=$env:TEMP; cargo test
  ```

## 打包安装包

```powershell
# ① 兜底界面就是前端产物（包内那份 frontend-dist），所以**先构建前端**：
pnpm --dir frontend build
# ② 出包前先造一次边车运行时（见上一节的 ⚠️）
powershell -ExecutionPolicy Bypass -File scripts/build-sidecar-runtime.ps1 -Offline
# ③ 打包
cd desktop
pnpm dlx @tauri-apps/cli@latest build      # 或者 npx @tauri-apps/cli@latest build
```

忘了第 ① 步时 **release 构建会直接失败**（`build.rs` 的守卫：Tauri 碰到不存在的
`bundle.resources` 是**静默跳过**的，那种包打开只剩引导页、还查不出为什么）：

```
没有前端产物，包里就没有兜底界面（首启/断网时只剩引导页）：…/frontend/dist/index.html
```

产物（v0.1.0，2026-10-01 出包那次；包内多了兜底界面之后的数字）：

| 文件 | 大小 | 给谁用 |
| --- | --- | --- |
| `src-tauri/target/release/kylab-desktop.exe` | 7.96 MiB | **绿色版**：拷过去双击就能跑，不写注册表（**要连 `sidecar-runtime\` 与 `frontend-dist\` 一起拷**） |
| `src-tauri/target/release/bundle/nsis/KYLAB_0.1.0_x64-setup.exe` | 16.59 MiB | 双击安装（简体中文 / English，按系统语言自动选） |
| `src-tauri/target/release/bundle/msi/KYLAB_0.1.0_x64_zh-CN.msi` | 27.84 MiB | 给要批量部署 / 走组策略的场合 |

绿色版 exe 只从 7.83 涨到 7.96 MiB：**兜底界面不在 exe 里**（它作为资源躺在旁边，
`frontend-dist\`；进包的是安装包）。安装包那两行比早先一版大，是两个原因叠加，
**都不是"进壳"本身**：① 包里多了 `frontend-dist\`（这次那份 **9.5 MB / 120 个文件**，
压缩后约 2–3 MiB）；② 本机 `build/sidecar-runtime` 已经是**跑过之后**的那份
（**61 MB**，出厂 17.3 MB）——想让安装包回到十几 MiB，先按上一节重建一次运行时再打包。

⚠️ **`build/sidecar-runtime` 与 `frontend/dist` 都进不了 git**（前者在 `.gitignore` 的
`build/`、后者是前端产物），而 `tauri build` 会把它们**原样拷到
`target/release/` 下**（绿色版就靠这一步带着它们跑）。绿色版**单拷一个 exe 是不完整的**：
没有 `sidecar-runtime\` 对话会回退到服务器那条链，没有 `frontend-dist\` 首启就只剩引导页。
**那份拷贝是增量写的，不清旧文件**（两份资源都这样）：换过几轮前端之后
`target/release/frontend-dist/assets/` 里会留着上一轮的旧 chunk（不影响功能——
`index.html` 只引它自己那批——只是让那份目录虚胖）。要干净就先把
`target/release/frontend-dist\` 删掉再打包。**安装包不受这个影响**：
它按 `frontend/dist` 现扫现打（`target/release/wix/x64/main.wxs` 里能看到 `Source=…\frontend\dist\…`）。

⚠️ **打包前先跑一次 `scripts/build-sidecar-runtime.ps1`**：它是**唯一**会清 `__pycache__` 的地方，
而边车一跑起来就会重新生成那些 `.pyc`（实测运行时因此从出厂 17.3 MB 涨到 24.6 MB）——
想让安装包最小，就在打包前重建一次运行时。

三处刻意的设置：

- **WebView2 用 `downloadBootstrapper`**（**不额外增加安装包体积**：Win10 1803+ 与
  Win11 随系统自带，只有很老的机器才需要联网装一次）；
- **安装包语言显式写了**（`wix.language: zh-CN`、`nsis.languages: [SimpChinese, English]`）：
  不写的话 WiX 按构建机的 locale 出 en-US 的安装向导——产品是中文的，
  安装向导却是一屏英文，那是最容易被拍下来的一处不一致；
- **版本号只有一个来源**：`tauri.conf.json` 的 `version`（与 `Cargo.toml` 一致）。
  它是**壳自己的版本流**（现在 0.1.0），与后端/前端的 `0.2.0` 不是一条线——
  壳一改就是一次壳的发布，服务端升级不需要重新发壳（见本文开头的三条约定）。

三平台各自的依赖与坑见调研文档 §3.2。

### 图标怎么来的（改图标看这一节）

图标**不是**用 `tauri icon` 从一张源图缩出来的，而是 `scripts/make-icons.py` **逐尺寸画**的
（用后端 venv 里的 Pillow）：

```powershell
backend/.venv/Scripts/python.exe desktop/scripts/make-icons.py
```

三个原因，每个都对应一处曾经的毛病：

1. **细笔画在小尺寸会糊成一团**。品牌标的外圆是 5.5/299、环是 2.2/299——等比缩到 32px，
   外圆只剩 0.6px。网页那边早就有对策（`frontend/src/features/chat/ui/Logo.tsx` 给每根线一个**渲染像素下限**：
   外圆与小圆 1.15px、环 0.8px），图标这边照搬同一条规则，所以**每个尺寸各画一张**，
   不是从一张大图缩下来的。
2. **画布要按真实墨迹居中**。标是横宽形（环的尖端伸出 SVG 的 `viewBox` 之外），
   照 `viewBox` 摆会偏右——旧那版 512 图里左边留白 104px、右边只有 30px。
3. **`bundle.icon` 的第一项决定托盘与任务栏用哪张**（`App::default_window_icon()` 按这个
   列表取）。原先第一项是 32x32.png，系统缩放 125%/150% 时 Windows 要 40/48px，
   于是把 32px 放大——这就是"图标糊"的直接原因。现在列表以大图打头
   （`128x128@2x.png` = 256、`icon.png` = 1024），并且产出一张**多帧 .ico**（16→256，
   帧用 BMP 存而不是 PNG：ICO 里的 PNG 帧官方只保证 256 那一档，小尺寸走老式位图最稳），
   Windows 按 DPI 取最合适的一帧。

改完要**重新构建**才会生效（图标是编译期嵌进 exe 的）：`npx @tauri-apps/cli@latest build`。

外观与产品同一份几何（`src/logo.svg` / `Logo.tsx` 的 mark 档），**只修清晰度与居中**。

## 壳把什么放在哪儿

| 东西 | 位置（Windows） | 说明 |
| --- | --- | --- |
| 配置 | `%APPDATA%\com.kylab.desktop\config.json` | 就一个 `server` 字段 + 最近用过的几条 + 这台电脑的 `device_id`（**长期凭据不在这里：那把 API Key 进系统钥匙串**，`kylab:nas_token:<地址>`，控制面板 → 凭据管理器里看得到） |
| 日志 | `%APPDATA%\com.kylab.desktop\kylab-desktop.log` | 一行一件事：启动（**界面从哪一份来**）、探活结果、资源更新、被拦掉的导航。托盘里「打开配置与日志」直接开这个文件夹 |
| 热更新下来的界面 | `%APPDATA%\com.kylab.desktop\frontend-resources\` | `current` 指针（纯文本版本号）+ `v<版本>/dist/`（只留当前 + 上一版）。**整份删掉不会让壳打不开**：会退到包内兜底那份 |
| 包内兜底界面 | `<exe 旁>\frontend-dist\` | 打包时收进去的 `frontend/dist`。绿色版要连它一起拷 |
| 边车运行时 | `<exe 旁>\sidecar-runtime\` | 打包时收进去的 `build/sidecar-runtime` |
| **本机库** | `%APPDATA%\com.kylab.desktop\kylab.db` | 会话 / 消息 / 事件 / 产物 / 笔记 / 设置 / 模型凭据 / 工作区 / 定时任务 / MCP 都在这一个 SQLite 文件里（M2）。**整份备份就是拷它**（连着 `-wal`） |
| schema 升级前的自动备份 | `%APPDATA%\com.kylab.desktop\migration-backup\` | 每次数据库结构升版前自动拍一份整库副本（出问题先看它） |
| 导入回滚快照 | `%APPDATA%\com.kylab.desktop\import-rollback\<批次>\` | 被替换的旧会话按导出同一套 NDJSON 存着；回滚按台账用它恢复 |
| 边车工作区 / 沙箱 | `%APPDATA%\com.kylab.desktop\workspace`、`sandbox` | 对话产物与沙箱文件 |

配置文件坏了（手改错了）不会让壳打不开：读不出来就当成"还没配过"，
在配置页重新填一次就覆盖掉了。

**关掉窗口就是退出**（不进托盘常驻）：壳是个前台工具，留着看不见的进程比退出更让人意外。

## 目录

```
desktop/
├── shell/src/               # 引导页（**编译进 exe 的兜底**，也是窗口的第一个页面）
│   ├── index.html           # 自包含：样式内联（它是"资源目录整个坏掉"时唯一能渲染的东西）
│   └── boot.js              # 连接 / 登录 / 换服务器；连上了就跳 app:// 加载真实界面
│                            # （CSP 不给 'unsafe-inline'，所以脚本必须独立成文件并嵌进 exe）
├── src/                     # **旧的配置页**（Phase 1 起被 shell/src 取代；只剩 logo.svg
│                            # 还在被 make-icons.py 当品牌标的来源，其余是死代码、待清）
├── scripts/
│   └── make-icons.py        # 生成图标：逐尺寸光学校正（见「图标怎么来的」）
└── src-tauri/
    ├── src/
    │   ├── main.rs          # 窗口、托盘、导航白名单、IPC 命令、协议注册、后台热更
    │   ├── resources.rs     # `app://` 协议：候选链（热更 > 包内兜底 > 引导页）、
    │   │                    # SPA 回退、缓存头、路径穿越防护、`/api/**` 转发、热更新安装
    │   ├── config.rs        # config.json 的读写（含"地址只由用户主动改"这条纪律）
    │   ├── probe.rs         # 探活：规范化地址 + 问 /api/v1/health + 认身份
    │   ├── signin.rs        # 连接即登录：登录 / 建管理员 → 领一把长期 API Key
    │   ├── sidecar.rs       # 起停本地边车（端口、健康检查、Job Object 收尾）
    │   └── logfile.rs       # 日志（时间戳自己算，不引 chrono）
    └── icons/               # 图标（白底 + 深色环行星，与前端同一份几何）：16→1024 的 PNG
                             # + 多帧 icon.ico；由 scripts/make-icons.py 生成
```

## 改这个壳

- **改地址输入的宽容度**（补 `http://`、去尾斜杠、保留反代前缀）：`probe::normalize`，
  那里有 6 条用例钉着行为；
- **改失败提示的措辞**：`probe::describe_transport`——注意它是给用户看的，
  要写"下一步该干什么"，而不是把 `os error 10061` 摆出来；
- **加了新的入口**（托盘项、macOS 菜单项）：`build_tray` / `build_menu` 里加一项，
  再到 `handle_menu` 里接上（`handle_menu` 里没有的分支会静默什么都不做，这是刻意的：
  入口与处理函数不必一一对应，但**加了就要接**）；
- **改"这台电脑"的身份 / 转发时带的设备标记**：身份是 `config.rs` 里的 `device_id`
  （UUID v4，第一次连上服务器时生成一次，之后改名/换服务器都不变），标记在
  `resources.rs` 的 `device_headers`（`X-Kylab-Device` / `X-Kylab-Device-Name`），
  **只加在转发给配置里那台服务器的 `/api/**` 请求上**（本地资源响应不带）；
- **改界面"从哪一份读"**（优先级、回退、某个文件取不到该给什么）：`resources.rs` 的
  `candidates` / `bundled_roots` / `usable`——那一段是纯函数 + 用例，改完跑 `cargo test`
  就该知道对不对；**别在 `main.rs` 的协议处理器里加判断**（它只做搬运）；
- **改热更新**（多久检查、装到哪、保留几版、重试几次）：`resources.rs` 的 `sync` /
  `install_package` / `prune_versions` 与 `main.rs` 里 `setup` 那段后台线程；
  三条纪律（本次不切换版本、失败只记日志、sha256 不符整包丢弃）别动；
- **改配置页的样子**：`shell/src/index.html`（自包含），用浏览器直接打开就能看
  （没有 `__TAURI__` 时它会退化成预览模式：表单照常显示，只在点连接时说一句
  "要在桌面壳里点"）。**壳里没法按 F12**，所以改美术走浏览器这一条路。

`cargo test` 里有 69 条用例（配置读写、地址解析、失败分支、日志时间、转发注入、
资源候选链与各级回退、热更新装包 / 校验 / 清理），其中一条会**真的去打本机 8000 的 KYLAB**
（可用 `KYLAB_TEST_SERVER` 换地址）——
没在跑就跳过，不会让别的机器红。

### 排查壳自己的问题

壳的页面也能通过 DevTools 协议看：启动前设一个环境变量就行。

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
cd desktop/src-tauri; cargo run
# 然后浏览器打开 http://127.0.0.1:9222 就是壳的页面；也能用 CDP 执行 JS
```

这条在开发时很省事（原生窗口没法用 Playwright），**但它等于把页面交出去**：
给用户的机器上不要设。
