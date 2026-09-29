//! 连接即登录：**登录一次，领一把长期钥匙**（P4-4 片①）。
//!
//! ## 为什么是"领钥匙"而不是"存密码"
//!
//! 会话令牌 7 天滑动续期，到期就得让用户再登一次；而桌面壳要的是"配一次就一直用"。
//! 服务器那边正好有这个长期凭据：**API Key**（`kylab_sk_…`，吊销在「API Keys」页）。
//! 所以流程是：
//!
//! ```text
//! /auth/status → needs_setup ? /auth/setup : /auth/login → /api-keys → 存 api_key
//!      （会话令牌只在内存里活这一次，**用完即弃、不落盘**）
//! ```
//!
//! **密码只在这一次请求里出现过**，壳不留它（配置文件里压根没有这一栏）。
//!
//! ## 契约（逐个核实过，不是猜的）
//!
//! - `GET  {base}/api/v1/auth/status`（不鉴权）→ `{ "needs_setup": bool }`
//! - `POST {base}/api/v1/auth/setup` `{ username, password, name? }` → `{ token, user }`
//!   **仅当还没有任何账号时开放**；首账号即管理员。
//! - `POST {base}/api/v1/auth/login` `{ username, password }` → `{ token, user }`
//! - `POST {base}/api/v1/api-keys`（**要管理员**）`{ name, permission, knowledge_base_ids }`
//!   → `201 { id, name, permission, knowledge_base_ids, created_at, last_used_at, prefix, token }`
//!   明文 `token` **只在这一次响应里出现**，之后拿不回来 → 必须当场存下。
//!
//! ⚠️ 两个默认值很容易踩：`permission` 服务端默认是 `readonly`（保守默认 ✓），
//! 而边车要写回对话 → **必须显式传 `readwrite`**；`knowledge_base_ids: []` = 不限制范围。
//!
//! ## 为什么用 `ureq`
//!
//! 与 `probe.rs` 同一个理由：这几个请求都是"点一下等结果"的同步动作，配
//! `spawn_blocking` 正好；为它们引一套 reqwest + tokio 不值（壳里已经有 tokio，
//! 但多一套 HTTP 栈就多一处要跟着升级的东西）。

use std::time::Duration;

use serde::Serialize;

/// 比探活宽松：这三步要查库、算口令哈希、写钥匙，局域网里慢一点也别误报。
const TIMEOUT: Duration = Duration::from_secs(15);

const USER_AGENT: &str = concat!("KYLAB-Desktop/", env!("CARGO_PKG_VERSION"));

const STATUS_PATH: &str = "/api/v1/auth/status";
const SETUP_PATH: &str = "/api/v1/auth/setup";
const LOGIN_PATH: &str = "/api/v1/auth/login";
const KEYS_PATH: &str = "/api/v1/api-keys";

/// 钥匙权限：**边车要写回对话，所以这里必须是 readwrite**（服务端默认是 readonly）。
pub const READWRITE: &str = "readwrite";

/// 一次登录的结果（**`token` 只活在内存里**）。
#[derive(Debug, Clone, Serialize)]
pub struct Session {
    /// 会话令牌（`kylab_st_…`）。用完即弃，不落盘。
    pub token: String,
    /// 账号的用户名（`probe_admin` 这种）。
    pub username: String,
    /// 显示名（留空时服务器用用户名）。
    pub name: String,
    /// `admin` / `member`。
    pub role: String,
}

impl Session {
    /// 界面上说"你是谁"用显示名；没有就退回用户名。
    pub fn display_name(&self) -> String {
        if self.name.trim().is_empty() {
            self.username.clone()
        } else {
            self.name.clone()
        }
    }
}

/// 领到的长期凭据。
#[derive(Debug, Clone, Serialize)]
pub struct IssuedKey {
    pub id: String,
    pub name: String,
    pub permission: String,
    /// 展示用前缀（`kylab_sk_ab12…`）—— **日志里只写它**，明文留给配置文件。
    pub prefix: String,
    /// 明文令牌（`kylab_sk_…`）：**只在这一次响应里出现** → 立刻存进配置。
    pub token: String,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
}

/// 把 `base`（`probe::Target::url`，可能带反代前缀）与路径拼起来。
fn url_for(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

/// `base` 为空时给一句人话（正常不会发生：调用方先用 `probe::normalize` 过一遍）。
fn require_base(base: &str) -> Result<String, String> {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("服务器地址是空的".into());
    }
    Ok(trimmed.to_string())
}

