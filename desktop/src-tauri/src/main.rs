//! KYLAB 桌面壳。
//!
//! **壳里没有服务端**：这个进程一个字节的业务逻辑都不含，它做的事只有一件——
//! 把窗口指到用户 NAS 上那台 KYLAB。定这个边界是为了发版：前端一改，用户不用
//! 重装壳；服务端一升，壳也不用跟着发。
//!
//! 三条行为约定（见 `desktop/README.md` 与《桌面端套壳调研》）：
//!
//! 1. **配过一次就一直用它**：地址落在 `config.json`，之后每次启动直接连它，
//!    连不上也不清空——只在用户主动改地址时才写掉；
//! 2. **先探活再导航**：连不上就留在配置页上说清原因，而不是把 WebView 的错误页
//!    甩给用户（那上面没有任何返回入口的提示）；
//! 3. **只加载你的服务器**：导航白名单只放行本地配置页与配置里的那个源，
//!    外链全部交给系统浏览器——壳不该变成一个没有地址栏的浏览器。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod logfile;
mod probe;
mod resources;
mod sidecar;
mod signin;

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_plugin_opener::OpenerExt;

/// 本地配置页 / 引导页（`shell/src/index.html`，编译进 exe）。
/// 窗口先落在这里——**这一页能调 Tauri 命令**（它是壳自己的页面），
/// 由它决定要不要跳到 `app://` 去加载真实前端。
const PAGE: &str = "index.html";

/// 自定义协议 scheme（规格 §5.2）。真实前端的所有静态资源都从它出。
/// 入口 URL 由 `resources::app_url()` 给——**平台不同写法不同**，别在这里再拼一遍。
const APP_SCHEME: &str = "app";


/// 「更换服务器」开出来的那个小窗口的标签。
const SETTINGS_WINDOW: &str = "connect";

/// 长住的那扇窗。
const MAIN_WINDOW: &str = "main";

/// 默认窗口宽度的上下限（逻辑像素）。
///
/// **1488 是实测出来的门槛**，不是拍的：笔记页编辑器里那行工具栏（标题 + 字符数 +
/// AI / 导出 / 删除）在 1280 的视口下折成两行（高 77px），到 1488 才是一行（45px）。
/// 窗口宽度**就是**视口宽度（壳里没有别的横条），所以这个数直接当默认宽度的下限：
/// **默认打开的那一屏不该有一处排版是坏的**。屏幕放不下时退到"屏幕宽 - 8"——
/// 几乎占满，但不贴死到边（贴死会让人以为窗口最大化了）。
const NOTES_TOOLBAR_MIN_WIDTH: f64 = 1488.0;
/// 宽度上限：**别一开就铺满大屏**（2560 的屏上铺满会显得空，而再宽也不会更好）。
const WINDOW_MAX_WIDTH: f64 = 1680.0;
/// 高度按 16:10 从宽度推（1280×800、1440×900、1680×1050 都是这一档），
/// 然后再夹进工作区。比写死一个高度好：宽高比例一致，换屏之后观感不变。
const WINDOW_RATIO: f64 = 0.625;
/// 窗口相对工作区留的边。合起来是"别忘了还有任务栏与标题栏"。
const WINDOW_WIDTH_FRACTION: f64 = 0.92;
const WINDOW_HEIGHT_MARGIN: f64 = 48.0;
/// 兜底的小窗下限：屏幕上真的只有几百像素高时（不常见），也别算出个负高度。
const WINDOW_MIN_HEIGHT: f64 = 400.0;
/// 小屏上"几乎占满"时留的那一条缝。
const SCREEN_EDGE_GAP: f64 = 8.0;

/// 默认窗口大小：**问显示器要，而不是写死一个数字**。
///
/// 原来写死 1280×800，结果笔记页一进去编辑器只剩 668px，那行工具栏折成两行
/// （实测：1280 下 77px 高，1488 下 45px）。而窗口大小是第一眼的观感，
/// "打开就有一处排版是坏的"最不该发生。
///
/// 三件事一起做：**取工作区的 92%**（不是整块屏——任务栏与标题栏要留位置）、
/// **按 16:10 推高度**、**夹进上下限**。显示器问不到时回落到 1440×900
/// （"大屏常见、窄屏也不离谱"的一档），而不是回落到出问题的那个 1280。
fn default_window_size(app: &AppHandle) -> (f64, f64) {
    // 工作区是物理像素，而 `inner_size` 要逻辑像素——**必须过一遍 scale_factor**，
    // 否则在 125% / 225% 缩放的机器上会开出一个超出屏幕的窗口（这台开发机就是 225%）
    let area = app.primary_monitor().ok().flatten().map(|monitor| {
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        (
            f64::from(work.size.width) / scale,
            f64::from(work.size.height) / scale,
        )
    });
    window_size_for(area)
}

