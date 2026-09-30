//! 本地资源加载：`app://` 协议、资源目录、内置兜底（规格 §3/§5，Phase 1）。
//!
//! **要解决的事**：原来是"纯套壳"——WebView 直接导航到 NAS 上那台 KYLAB
//! （`main.rs` 的 `connect` 里 `navigate(url)`）。于是**每次切页面都在等网络**：
//! 路由是远端 SPA 的 history 路由，点一下就去服务器要一次文档与它依赖的 chunk。
//! 现在把前端整套搬到本地磁盘，壳只当**路由**：所有静态资源请求都走这个模块，
//! 后端 API 仍然是远端那台（**只有静态资源走本地**，这一点别搞混）。
//!
//! ## 一次请求的走向（`resolve` → `serve`）
//!
//! ```text
//! app://localhost/assets/index-abc.js
//!   ├─ /api/**            → 转发到配置里的远端服务器（见 `proxy`）
//!   ├─ 读 resources/current → "1.4.2"      （缺失/非法 → 走兜底）
//!   ├─ <resources>/v1.4.2/dist/assets/index-abc.js   命中 → 返回
//!   ├─ 其它版本目录里找同一路径（回退上一可用版本，规格 §5.4）
//!   ├─ 路径像路由（无扩展名）→ index.html（SPA fallback，规格 §10）
//!   └─ 都取不到 → 内置兜底页（`include_bytes!`，编译进 exe）
//! ```
//!
//! ## 目录结构（规格 §3，`<app_data_dir>/frontend-resources/`）
//!
//! ```text
//! frontend-resources/
//! ├── current          # 纯文本版本号；写 current.tmp 再 rename（同目录 rename 是原子的）
//! ├── v1.0.0/dist/...  # 一份解开的 dist
//! └── staging/         # 下载/解压临时区（Phase 2 用）
//! ```
//!
//! ## 两道必须写在代码里的安全闸（规格 §5.5）
//!
//! 1. **拒绝 `..` 与绝对路径**（`safe_relative`）——请求路径由 WebView 给，
//!    而拼接目标在用户的磁盘上；`../../.ssh/id_rsa` 这种一旦能拼出去，
//!    本地加载就从"变快"变成"读任意文件"；
//! 2. **版本号只认 `[A-Za-z0-9._-]`**（`read_current`）——版本号来自磁盘上的指针文件，
//!    它将来是**下载下来的内容**，不是可信输入。
//!
//! ## 与规格的一处差异（如实记）
//!
//! 规格 §5.4 的"回退"分两级：进程内另有服务端（`resource_dir()/fallback-dist`）那份。
//! Phase 1 的兜底直接**编译进 exe**（`include_bytes!` 一个自包含的引导页），
//! 于是"删掉整个资源目录，壳还能打开"这件事不依赖任何磁盘布局——
//! 而完整 dist 的兜底版等 Phase 2 打包时按规格落到 `frontend/dist` 资源里。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::http::{header, Response, StatusCode};

/// 资源目录名（规格 §3）。
pub const RESOURCES_DIRNAME: &str = "frontend-resources";

/// 应用入口 URL。**平台不同、写法不同**（实测踩到过）：
/// Windows / Android 上 WebView2 把自定义 scheme 挂在 `http://<scheme>.localhost`，
/// 直接导航 `app://localhost/` 会被 WebView 当成未知协议**静默拦掉**（页面停在原处、
/// 连一次导航事件都没有）；macOS / Linux 才是 `app://localhost`。
///
/// 所以这一条**由 Rust 给**（它知道自己在哪个平台），页面不自己拼。
pub fn app_url() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://app.localhost/"
    } else {
        "app://localhost/"
    }
}

/// 应用入口 URL 的源（导航白名单要按它判）。
pub fn app_origin() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://app.localhost"
    } else {
        "app://localhost"
    }
}

/// `current` 指针文件名。
pub const POINTER_FILE: &str = "current";

/// 引导页（内置兜底）。**编译进 exe**：它是"资源目录整个坏掉"时唯一还能渲染的东西，
/// 所以不能反过来依赖资源目录。
///
/// 路径从**本文件**算：`desktop/src-tauri/src/` → `../../../shell/src/`。
/// 这一段踩过一次坑：写成 `../../src/` 会落到 `desktop/src/`（那是旧的配置页），
/// **编译得过、行为是错的**（兜底页悄悄变成另一份文件）。
pub const BOOT_PAGE: &[u8] = include_bytes!("../../../shell/src/index.html");

/// 引导页引用的脚本。**必须一起嵌**：CSP 是 `script-src 'self' app:`（不给
/// `'unsafe-inline'`），所以引导逻辑不能内联；而兜底路径上资源目录里并没有这个文件，
/// 协议层得从内存里给（否则兜底页是一张点不动的表单）。
pub const BOOT_SCRIPT: &[u8] = include_bytes!("../../../shell/src/boot.js");

/// 内置兜底能直接给的资源（键是请求路径，值是内容）。
fn embedded_asset(requested: &str) -> Option<(&'static str, &'static [u8])> {
    match requested {
        "" | "index.html" => Some(("text/html; charset=utf-8", BOOT_PAGE)),
        "boot.js" => Some(("text/javascript; charset=utf-8", BOOT_SCRIPT)),
        _ => None,
    }
}

/// 一次转发的响应体上限（内存里整流，见 `proxy`）。32 MB 与后端的分片上限同量级。
const MAX_PROXY_BYTES: u64 = 32 * 1024 * 1024;

/// 转发超时（秒）。**长**：SSE 那一轮可能跑几分钟，
/// 卡在这里会比"慢"更糟（用户看到的是明明在跑却断了）。
const PROXY_TIMEOUT_SECONDS: u64 = 900;

// ---------------------------------------------------------------- 资源目录

/// 资源目录：`<app_data_dir>/frontend-resources`。
pub fn resources_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(RESOURCES_DIRNAME)
}