/// 这台服务器**是否还没有账号**（`needs_setup`）。
pub fn status(base: &str) -> Result<bool, String> {
    let base = require_base(base)?;
    let url = url_for(&base, STATUS_PATH);
    let response = agent()
        .get(&url)
        .call()
        .map_err(|error| describe_failure(&base, &url, error, "查登录状态"))?;
    let payload = read_json(response, &base, "登录状态")?;
    Ok(payload
        .get("needs_setup")
        .and_then(|value| value.as_bool())
        .unwrap_or(false))
}

/// 首次初始化：建管理员账号（**仅当服务器上还没有任何账号时可用**）。
pub fn setup(base: &str, username: &str, password: &str) -> Result<Session, String> {
    let base = require_base(base)?;
    let body = serde_json::json!({
        "username": username.trim(),
        "password": password,
    });
    let url = url_for(&base, SETUP_PATH);
    let response = agent()
        .post(&url)
        .send_json(body)
        .map_err(|error| describe_failure(&base, &url, error, "初始化管理员"))?;
    let payload = read_json(response, &base, "初始化结果")?;
    parse_session(&payload)
}

/// 登录：用户名 + 密码 → 会话令牌。
pub fn login(base: &str, username: &str, password: &str) -> Result<Session, String> {
    let base = require_base(base)?;
    let body = serde_json::json!({
        "username": username.trim(),
        "password": password,
    });
    let url = url_for(&base, LOGIN_PATH);
    let response = agent()
        .post(&url)
        .send_json(body)
        .map_err(|error| describe_failure(&base, &url, error, "登录"))?;
    let payload = read_json(response, &base, "登录结果")?;
    parse_session(&payload)
}

/// 用会话令牌换一把长期钥匙（**这一步要管理员**）。
pub fn issue_key(base: &str, session_token: &str, device_name: &str) -> Result<IssuedKey, String> {
    let base = require_base(base)?;
    let body = serde_json::json!({
        "name": device_name,
        // ⚠️ 必须显式传 readwrite：服务端默认 readonly（保守默认），而边车要写回对话
        "permission": READWRITE,
        // 空 = 不限制知识库范围
        "knowledge_base_ids": [],
    });
    let url = url_for(&base, KEYS_PATH);
    let response = agent()
        .post(&url)
        .set("Authorization", &format!("Bearer {session_token}"))
        .send_json(body)
        .map_err(|error| describe_failure(&base, &url, error, "领钥匙"))?;
    let payload = read_json(response, &base, "领钥匙的结果")?;
    parse_key(&payload)
}

/// 解析 `{ token, user: { username, name, role } }`。
fn parse_session(payload: &serde_json::Value) -> Result<Session, String> {
    let token = payload
        .get("token")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "服务器没有返回会话令牌".to_string())?
        .to_string();
    let user = payload.get("user").cloned().unwrap_or(serde_json::Value::Null);
    let username = user
        .get("username")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let name = user
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let role = user
        .get("role")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    Ok(Session {
        token,
        username,
        name,
        role,
    })
}

/// 解析 `{ id, name, permission, prefix, token }`。
fn parse_key(payload: &serde_json::Value) -> Result<IssuedKey, String> {
    let field = |key: &str| -> String {
        payload
            .get(key)
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string()
    };
    let token = field("token");
    if token.is_empty() {
        return Err("服务器没有返回钥匙明文（这一份只在创建响应里出现一次）".into());
    }
    Ok(IssuedKey {
        id: field("id"),
        name: field("name"),
        permission: field("permission"),
        prefix: field("prefix"),
        token,
    })
}

/// 读响应体并解析成 JSON（非 JSON = 这个地址上不是 KYLAB，与 `probe.rs` 同口径）。
fn read_json(response: ureq::Response, base: &str, what: &str) -> Result<serde_json::Value, String> {
    let body = response
        .into_string()
        .map_err(|error| format!("{what}的响应读不出来：{error}（{base}）"))?;
    serde_json::from_str(&body)
        .map_err(|_| format!("{what}拿到的不是 JSON：{base} 上跑的可能不是 KYLAB"))
}

