//! 探活：在把窗口导航过去之前，先问一句 `/api/v1/health`。
//!
//! 为什么非要先问一句：**不做这一步，地址填错或 NAS 没开机时，用户会得到
//! WebView 自己的错误页**——那上面没有返回入口的意思（得知道去菜单里找），
//! 而"这一步失败"是壳最容易说清楚的一件事。探通之后才导航，
//! 失败就留在配置页上把原因写出来。
//!
//! 顺带做两件校验：**这是不是 KYLAB**（`app` 字段）、**接口版本对不对得上**
//! （`api_version`）。有了它们，"填成了路由器管理页"这种错能当场说破，
//! 而不是让用户盯着一个不是我们产品的界面发呆。
//!
//! 为什么用 `ureq` 而不手写 TCP：https 要 TLS，手写不了；而 shell 里为一次探活
//! 引一个异步 HTTP 栈（reqwest + tokio 全家桶）又不值。ureq 是同步的，正好配
//! `spawn_blocking`（见 main.rs 的 `connect`）。

use std::time::Duration;

use serde::Serialize;

/// 连不上时最多等这么久。够局域网里"NAS 关机"当场失败，也不至于让启动卡住。
const TIMEOUT: Duration = Duration::from_secs(4);

/// 探针路径。**与后端的 `app/api/v1/health.py` 对应**，改那边要同步这里。
const HEALTH_PATH: &str = "/api/v1/health";

const USER_AGENT: &str = concat!("KYLAB-Desktop/", env!("CARGO_PKG_VERSION"));

/// 规范化之后的服务器地址。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Target {
    /// `scheme://host[:port]`，不含路径。**写进配置、做导航白名单都用它**。
    pub origin: String,
    /// 导航用的完整地址（可能带反代前缀）。
    pub url: String,
    /// 探针地址。
    health: String,
}

/// 探活结果：服务端自报的身份。
#[derive(Debug, Clone, Serialize)]
pub struct Probed {
    pub app: String,
    pub version: String,
    pub api_version: String,
    pub origin: String,
    pub url: String,
}

/// 把用户输入变成一个能用的地址。
///
/// 宽容的地方：没写协议就补 `http://`（局域网里没人会写）、末尾多余的斜杠去掉、
/// 只填 `192.168.1.10:8080` 也认。严格的地方：只收 http/https（Tauri 的
/// `WebviewUrl::External` 也只收这两个），地址里不许带用户名密码。
pub fn normalize(address: &str) -> Result<Target, String> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Err("请填写服务器地址".into());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = tauri::Url::parse(&with_scheme)
        .map_err(|_| format!("这个地址看不懂：{trimmed}（示例 http://192.168.1.10:8080）"))?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "只支持 http 与 https 地址，不支持 {}",
            parsed.scheme()
        ));
    }
    if parsed.host_str().is_none() {
        return Err(format!("地址里没有主机名：{trimmed}"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("地址里不要带用户名密码".into());
    }

    // 丢掉问号与井号那两段（它们对"哪台服务器"没有意义），路径保留：
    // 反向代理挂在子路径下时（`http://nas/kylab`）那个前缀是地址的一部分。
    let mut base = parsed.clone();
    base.set_query(None);
    base.set_fragment(None);
    let path = base.path().trim_end_matches('/').to_string();
    let origin = format!(
        "{}://{}{}",
        parsed.scheme(),
        parsed.host_str().unwrap_or_default(),
        match parsed.port() {
            Some(port) => format!(":{port}"),
            None => String::new(),
        }
    );
    let base = format!("{origin}{path}");
    if base.len() > 300 {
        return Err("地址太长了，检查一下是不是粘多了东西".into());
    }
    Ok(Target {
        origin,
        health: format!("{base}{HEALTH_PATH}"),
        url: base,
    })
}

/// 探活。成功返回服务端自报的身份，失败返回一句**能照着排查**的中文。
pub fn check(address: &str) -> Result<Probed, String> {
    let target = normalize(address)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .build();

    let response = match agent.get(&target.health).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(code, _)) => {
            return Err(format!(
                "{} 有响应，但 {HEALTH_PATH} 回的是 HTTP {code}：这个地址上不是 KYLAB 服务",
                target.origin
            ))
        }
        Err(ureq::Error::Transport(transport)) => {
            return Err(describe_transport(&target, &transport))
        }
    };

    let body = response
        .into_string()
        .map_err(|error| format!("{} 的响应读不出来：{error}", target.origin))?;
    let payload: serde_json::Value = serde_json::from_str(&body).map_err(|_| {
        format!(
            "{} 回的不是 KYLAB 的探针响应（拿到的不是 JSON）",
            target.origin
        )
    })?;

    let app = payload.get("app").and_then(|value| value.as_str()).unwrap_or("");
    if app != "kylab" {
        return Err(match app {
            "" => format!("{} 上没有 KYLAB 的探针响应：地址填错了吧", target.origin),
            other => format!("{} 上跑的不是 KYLAB（它自报 {other}）", target.origin),
        });
    }

    let api_version = payload
        .get("api_version")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if api_version != "v1" {
        return Err(format!(
            "这台 KYLAB 的接口版本是 {api_version}，而壳只认 v1：把 NAS 或壳升到配套的版本",
            api_version = if api_version.is_empty() { "未标注" } else { api_version }
        ));
    }

    Ok(Probed {
        app: app.to_string(),
        version: payload
            .get("version")
            .and_then(|value| value.as_str())
            .unwrap_or("未知")
            .to_string(),
        api_version: api_version.to_string(),
        origin: target.origin,
        url: target.url,
    })
}