/// 读 `current` 指针。**返回 `None` = 指针缺失或内容非法**（调用方走兜底）。
///
/// 版本号只认 `[A-Za-z0-9._-]`：它来自磁盘上那个文件，而那个文件将来是下载下来的
/// 内容——`"../.."` 这样的版本号一旦被拼进路径，本地加载就能读到资源目录之外去。
pub fn read_current(resources_root: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(resources_root.join(POINTER_FILE)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // 允许指针里已经是 "v1.4.2" 这种写法（两种都认，省一次人工踩坑）
    let candidate = trimmed.strip_prefix('v').unwrap_or(trimmed);
    if !is_safe_version(candidate) {
        return None;
    }
    Some(candidate.to_string())
}

/// 版本号是不是"干净"的。
///
/// **光有字符白名单不够**：`..` 与 `.` 全由白名单字符组成，而它们拼进路径就是
/// 目录导航（`v../dist` 会指到资源目录之外）。所以三条一起判：
/// 非空、**至少一个字母或数字**、**不含 `..`**。
fn is_safe_version(value: &str) -> bool {
    if value.is_empty() || value.contains("..") {
        return false;
    }
    if !value.chars().all(|ch| ch.is_ascii_alphanumeric() || ".-_".contains(ch)) {
        return false;
    }
    value.chars().any(|ch| ch.is_ascii_alphanumeric())
}

/// 把请求路径收敛成一个**安全的相对路径**；越界一律 `None`。
///
/// 三条判据（顺序即优先级）：
/// 1. 丢掉查询串与片段（WebView 会把 `?t=...` 一起给过来）；
/// 2. 反斜杠统一成立斜杠（Windows 上 `..\..\x` 与 `../../x` 是同一件事）；
/// 3. **逐段检查**：`..` 直接拒；空段与 `.` 丢掉；剩下来的段不再二次解释。
///
/// 为什么不用 `Path::join` 之后再 `canonicalize` 看前缀：那要求目标**存在**，
/// 而这里要判的是"请求路径本身正不正经"——不存在的路径也该被判成 404 而不是越界。
pub fn safe_relative(path: &str) -> Option<Vec<String>> {
    let without_query = path.split(['?', '#']).next().unwrap_or("");
    // 绝对路径（`/etc/passwd` 与 `C:/...`）在这里被折成相对路径的段——
    // 前导斜杠本身不危险（它只是 WebView URL 的一部分），危险的是 `..` 与盘符
    if without_query.len() > 1 && without_query.as_bytes()[1] == b':' {
        return None;
    }
    let mut segments = Vec::new();
    for segment in without_query.replace('\\', "/").split('/') {
        match segment {
            "" | "." => continue,
            ".." => return None,
            other => segments.push(other.to_string()),
        }
    }
    Some(segments)
}

/// 一份资源的落点与来源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub path: PathBuf,
    /// `version` = 热更新下来的那版；`embedded` = exe 内置兜底；`previous` = 回退到的上一版。
    pub source: &'static str,
    pub version: Option<String>,
}

/// 请求路径 → 磁盘上的文件（`None` = 哪儿都没有，协议层给 404 或兜底）。
///
/// 顺序就是优先级：
/// 1. `current` 指的版本；
/// 2. **目录里存在的最新版本**（`current` 指向的目录被删时，规格 §5.4 要求"回退上一可用版本"）；
/// 3. 路径看起来是前端路由（没有扩展名）→ 该版本的 `index.html`（SPA fallback，规格 §10）。
pub fn resolve_file(resources_root: &Path, segments: &[String]) -> Option<Resolved> {
    let requested = segments.join("/");
    // 请求根 = 要 index.html；其余按字面路径找
    let wanted = if requested.is_empty() { "index.html" } else { requested.as_str() };

    /*
     * 候选版本按顺序试：`current` 指的 → 目录里其余版本（按修改时间从新到旧）。
     *
     * **空请求也要走这条路**（修过一个 bug）：以前"请求根"只试 `current`，
     * 于是 `current` 指向一个已经被删掉的版本目录时，首页取不到——
     * 而规格 §5.4 要的正是"回退上一可用版本"。
     */
    let mut versions: Vec<String> = Vec::new();
    if let Some(current) = read_current(resources_root) {
        versions.push(current.clone());
        versions.extend(other_versions(resources_root, &current));
    } else {
        versions = other_versions(resources_root, "");
    }

    for (index, version) in versions.iter().enumerate() {
        let source = if index == 0 { "version" } else { "previous" };
        if let Some(hit) = resolve_in_version(resources_root, version, wanted, source) {
            return Some(hit);
        }
    }

    // SPA 路由：`/chat/conv_x` 这种没有扩展名的路径都交给 index.html，由前端路由接管。
    // **带扩展名的取不到就是取不到**：回退成 index.html 会把"缺一个 js"变成
    // "一段 HTML 被当脚本执行"，报出来的是语法错，离真正原因远得多。
    if !requested.is_empty() && looks_like_route(&requested) {
        for (index, version) in versions.iter().enumerate() {
            let source = if index == 0 { "version" } else { "previous" };
            if let Some(hit) = resolve_in_version(resources_root, version, "index.html", source) {
                return Some(hit);
            }
        }
    }
    None
}

/// 请求路径看起来像前端路由吗（没有扩展名）。
///
/// 判据取"最后一段里有没有点"：`/chat/conv_x` 是路由，`/assets/index-abc.js` 是文件。
/// 反例（真有个没有扩展名的文件）在真实 dist 里不存在，而 Vite 的产物带 hash，不会撞。
pub fn looks_like_route(requested: &str) -> bool {
    let last = requested.rsplit('/').next().unwrap_or("");
    !last.contains('.')
}