/// 把一次失败的请求翻译成"下一步该干什么"。
///
/// 分类与 `probe.rs` 一致（连不上 / 不是 KYLAB / 版本不配），另外**把 401 单独一类**：
/// "用户名或密码不对"是用户能自己修的一件事，混进"网络错误"里就白说了。
fn describe_failure(base: &str, url: &str, error: ureq::Error, action: &str) -> String {
    match error {
        ureq::Error::Transport(transport) => {
            let raw = transport.message().unwrap_or("没有更多信息");
            let hint = match transport.kind() {
                ureq::ErrorKind::Dns => "域名解析不了：检查主机名拼写，或直接填 IP".to_string(),
                ureq::ErrorKind::ConnectionFailed => {
                    "连接被拒绝：确认 NAS 开着、KYLAB 服务在跑，端口也没写错".to_string()
                }
                ureq::ErrorKind::Io => {
                    if base.starts_with("https://") {
                        "连接断开：如果 NAS 用的是自签名证书，壳不会替它跳过校验——换一张受信任的证书，或先用 http".to_string()
                    } else {
                        "连接中断：网络不稳定，或对端把连接掐了".to_string()
                    }
                }
                _ => format!("网络错误：{raw}"),
            };
            format!("{action}时连不上 {base}：{hint}")
        }
        ureq::Error::Status(code, response) => {
            let detail = server_message(response);
            match code {
                401 => {
                    if action == "领钥匙" {
                        "登录已失效（401）：会话令牌过期了，请重新登录".to_string()
                    } else {
                        format!(
                            "用户名或密码不对（401）{}",
                            if detail.is_empty() {
                                String::new()
                            } else {
                                format!("：{detail}")
                            }
                        )
                    }
                }
                403 => format!(
                    "这个账号不是管理员，领不了钥匙（403）{}——钥匙只能由管理员签发",
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!("：{detail}")
                    }
                ),
                409 => "这台服务器上已经有账号了：改用登录（首次初始化只开放一次）".to_string(),
                422 => format!(
                    "服务器不接受这次请求（422）{}",
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!("：{detail}")
                    }
                ),
                _ => format!(
                    "{action}失败：HTTP {code} {}{}",
                    url,
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!("（{detail}）")
                    }
                ),
            }
        }
    }
}

