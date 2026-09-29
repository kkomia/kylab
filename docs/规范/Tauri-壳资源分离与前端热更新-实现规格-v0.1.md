# Tauri 壳资源分离 + 前端热更新 · 实现规格 v0.1

> 来源：用户 2026-09-29 提供（原文由用户撰写，本文件**逐条落档**，含全部规范性细节）。
> 目标：前端日常迭代只需部署服务器，客户端 exe 自动热更新前端资源，无需重新打包发版。
> 本文件为完整实现规格，可直接交由实现 AI / 开发同事执行。

## 1. 背景与目标

### 现状
- Tauri 打包 exe，`frontendDist` 嵌入完整前端 dist。
- 前端任何改动 → 重新 `tauri build` → 重新发布安装包 → 用户更新客户端。

### 目标架构
```
exe（引导壳：内置兜底版 dist + 更新逻辑，极少改动）
  │ 启动
  ├─ 读本地资源目录 current 指针 → 加载该版本前端（本地磁盘速度）
  ├─ 后台比对服务器 manifest
  │     ├─ 已最新 → 无事发生
  │     └─ 有新版 → 下载 → 校验 → 解压 → 原子切指针 → 下次启动生效
  └─ 资源损坏/缺失 → 回退 exe 内置兜底版
```

### 成功标准
- [ ] 服务器发布新前端版本后，客户端下次启动自动加载新版，全程无感知
- [ ] 启动加载永远走本地磁盘（弱网/断网可打开兜底版或已缓存版本）
- [ ] 资源包被篡改时拒绝加载并回退
- [ ] 壳自身不随前端迭代重新打包

## 2. 组件清单

| 组件 | 位置 | 职责 |
|---|---|---|
| 引导壳 dist | 编译进 exe（`frontendDist` 指向引导壳构建产物） | 显示加载/更新状态，引导到真实资源 |
| 自定义协议处理器 | Rust，`register_uri_scheme_protocol` | 所有 WebView 资源请求的"路由决策" |
| 资源目录 | 应用数据目录（见 §3） | 存放热更新下来的前端版本 |
| manifest 接口 | 后端 | 返回当前前端版本与下载信息 |
| 资源包 | 对象存储/静态托管 | zip 格式的前端 dist + 校验信息 |

## 3. 目录结构

### 客户端资源目录（app_data_dir 下）
```
<app_data_dir>/
└── frontend-resources/
    ├── current                 # 纯文本：当前版本号（如 "1.4.2"），原子写入
    ├── v1.4.1/                 # 历史版本（保留最近 2 个）
    │   └── dist/...
    ├── v1.4.2/                 # 当前版本
    │   └── dist/
    │       ├── index.html
    │       ├── assets/...
    │       └── ...
    └── staging/                # 下载/解压临时区，完成后移入正式版本目录
```

### 服务端发布目录
```
frontend-releases/
├── manifest.json               # 当前生效的清单（最后更新！）
├── dist-v1.4.2.zip
├── dist-v1.4.2.zip.sha256      # 可选：独立哈希文件
└── archive/                    # 旧版本归档（可选）
```

### 引导壳源码结构（独立小前端工程）
```
shell/
├── index.html                  # 加载/更新状态页
└── main.js                     # 检测加载结果、错误兜底、跳转真实资源
```

## 4. 接口契约

### 4.1 获取版本清单
```
GET /app/frontend/manifest
```
响应（200）：
```json
{
  "version": "1.4.2",
  "package_url": "https://cdn.example.com/frontend-releases/dist-v1.4.2.zip",
  "sha256": "<小写 hex sha256>",
  "size": 2345678,
  "min_shell_version": "1.0.0",
  "released_at": "2026-09-29T10:00:00Z"
}
```
错误处理：
- 网络失败 → 静默跳过本次检查（不打断使用），下次启动再查
- 非 200 → 同上
- JSON 解析失败 → 记日志，跳过

### 4.2 下载资源包
```
GET <package_url>  →  application/zip
```
要求：必须 HTTPS；支持断点续传（可选，大包建议加 `Range`）。

## 5. 客户端实现细节（Rust / Tauri v2）

### 5.1 tauri.conf.json 关键配置
```json
{
  "build": { "frontendDist": "../shell/dist" },
  "app": {
    "security": {
      "assetProtocolScope": ["$APPDATA/frontend-resources/**", "$RESOURCE/**"],
      "csp": "default-src 'self' app: https:; script-src 'self' app:; style-src 'self' app: 'unsafe-inline'"
    }
  }
}
```
> `assetProtocolScope` 必须覆盖资源目录，否则协议读文件返回 403。CSP 按需收紧，至少保证脚本只允许 self + 自定义协议。