/// `current` 之外的版本目录，**按目录修改时间从新到旧**（回退要退到"最近还能用的那版"）。
fn other_versions(resources_root: &Path, current: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(resources_root) else {
        return Vec::new();
    };
    let mut found: Vec<(std::time::SystemTime, String)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(version) = name.strip_prefix('v') else {
            continue;
        };
        if version == current || version.is_empty() {
            continue;
        }
        if !version.chars().all(|ch| ch.is_ascii_alphanumeric() || ".-_".contains(ch)) {
            continue;
        }
        if !entry.path().join("dist").is_dir() {
            continue;
        }
        let stamp = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        found.push((stamp, version.to_string()));
    }
    found.sort_by(|left, right| right.0.cmp(&left.0));
    found.into_iter().map(|(_, version)| version).collect()
}

fn resolve_in_version(
    resources_root: &Path,
    version: &str,
    requested: &str,
    source: &'static str,
) -> Option<Resolved> {
    let mut path = resources_root.join(format!("v{version}")).join("dist");
    for segment in requested.split('/') {
        if segment.is_empty() {
            continue;
        }
        path.push(segment);
    }
    if path.is_file() {
        return Some(Resolved {
            path,
            source,
            version: Some(version.to_string()),
        });
    }
    None
}

// ---------------------------------------------------------------- 响应

/// 按扩展名给 Content-Type。**不猜**：认不出来给 `application/octet-stream`
/// （那会让 `<script>` 拒绝执行，比"猜成 text/html 却把 JS 当 HTML 跑"安全）。
pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("map") => "application/json; charset=utf-8",
        Some("txt") | Some("md") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("pdf") => "application/pdf",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        _ => "application/octet-stream",
    }
}

/// 缓存头（规格 §10 那一问的答案）。
///
/// 前端产物带内容 hash（Vite 默认），所以：**带 hash 的静态资源一年不过期**，
/// `index.html` **必须每次问一次**——否则"发布新版本之后用户还看到旧壳"就成了新 bug。
pub fn cache_control(segments: &[String]) -> &'static str {
    let first = segments.first().map(String::as_str).unwrap_or("");
    let last = segments.last().map(String::as_str).unwrap_or("");
    if first == "assets" || last.contains('-') && last.contains('.') {
        "public, max-age=31536000, immutable"
    } else if last.ends_with(".html") || last.is_empty() {
        "no-cache"
    } else {
        "public, max-age=3600"
    }
}

fn respond(status: StatusCode, content_type: &str, cache: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache)
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 内置兜底页的响应（`index.html` 与 404 都用它）。
pub fn boot_response(status: StatusCode) -> Response<Vec<u8>> {
    respond(
        status,
        "text/html; charset=utf-8",
        "no-cache",
        BOOT_PAGE.to_vec(),
    )
}

/// 内置兜底资源（引导页与它的脚本）。取不到 = 这个路径兜底里也没有。
fn boot_asset_response(requested: &str) -> Option<Response<Vec<u8>>> {
    embedded_asset(requested).map(|(content_type, bytes)| {
        respond(StatusCode::OK, content_type, "no-cache", bytes.to_vec())
    })
}

// ---------------------------------------------------------------- 协议入口

/// `app://` 协议的一次请求。
///
/// **这条路径上的每一个判断都必须能在没有 Tauri 的情况下测**：所以它只收
/// `resources_root` 与 `server` 两个事实，剩下的是纯逻辑（见文件末的用例）。
/// 把请求路径拆成「路径」与「查询串」两半（`/api/v1/x?k=v` → （`/api/v1/x`, `Some("k=v")`））。
///
/// **为什么必须有这一步**（2026-09-30 用户实测发现）：协议层原来只取 `Uri::path()`，
/// 于是**查询串被整段丢掉**——`/chat/context-usage?conversation_id=…` 到服务器手里
/// 就是"没带参数"（422；界面上的表现是上下文用量环永远显示"不可用"），
/// `?q=…` / `?limit=…` 这类可选参数则**静默走默认值**（看起来像搜索没生效）。
/// 现在协议层用 `path_and_query()` 取全串，由这里拆开：
/// - `/api/**` 分支**原样转发**（连 query 一起）；
/// - 静态资源分支**只用路径那一半**——`?v=1` 这类缓存串不参与"找文件"
///   （参与的话本来命中的文件会平白掉进兜底页，见文件末用例）。
fn split_query(uri_path: &str) -> (&str, Option<&str>) {
    match uri_path.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (uri_path, None),
    }
}

pub fn handle(
    resources_root: &Path,
    server: Option<&str>,
    method: &str,
    uri_path: &str,
    body: Option<&[u8]>,
    headers: &[(String, String)],
) -> Response<Vec<u8>> {
    // `uri_path` 可能带查询串（协议层传的是 `path_and_query`）：API 原样转发，
    // 静态资源只用路径（见 `split_query` 的说明）。
    let (path_only, _query) = split_query(uri_path);
    if path_only.starts_with("/api/") {
        return match server {
            Some(origin) => proxy(origin, method, uri_path, body, headers),
            None => respond(
                StatusCode::SERVICE_UNAVAILABLE,
                "application/json; charset=utf-8",
                "no-store",
                br#"{"detail":"shell: no server configured yet"}"#.to_vec(),
            ),
        };
    }

    let Some(segments) = safe_relative(path_only) else {
        // 越界：**给兜底页而不是 404**。用户看到的仍然是一个能操作的界面，
        // 而不是 WebView 那张"打不开"的错误页。
        return boot_response(StatusCode::OK);
    };

    let resolved = resolve_file(resources_root, &segments);
    if let Some(hit) = resolved {
        return match std::fs::read(&hit.path) {
            Ok(bytes) => respond(
                StatusCode::OK,
                content_type(&hit.path),
                cache_control(&segments),
                bytes,
            ),
            // 单文件读失败 = 这个文件 404；`index.html` 读失败由上一层回退兜底
            Err(_) => match boot_asset_response(&segments.join("/")) {
                Some(response) => response,
                None => boot_response(StatusCode::NOT_FOUND),
            },
        };
    }

    // 资源目录里没有：先看内置兜底里有没有这个路径（引导页 + 它的脚本），
    // 再让 SPA 路由回退到兜底页，最后才是 404。
    let requested = segments.join("/");
    if let Some(response) = boot_asset_response(&requested) {
        return response;
    }
    if requested.is_empty() || looks_like_route(&requested) {
        return boot_response(StatusCode::OK);
    }
    boot_response(StatusCode::NOT_FOUND)
}

