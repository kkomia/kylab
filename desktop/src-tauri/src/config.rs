//! 壳的配置：**只存一个服务器地址**（外加最近用过的那几条、这台电脑的身份、
//! 以及替用户领到的长期凭据）。
//!
//! 落在 `app_config_dir()/config.json`（Windows 是 `%APPDATA%\com.kylab.desktop\`）。
//! 手写读写而不是用 `tauri-plugin-store`：这里只有几个键，而"配置怎么不生效"
//! 这类问题，一个肉眼可读、路径明确的 JSON 比插件的黑盒文件好排查。
//!
//! 一条纪律写在类型里：**地址只会被"用户主动改"这一个动作写掉**。
//! 启动时自动连接用的是配置里那份，连不上也不清空它——用户配过一次的地址，
//! 不该因为 NAS 那一刻没开机就被忘掉。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 最近使用的地址最多留几条。多了这一栏就会比输入框还长，反而找不到东西。
const MAX_RECENT: usize = 4;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Config {
    /// 用户配置的服务器地址。`None` = 还没配过，启动时进配置页。
    #[serde(default)]
    pub server: Option<String>,
    /// 用过的地址，最近的在前面。
    #[serde(default)]
    pub recent: Vec<String>,
    /// **这台电脑的身份**（UUID v4，见 `ensure_device_id`）：转发到服务器的每个
    /// `/api/**` 请求都带上它（`X-Kylab-Device`），服务器据此把多台电脑的工作区分开。
    ///
    /// 它跟 `server` / 钥匙都**没有关系**：改名、换服务器都不重新生成——
    /// 它是"这台电脑"的身份，不是"这条连接"的身份。老配置文件里没有这一栏
    /// （`serde(default)`），所以升级后照旧能读。
    #[serde(default)]
    pub device_id: Option<String>,
    /// **长期凭据**：桌面壳替用户领到的 API Key（`kylab_sk_…`）。
    ///
    /// 为什么是它而不是密码：会话令牌 7 天滑动续期，到期就得再登一次；而 API Key
    /// 是长期的那个（吊销在服务器的「API Keys」页），用户"配一次就一直用"。
    /// **密码一个字节都不落盘**（用户不该在配置文件里留下一份明文口令）。
    ///
    /// 明文落盘是**有意的**：这台机器的这个用户目录本来就是"装着它就等于有权限"的边界；
    /// 但**日志里绝不许出现它**（见 `main.rs` 里日志只写 id / 名字 / 前缀）。
    #[serde(default)]
    pub api_key: Option<String>,
    /// 钥匙的 id（`key_…`）：日志与界面用它来指认"是哪一把"。
    #[serde(default)]
    pub key_id: Option<String>,
    /// 钥匙的名字（领的时候填的，一般含主机名）。
    #[serde(default)]
    pub key_name: Option<String>,
    /// 领钥匙的那个账号（显示名优先，退回用户名）：只用于界面上说"你是谁"。
    #[serde(default)]
    pub user_name: Option<String>,
}