/// 上面那个的**纯函数部分**：与显示器无关，所以能写成断言。
fn window_size_for(area: Option<(f64, f64)>) -> (f64, f64) {
    let Some((area_width, area_height)) = area else {
        return (1440.0, 900.0);
    };

    // 下限**也夹进工作区**：小屏（1280×680 那种）上不能因为"门槛是 1488"
    // 就硬开一个比屏幕还宽的窗——那时宁可窄一点，也不要露出一截在屏幕外
    let floor = NOTES_TOOLBAR_MIN_WIDTH.min(area_width - SCREEN_EDGE_GAP);
    let width = (area_width * WINDOW_WIDTH_FRACTION)
        .clamp(floor, WINDOW_MAX_WIDTH)
        .floor();
    // 高度同理：**上限也要夹**，否则一块 600 高的屏上会开出 640 高的窗
    // （下限 640 那条是"别算出个扁窗"，它不能反过来撑破屏幕）
    let max_height = (area_height - WINDOW_HEIGHT_MARGIN).max(WINDOW_MIN_HEIGHT);
    let height = (width * WINDOW_RATIO).min(max_height).floor();
    (width, height)
}

/// 壳的状态：内存里的配置 + 它落在哪个目录。
struct Shell {
    /// 配置目录（`config.json` 在这儿）。
    dir: std::path::PathBuf,
    /// 数据目录（`<data_dir>/frontend-resources/` 在这儿）。**两处刻意分开**：
    /// 配置是"壳自己的偏好"，资源是"可以整份删掉重下"的东西——
    /// 清理资源不该顺手把用户填的服务器地址一起清了。
    data_dir: std::path::PathBuf,
    config: Mutex<config::Config>,
    /// 这台电脑的显示名（主机名，见 `device_name`）。**每次启动读一次环境变量就够**：
    /// 它在一轮运行里不会变，而每个转发的请求都要带它。
    device_name: String,
    /// 边车（本地 Python 运行时）的起停。**一个进程一个**，用 `Arc` 是为了能把它
    /// 挪进阻塞线程（起边车要等它 import 完，不能按住 async 运行时）。
    sidecar: Arc<sidecar::Manager>,
}

impl Shell {
    /// 配置里的服务器源（`scheme://host[:port]`）。导航白名单与 API 转发都认它。
    fn origin(&self) -> Option<String> {
        self.config.lock().ok().and_then(|config| config.server.clone())
    }

    /// 转发给服务器时要打的**设备标记**（见 `resources::Device`）。
    ///
    /// `None` = 配置里还没有 `device_id`（这台机器一次都没连上过服务器）：
    /// 那时两个头都不带，**等价于网页端的语义**——服务器看到一个没有标记的请求，
    /// 就按它原本的方式办。**每次请求现读配置**：id 是连接成功那一刻才生成的，
    /// 壳启动时（协议处理器早就装好了）它可能还不存在。
    fn device(&self) -> Option<resources::Device> {
        let id = self.config.lock().ok()?.device_id.clone()?;
        Some(resources::Device {
            id,
            name: self.device_name.clone(),
        })
    }

    /// 资源目录的绝对路径（`<app_data_dir>/frontend-resources`）。
    fn resources_root(&self) -> std::path::PathBuf {
        resources::resources_root(&self.data_dir)
    }
}

// ---------------------------------------------------------------- 前端能调的两件事

#[derive(Serialize)]
struct StartupInfo {
    /// `main` = 启动窗，`connect` = 用户自己打开的设置窗。
    /// **页面靠它决定"要不要自动连"**：设置窗永远显示表单（用户是来改地址的），
    /// 启动窗有地址就直接连。
    role: String,
    server: Option<String>,
    recent: Vec<String>,
    shell_version: String,
    /// 本地资源状态（规格 §3）。页面据此决定"直接进应用"还是"留在配置页"。
    resources: resources::ResourceStatus,
    /// 应用入口 URL（**平台不同写法不同**，见 `resources::app_url`）。
    /// 页面不许自己拼 `app://localhost/`——Windows 上那样写会被静默拦掉。
    app_url: String,
    /// **壳手里有没有能用的长期凭据**（给这个源）。
    ///
    /// 页面靠它决定"直接进应用"还是"先登录一次"：没有钥匙时进应用也连不上服务器
    /// （边车没有 token），不如当场让用户登录 —— 登录一次之后这一栏就一直是 `true`。
    has_key: bool,
    /// 钥匙名字与账号显示名：页面上说"你是谁、用的哪把钥匙"。
    key_name: Option<String>,
    user_name: Option<String>,
    /// 边车现在活着吗（活着就给端口）：引导页据此说"本地边车已就绪/没起来"。
    sidecar_port: Option<u16>,
    sidecar_base: Option<String>,
}

#[tauri::command]
fn startup(window: WebviewWindow, shell: State<'_, Shell>) -> StartupInfo {
    let config = shell.config.lock().expect("配置锁被污染了");
    let running = shell.sidecar.info();
    StartupInfo {
        role: window.label().to_string(),
        server: config.server.clone(),
        recent: config.recent.clone(),
        shell_version: env!("CARGO_PKG_VERSION").to_string(),
        resources: resources::status(&shell.data_dir),
        app_url: resources::app_url().to_string(),
        has_key: config
            .server
            .as_deref()
            .map(|origin| config.has_key_for(origin))
            .unwrap_or(false),
        key_name: config.key_name.clone(),
        user_name: config.user_name.clone(),
        sidecar_port: running.as_ref().map(|info| info.port),
        sidecar_base: running.map(|info| info.base),
    }
}