/// 转发 `/api/**` 到配置里的远端服务器。**只有 API 走远端**，静态资源一律本地。
///
/// 为什么要转发而不是让前端直接打远端：前端的 API 基址是**相对路径**
/// （`frontend/src/api/client.ts` 的 `API_BASE = '/api/v1'`），从 `app://` 加载时
/// 它会打到 `app://localhost/api/v1/...` 上。两条出路里我们选这条：
/// - **转发**（本函数）：前端一个字节都不用改，也**不需要后端开 CORS**
///   （跨源那一步根本没发生——浏览器看到的是同源）；
/// - 或者让前端把基址指向远端：那要改 SPA 源码 + 后端加 CORS，两处产品代码一起动。
///
/// 已知代价（Phase 1，如实写）：Tauri 的协议响应是**一次性**的
/// （`UriSchemeResponder::respond` 收整包），所以 SSE 那一轮会被缓冲到流结束才交给
/// 页面——文字不是逐字冒出来的。普通 REST 调用不受影响。要恢复流式有两条路
/// （Phase 2/3 选一条）：① 壳自己用 SSE 取事件、进度走事件推给本地前端；
/// ② 后端为 `app://` 这个源开 CORS，前端直接打远端（要动后端）。
fn proxy(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    headers: &[(String, String)],
) -> Response<Vec<u8>> {
    let url = format!("{}{}", origin.trim_end_matches('/'), path);
    // 超时**长**：SSE 一轮可能几分钟；卡在这里比"慢"更糟（看起来像断了）
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(PROXY_TIMEOUT_SECONDS))
        .build();

    // GET/POST 之外的动词不支持（前端的 API 只用这两种）
    if method != "GET" && method != "POST" {
        return respond(
            StatusCode::METHOD_NOT_ALLOWED,
            "text/plain; charset=utf-8",
            "no-store",
            format!("shell: 只转发 GET/POST，收到 {method}").into_bytes(),
        );
    }
    let mut request = agent.request(method, &url);
    // 请求头带过去（`Authorization` 尤其），三类例外见上面那段说明
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "content-length" | "host" | "origin" | "referer" | "connection" | "accept-encoding"
        ) {
            continue;
        }
        request = request.set(name, value);
    }
    if method == "GET" && !headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("accept")) {
        request = request.set("Accept", "application/json, text/event-stream");
    }

    let response = match body {
        Some(bytes) => request.send_bytes(bytes),
        None => request.call(),
    };

    match response {
        Ok(found) => {
            let status = StatusCode::from_u16(found.status()).unwrap_or(StatusCode::BAD_GATEWAY);
            // 响应头**原样带过去**（`Content-Type` 决定页面怎么读它），
            // 但 CORS 与长度那几项丢掉：长度由我们自己算，CORS 是"同源"这件事的产物
            let mut builder = Response::builder().status(status);
            for name in found.headers_names() {
                let lower = name.to_ascii_lowercase();
                if matches!(
                    lower.as_str(),
                    "content-length" | "transfer-encoding" | "content-encoding"
                        | "access-control-allow-origin" | "connection" | "keep-alive"
                ) {
                    continue;
                }
                for value in found.all(&name) {
                    builder = builder.header(name.as_str(), value);
                }
            }
            let mut bytes = Vec::new();
            let read = found
                .into_reader()
                .take(MAX_PROXY_BYTES)
                .read_to_end(&mut bytes);
            if read.is_err() {
                return respond(
                    StatusCode::BAD_GATEWAY,
                    "text/plain; charset=utf-8",
                    "no-store",
                    b"shell: upstream read failed".to_vec(),
                );
            }
            builder
                .header("X-Content-Type-Options", "nosniff")
                .body(bytes)
                .unwrap_or_else(|_| Response::new(Vec::new()))
        }
        // 4xx/5xx 也是"正常的回答"：把状态码与正文交给页面（前端的错误处理要在）
        Err(ureq::Error::Status(code, found)) => {
            let status = StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY);
            let mut bytes = Vec::new();
            let _ = found.into_reader().take(MAX_PROXY_BYTES).read_to_end(&mut bytes);
            respond(
                status,
                "application/json; charset=utf-8",
                "no-store",
                bytes,
            )
        }
        Err(error) => {
            // 连不上远端：**说清是"壳转发失败"**，别让页面以为是自己错了
            respond(
                StatusCode::BAD_GATEWAY,
                "application/json; charset=utf-8",
                "no-store",
                format!(r#"{{"detail":"shell: 转发到 {origin} 失败：{error}"}}"#).into_bytes(),
            )
        }
    }
}

// ---------------------------------------------------------------- 启动时的一次快照

/// 启动时读一次资源状态（给引导页决定往哪走）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ResourceStatus {
    /// `version` = 有热更新资源；`embedded` = 只有内置兜底。
    pub mode: &'static str,
    pub version: Option<String>,
    pub root: String,
    /// 资源目录**能不能读到 `index.html`**（引导页据此决定敢不敢往 `app://` 跳）。
    pub has_app: bool,
}

pub fn status(app_data_dir: &Path) -> ResourceStatus {
    let root = resources_root(app_data_dir);
    let version = read_current(&root);
    let has_app = !matches!(resolve_file(&root, &[]), None);
    ResourceStatus {
        mode: if has_app { "version" } else { "embedded" },
        version,
        root: root.display().to_string(),
        has_app,
    }
}

