//! 壳的配置：**只存一个服务器地址**（外加最近用过的那几条）。
//!
//! 落在 `app_config_dir()/config.json`（Windows 是 `%APPDATA%\com.kylab.desktop\`）。
//! 手写读写而不是用 `tauri-plugin-store`：这里只有两个键，而"配置怎么不生效"
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
}

impl Config {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join("config.json")
    }

    /// 读配置。**读不出来就当没配过**（不 panic）：一个坏掉的配置文件不该让壳打不开，
    /// 用户还能在配置页里重新填一遍覆盖掉它。
    pub fn load(dir: &Path) -> Config {
        let path = Self::path(dir);
        let Ok(text) = fs::read_to_string(&path) else {
            return Config::default();
        };
        serde_json::from_str(&text).unwrap_or_else(|error| {
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
}