/// 让**页面把自己的关键动作写进同一份日志**。
///
/// 壳这边只看得见"探活成功/失败"，看不见"页面到底停在哪一态"——用户报
/// "打开是一片空白"时，这两件事要一起看才判得出来。所以给页面一个写日志的入口，
/// 它记的是状态迁移（进了表单 / 开始自动连接 / 失败原因），不是逐条流水。
#[tauri::command]
fn note(shell: State<'_, Shell>, message: String) {
    let line: String = message.chars().take(500).collect();
    logfile::log(&shell.dir, &format!("[页面] {line}"));
}

/// 探活 → （没有钥匙时）登录并领钥匙 → 写配置 → 把主窗导航过去 → 关掉设置窗。
///
/// `remember` 由页面给：启动时自动连接传 `false`（**不要写配置**，那本来就是配置里
/// 那份），用户在表单里点了连接传 `true`。这一条就是"配了就一直用它"的落点——
/// 自动重连不会把地址改掉，连不上也不会把它清掉。
///
/// ## 连接即登录（P4-4 片①）
///
/// 壳要拿去调服务器的是**长期凭据**（API Key）。所以第一次连接时：
/// `probe` → `signin::status` →（`setup` 或 `login`）→ `signin::issue_key` → 写配置。
/// **会话令牌只在这次调用里活一下，用完即弃、不落盘**；密码一个字节都不留。
///
/// 已经有钥匙（且地址没变）就直接复用——启动自动连接走这条路，用户不必每次开机登录。
/// 用户在表单里重新填了用户名密码，则**重新登一次并换一把新钥匙**（例如换账号）。
#[tauri::command]
async fn connect(
    app: AppHandle,
    shell: State<'_, Shell>,
    address: String,
    remember: bool,
    username: Option<String>,
    password: Option<String>,
) -> Result<Connected, String> {
    // 探活是阻塞的（最长 4 秒）：放到阻塞线程上，别按住 async 运行时
    let asked = address.clone();
    let probed = tauri::async_runtime::spawn_blocking(move || probe::check(&asked))
        .await
        .map_err(|error| format!("探活没跑起来：{error}"))??;

    let (has_key, saved_key_name) = {
        let config = shell.config.lock().map_err(|_| "配置锁被污染了".to_string())?;
        (
            config.has_key_for(&probed.origin),
            config.key_name.clone(),
        )
    };
    let username = username.unwrap_or_default();
    let password = password.unwrap_or_default();
    let wants_sign_in = !username.trim().is_empty() || !password.is_empty();

    let mut signed_in = false;
    let mut key_name = saved_key_name;
    let mut user_name: Option<String> = None;
    let mut key_prefix: Option<String> = None;
    let mut key_permission: Option<String> = None;
    let mut fresh_key: Option<(signin::IssuedKey, String)> = None;

    if !has_key || wants_sign_in {
        if username.trim().is_empty() || password.is_empty() {
            return Err(if has_key {
                "请填用户名与密码；或者把这两栏留空，直接用已经存下的钥匙".to_string()
            } else {
                "这台机器还没有钥匙：填上用户名与密码，壳会登录一次并领一把长期钥匙".to_string()
            });
        }
        let base = probed.url.clone();
        let issued_name = issued_key_name();
        let (session, key) = tauri::async_runtime::spawn_blocking(move || {
            let needs_setup = signin::status(&base)?;
            let session = if needs_setup {
                signin::setup(&base, &username, &password)?
            } else {
                signin::login(&base, &username, &password)?
            };
            let key = signin::issue_key(&base, &session.token, &issued_name)?;
            Ok::<_, String>((session, key))
        })
        .await
        .map_err(|error| format!("登录没跑起来：{error}"))??;

        signed_in = true;
        user_name = Some(session.display_name());
        key_name = Some(key.name.clone());
        key_prefix = Some(key.prefix.clone());
        key_permission = Some(key.permission.clone());
        fresh_key = Some((key, session.display_name()));
    }

    {
        let mut config = shell.config.lock().map_err(|_| "配置锁被污染了".to_string())?;
        // **设备身份在"连上了这一台服务器"这一刻生成一次**（探活已经过了才走到这里），
        // 之后不再变：改名、换服务器、换账号都不重新生成——它是"这台电脑"的身份，
        // 不是"这条连接"的身份。服务器靠它把多台电脑的工作区分开。
        let fresh_device = config.ensure_device_id();
        if remember {
            config.remember(&probed.origin);
        }
        if let Some((key, display_name)) = &fresh_key {
            // 钥匙是**绑定这个源**的：领到新钥匙时把源一起记下（`has_key_for` 靠它判等），
            // 否则下次启动会以为"没有钥匙"而再来一次登录。
            config.remember(&probed.origin);
            config.remember_key(&key.id, &key.name, display_name, &key.token);
        }
        // **新生成的设备 id 必须落盘**（`fresh_device`）：不然下次启动又换一个，
        // 服务器那边会把同一台电脑看成一串不同的电脑（工作区一次次"没了"）。
        // 只按 `remember || fresh_key` 存的那些路径（启动时自动重连）到不了这里。
        if remember || fresh_key.is_some() || fresh_device {
            // 写不进去要说，但**不阻断这次连接**：已经连上了，先让人进去，
            // 下次打开重填一遍是小事，卡在这儿是大事。
            if let Err(error) = config.save(&shell.dir) {
                logfile::log(&shell.dir, &format!("配置写不进去（{error}）"));
            }
        }
        if fresh_device {
            logfile::log(
                &shell.dir,
                &format!(
                    "这台电脑的设备标记已生成：{}（之后不再变）",
                    config.device_id.as_deref().unwrap_or_default()
                ),
            );
        }
    }
    // ⚠️ 日志里**只写 id / 名字 / 前缀**，绝不写钥匙明文（那等同于把凭据抄进日志文件）。
    logfile::log(
        &shell.dir,
        &format!(
            "连接成功：{}（{} {} / api {}）{}{}",
            probed.origin,
            probed.app,
            probed.version,
            probed.api_version,
            if remember { "，已记为默认地址" } else { "" },
            match (&key_name, &key_prefix) {
                (Some(name), Some(prefix)) => format!(
                    "；钥匙 {name}（{prefix}，权限 {}）",
                    key_permission.clone().unwrap_or_default()
                ),
                (Some(name), None) => format!("；复用已存下的钥匙 {name}"),
                _ => String::new(),
            },
        ),
    );
    if signed_in {
        logfile::log(
            &shell.dir,
            "登录成功：会话令牌用完即弃（**没有落盘**），长期凭据是配置里那把 API Key",
        );
    }

    // ---------------------------------------------------------------- 起边车（P4-4 片②）
    //
    // 顺序**必须在导航之前**：前端一加载就可能打 `/turn/stream`，那时边车得已经在听。
    // 用户在表单里主动点连接（`remember`）或刚换了钥匙 → 先把旧的停掉再起新的
    // （换服务器/换账号都得换一套 base+token）。
    let key = {
        let config = shell.config.lock().map_err(|_| "配置锁被污染了".to_string())?;
        config.api_key.clone()
    };
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let runtime_root = sidecar::resolve_runtime(&resource_dir, &shell.dir);
    let log_dir = shell.dir.clone();
    let data_dir = shell.data_dir.clone();
    let workspace = data_dir.join("workspace");
    let manager = Arc::clone(&shell.sidecar);
    let restart = remember || fresh_key.is_some();
    let api_base = format!("{}/api/v1", probed.url.trim_end_matches('/'));
    let token = key.unwrap_or_default();
    let started = tauri::async_runtime::spawn_blocking(move || {
        if restart {
            manager.stop();
        }
        manager.ensure(
            &runtime_root,
            &log_dir,
            &data_dir,
            &workspace,
            &api_base,
            &token,
        )
    })
    .await
    .map_err(|error| format!("起边车没跑起来：{error}"))?;

    // 边车起不来**不阻断连接**：界面还能用（走服务器那条链），但必须如实说出来
    let (sidecar_port, sidecar_base, sidecar_note) = match started {
        Ok(info) => (Some(info.port), Some(info.base), String::new()),
        Err(error) => {
            logfile::log(&shell.dir, &format!("边车没起来：{error}"));
            (None, None, error)
        }
    };

    let url = Url::parse(&probed.url).map_err(|error| format!("地址拼不出来：{error}"))?;
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "主窗口不见了".to_string())?;

    /*
     * **导航到本地资源，而不是远端那台服务器**（这是本次改造的核心一跳）。
     *
     * 以前这里是 `window.navigate(远端 URL)`：于是 WebView 的文档与它依赖的每个
     * chunk 都要去 NAS 上取——切一次页面就是一次网络往返（用户报的"页面切换都有
     * 加载延迟"）。现在文档来自 `app://`（协议层读本地磁盘），
     * 只有 API 路径（`/api/…`）由协议层转发到这台服务器。
     *
     * `probed.url` 仍然要探（它证明"这台服务器是活的、是 KYLAB、版本对得上"），
     * 但**不再拿它当文档地址**。
     */
    let target =
        Url::parse(resources::app_url()).map_err(|error| format!("本地地址拼不出来：{error}"))?;
    window
        .navigate(target)
        .map_err(|error| format!("导航到本地资源失败：{error}"))?;
    logfile::log(
        &shell.dir,
        &format!(
            "已导航到本地资源 {}（文档不再走网络；API 转发到 {}；探活地址 {}）",
            resources::app_url(),
            shell.origin().unwrap_or_else(|| "（无）".into()),
            url
        ),
    );

    if let Some(settings) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = settings.close();
    }
    Ok(Connected {
        origin: probed.origin,
        url: probed.url,
        app: probed.app,
        version: probed.version,
        api_version: probed.api_version,
        signed_in,
        user_name,
        key_name,
        key_prefix,
        key_permission,
        has_key: has_key || fresh_key.is_some(),
        sidecar_port,
        sidecar_base,
        sidecar_note,
    })
}