impl Config {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join("config.json")
    }

    /// **这份配置里有能用的长期凭据吗**（而且是给这一个源的）。
    ///
    /// 比对 `server` 而不是另加一个 `key_origin` 字段：地址与钥匙本来就是一起配的
    /// （换服务器要重新领钥匙），多一个字段就多一处可能不一致的状态。
    pub fn has_key_for(&self, origin: &str) -> bool {
        self.api_key.is_some() && self.server.as_deref() == Some(origin)
    }

    /// 记下刚领到的钥匙（**不碰 `server`**：那是 `remember` 的事）。
    pub fn remember_key(
        &mut self,
        key_id: &str,
        key_name: &str,
        user_name: &str,
        api_key: &str,
    ) {
        self.key_id = Some(key_id.to_string());
        self.key_name = Some(key_name.to_string());
        self.user_name = Some(user_name.to_string());
        self.api_key = Some(api_key.to_string());
    }

    /// 读配置。**读不出来就当没配过**（不 panic）：一个坏掉的配置文件不该让壳打不开，
    /// 用户还能在配置页里重新填一遍覆盖掉它。
    ///
    /// **BOM 要先剥掉**（这一次实测踩到）：托盘的「配置与日志」会把目录打开给用户，
    /// 而 Windows 记事本存 UTF-8 默认带 BOM；`serde_json::from_str` 见到 BOM 直接报错，
    /// 于是"我明明填了地址，壳却说没配过"——而配置页里地址栏是空的，用户只能再填一遍。
    pub fn load(dir: &Path) -> Config {
        let path = Self::path(dir);
        let Ok(text) = fs::read_to_string(&path) else {
            return Config::default();
        };
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        serde_json::from_str(text).unwrap_or_else(|error| {
            crate::logfile::log(dir, &format!("配置文件读不出来（{error}），按没配过处理：{}", path.display()));
            Config::default()
        })
    }

    /// 写配置。**先写临时文件再改名**：直接覆盖的话，写到一半断电会留下一个
    /// 半截的 JSON，下次启动就读不出来了。
    pub fn save(&self, dir: &Path) -> io::Result<()> {
        fs::create_dir_all(dir)?;
        let target = Self::path(dir);
        let temporary = target.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_string_pretty(self)? + "\n")?;
        fs::rename(&temporary, &target)
    }

    /// 用户主动改地址时走这里：写进配置，并把它挪到「最近使用」的第一位。
    pub fn remember(&mut self, server: &str) {
        self.server = Some(server.to_string());
        self.recent.retain(|item| item != server);
        self.recent.insert(0, server.to_string());
        self.recent.truncate(MAX_RECENT);
    }

    /// **确保这台电脑有身份**：没有就生成一个 UUID v4。
    ///
    /// 返回 `true` = 这次是新生成的（调用方**必须落盘**，否则下次启动又换一个，
    /// 服务器那边就会把同一台电脑看成一串不同的电脑）。已经有则原样返回 `false`
    /// ——**绝不覆盖**：换服务器、换账号、重装钥匙都还是这台电脑。
    pub fn ensure_device_id(&mut self) -> bool {
        if self.device_id.as_deref().is_some_and(|id| !id.trim().is_empty()) {
            return false;
        }
        self.device_id = Some(uuid::Uuid::new_v4().to_string());
        true
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kylab-desktop-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn roundtrip_keeps_the_same_server() {
        let dir = temp_dir("roundtrip");
        let mut config = Config::default();
        config.remember("http://192.168.1.10:8080");
        config.save(&dir).expect("写配置");
        let loaded = Config::load(&dir);
        assert_eq!(loaded.server.as_deref(), Some("http://192.168.1.10:8080"));
        assert_eq!(loaded.recent, vec!["http://192.168.1.10:8080"]);
    }

    #[test]
    fn missing_file_means_not_configured_yet() {
        let dir = temp_dir("missing");
        assert!(Config::load(&dir).server.is_none());
    }

    #[test]
    fn broken_file_is_treated_as_not_configured() {
        let dir = temp_dir("broken");
        fs::create_dir_all(&dir).unwrap();
        fs::write(Config::path(&dir), "{ 这不是 JSON").unwrap();
        assert!(Config::load(&dir).server.is_none());
    }

    /// **带 BOM 的配置也要能读**（2026-09-29 实测：Windows 记事本存 UTF-8 会加 BOM，
    /// 而 `serde_json::from_str` 见到 BOM 直接报错 → 用户填的地址像凭空消失了）。
    #[test]
    fn a_config_file_with_a_bom_is_still_read() {
        let dir = temp_dir("bom");
        fs::create_dir_all(&dir).unwrap();
        let body = "{\"server\":\"http://192.168.1.10:8000\",\"recent\":[]}";
        fs::write(Config::path(&dir), format!("\u{feff}{body}")).unwrap();
        assert_eq!(
            Config::load(&dir).server.as_deref(),
            Some("http://192.168.1.10:8000")
        );
    }

    #[test]
    fn recent_is_deduped_and_newest_first() {
        let mut config = Config::default();
        for address in ["a", "b", "c", "a"] {
            config.remember(address);
        }
        assert_eq!(config.recent, vec!["a", "c", "b"]);
        assert_eq!(config.server.as_deref(), Some("a"));
    }

    #[test]
    fn recent_is_capped() {
        let mut config = Config::default();
        for index in 0..(MAX_RECENT + 3) {
            config.remember(&format!("http://host-{index}"));
        }
        assert_eq!(config.recent.len(), MAX_RECENT);
        assert_eq!(config.recent[0], format!("http://host-{}", MAX_RECENT + 2));
    }

    /// **老配置文件必须照旧能读**：升级前写的 `config.json` 里没有钥匙那几栏，
    /// 这时不能因为"缺字段"就把用户填过的地址一起丢掉（`#[serde(default)]` 就是为它）。
    #[test]
    fn an_old_config_without_the_key_fields_still_loads() {
        let dir = temp_dir("old-config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            Config::path(&dir),
            r#"{"server":"http://192.168.1.10:8000","recent":["http://192.168.1.10:8000"]}"#,
        )
        .unwrap();

        let loaded = Config::load(&dir);
        assert_eq!(loaded.server.as_deref(), Some("http://192.168.1.10:8000"));
        assert!(loaded.api_key.is_none());
        assert!(loaded.key_id.is_none());
        assert!(loaded.key_name.is_none());
        assert!(loaded.user_name.is_none());
        // 设备身份那一栏也是后加的：老配置里没有它，不能因此读不出来（`serde(default)`）
        assert!(loaded.device_id.is_none());
        assert!(!loaded.has_key_for("http://192.168.1.10:8000"));
    }

    #[test]
    fn a_key_round_trips_and_is_tied_to_its_origin() {
        let dir = temp_dir("key-roundtrip");
        let mut config = Config::default();
        config.remember("http://nas:8000");
        config.remember_key("key_abc", "桌面端 NAS", "小又", "kylab_sk_secret");
        config.save(&dir).expect("写配置");

        let loaded = Config::load(&dir);
        assert_eq!(loaded.api_key.as_deref(), Some("kylab_sk_secret"));
        assert_eq!(loaded.key_id.as_deref(), Some("key_abc"));
        assert_eq!(loaded.key_name.as_deref(), Some("桌面端 NAS"));
        assert_eq!(loaded.user_name.as_deref(), Some("小又"));
        // 只认配它的那一个源：换了服务器就得重新领（免得把 A 的钥匙发给 B）
        assert!(loaded.has_key_for("http://nas:8000"));
        assert!(!loaded.has_key_for("http://other:8000"));
    }

    /// **密码不许落盘**：类型里就没有 `password` 这一栏，这条测试钉住这个事实
    /// （有人"顺手"加一栏存密码时，它应该红）。
    #[test]
    fn the_config_never_contains_a_password_field() {
        let mut config = Config::default();
        config.remember("http://nas:8000");
        config.remember_key("key_abc", "桌面端 NAS", "小又", "kylab_sk_secret");
        let text = serde_json::to_string(&config).expect("能序列化");
        assert!(!text.contains("password"), "{text}");
    }

    /// 设备身份要能**原样往返**：服务器就是拿它当"这台电脑"的键，
    /// 每次启动读出来的值不一样 = 每次启动都是一台新电脑（工作区分家）。
    #[test]
    fn the_device_id_round_trips() {
        let dir = temp_dir("device-roundtrip");
        let mut config = Config::default();
        config.ensure_device_id();
        let generated = config.device_id.clone().expect("生成了设备 id");
        config.save(&dir).expect("写配置");

        let loaded = Config::load(&dir);
        assert_eq!(loaded.device_id.as_deref(), Some(generated.as_str()));
        // UUID v4：`8-4-4-4-12` 的十六进制（**别用主机名代替**：同型号机器的默认名会撞）
        assert_eq!(generated.len(), 36, "{generated}");
        assert_eq!(generated.matches('-').count(), 4, "{generated}");
    }

    /// **生成一次就不再变**：第二次调用不该换一个新的（换服务器/换账号也一样）。
    #[test]
    fn the_device_id_is_generated_once_and_never_replaced() {
        let mut config = Config::default();
        assert!(config.ensure_device_id(), "第一次应当生成");
        let first = config.device_id.clone().unwrap();
        assert!(!config.ensure_device_id(), "第二次不该再生成");
        assert_eq!(config.device_id.as_deref(), Some(first.as_str()));

        // 手改过地址也不影响它
        config.remember("http://other:8000");
        assert!(!config.ensure_device_id());
        assert_eq!(config.device_id.as_deref(), Some(first.as_str()));
        // 空串（有人手改成 `""`）按"没有"算，重新生成一个能用的
        config.device_id = Some("  ".to_string());
        assert!(config.ensure_device_id());
        assert_ne!(config.device_id.as_deref(), Some("  "));
    }
}
