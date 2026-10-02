//! 壳的配置：**只存一个服务器地址**（外加最近用过的那几条、这台电脑的身份）。
//!
//! 落在 `app_config_dir()/config.json`（Windows 是 `%APPDATA%\com.kylab.desktop\`）。
//!
//! **长期凭据不在这里了**（M5 阶段 6B）：那把钥匙的家是系统钥匙串
//! （`kylab:nas_token:<归一化地址>`，见 `secrets` 模块）。`api_key` 那一栏**留着**是为了
//! 读得动老配置——首次运行会把它迁进钥匙串并清掉（见 [`Config::migrate_api_key`]），
//! 迁完之后它恒空。
//!
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
    /// **这一栏现在只是"老配置还读得动"**（M5 阶段 6B）：钥匙的家是系统钥匙串
    /// （`kylab:nas_token:<归一化地址>`）。首次运行会把它迁进去并清掉这一栏
    /// （[`Config::migrate_api_key`]）；迁移**写不进钥匙串时它原样留着**——宁可留着
    /// 明文也不让用户丢钥匙（下次启动再试）。**日志里绝不许出现它**（见 `main.rs`
    /// 里日志只写 id / 名字 / 前缀）。
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

/// 老明文收编的结果（见 [`Config::migrate_api_key`]）。
///
/// 用类型而不是一个 `bool`：日志与用例都要能分清"迁了 / 钥匙串里本来就是同一把 /
/// 钥匙串里那把不一样 / 写不进去"，而这四种在用户那边是三件不同的事
/// （无事发生 / 已收编 / 丢了一次收编机会）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Migration {
    /// 配置里本来就没有明文（或只有空白）：**什么都没做**——幂等的那一半。
    Nothing,
    /// 这次搬进钥匙串了。
    Moved,
    /// 钥匙串里已经是同一个值：只清掉配置那一栏，**不重写**钥匙串里那份。
    AlreadyStored,
    /// 钥匙串里有一份**不一样**的：以钥匙串为准，只清掉配置那一栏，**不覆盖**。
    KeychainWins,
    /// 配置里有明文但**没有地址**（或地址拼不出名字）：这次不迁，明文原样留着。
    NoOrigin,
    /// 写不进钥匙串：**配置那一栏原样留着**，下次启动再试（理由如实说）。
    Failed(String),
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

    /// **首次运行把老明文搬进系统钥匙串**（M5 阶段 6B，方案 §4.2 #1）。
    ///
    /// 顺序与 Python 侧逐条对齐（`CredentialsService._move`）：**先写钥匙串、后清配置**。
    /// 反过来的话，一次崩在中间就永久丢了一把钥匙（而"配置里还有明文"至少是可重跑的状态）。
    ///
    /// 三条硬要求各自落在哪里：
    ///
    /// - **幂等**：配置里没有明文时第一步就返回 [`Migration::Nothing`]（**一个字节都不写**）；
    ///   钥匙串里已经是同一个值时走 [`Migration::AlreadyStored`]（**不重写**那把钥匙）——
    ///   每次启动都会跑这一下，第二次之后走的都是这两支；
    /// - **写失败就不清明文**：[`Migration::Failed`] 那一支**不碰 `api_key`、不落盘**。
    ///   静默清掉等于用户那把钥匙没了，而钥匙串里什么都没有；
    /// - **`api_key` 字段留在结构里**：老配置照旧读得出来，只是迁完之后恒空。
    ///
    /// 为什么不把它塞进 [`Config::load`]：`load` 是"读一个文件"的纯函数（很多用例在调它，
    /// 其中就有带着明文的配置文件），而这一步要**注入一个钥匙串**、会**写盘**、还会**动系统**。
    /// 分开之后，"迁移"这件事只有一个入口（`main.rs` 启动那一步）。
    pub fn migrate_api_key(
        &mut self,
        dir: &Path,
        store: &dyn crate::secrets::SecretStore,
    ) -> Migration {
        let plaintext = self.api_key.as_deref().unwrap_or_default().trim().to_string();
        if plaintext.is_empty() {
            // 空串不是秘密（与 Python 侧 `_items` 同一条）：这一支是**每次启动**都会走的
            return Migration::Nothing;
        }
        let server = self.server.as_deref().unwrap_or_default().trim().to_string();
        let Ok(target) = crate::secrets::nas_token_target(&server) else {
            // 有钥匙却没有地址（或地址是空的）：名字拼不出来，**明文原样留着**
            return Migration::NoOrigin;
        };

        let outcome = match store.get(&target) {
            // 钥匙串里已经是同一个值：上一次迁过了，只剩配置里这份重复的
            Some(current) if current == plaintext => Migration::AlreadyStored,
            // 钥匙串里有一份**不一样**的：用户在这之后又改过（新值只落钥匙串），
            // 所以以钥匙串为准，配置里这份是旧的——**不覆盖**（那会把用户的新值抹掉）
            Some(_) => Migration::KeychainWins,
            None => match store.set(&target, &plaintext) {
                Ok(()) => Migration::Moved,
                // 写不进去：**明文原样留着**，如实报，下次启动再试
                Err(reason) => return Migration::Failed(reason),
            },
        };

        // 走到这里：钥匙串里已经有一份能用的（刚写的，或本来就在的）→ 才动配置那一栏
        self.api_key = None;
        if let Err(error) = self.save(dir) {
            // 盘上那份明文这次没清掉：下次启动会再走一遍（幂等），这里如实记一行
            crate::logfile::log(
                dir,
                &format!(
                    "钥匙已进系统钥匙串，但配置写不进去（{error}）：config.json 里那份明文这次没清掉"
                ),
            );
        }
        outcome
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    // 用例用的假钥匙串（真凭据管理器给不了"写不进去""已经有一份别的"这些状态）
    use crate::secrets::fake::InMemoryStore;

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

    // ---------------------------------------------------------------- 老明文收编（6B）

    /// 一份"升级前"的配置：`api_key` 那一栏里躺着明文（老壳留下的那种）。
    ///
    /// `name` 每个用例各给一个：`temp_dir` 是按名字建的目录，**重名就会互相踩**
    /// （用例是并行跑的，同一个目录里后跑的那个会把前一个的文件删掉）。
    fn an_old_config_with_a_plaintext_key(name: &str) -> (PathBuf, Config) {
        let dir = temp_dir(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            Config::path(&dir),
            "{\"server\":\"http://nas:8090\",\"recent\":[\"http://nas:8090\"],\
             \"api_key\":\"kylab_sk_明文\",\"key_id\":\"key_abc\",\
             \"key_name\":\"桌面端 NAS\",\"user_name\":\"小又\"}",
        )
        .unwrap();
        let config = Config::load(&dir);
        assert_eq!(config.api_key.as_deref(), Some("kylab_sk_明文"), "读得出老明文");
        (dir, config)
    }

    /// 老配置里那把明文钥匙：**首启动迁进钥匙串、配置里那一栏清掉**。
    #[test]
    fn the_plaintext_key_is_migrated_into_the_keychain_and_cleared() {
        let (dir, mut config) = an_old_config_with_a_plaintext_key("migrate-moved");
        let store = InMemoryStore::new();

        let outcome = config.migrate_api_key(&dir, &store);

        assert_eq!(outcome, Migration::Moved, "{outcome:?}");
        assert!(config.api_key.is_none(), "迁完配置里那一栏该是空的");
        assert_eq!(
            store.names(),
            vec!["kylab:nas_token:http://nas:8090".to_string()],
            "名字就是两侧共用的那一条规则"
        );
        assert_eq!(
            store.value("kylab:nas_token:http://nas:8090").as_deref(),
            Some("kylab_sk_明文")
        );
        // 磁盘上那份也清了（"迁完还留一份明文"= 收编白做）
        let on_disk = fs::read_to_string(Config::path(&dir)).unwrap();
        assert!(!on_disk.contains("kylab_sk_明文"), "{on_disk}");
        // 别的几栏一个都没动
        let reloaded = Config::load(&dir);
        assert_eq!(reloaded.server.as_deref(), Some("http://nas:8090"));
        assert_eq!(reloaded.key_id.as_deref(), Some("key_abc"));
        assert_eq!(reloaded.key_name.as_deref(), Some("桌面端 NAS"));
        assert_eq!(reloaded.user_name.as_deref(), Some("小又"));
    }

    /// **幂等**：再跑一次是 no-op——不重写钥匙串里那把、配置那一栏还是空。
    #[test]
    fn the_migration_is_idempotent_and_never_rewrites() {
        let (dir, mut config) = an_old_config_with_a_plaintext_key("migrate-idempotent");
        let store = InMemoryStore::new();

        assert_eq!(config.migrate_api_key(&dir, &store), Migration::Moved);
        let writes = store.writes();

        // 第二次启动：配置里已经空了 → **一个字节都不写**
        assert_eq!(config.migrate_api_key(&dir, &store), Migration::Nothing);
        assert_eq!(store.writes(), writes, "不该重写钥匙串");
        assert_eq!(
            store.value("kylab:nas_token:http://nas:8090").as_deref(),
            Some("kylab_sk_明文")
        );

        // 手改回配置里还有同一份明文（上一次"写完钥匙串、还没清盘"那一刻崩了）：
        // 也不重写，只把这份重复的清掉
        config.api_key = Some("kylab_sk_明文".to_string());
        assert_eq!(config.migrate_api_key(&dir, &store), Migration::AlreadyStored);
        assert_eq!(store.writes(), writes, "同一个值不该再写一次");
        assert!(config.api_key.is_none(), "这份重复的要清掉");
        let on_disk = fs::read_to_string(Config::path(&dir)).unwrap();
        assert!(!on_disk.contains("kylab_sk_明文"), "{on_disk}");
    }

    /// **写不了就别清明文**（R4 那条）：如实失败、`api_key` 原样留着、盘上那份也在
    /// ——"不清就不算迁完"，用户下次启动还能用（而不是钥匙没了、钥匙串里也没有）。
    #[test]
    fn a_failed_keychain_write_leaves_the_plaintext_alone() {
        let (dir, mut config) = an_old_config_with_a_plaintext_key("migrate-failed");
        // 这台机器没有可用的钥匙串（Linux 桌面 / 容器 / CI 就是这一档）：`set` 明确失败
        let store = InMemoryStore::unavailable();

        let reason = match config.migrate_api_key(&dir, &store) {
            Migration::Failed(reason) => reason,
            other => panic!("应当如实失败（写不进钥匙串）：{other:?}"),
        };

        assert!(reason.contains("钥匙串"), "失败要说得出理由：{reason}");
        assert_eq!(
            config.api_key.as_deref(),
            Some("kylab_sk_明文"),
            "明文要原样留着"
        );
        let on_disk = fs::read_to_string(Config::path(&dir)).unwrap();
        assert!(on_disk.contains("kylab_sk_明文"), "盘上那份也不许清：{on_disk}");
        assert!(store.names().is_empty(), "什么都没写进去");
    }

    /// 钥匙串里已有一份**不一样**的（用户在这之后改过）：以钥匙串为准，**不覆盖**。
    #[test]
    fn a_keychain_value_wins_over_the_stale_plaintext() {
        let (dir, mut config) = an_old_config_with_a_plaintext_key("migrate-keychain-wins");
        let store = InMemoryStore::new();
        store.seed("kylab:nas_token:http://nas:8090", "kylab_sk_新的");

        let outcome = config.migrate_api_key(&dir, &store);

        assert_eq!(outcome, Migration::KeychainWins, "{outcome:?}");
        assert_eq!(store.writes(), 0, "**不许覆盖**钥匙串里那把新的");
        assert_eq!(
            store.value("kylab:nas_token:http://nas:8090").as_deref(),
            Some("kylab_sk_新的")
        );
        assert!(config.api_key.is_none(), "配置里那份旧的清掉");
    }

    /// 没有地址（或地址是空的）：名字拼不出来 → **不迁**，明文原样留着；没有明文时
    /// 是彻底的 no-op（**每次启动都会走这一支**，所以它连一个文件都不该写）。
    #[test]
    fn a_key_without_an_address_is_not_migrated() {
        let dir = temp_dir("migrate-no-origin");
        fs::create_dir_all(&dir).unwrap();
        let store = InMemoryStore::new();
        let mut config = Config::default();
        config.api_key = Some("kylab_sk_明文".to_string());

        assert_eq!(config.migrate_api_key(&dir, &store), Migration::NoOrigin);
        assert_eq!(config.api_key.as_deref(), Some("kylab_sk_明文"));
        assert!(store.names().is_empty());
        assert!(!Config::path(&dir).exists(), "什么都没写");

        config.api_key = None;
        assert_eq!(config.migrate_api_key(&dir, &store), Migration::Nothing);
        assert!(!Config::path(&dir).exists(), "没明文时也不该写盘");
        // 空白串不算秘密（有人手改成 `""`）
        config.api_key = Some("   ".to_string());
        assert_eq!(config.migrate_api_key(&dir, &store), Migration::Nothing);
    }
}