/// `connect` 的结果（页面主要看 `signed_in` / `key_name` / `sidecar_port`）。
#[derive(Serialize)]
struct Connected {
    origin: String,
    url: String,
    app: String,
    version: String,
    api_version: String,
    /// 这一轮真去登录了吗（有钥匙直接用则为 `false`）。
    signed_in: bool,
    /// 账号显示名（这一轮登录才有）。
    user_name: Option<String>,
    key_name: Option<String>,
    /// 钥匙展示前缀（`kylab_sk_ab12…`）—— **不是明文**。
    key_prefix: Option<String>,
    key_permission: Option<String>,
    /// 这一轮结束后壳手里有没有能用的钥匙。
    has_key: bool,
    /// 边车端口与基址（没起来则是 `None`）；`sidecar_note` 是没起来的原因。
    sidecar_port: Option<u16>,
    sidecar_base: Option<String>,
    sidecar_note: String,
}

/// 边车现在活着吗（页面轮询用；`null` = 没活着）。
#[tauri::command]
fn sidecar_info(shell: State<'_, Shell>) -> Option<sidecar::Info> {
    shell.sidecar.info()
}

/// 问一句"这台服务器要不要先建管理员"。
///
/// 页面据此把文案换成「首次设置管理员」并显示"确认密码"栏——**先问再做**，
/// 而不是让用户点了连接再看服务端报 409。
#[derive(Serialize)]
struct SignInStatus {
    origin: String,
    needs_setup: bool,
}