/// 把底层网络错误翻译成"下一步该干什么"。
///
/// `ureq` 的 message 是英文且常常是 `os error 10061` 这种，直接摆给用户
/// 等于没说；但也不能把它丢掉——**看不懂的原始信息比没有信息强**，
/// 所以留在括号里，前面给出人话。
fn describe_transport(target: &Target, transport: &ureq::Transport) -> String {
    let raw = transport.message().unwrap_or("没有更多信息");
    let hint = match transport.kind() {
        ureq::ErrorKind::Dns => "域名解析不了：检查主机名拼写，或直接填 IP".to_string(),
        ureq::ErrorKind::ConnectionFailed => {
            "连接被拒绝：确认 NAS 开着、服务在跑，端口也没写错（默认 8000）".to_string()
        }
        ureq::ErrorKind::Io => {
            if target.origin.starts_with("https://") {
                "连接断开：如果 NAS 用的是自签名证书，壳不会替它跳过校验——换一张受信任的证书，或先用 http".to_string()
            } else {
                "连接中断：网络不稳定，或对端把连接掐了".to_string()
            }
        }
        _ => format!("网络错误：{raw}"),
    };
    format!("连不上 {}：{hint}", target.origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_in_http_when_scheme_is_missing() {
        let target = normalize("192.168.1.10:8080").expect("能认出裸地址");
        assert_eq!(target.origin, "http://192.168.1.10:8080");
        assert_eq!(target.health, "http://192.168.1.10:8080/api/v1/health");
        assert_eq!(target.url, "http://192.168.1.10:8080");
    }

    #[test]
    fn keeps_a_reverse_proxy_prefix() {
        let target = normalize("https://nas.example.com/kylab/").expect("带前缀也行");
        assert_eq!(target.origin, "https://nas.example.com");
        assert_eq!(target.url, "https://nas.example.com/kylab");
        assert_eq!(target.health, "https://nas.example.com/kylab/api/v1/health");
    }

    #[test]
    fn drops_query_and_fragment() {
        let target = normalize("http://nas:8000/?x=1#y").expect("问号井号丢掉");
        assert_eq!(target.url, "http://nas:8000");
    }

    #[test]
    fn rejects_other_schemes() {
        assert!(normalize("file:///etc/passwd").is_err());
        assert!(normalize("javascript:alert(1)").is_err());
    }

    #[test]
    fn rejects_credentials_in_the_address() {
        assert!(normalize("http://user:secret@nas:8000").is_err());
    }

    #[test]
    fn rejects_empty_input() {
        assert!(normalize("   ").is_err());
    }

    #[test]
    fn unreachable_port_says_what_to_check() {
        // 127.0.0.1:1 上不会有服务，这条走的是"连接被拒绝"那条分支
        let message = check("http://127.0.0.1:1").expect_err("应该失败");
        assert!(message.contains("连不上 http://127.0.0.1:1"), "{message}");
    }

    /// 与真后端对一次：`KYLAB_TEST_SERVER` 指到跑着的服务（默认本机 8000）。
    /// 没在跑就跳过——**这条不该让没起服务的机器红**。
    #[test]
    fn talks_to_a_real_server_when_one_is_running() {
        let address =
            std::env::var("KYLAB_TEST_SERVER").unwrap_or_else(|_| "http://127.0.0.1:8000".into());
        match check(&address) {
            Ok(probed) => {
                assert_eq!(probed.app, "kylab");
                assert_eq!(probed.api_version, "v1");
                assert!(!probed.version.is_empty());
            }
            Err(message) => {
                eprintln!("跳过：{address} 上没有跑着的 KYLAB（{message}）");
            }
        }
    }
}