// ---------------------------------------------------------------- 热更新（Phase 2，**客户端半边**）
//
// 服务器那份清单与包由 `backend/app/api/v1/frontend.py` 提供（规格 §4 的服务半边）：
//
// ```text
// GET {origin}/api/v1/app/frontend/manifest → {version, package_url, sha256, size, min_shell_version, …}
// GET {origin}/api/v1/app/frontend/package  → zip（整份 dist，**确定性打包** ⇒ 指纹可比）
// ```
//
// 流程（规格 §4.2 的 1→7）：拉清单 → 与本地 `current` 比（一样就收工）→ 下载 →
// **校验 sha256** → 解压到 staging → 校验含 `index.html` → 移到 `v{version}/` →
// **原子切 `current`**（写 `current.tmp` 再 rename）→ 只留当前 + 上一版。
//
// 三条纪律：
// 1. **更新是背景动作、下次启动生效**（规格 §1）：不打断用户，也不在这一次里换掉正开着的界面；
// 2. **校验不过就整包丢弃**：宁可这次不用新版，也不用一份来路不明的包（清单是服务器给的）；
// 3. **失败只记日志**：拉不到清单（NAS 没开、断网）是常态，绝不能让壳起不来或弹窗。

/// 一次同步的结果——**只说给日志听**（更新不弹窗）。
#[derive(Debug, PartialEq, Eq)]
pub enum SyncOutcome {
    /// 本地已经是最新（指纹一致）
    UpToDate,
    /// 装好了（**下次启动生效**）
    Installed { version: String },
    /// 没做（网络/校验/安装失败），原因如实带出来
    Skipped { reason: String },
}

/// 服务端那份清单（规格 §4.1）。
///
/// **不 `deny_unknown_fields`**：服务端将来加字段，不该让旧壳罢工。
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub package_url: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub min_shell_version: Option<String>,
}

/// 包大小上限：现在压出来约 2.6 MB，留 32 MB 余量。
///
/// 为什么要有这条：**清单是服务器给的**，一个畸形条目不该把用户的磁盘写满。
const MAX_PACKAGE_BYTES: u64 = 32 * 1024 * 1024;

/// 拉清单（同步动作；调用方把它放到后台线程上）。
pub fn fetch_manifest(origin: &str, timeout: Duration) -> Result<Manifest, String> {
    let url = format!(
        "{}/api/v1/app/frontend/manifest",
        origin.trim_end_matches('/')
    );
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let response = agent
        .get(&url)
        .call()
        .map_err(|error| format!("清单拿不到（{url}）：{error}"))?;
    response
        .into_json::<Manifest>()
        .map_err(|error| format!("清单读不懂（{url}）：{error}"))
}

/// 下载整包并**校验**（大小 + sha256）：对不上就整包丢弃。
pub fn download_package(
    origin: &str,
    manifest: &Manifest,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let url = if manifest.package_url.starts_with("http") {
        manifest.package_url.clone()
    } else {
        format!("{}{}", origin.trim_end_matches('/'), manifest.package_url)
    };
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let response = agent
        .get(&url)
        .call()
        .map_err(|error| format!("下载失败（{url}）：{error}"))?;
    let mut bytes: Vec<u8> = Vec::new();
    // 多读 1 字节：真到上限时能看出"被截断了"（而不是当成一份完整的小包）
    response
        .into_reader()
        .take(MAX_PACKAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("下载读到一半失败（{url}）：{error}"))?;
    verify_package(manifest, &bytes)?;
    Ok(bytes)
}

/// 校验一个包：**大小与 sha256 都要与清单一致**（纯函数，离线可测）。
pub fn verify_package(manifest: &Manifest, package: &[u8]) -> Result<(), String> {
    if package.len() as u64 != manifest.size {
        return Err(format!(
            "包大小不对（清单 {} B，实收 {} B）",
            manifest.size,
            package.len()
        ));
    }
    if package.len() as u64 > MAX_PACKAGE_BYTES {
        return Err(format!("包超过上限（{} B）", MAX_PACKAGE_BYTES));
    }
    let digest = hex(&Sha256::digest(package));
    if digest != manifest.sha256 {
        return Err(format!(
            "包内容对不上（清单 {}，实收 {}）",
            manifest.sha256, digest
        ));
    }
    Ok(())
}

/// 这份清单**能不能用**（纯函数）：版本号字符集、包大小、最低壳版本。
pub fn check_manifest(manifest: &Manifest, shell_version: &str) -> Result<(), String> {
    if manifest.version.is_empty()
        || !manifest
            .version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        // 与 `read_current` 同一判据：版本号会变成**目录名**、还会写进 `current` 指针
        return Err(format!("版本号不合法：{:?}", manifest.version));
    }
    if manifest.size == 0 || manifest.size > MAX_PACKAGE_BYTES {
        return Err(format!("包大小不在合理范围：{} B", manifest.size));
    }
    if let Some(minimum) = manifest.min_shell_version.as_deref() {
        if newer(minimum, shell_version) {
            return Err(format!(
                "这份前端要求壳 ≥ {minimum}（当前 {shell_version}）：请更新客户端"
            ));
        }
    }
    Ok(())
}