#[tauri::command]
async fn signin_status(address: String) -> Result<SignInStatus, String> {
    let asked = address.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target = probe::normalize(&asked)?;
        let needs_setup = signin::status(&target.url)?;
        Ok(SignInStatus {
            origin: target.origin,
            needs_setup,
        })
    })
    .await
    .map_err(|error| format!("登录状态没查成：{error}"))?
}

/// 领钥匙时填的名字（服务器那边 `name` 上限 64）。带上主机名，用户在多台机器上
/// 装壳时能在「API Keys」页一眼分清哪把是哪台（命名口径见《桌面端-成员与钥匙》：
/// `桌面端 <主机名>`）。
fn issued_key_name() -> String {
    format!("桌面端 {}", device_name()).chars().take(64).collect()
}

/// **这台电脑的显示名**：转发给服务器的请求上带的就是它（`X-Kylab-Device-Name`）。
///
/// 主机名（Windows 看 `COMPUTERNAME`，别的平台看 `HOSTNAME`）取不到时用「这台电脑」：
/// 宁可名字笼统，也不要一个空字符串（服务器那边这只是一句给人看的、用来认人的话）。
/// **这不是身份**——身份是 `config.json` 里的 `device_id`（同型号机器的默认主机名会撞）。
fn device_name() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let host = host.trim();
    if host.is_empty() {
        "这台电脑".to_string()
    } else {
        host.to_string()
    }
}

// ---------------------------------------------------------------- 导航策略

/// 本地配置页。Windows 上是 `http://tauri.localhost/…`，macOS/Linux 是 `tauri://localhost/…`。
fn is_local_page(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost") | Some("tauri.localhost"))
}

/// `scheme://host[:port]`。与 `probe::normalize` 里拼的是同一个形状，才能直接比字符串。
fn origin_of(url: &Url) -> String {
    format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.port().map(|port| format!(":{port}")).unwrap_or_default()
    )
}

/// 顶层导航放行规则：壳自己的页面 + `app://` 本地资源 + 配置里的那个源，别的都不许。
///
/// 拦下来的**外链交给系统浏览器**而不是静默丢弃：回答里的链接本来就该在浏览器里开，
/// 而在这个壳里导航过去，用户就回不来了（没有地址栏，也没有后退按钮）。
fn allow_navigation(app: &AppHandle, url: &Url) -> bool {
    if is_local_page(url) || url.scheme() == "about" || url.scheme() == APP_SCHEME {
        return true;
    }
    // Windows 上自定义 scheme 落在 `http://app.localhost/…`（见 `resources::app_url`），
    // 它的 scheme 是 http——按源判，不然本地资源那一跳会被自己拦掉
    if url.as_str().starts_with(resources::app_origin()) {
        return true;
    }
    let shell = app.state::<Shell>();
    if shell.origin().as_deref() == Some(origin_of(url).as_str()) {
        return true;
    }
    open_externally(app, url);
    false
}

/// 交给系统浏览器打开（外部链接、以及"在浏览器里打开"这个菜单项）。
fn open_externally(app: &AppHandle, url: &Url) {
    let dir = app.state::<Shell>().dir.clone();
    match app.opener().open_url(url.as_str(), None::<&str>) {
        Ok(()) => logfile::log(&dir, &format!("外链交给系统浏览器：{url}")),
        Err(error) => logfile::log(&dir, &format!("外链打不开（{error}）：{url}")),
    }
}

// ---------------------------------------------------------------- 菜单

/// 「更换服务器」：把配置页单独开一扇窗。
///
/// **不在原窗口里导航回去**：那样会把用户正在看的会话丢掉，而"改地址"和
/// "离开当前页面"是两件事。已经开着就把它提到前面。
fn open_settings_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App(PAGE.into()))
        .title("连接到 KYLAB")
        .inner_size(520.0, 480.0)
        .min_inner_size(520.0, 480.0)
        .resizable(false)
        .center()
        .enable_clipboard_access()
        .build()?;
    Ok(())
}