### 5.2 自定义协议处理器（核心）
注册 `app` scheme，所有 WebView 导航与资源请求都经过它。骨架：
```rust
fn resolve_resource(app: &tauri::AppHandle, path: &str) -> Option<Vec<u8>> {
    let app_data = app.path().app_data_dir().ok()?;
    let resources_root = app_data.join("frontend-resources");
    // 1. 读 current 指针
    let current = std::fs::read_to_string(resources_root.join("current")).ok()?.trim().to_string();
    // 2. 防路径穿越：拒绝任何含 ".." 的路径
    if path.contains("..") { return None; }
    // 3. 优先读热更新资源
    let candidate = resources_root.join(format!("v{}/dist/{}", current, path));
    if let Ok(bytes) = std::fs::read(&candidate) { return Some(bytes); }
    // 4. 回退：exe 内置兜底资源
    let embedded = app.path().resource_dir().ok()?.join("fallback-dist").join(path);
    std::fs::read(embedded).ok()
}
// register_uri_scheme_protocol("app", …)：path 为空取 index.html；命中按扩展名给 Content-Type；
// 未命中返回 404。WebView 初始加载 URL：app://index.html
```

### 5.3 启动与更新流程
在 `setup` 钩子中：同步确保资源目录存在；首启立即触发一次更新检查（后台）。异步任务（`tokio::spawn`）：
1. GET manifest；2. 版本比较（语义化版本）；3. 若 `min_shell_version` > 当前壳版本 → 发事件给前端提示"请更新客户端"，结束；4. 若有新版：
   a. 下载到 `staging/dist.zip`（带重试，最多 3 次）；b. sha256 校验，不符则丢弃并结束；c. 解压到 `staging/extracted/`；
   d. 校验解压结果必须包含 `index.html`（基本完整性检查）；e. 移动到 `resources/v{version}/`；
   f. **原子更新 current 指针**：写 `current.tmp` → `fs::rename` 为 `current`（同目录 rename 是原子的）；g. 清理旧版本：只保留 current + 上一版。
5. 全程不发事件打扰用户；失败只记日志。

**设计决策（重要，不要改）**：
- 本次启动永远用启动时刻的 current 版本渲染，**不在启动中途切换版本**；
- 更新静默完成，**下次启动生效**；
- 所有失败路径都不打断用户当前使用。

### 5.4 回退与异常处理

| 场景 | 行为 |
|---|---|
| current 文件缺失/内容非法 | 协议层回退 exe 内置兜底版；后台触发更新检查 |
| current 指向的版本目录缺失 | 同上；尝试回退到目录中存在的最新版本 |
| 资源文件损坏（读取失败） | 单文件 404；index.html 损坏 → 兜底版 |
| 下载/校验失败 | 丢弃 staging，本次放弃，下次启动重试 |
| manifest 要求的壳版本过高 | 前端 banner 提示升级客户端（不阻断使用） |
| 前端运行时报错 | 引导壳捕获 window error，上报并提示刷新 |

### 5.5 安全要求
- [ ] 资源包 sha256 强校验，不符绝不解压到正式目录
- [ ] （增强）用 Ed25519 签名替代/叠加 hash：壳内置公钥，manifest 带签名
- [ ] 协议层路径穿越防护（拒绝 `..`，拒绝绝对路径）
- [ ] 全程 HTTPS
- [ ] CSP 禁止外部脚本注入
- [ ] staging 目录写入校验：zip 解压必须限制在目标目录内（防 zip-slip）

## 6. 服务端发布流程（CI）
```
前端仓库 main 分支合并
  → 构建 dist → 打 zip：dist-v{version}.zip → 计算 sha256
  → 上传到对象存储（CDN） → 更新 manifest.json（最后一步！顺序不可颠倒）
```
**顺序红线**：manifest 必须在资源包可下载之后更新。否则客户端会拿到清单却下载失败（虽有重试，但会产生无谓流量与日志噪音）。
版本号：前端 `package.json` 的 version 即资源版本，CI 读取，**禁止同版本重复发布**（manifest 版本必须单调递增）。

## 7. 引导壳（shell）前端
极小独立工程：- [ ] 显示品牌 logo + 加载动画；- [ ] 通过 `app://` 加载真实前端（iframe 或直接跳转 `app://index.html`）；
- [ ] 捕获加载失败（超时 10s / error 事件）→ 显示"资源加载失败，正在使用兼容模式"并停留可重试界面；
- [ ] 接收"壳版本过低"事件 → 显示升级提示。
> 简化方案：引导壳可极简到只有一个重定向页面 + 错误兜底。

## 8. 分阶段实施计划
- **Phase 1（协议层与目录，核心，约 3–5 天）**：Rust 自定义协议处理器 + 兜底回退；资源目录结构与 current 指针读写；引导壳工程 + exe 打包改造；本地手动放置资源验证协议加载。
- **Phase 2（更新机制，约 2–3 天）**：manifest 接口（后端）；后台更新任务：下载/校验/解压/原子切换/清理；首启自动触发更新。
- **Phase 3（健壮性与安全，约 2–3 天）**：sha256 校验 + zip-slip 防护 + 路径穿越防护；全部回退路径测试；CSP 收紧；埋点/日志（更新成功率、失败原因）。
- **Phase 4（CI 打通，约 1–2 天）**：前端发布流水线接入 zip + hash + manifest 更新；老 exe 兼容验证。