/// 把包**装成一份可用版本**：解压到 staging → 校验 `index.html` → 移到 `v{version}/` →
/// 原子切 `current` → 清掉更老的版本。
pub fn install_package(
    resources_root: &Path,
    manifest: &Manifest,
    package: &[u8],
) -> Result<(), String> {
    verify_package(manifest, package)?;
    let version = manifest.version.as_str();
    // 包 = **`dist/` 里的内容**（服务器那份就是拿 `frontend/dist` 打的），而壳的布局是
    // `<资源目录>/v<版本>/dist/...`（`resolve_in_version` 认这一层）——所以在**解压这一层**
    // 补上 `dist/`。把这条写在这里，是因为"少一层 dist"的表现是"装好了、界面却回到兜底页"。
    let staging = resources_root.join(format!("staging-{version}"));
    let _ = std::fs::remove_dir_all(&staging);
    let dist = staging.join("dist");
    std::fs::create_dir_all(&dist)
        .map_err(|error| format!("staging 建不出来（{}）：{error}", dist.display()))?;

    let prepared = extract(package, &dist).and_then(|()| {
        if dist.join("index.html").is_file() {
            Ok(())
        } else {
            Err("包里没有 index.html（这不是一份能用的前端）".to_string())
        }
    });
    if let Err(error) = prepared {
        // 半份 staging 留着只会让下一次撞上（而且它长得像一份可用版本）
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }

    let target = resources_root.join(format!("v{version}"));
    if target.exists() {
        let _ = std::fs::remove_dir_all(&target);
    }
    std::fs::rename(&staging, &target)
        .map_err(|error| format!("落成 {} 失败：{error}", target.display()))?;

    // **原子切指针**：写 `current.tmp` 再 rename（同目录 rename 是原子的，规格 §4.2 e/f）
    let pointer = resources_root.join(POINTER_FILE);
    let tmp = resources_root.join(format!("{POINTER_FILE}.tmp"));
    std::fs::write(&tmp, version)
        .map_err(|error| format!("写指针失败（{}）：{error}", tmp.display()))?;
    std::fs::rename(&tmp, &pointer)
        .map_err(|error| format!("切指针失败（{}）：{error}", pointer.display()))?;

    prune_versions(resources_root, version);
    Ok(())
}

/// 一次完整同步（背景线程里跑）：拉清单 → 比版本 → 下载 → 安装。
pub fn sync(
    origin: &str,
    app_data_dir: &Path,
    shell_version: &str,
    timeout: Duration,
) -> SyncOutcome {
    let root = resources_root(app_data_dir);
    let manifest = match fetch_manifest(origin, timeout) {
        Ok(manifest) => manifest,
        Err(reason) => return SyncOutcome::Skipped { reason },
    };
    if let Err(reason) = check_manifest(&manifest, shell_version) {
        return SyncOutcome::Skipped { reason };
    }
    if read_current(&root).as_deref() == Some(manifest.version.as_str()) {
        return SyncOutcome::UpToDate;
    }
    let package = match download_package(origin, &manifest, timeout) {
        Ok(package) => package,
        Err(reason) => return SyncOutcome::Skipped { reason },
    };
    match install_package(&root, &manifest, &package) {
        Ok(()) => SyncOutcome::Installed {
            version: manifest.version,
        },
        Err(reason) => SyncOutcome::Skipped { reason },
    }
}

/// 解压到 `target`。**zip-slip 挡在 `enclosed_name` 上**：它拒绝 `..` 与绝对路径，
/// 拿不到就整包不装（与 `safe_relative` 是同一条纪律，只是入口不同）。
fn extract(package: &[u8], target: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package))
        .map_err(|error| format!("包不是合法的 zip：{error}"))?;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("包里的第 {} 个条目读不了：{error}", index + 1))?;
        let Some(relative) = file.enclosed_name() else {
            return Err(format!("包里有越界路径：{}", file.name()));
        };
        let destination = target.join(relative);
        if file.is_dir() {
            std::fs::create_dir_all(&destination)
                .map_err(|error| format!("建目录失败（{}）：{error}", destination.display()))?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("建目录失败（{}）：{error}", parent.display()))?;
        }
        let mut sink = std::fs::File::create(&destination)
            .map_err(|error| format!("写文件失败（{}）：{error}", destination.display()))?;
        std::io::copy(&mut file, &mut sink)
            .map_err(|error| format!("写文件失败（{}）：{error}", destination.display()))?;
    }
    Ok(())
}

/// 只留**当前 + 上一版**（规格 §4.2 g）：`other_versions` 已按 mtime 新→旧排序，
/// 列表里第一个就是"上一版"，其余都删。
fn prune_versions(resources_root: &Path, current: &str) {
    for stale in other_versions(resources_root, current).into_iter().skip(1) {
        let _ = std::fs::remove_dir_all(resources_root.join(format!("v{stale}")));
    }
}

/// `a` 比 `b` 新吗。按 `.` 分段、数字段比数字、其余退字典序 —— 版本号是我们自己产出的
/// `x.y.z` 或内容指纹，够用且不为它引 semver 那套依赖。
fn newer(a: &str, b: &str) -> bool {
    let left: Vec<&str> = a.split('.').collect();
    let right: Vec<&str> = b.split('.').collect();
    for index in 0..left.len().max(right.len()) {
        let one = left.get(index).copied().unwrap_or("");
        let two = right.get(index).copied().unwrap_or("");
        match (one.parse::<u64>(), two.parse::<u64>()) {
            (Ok(one), Ok(two)) if one != two => return one > two,
            (Ok(_), Ok(_)) => continue,
            _ => {
                if one != two {
                    return one > two;
                }
            }
        }
    }
    false
}

/// 小写 hex（sha256 的小写十六进制；为它引 `hex` 这个依赖不值当）。
fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