/// 建菜单项，**快捷键不被接受就退回不带快捷键的那一条**。
///
/// 这个兜底是必要的：加速键的字符串格式（`CmdOrCtrl+,` 这类）没有编译期校验，
/// 一旦某个平台不认，`with_id` 会返回 Err——那样整个菜单都建不起来、壳直接打不开。
/// 少一个快捷键是小事，打不开是大事。
fn menu_item(
    app: &AppHandle,
    dir: &Path,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<Wry>> {
    if let Some(keys) = accelerator {
        match MenuItem::with_id(app, id, text, true, Some(keys)) {
            Ok(item) => return Ok(item),
            Err(error) => logfile::log(dir, &format!("快捷键 {keys:?} 不被接受（{error}），该菜单项不带快捷键")),
        }
    }
    MenuItem::with_id(app, id, text, true, None::<&str>)
}

/// 菜单结构。**只在 macOS 上编译**（Windows/Linux 上不挂菜单，见 `build_tray`）。
/// **「编辑」那一段是必需的**，不是客套：
/// macOS 上网页里的 ⌘C / ⌘V 要靠菜单里的加速键才生效（Tauri 官方文档原话），
/// 少了它，用户在壳里复制不了任何东西。
#[cfg(target_os = "macos")]
use tauri::menu::Submenu;

#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle, dir: &Path) -> tauri::Result<Menu<Wry>> {
    let change = menu_item(app, dir, "change-server", "更换服务器…", Some("CmdOrCtrl+,"))?;
    let reload = menu_item(app, dir, "reload", "重新加载", Some("CmdOrCtrl+R"))?;
    let external = menu_item(app, dir, "open-in-browser", "在浏览器里打开", None)?;
    let data_dir = menu_item(app, dir, "open-data-dir", "打开配置与日志", None)?;
    let first_separator = PredefinedMenuItem::separator(app)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("退出"))?;

    let connect_items: Vec<&dyn IsMenuItem<Wry>> =
        vec![&change, &reload, &first_separator, &external, &second_separator, &quit];
    let connect = Submenu::with_items(app, "连接", true, &connect_items)?;

    // 每一项都先绑成局部变量：`PredefinedMenuItem::xxx()` 返回的是**临时值**，
    // 直接塞进 `Vec<&dyn IsMenuItem>` 会在语句结束时被丢掉，而
    // `Submenu::with_items` 还要接着借用它们（编译器会以 E0716 明说）。
    let undo = PredefinedMenuItem::undo(app, Some("撤销"))?;
    let redo = PredefinedMenuItem::redo(app, Some("重做"))?;
    let edit_separator = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, Some("剪切"))?;
    let copy = PredefinedMenuItem::copy(app, Some("复制"))?;
    let paste = PredefinedMenuItem::paste(app, Some("粘贴"))?;
    let select_all = PredefinedMenuItem::select_all(app, Some("全选"))?;
    let edit_items: Vec<&dyn IsMenuItem<Wry>> = vec![
        &undo,
        &redo,
        &edit_separator,
        &cut,
        &copy,
        &paste,
        &select_all,
    ];
    let edit = Submenu::with_items(app, "编辑", true, &edit_items)?;

    let minimize = PredefinedMenuItem::minimize(app, Some("最小化"))?;
    let close = PredefinedMenuItem::close_window(app, Some("关闭窗口"))?;
    let window_items: Vec<&dyn IsMenuItem<Wry>> = vec![&minimize, &close];
    let window = Submenu::with_items(app, "窗口", true, &window_items)?;

    let help_items: Vec<&dyn IsMenuItem<Wry>> = vec![&data_dir];
    let help = Submenu::with_items(app, "帮助", true, &help_items)?;

    Menu::with_items(app, &[&connect, &edit, &window, &help])
}