## 9. 验收清单
- [ ] 断网启动：使用本地已缓存版本正常打开
- [ ] 全新安装：首启走兜底版 → 后台下载 → 二启为新版本
- [ ] 服务器发新版：老客户端下次启动自动升级，无感知
- [ ] 篡改资源包：sha256 校验失败，客户端不加载并回退
- [ ] 删除 current 文件：回退兜底版，自动恢复
- [ ] 删除当前版本目录：回退上一可用版本/兜底版
- [ ] manifest 版本回退（发旧版）：客户端忽略（版本不单调递增则不切指针）
- [ ] `min_shell_version` 高于壳版本：前端显示升级提示且不崩溃
- [ ] 连续快速启动两次：不产生并发下载冲突（更新任务加锁/幂等）

## 10. 常见问题（边界说明）
- **为什么不用 Tauri Updater plugin？** Updater 更新的是 exe 壳本身（整包替换），不适合高频前端迭代。本方案与其正交：壳用 Updater（低频），前端资源用本方案（高频），两者可共存。
- **能不能启动时同步等更新完再进页面？** 不要。启动时下载不可控（弱网可能等几十秒）。本方案刻意"本次旧版、下次新版"。
- **前端路由（history 模式）怎么处理？** 协议层对任何路径先尝试按文件返回，404 时回退返回 `index.html`（SPA fallback），由前端路由接管。
- **WebView 缓存会不会拿到旧资源？** 给协议响应加缓存头：`index.html` 加 `Cache-Control: no-cache`，带 hash 的静态资源（`assets/*.js`）加 `max-age=31536000, immutable`；前端构建必须带内容 hash 文件名（Vite 默认行为）。
- **多窗口/多实例并发？** 更新任务需要进程内互斥（单例锁或状态标记），防止两个实例同时写 `staging`/`current`。

## 附：版本号约定
- 前端资源版本：semver（如 `1.4.2`），来自前端 `package.json`；
- 壳版本：独立 semver，存于 exe（可用 `tauri.conf.json` 的 version）；
- `min_shell_version`：前端 manifest 声明，向前兼容的桥。

---

## v0.1 落地范围（开发版）

> 本节是**落地时的范围裁定**（2026-09-29，用户原话："就做前后端分离。至于向前兼容这个暂时不考虑。
> 因为还在开发版。目前都是同时更新的，又没有做发行版"）。
> **上文规格正文一字未改**——它是用户写的原始规格；这一节只说明**本期做到哪、哪些先划掉、为什么**，
> 方便以后真的要做发行版时回头补齐。

### 划掉（本期不做）

| 划掉的东西 | 为什么 |
| --- | --- |
| **最小客户端版本的拦截逻辑**（`min_shell_version` 判据） | 开发版**前后端同时更新**、没有发行版，拦谁都没有意义。⚠️ **字段在 manifest 里保留**（`min_shell_version`），标注"留字段，暂不拦，等有发行版再说"——它不是死数据，是下一版的接口形状 |
| **老客户端容错**（API 向前兼容、老壳兼容验证、双版本共存） | 同上：没有"老客户端"这个概念存在。等有发行版、且真的出现"用户壳比服务端旧"时再做 |
| 规格 §9 验收清单里 **"老 exe 兼容验证"** 那一条 | 同上 |

### 保留（本期做）

| 保留的东西 | 状态 |
| --- | --- |
| **本地资源加载（Phase 1）**：`app://` 协议 + 资源目录 + `current` 指针 + 内置兜底 + 路径穿越防护 + SPA fallback + 缓存头 | 落点 `desktop/src-tauri/src/resources.rs`（纯函数 + 用例）+ `shell/`（引导页）；**已跑通**（见 `docs/计划与记录` 的交卷记录） |
| **Origin 与后端放行** | **实测结论：后端不用改**。理由两条：① 壳里页面的 API 基址是相对路径，**所有 `/api/**` 都是同源请求**（`http://app.localhost/api/…`），浏览器根本不发 CORS 请求；② 壳的协议层把请求转发给远端后端时会**剥掉 `Origin`/`Referer`**（`resources.rs::proxy` 的白名单），后端看到的是一次没有 Origin 的服务端请求。实测数据见落地记录 |
| **缓存 L1**（静态资源本地磁盘） | 本次做的就是这个；`index.html` → `no-cache`，带 hash 的资源 → `max-age=31536000, immutable`（规格 §10） |
| **缓存 L3 的一半**（会话列表 + 当前会话落 IndexedDB，冷启动先渲染上次快照再后台刷新） | 待做（改前端；要与正在改前端的 lane 协调） |
| **缓存 L4**（后端不可达时只读展示快照 + 顶部明示「离线，数据可能不是最新」） | 待做（同上）。**明确的红线**：绝不把旧数据静默当新的 |
| **L5 热更新**（manifest + 下载/校验/解压/原子切指针 + 保留最近两版） | Phase 2（规格 §8）。**不加版本闸**："有新版就换"做，"太旧就拦"不做（同上面那条裁定的口径） |

### 明确不做（写在这里免得以后被当成漏了）

- **离线写**（离线排队发消息 / 改设置）：冲突与顺序是无底洞，本期不做；
- **流式回答缓存**：live 的东西不缓存；
- **把旧数据静默当新的**：任何时候都不做（L4 必须带明示）。