// ---------------------------------------------------------------- 用例

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kylab-resources-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(root: &Path, version: &str, relative: &str, body: &str) {
        let path = root.join(format!("v{version}")).join("dist").join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn pointer_is_read_and_normalised() {
        let root = temp_root("pointer");
        std::fs::write(root.join(POINTER_FILE), "1.4.2\n").unwrap();
        assert_eq!(read_current(&root).as_deref(), Some("1.4.2"));
        std::fs::write(root.join(POINTER_FILE), " v1.4.2 ").unwrap();
        assert_eq!(read_current(&root).as_deref(), Some("1.4.2"));
    }

    #[test]
    fn pointer_with_traversal_is_refused() {
        let root = temp_root("pointer-evil");
        for evil in ["..", "../..", "1.4/../..", "a b", ""] {
            std::fs::write(root.join(POINTER_FILE), evil).unwrap();
            assert_eq!(read_current(&root), None, "{evil} 不该被当成版本号");
        }
    }

    #[test]
    fn traversal_paths_are_refused() {
        assert_eq!(safe_relative("/../../etc/passwd"), None);
        assert_eq!(safe_relative("/..\\..\\secrets"), None);
        assert_eq!(safe_relative("/a/../../b"), None);
        assert_eq!(safe_relative("C:/Windows/win.ini"), None);
        assert_eq!(safe_relative("/assets/index-abc.js").unwrap(), vec!["assets", "index-abc.js"]);
        assert_eq!(safe_relative("/chat/conv_1?x=1#y").unwrap(), vec!["chat", "conv_1"]);
    }

    #[test]
    fn files_are_served_from_the_current_version() {
        let root = temp_root("serve");
        put(&root, "1.0.0", "index.html", "<html>v1</html>");
        put(&root, "1.0.0", "assets/index-abc.js", "console.log(1)");
        std::fs::write(root.join(POINTER_FILE), "1.0.0").unwrap();

        let hit = resolve_file(&root, &["assets".into(), "index-abc.js".into()]).unwrap();
        assert_eq!(hit.source, "version");
        assert_eq!(hit.version.as_deref(), Some("1.0.0"));
        assert_eq!(std::fs::read_to_string(hit.path).unwrap(), "console.log(1)");
    }

    #[test]
    fn spa_routes_fall_back_to_index_html() {
        let root = temp_root("spa");
        put(&root, "1.0.0", "index.html", "<html>app</html>");
        std::fs::write(root.join(POINTER_FILE), "1.0.0").unwrap();

        let hit = resolve_file(&root, &["chat".into(), "conv_123".into()]).unwrap();
        assert!(hit.path.ends_with("index.html"), "路由该回退到 index.html");
        // 带扩展名的资源取不到就是取不到，**不许**回退成 index.html
        // （否则一个 404 的 js 会变成一段 HTML，页面报的是语法错，查起来远得多）
        assert_eq!(resolve_file(&root, &["assets".into(), "missing.js".into()]), None);
    }

    #[test]
    fn missing_pointer_falls_back_to_the_newest_version_on_disk() {
        let root = temp_root("fallback");
        put(&root, "1.0.0", "index.html", "<html>old</html>");
        std::thread::sleep(std::time::Duration::from_millis(20));
        put(&root, "1.1.0", "index.html", "<html>new</html>");

        // 指针整个没了（规格 §5.4 第一行）：回退到目录里最新那版
        assert_eq!(read_current(&root), None);
        let hit = resolve_file(&root, &[]).unwrap();
        assert_eq!(hit.version.as_deref(), Some("1.1.0"), "该用最新的那份可用版本");
    }

    #[test]
    fn pointer_to_a_deleted_version_falls_back_to_the_previous_one() {
        let root = temp_root("deleted");
        put(&root, "1.0.0", "index.html", "<html>old</html>");
        std::fs::write(root.join(POINTER_FILE), "9.9.9").unwrap();

        let hit = resolve_file(&root, &[]).unwrap();
        assert_eq!(hit.source, "previous");
        assert_eq!(hit.version.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn empty_resource_root_has_no_app_so_the_boot_page_is_used() {
        let root = temp_root("empty");
        assert!(!status(&root).has_app);
        assert_eq!(status(&root).mode, "embedded");
    }

    #[test]
    fn api_requests_go_remote_static_requests_stay_local() {
        let root = temp_root("branch");
        put(&root, "1.0.0", "index.html", "<html>app</html>");
        std::fs::write(root.join(POINTER_FILE), "1.0.0").unwrap();

        // 没有配服务器时 API 请求给 503 而不是本地 404（错误能被页面读懂）
        let response = handle(&root, None, "GET", "/api/v1/conversations", None, &[]);
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        // 静态资源：本地命中，且带缓存头
        let response = handle(&root, None, "GET", "/", None, &[]);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );

        // 越界路径 → 兜底页（不是 404 错误页）
        let response = handle(&root, None, "GET", "/../../etc/passwd", None, &[]);
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.body().len() > 100);
    }

    #[test]
    fn content_types_and_cache_headers_match_the_spec() {
        assert_eq!(content_type(Path::new("a/index-abc.js")), "text/javascript; charset=utf-8");
        assert_eq!(content_type(Path::new("a/index.html")), "text/html; charset=utf-8");
        assert_eq!(content_type(Path::new("a/x.unknown")), "application/octet-stream");
        // 带 hash 的静态资源一年不过期；index.html 每次问
        assert_eq!(
            cache_control(&["assets".into(), "index-abc.js".into()]),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(cache_control(&["index.html".into()]), "no-cache");
    }

    #[test]
    fn split_query_separates_the_path_from_the_query() {
        assert_eq!(split_query("/a/b"), ("/a/b", None));
        assert_eq!(
            split_query("/api/v1/chat/context-usage?conversation_id=conv_1&x=2"),
            ("/api/v1/chat/context-usage", Some("conversation_id=conv_1&x=2"))
        );
        // 只切第一个 `?`：后面的问号归查询串自己
        assert_eq!(split_query("/a?b?c"), ("/a", Some("b?c")));
    }

    #[test]
    fn a_static_request_with_a_cache_buster_still_hits_the_local_file() {
        // `?v=1` 这类缓存串**不能**参与"找文件"：参与的话本来命中的文件会掉进兜底页
        let root = temp_root("cache-buster");
        put(&root, "1.0.0", "assets/app.js", "console.log(1)");
        std::fs::write(root.join(POINTER_FILE), "1.0.0").unwrap();

        let response = handle(&root, None, "GET", "/assets/app.js?v=1", None, &[]);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body().as_slice(), b"console.log(1)");
    }

    /// 2026-09-30 的真 bug 钉在这里：协议层原来只取 `Uri::path()` ⇒ 查询串整段丢掉，
    /// 于是上下文用量环永远"不可用"（`conversation_id` 必填 → 422）、
    /// 搜索的 `q=` 与分页的 `limit=` 则静默走默认值。
    #[test]
    fn api_requests_forward_the_query_string_to_the_server() {
        // 一个只接一次的最小 HTTP 服务：把收到的请求头抄下来当物证
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut buf = [0u8; 2048];
                        let n = std::io::Read::read(&mut stream, &mut buf).unwrap_or(0);
                        let head = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = std::io::Write::write_all(
                            &mut stream,
                            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
                        );
                        return head;
                    }
                    Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() > deadline {
                            return String::new();
                        }
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    Err(_) => return String::new(),
                }
            }
        });

        let root = temp_root("query-forward");
        let origin = format!("http://{addr}");
        let response = handle(
            &root,
            Some(&origin),
            "GET",
            "/api/v1/chat/context-usage?conversation_id=conv_1&x=2",
            None,
            &[],
        );
        assert_eq!(response.status(), StatusCode::OK);

        let head = server.join().unwrap();
        let request_line = head.lines().next().unwrap_or_default().to_string();
        assert!(
            request_line.contains("?conversation_id=conv_1&x=2"),
            "上游收到的请求行应当带查询串，实际是：{request_line:?}"
        );
    }

    // ------------------------------------------------------------ 热更新（Phase 2，客户端半边）

    fn manifest_of(version: &str, package: &[u8]) -> Manifest {
        Manifest {
            version: version.to_string(),
            package_url: "/api/v1/app/frontend/package".to_string(),
            sha256: hex(&Sha256::digest(package)),
            size: package.len() as u64,
            min_shell_version: Some("0.1.0".to_string()),
        }
    }

    /// 现写一个包（与服务器那份同形：`index.html` + `assets/…`）
    fn package_with(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, body) in files {
                writer.start_file(*name, options).unwrap();
                std::io::Write::write_all(&mut writer, body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    #[test]
    fn a_package_that_does_not_match_the_manifest_is_refused() {
        let package = package_with(&[("index.html", "<html>new</html>")]);
        let manifest = manifest_of("abc123", &package);

        assert!(verify_package(&manifest, &package).is_ok());

        // 等长篡改一个字节：大小那关过得去，**撞的正是哈希那关**
        let mut tampered = package.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        let error = verify_package(&manifest, &tampered).unwrap_err();
        assert!(error.contains("对不上"), "{error}");

        // 大小对不上（比哈希便宜的那一关先报）
        let mut shorter = package.clone();
        shorter.pop();
        let error = verify_package(&manifest, &shorter).unwrap_err();
        assert!(error.contains("包大小不对"), "{error}");
    }

    #[test]
    fn a_manifest_with_a_bad_version_or_a_too_new_shell_is_refused() {
        let package = package_with(&[("index.html", "<html>x</html>")]);

        // 版本号会变成**目录名**（还会写进 current 指针）→ 与 read_current 同一判据
        let mut manifest = manifest_of("../evil", &package);
        assert!(check_manifest(&manifest, "0.1.0").is_err());

        manifest = manifest_of("abc123", &package);
        assert!(check_manifest(&manifest, "0.1.0").is_ok());

        // 这份前端要求更高的壳 → 如实说"请更新客户端"，而不是硬装
        manifest.min_shell_version = Some("9.9.9".to_string());
        let error = check_manifest(&manifest, "0.1.0").unwrap_err();
        assert!(error.contains("请更新客户端"), "{error}");
    }

    #[test]
    fn installing_switches_the_pointer_and_keeps_two_versions() {
        let root = temp_root("hot-update");
        let first = package_with(&[("index.html", "<html>one</html>")]);
        let second = package_with(&[("index.html", "<html>two</html>")]);
        let third = package_with(&[("index.html", "<html>three</html>")]);

        install_package(&root, &manifest_of("aaa", &first), &first).unwrap();
        assert_eq!(read_current(&root).as_deref(), Some("aaa"));
        // 新的那份真的能被协议层读出来（"本地磁盘加载"这条就落在这上面）
        assert_eq!(
            resolve_file(&root, &[]).unwrap().version.as_deref(),
            Some("aaa")
        );

        // 再装一版：指针切过去，staging 不留残渣
        install_package(&root, &manifest_of("bbb", &second), &second).unwrap();
        assert_eq!(read_current(&root).as_deref(), Some("bbb"));
        assert!(!root.join("staging-bbb").exists());

        // 第三版：只留**当前 + 上一版**（规格 §4.2 g）
        install_package(&root, &manifest_of("ccc", &third), &third).unwrap();
        assert_eq!(read_current(&root).as_deref(), Some("ccc"));
        assert!(root.join("vccc").join("dist").join("index.html").is_file());
        assert!(root.join("vbbb").is_dir(), "上一版要留着（回退用）");
        assert!(!root.join("vaaa").exists(), "更老的版本该被清掉");
    }

    #[test]
    fn a_package_without_index_html_is_refused_and_staging_is_cleaned() {
        let root = temp_root("hot-update-broken");
        let package = package_with(&[("assets/app.js", "console.log(1)")]);

        let error = install_package(&root, &manifest_of("ddd", &package), &package).unwrap_err();

        assert!(error.contains("index.html"), "{error}");
        assert!(!root.join("staging-ddd").exists(), "半份 staging 不该留着");
        assert_eq!(read_current(&root), None, "失败不该动指针");
    }

    #[test]
    fn a_zip_with_a_traversal_entry_is_refused() {
        let root = temp_root("hot-update-slip");
        let package = package_with(&[("index.html", "x"), ("../escaped.txt", "nope")]);

        let error = install_package(&root, &manifest_of("eee", &package), &package).unwrap_err();

        assert!(error.contains("越界"), "{error}");
        assert!(
            !root.parent().unwrap().join("escaped.txt").exists(),
            "zip-slip 的条目绝不能落到资源目录之外"
        );
    }
}