/// 托盘图标。**窗口里那一条菜单栏的替代品**（v0.30 调整）。
///
/// 原来 Windows/Linux 上也是挂菜单栏，结果窗口顶上叠三条横杠：系统标题栏、
/// 菜单栏、应用自己的头部——用户在截图里圈出来说"这一坨太丑了"。菜单栏是
/// 系统画的原生控件，样式改不了，所以干脆不挂：那几个入口挪到托盘右键菜单里，
/// 一个都不少，而窗口顶只剩系统标题栏。
///
/// 左边单击托盘 = 把主窗提到前面（壳的窗口被别的窗口盖住时最快的找法）。
fn build_tray(app: &AppHandle, dir: &Path) -> tauri::Result<()> {
    let change = menu_item(app, dir, "change-server", "更换服务器…", None)?;
    let reload = menu_item(app, dir, "reload", "重新加载", None)?;
    let external = menu_item(app, dir, "open-in-browser", "在浏览器里打开", None)?;
    let data_dir = menu_item(app, dir, "open-data-dir", "打开配置与日志", None)?;
    let first_separator = PredefinedMenuItem::separator(app)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("退出"))?;
    let items: Vec<&dyn IsMenuItem<Wry>> =
        vec![&change, &reload, &first_separator, &external, &data_dir, &second_separator, &quit];
    let menu = Menu::with_items(app, &items)?;

    let Some(icon) = app.default_window_icon().cloned() else {
        // 图标没配上（`tauri.conf.json` 的 bundle.icon）就不建托盘：
        // 为一个入口少了图标而让壳起不来，不值当
        logfile::log(dir, "没有默认窗口图标，跳过托盘图标");
        return Ok(());
    };

    TrayIconBuilder::with_id("kylab-tray")
        .icon(icon)
        .tooltip("KYLAB")
        .menu(&menu)
        // 左键不弹菜单（左键留给"把窗口叫到前面"），右键才弹
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;
    logfile::log(dir, "托盘图标已就绪（更换服务器 / 重新加载 / 在浏览器里打开 / 配置与日志 / 退出）");
    Ok(())
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "change-server" => {
            if let Err(error) = open_settings_window(app) {
                logfile::log(
                    &app.state::<Shell>().dir,
                    &format!("设置窗打不开：{error}"),
                );
            }
        }
        "reload" => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.reload();
            }
        }
        "open-in-browser" => {
            if let Some(origin) = app.state::<Shell>().origin() {
                if let Ok(url) = Url::parse(&origin) {
                    open_externally(app, &url);
                }
            }
        }
        "open-data-dir" => {
            let dir = app.state::<Shell>().dir.clone();
            let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- 启动

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            startup,
            connect,
            note,
            signin_status,
            sidecar_info
        ])
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        /*
         * `app://` 协议：真实前端的**所有静态资源**都从这里出（规格 §5.2）。
         *
         * 为什么走**异步**注册：这个处理器里要发 HTTP（把 `/api/…` 转发到远端），
         * 而同步版本的签名是 `Fn(...) -> Response`——在里面阻塞会按住 WebView 的
         * 协议线程。异步版把活交给自己的线程，协议线程立刻返回。
         *
         * 闭包能拿到的事实只有两样：`AppHandle`（→ 配置里的服务器地址 + 数据目录）
         * 与这次请求（方法 / 路径 / 正文）。**判据全在 `resources::handle` 里**，
         * 那是纯函数、模块里有 23 条用例（含"查询串原样转发""设备标记注入"那两条）
         * ——协议这一层只做搬运。
         */
        .register_asynchronous_uri_scheme_protocol(APP_SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let method = request.method().as_str().to_string();
            // **路径要带查询串**（`/api/v1/x?k=v`）：只取 `Uri::path()` 会把 `conversation_id`
            // 这类参数丢在壳里——2026-09-30 实测，带 query 的请求在页面里 422、直连服务器 200，
            // 界面上的表现是上下文用量环永远"不可用"（拆分与转发判据见 `resources::handle`）。
            let path = request
                .uri()
                .path_and_query()
                .map(|pq| pq.as_str().to_string())
                .unwrap_or_else(|| request.uri().path().to_string());
            let body = request.body();
            let payload = if body.is_empty() { None } else { Some(body.clone()) };
            // **请求头要转发**（Authorization 尤其）：不转发的话每个要登录的接口都 401
            let headers: Vec<(String, String)> = request
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.as_str().to_string(), value.to_string()))
                })
                .collect();
            std::thread::spawn(move || {
                let state = app.state::<Shell>();
                let root = state.resources_root();
                let server = state.origin();
                // **设备标记只加在转发给那台服务器的请求上**（见 `resources::proxy`）：
                // 本地资源那一支一个头都不带——它不是给服务器看的。还没生成 device_id
                // 时这里是 `None`，等价于网页端语义。
                let device = state.device();
                let response = resources::handle(
                    &root,
                    server.as_deref(),
                    device,
                    &method,
                    &path,
                    payload.as_deref(),
                    &headers,
                );
                responder.respond(response);
            });
        })
        .setup(|app| {
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let config = config::Config::load(&dir);
            // 资源目录**启动时确保存在**（规格 §5.3 第一条）：不存在时协议层要读它，
            // 而"目录不存在"与"目录里没有可用版本"在日志里该是两件事
            let resources_root = resources::resources_root(&data_dir);
            if let Err(error) = std::fs::create_dir_all(&resources_root) {
                logfile::log(&dir, &format!("资源目录建不出来（{error}）：{}", resources_root.display()));
            }
            let status = resources::status(&data_dir);
            logfile::log(
                &dir,
                &format!(
                    "启动（壳 {}），配置里的地址：{}；资源：{}（版本 {}，目录 {}）",
                    env!("CARGO_PKG_VERSION"),
                    config.server.as_deref().unwrap_or("（还没配过）"),
                    status.mode,
                    status.version.as_deref().unwrap_or("无"),
                    status.root
                ),
            );
            app.manage(Shell {
                dir: dir.clone(),
                data_dir,
                config: Mutex::new(config),
                device_name: device_name(),
                sidecar: Arc::new(sidecar::Manager::new()),
            });

            /*
             * **资源热更新**（Phase 2，规格 §4）：后台拉一次清单，有新版就下载 → 校验 sha256 →
             * 原子切指针 —— **下次启动生效**（不打断这一次的使用）。
             *
             * 放在这里、**不进任何 await 路径**：拉不到清单是常态（NAS 没开、断网），
             * 那种时候这一句只该让日志多一行，绝不能让壳起不来或弹窗。
             */
            {
                /// 一次更新的墙钟上限：清单 + 包（现在约 2.6 MB）在局域网里几秒就完，
                /// 给 30 秒是"慢网络也别卡在后台线程上"的余量。
                const UPDATE_TIMEOUT_SECONDS: u64 = 30;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let shell = handle.state::<Shell>();
                    // 还没配服务器（首次打开、停在引导页）：等用户登录之后再谈更新
                    let Some(origin) = shell.origin() else {
                        return;
                    };
                    let outcome = resources::sync(
                        &origin,
                        &shell.data_dir,
                        env!("CARGO_PKG_VERSION"),
                        std::time::Duration::from_secs(UPDATE_TIMEOUT_SECONDS),
                    );
                    let line = match outcome {
                        resources::SyncOutcome::UpToDate => "资源更新：已是最新".to_string(),
                        resources::SyncOutcome::Installed { version } => {
                            format!("资源更新：装好 {version}（**下次启动生效**）")
                        }
                        resources::SyncOutcome::Skipped { reason } => {
                            format!("资源更新：这次跳过（{reason}）")
                        }
                    };
                    logfile::log(&shell.dir, &line);
                });
            }

            // 菜单**只在 macOS 上挂**：那里没有应用菜单就没有 ⌘C / ⌘V
            // （Tauri 官方文档明说要用菜单加速键）。Windows/Linux 上网页的
            // Ctrl+C / Ctrl+V 由 WebView 自己处理，挂了菜单反而在窗口顶上多一条
            // 老式菜单栏——它与系统标题栏、应用自己的头部叠成三条横杠，
            // 用户看到就一句"这一坨太丑了"。那几个入口改走托盘（build_tray）。
            #[cfg(target_os = "macos")]
            {
                let menu = build_menu(app.handle(), &dir)?;
                app.set_menu(menu)?;
            }
            build_tray(app.handle(), &dir)?;

            let handle = app.handle().clone();
            let external_handle = app.handle().clone();
            let (width, height) = default_window_size(app.handle());
            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App(PAGE.into()))
                .title("KYLAB")
                .inner_size(width, height)
                // 下限**比默认小一大截**：用户自己把窗口拖窄是他的选择
                // （拖到 900 以下时笔记页本来就有单列布局，那是设计过的状态），
                // 但默认不该一开就是"已经有一处排版坏了"的宽度（见 default_window_size）
                .min_inner_size(1024.0, 680.0)
                .center()
                // Linux/Windows 上页面默认拿不到剪贴板，要显式开
                // （复制按钮是这个项目里天天用的东西，见开发计划 §12.205）
                .enable_clipboard_access()
                .on_navigation(move |url| allow_navigation(&handle, url))
                .on_new_window(move |url, _features| {
                    // `target="_blank"`（回答里的链接、检索结果的网址）一律交给系统浏览器。
                    // 闭包签名里拿不到 app handle，所以在建窗之前先 clone 一份带着。
                    open_externally(&external_handle, &url);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("KYLAB 桌面壳启动失败")
        .run(|app, event| {
            // **退出时把边车收干净**（不留孤儿 python ✗）。这里只是"正常退出"那一路：
            // 托盘退出 / 关窗（Windows 上关主窗就是退出）/ 系统要求退出都会走到。
            // 壳**崩了**这一路没有代码会跑——那一路靠 sidecar.rs 里的 Job Object
            // （KILL_ON_JOB_CLOSE）把子进程一起收走。
            if let tauri::RunEvent::Exit = event {
                let shell = app.state::<Shell>();
                shell.sidecar.stop();
                logfile::log(&shell.dir, "壳要退出了：边车已停");
            }
        });
}

#[cfg(test)]
mod tests {
    use super::window_size_for;

    /// 这台开发机：3840 宽的屏按 225% 缩放 → 工作区约 1707×910 逻辑像素。
    #[test]
    fn a_scaled_big_screen_gets_a_size_that_fits_its_work_area() {
        let (width, height) = window_size_for(Some((1707.0, 910.0)));
        assert!(width < 1707.0, "宽度要留边：{width}");
        assert!(height < 910.0, "高度要留出任务栏：{height}");
        assert!(width >= 1488.0, "这台机器的默认宽度必须够笔记页一行放下：{width}");
    }

    /// **比 16:10 推出来的高度更高的屏**上也别超出去：高度是夹进工作区的。
    #[test]
    fn height_never_exceeds_the_work_area() {
        let (_, height) = window_size_for(Some((2560.0, 700.0)));
        assert!(height <= 700.0 - 48.0, "{height}");
    }

    /// 大屏上取上限（别一开就铺满），小屏上**不超出去**（宁可窄，也不要露在屏幕外）。
    #[test]
    fn the_cap_and_the_floor_both_hold() {
        assert_eq!(window_size_for(Some((2560.0, 1400.0))).0, 1680.0);
        let (small_w, small_h) = window_size_for(Some((1280.0, 680.0)));
        assert!(small_w <= 1280.0 && small_h <= 680.0, "{small_w}x{small_h}");
        let (tiny_w, tiny_h) = window_size_for(Some((1024.0, 600.0)));
        assert!(tiny_w <= 1024.0 && tiny_h <= 600.0, "{tiny_w}x{tiny_h}");
    }

    /// 问不到显示器时回落到 1440×900，**不是**回落到出问题的那个 1280。
    #[test]
    fn without_a_monitor_it_falls_back_to_a_sane_default() {
        assert_eq!(window_size_for(None), (1440.0, 900.0));
    }

    /// 回归钉子：默认宽度必须 ≥1488（笔记页那行工具栏不折行的门槛）。
    #[test]
    fn the_default_barely_clears_the_notes_toolbar_threshold() {
        for area in [1600.0, 1920.0, 2560.0] {
            let (width, _) = window_size_for(Some((area, 1040.0)));
            assert!(width >= 1488.0, "{area} 宽的屏上默认只有 {width}");
        }
    }
}