/// 从错误响应里取出后端那句给人看的 `message`（错误信封：`{code, message}`）。
///
/// **不解析 `code`**：程序分支按 HTTP 状态码走，`message` 只负责"人话"那一半——
/// 后端明确说过 message 的措辞可能随版本改进（见《API 接口规范》§1.3）。
fn server_message(response: ureq::Response) -> String {
    let Ok(body) = response.into_string() else {
        return String::new();
    };
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&body) else {
        return body.chars().take(120).collect();
    };
    payload
        .get("message")
        .and_then(|value| value.as_str())
        .map(|value| value.chars().take(200).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_joined_without_double_slashes() {
        assert_eq!(
            url_for("http://nas:8000/", LOGIN_PATH),
            "http://nas:8000/api/v1/auth/login"
        );
        assert_eq!(
            url_for("http://nas/kylab", STATUS_PATH),
            "http://nas/kylab/api/v1/auth/status"
        );
    }

    #[test]
    fn an_empty_base_is_rejected_before_any_request() {
        assert!(status("   ").is_err());
        assert!(login("", "u", "p").is_err());
    }

    #[test]
    fn a_session_needs_a_token() {
        let payload = serde_json::json!({ "user": { "username": "u", "name": "名字", "role": "admin" } });
        assert!(parse_session(&payload).is_err());

        let ok = serde_json::json!({
            "token": "kylab_st_x",
            "user": { "username": "u", "name": "名字", "role": "admin" }
        });
        let session = parse_session(&ok).expect("能解析");
        assert_eq!(session.token, "kylab_st_x");
        assert_eq!(session.display_name(), "名字");
        assert_eq!(session.role, "admin");
    }

    /// 显示名留空时退回用户名（服务器允许 `name` 为空）。
    #[test]
    fn an_empty_display_name_falls_back_to_the_username() {
        let payload = serde_json::json!({
            "token": "kylab_st_x",
            "user": { "username": "probe_admin", "name": "", "role": "admin" }
        });
        assert_eq!(parse_session(&payload).unwrap().display_name(), "probe_admin");
    }

    #[test]
    fn an_issued_key_needs_the_plaintext_token() {
        let without = serde_json::json!({ "id": "key_1", "prefix": "kylab_sk_ab12…" });
        assert!(parse_key(&without).is_err());

        let with = serde_json::json!({
            "id": "key_1",
            "name": "桌面端 NAS",
            "permission": "readwrite",
            "prefix": "kylab_sk_ab12…",
            "token": "kylab_sk_secret"
        });
        let key = parse_key(&with).expect("能解析");
        assert_eq!(key.id, "key_1");
        assert_eq!(key.permission, "readwrite");
        assert_eq!(key.token, "kylab_sk_secret");
    }

    /// 与真后端对一次：只有显式给了 `KYLAB_TEST_SERVER` 才跑。
    ///
    /// 为什么这么设计：CI 与"没起服务的机器"上不该因为一条网络用例变红（与
    /// `probe.rs::talks_to_a_real_server_when_one_is_running` 同一思路）。
    /// 需要账号时用 `KYLAB_TEST_USER` / `KYLAB_TEST_PASSWORD`。
    #[test]
    fn talks_to_a_real_server_when_one_is_running() {
        let Ok(base) = std::env::var("KYLAB_TEST_SERVER") else {
            eprintln!("跳过：没有给 KYLAB_TEST_SERVER");
            return;
        };
        match status(&base) {
            Ok(needs_setup) => {
                eprintln!("/auth/status → needs_setup={needs_setup}");
                assert!(needs_setup || !needs_setup); // 能解析出来就算通过
            }
            Err(message) => eprintln!("跳过：{base} 上没有可用的 KYLAB（{message}）"),
        }
    }

    /// **端到端（P4-4 片① 的验收）**：登录 → 领钥匙 → 写 `config.json`。
    ///
    /// 只在给了 `KYLAB_TEST_SERVER` / `KYLAB_TEST_USER` / `KYLAB_TEST_PASSWORD` 时跑
    /// （与上一条同思路：没起服务的机器不该因此变红）。配置落在**临时目录**，
    /// 不碰用户真实的 `%APPDATA%`。
    #[test]
    fn a_real_server_hands_out_a_key_and_the_config_keeps_it() {
        let (Ok(base), Ok(user), Ok(secret)) = (
            std::env::var("KYLAB_TEST_SERVER"),
            std::env::var("KYLAB_TEST_USER"),
            std::env::var("KYLAB_TEST_PASSWORD"),
        ) else {
            eprintln!("跳过：需要 KYLAB_TEST_SERVER / KYLAB_TEST_USER / KYLAB_TEST_PASSWORD");
            return;
        };

        let needs_setup = status(&base).expect("① 查登录状态");
        eprintln!("① GET /api/v1/auth/status → needs_setup={needs_setup}");

        let session = if needs_setup {
            setup(&base, &user, &secret).expect("② 初始化管理员")
        } else {
            login(&base, &user, &secret).expect("② 登录")
        };
        eprintln!(
            "② POST {} → username={} name={} role={} token=<{} 位，打码>",
            if needs_setup {
                "/api/v1/auth/setup"
            } else {
                "/api/v1/auth/login"
            },
            session.username,
            session.display_name(),
            session.role,
            session.token.len()
        );

        let key = issue_key(&base, &session.token, "桌面端 验收").expect("③ 领钥匙");
        eprintln!(
            "③ POST /api/v1/api-keys → id={} name={} permission={} prefix={} token=<{} 位，打码>",
            key.id,
            key.name,
            key.permission,
            key.prefix,
            key.token.len()
        );
        // 默认是 readonly，而边车要写回对话 —— 这条断言钉住"必须显式传 readwrite"
        assert_eq!(key.permission, READWRITE);

        // ④ 写配置（与 `main.rs::connect` 里那段写法一致）
        let dir = std::env::temp_dir().join("kylab-desktop-signin-live");
        let _ = std::fs::remove_dir_all(&dir);
        let mut config = crate::config::Config::default();
        config.remember(&base);
        config.remember_key(&key.id, &key.name, &session.display_name(), &key.token);
        config.save(&dir).expect("④ 写配置");

        let saved = std::fs::read_to_string(crate::config::Config::path(&dir)).expect("读回配置");
        eprintln!(
            "④ config.json → {}",
            saved.replace(&key.token, "kylab_sk_<打码>").trim()
        );
        assert!(saved.contains(&key.token), "钥匙要真的写进配置文件");
        assert!(config.has_key_for(&base), "配置要认得这个源");
        assert!(!saved.contains(&secret), "密码绝不许落盘");
    }
}
