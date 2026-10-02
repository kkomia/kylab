//! 系统钥匙串（Windows 凭据管理器）：**壳手里那把长期钥匙的家**（M5 阶段 6B）。
//!
//! ```text
//! 迁移：config.json 里那份老明文 ──写──▶ kylab:nas_token:<归一化地址>
//! 读：  起边车要 token 那一刻     ──读──▶ 同上（读不到才回落 config.json 那一栏）
//! ```
//!
//! ## 与后端那一半是**同一条规则的两份实现**（`backend/app/services/secrets.py`）
//!
//! 两边逐字对齐；差一个字符，另一侧读到的就是"没配"（**静默**，表现为"用户那把钥匙不见了"）：
//!
//! | 那一项 | 值 |
//! | --- | --- |
//! | 名字 | `kylab:nas_token:<normalize_origin(地址)>` |
//! | Type | `CRED_TYPE_GENERIC`（1） |
//! | UserName / Comment | `kylab` |
//! | Blob | **UTF-8 明文**，≤ 2560 字节（超了如实拒，**不截断**） |
//! | Persist | `CRED_PERSIST_LOCAL_MACHINE`（本机跨登录会话都读得到，**不漫游**：换机器要重配） |
//!
//! 对拍的两条（阶段 8 的物证，用例见 `the_shell_and_the_backend_agree_on_the_same_entry`）：
//!
//! ```text
//! cargo test --quiet the_shell_and_the_backend_agree    # 两侧各写一次、另一侧读一次
//! python -m app.services.credentials nas-token --origin http://nas:8090 --show
//! ```
//!
//! ## 三条口径（与 Python 侧逐条对应）
//!
//! 1. **读不到 = 没配**（`get` 回 `None`）：**绝不回退到别处去读明文**。回退会让"收编"
//!    这件事白做——同一把钥匙有了两个家，"哪一份是新的"迟早分叉；
//! 2. **写不了 = 明确失败**（`set` 回 `Err`）：**绝不静默把钥匙写回 `config.json`**。
//!    这一条是"迁移失败就不清明文"的判据（见 `config::Config::migrate_api_key`）；
//! 3. **不缓存**：四条操作每次都问系统。缓存了就会出现"用户已经在服务器那边吊销了钥匙，
//!    壳还拿着一份旧的"。
//!
//! ## 为什么用 `windows` 而不是 `keyring`
//!
//! 与 Python 侧"不引 `keyring` 包"同一条理由（闭包不涨），而这边更省：`windows` 本来就在
//! 依赖树里（Job Object 那一块在用），这里**只加一个 feature，一个新包都不拉**。
//! 四个入口与 Python 侧 `_advapi32()` 一一对应（`CredWriteW` / `CredReadW` /
//! `CredDeleteW` / `CredFree`）。

/// 那一条凭据的名字前缀（`kylab:<用途>:<对象 id>`，与 Python 侧 `TARGET_PREFIX` 同值）。
///
/// 前缀是刻意的：用户的凭据管理器里通常还躺着几十条别人的东西，而 `cmdkey /list` 与
/// "控制面板 → 凭据管理器"都按名字排——前缀让"哪些是我们写的"一眼可辨。
pub const TARGET_PREFIX: &str = "kylab";

/// 那条凭据的 `UserName` / `Comment`（凭据管理器界面上显示的名字，不是账号）。
pub const USER_NAME: &str = "kylab";

/// 单条秘密的容量上限：Windows 凭据管理器 `CRED_MAX_CREDENTIAL_BLOB_SIZE`（5 × 512）。
///
/// **超了如实拒，绝不截断**（截断后写进去的是一把坏钥匙，而用户看到的是"配好了"）。
pub const MAX_BLOB_BYTES: usize = 2560;

/// 用途那一段：NAS 长期钥匙（名字里不带 "token" 之外的东西，与 Python 侧 `_KIND_NAS` 同值）。
const KIND_NAS: &str = "nas_token";

/// 可用性探针读的那个名字：**只读**它，从不写（`CredReadW` 不创建任何东西）。
const PROBE_TARGET: &str = "kylab:availability";

/// 拼一条凭据的名字：`kylab:<用途>:<对象 id>`（**唯一一处拼接**，与 Python 侧同名函数对应）。
///
/// 两段都不能空；"用途"那一段不许含 `:`（它是分隔符），而**对象 id 里的 `:` 是允许的**
/// ——NAS 地址本来就有端口（`http://nas:8090`），名字只拼不拆。
fn target_name(kind: &str, object_id: &str) -> Result<String, String> {
    let kind = kind.trim();
    let object_id = object_id.trim();
    if kind.is_empty() || object_id.is_empty() {
        return Err("凭据名字的两段都不能空（kylab:<用途>:<对象 id>）".to_string());
    }
    if kind.contains(':') {
        return Err("凭据名字里的「用途」那一段不能含 ':'（它是分隔符）".to_string());
    }
    Ok(format!("{TARGET_PREFIX}:{kind}:{object_id}"))
}

/// NAS 长期钥匙的名字：`kylab:nas_token:<origin>`。
pub fn nas_token_target(origin: &str) -> Result<String, String> {
    let cleaned = normalize_origin(origin);
    if cleaned.is_empty() {
        return Err("NAS 地址不能为空（凭据名字里要有它）".to_string());
    }
    target_name(KIND_NAS, &cleaned)
}

/// 把"NAS 地址"归一成名字里的 `<origin>` 那一段（**壳与后端同一条规则**，见 Python 侧同名函数）。
///
/// - 去掉两端空白与末尾的 `/`；
/// - **有 scheme 时**：`scheme://host[:port]`（丢掉 path；scheme 与 host 小写）——于是
///   `http://nas:8090/api/v1`、`http://nas:8090/`、`HTTP://NAS:8090` 是**同一把钥匙**
///   （同一个 NAS 的三种写法，各存一份会让用户改了一处、另一处还是旧的）；
/// - **没有 scheme 时**：整串小写（`nas:8090`）——**不替用户补 `http://`**：补了就会与
///   "壳里填的是什么"分叉，而钥匙串里那一条是按壳填的那个串找的。
///
/// "有 scheme" 的判据照着 Python `urlsplit` 那条走：**scheme 与 netloc 都得有**才算数
/// （`nas:8090` 在 urlsplit 眼里 scheme 是 `nas`、netloc 是空，于是落到"整串小写"那一支）。
pub fn normalize_origin(raw: &str) -> String {
    let text = raw.trim().trim_end_matches('/');
    if text.is_empty() {
        return String::new();
    }
    if let Some((scheme, rest)) = text.split_once("://") {
        if !scheme.is_empty() {
            // 丢掉 path / query / fragment：`netloc` 那一段到第一个分隔符为止
            let host = rest
                .split(['/', '?', '#'])
                .next()
                .unwrap_or_default()
                .trim();
            if !host.is_empty() {
                return format!("{}://{}", scheme.to_lowercase(), host.to_lowercase());
            }
        }
    }
    text.to_lowercase()
}

/// 一处「秘密来源」（与 Python 侧 `SecretStore` 协议、以及那三个实现一一对应）。
///
/// 抽成 trait 是为了**能注入**：迁移那三条硬要求（幂等、不许覆盖、写不了就别清明文）
/// 只有在"能构造出写失败 / 已经有一条"的假实现时才钉得住，而真的凭据管理器给不了这些状态。
/// 生产路径上唯一的实现是 [`Keychain`]。
pub trait SecretStore {
    /// 这台机器现在有没有可用的系统钥匙串。
    fn available(&self) -> bool;

    /// 读一条；**`None` = 没配**（含"读失败"与"这把钥匙串用不上"，与第一条口径一致）。
    fn get(&self, name: &str) -> Option<String>;

    /// 写一条；不可用时回 `Err`（**绝不落明文到别处**）。空值等价于 [`SecretStore::delete`]。
    fn set(&self, name: &str, value: &str) -> Result<(), String>;

    /// 删一条；本来就没有也算成功（**幂等**：迁移与"清除凭据"都会重跑）。
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// 这台机器上的系统钥匙串：Windows 是凭据管理器，别的平台是"这里没有它"。
///
/// 一个零大小的类型：四条操作每次都去问系统，没有要留的状态（见第三条口径"不缓存"）。
pub struct Keychain;

#[cfg(windows)]
impl SecretStore for Keychain {
    fn available(&self) -> bool {
        // 探一次读。`CredReadW` **只读不创建**，所以这个探针是幂等的、也不会在用户的
        // 凭据管理器里留下任何东西；"没有这一条"（ERROR_NOT_FOUND）恰恰是**健康**的证据
        // ——只有真出错才算不可用（与 Python 侧 `_PROBE_TARGET` 同一手法）。
        read(PROBE_TARGET).is_ok()
    }

    fn get(&self, name: &str) -> Option<String> {
        // 读不到 = 没配：真出错的那一支也回 `None`（**不回退去别处读明文**）。
        read(name).ok().flatten()
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        if value.is_empty() {
            // 空值不是秘密：与 delete 是同一件事（与 Python 侧一致）
            return self.delete(name);
        }
        let data = value.as_bytes();
        if data.len() > MAX_BLOB_BYTES {
            return Err(format!(
                "这条秘密有 {} 字节，超过钥匙串单条的上限 {MAX_BLOB_BYTES} 字节：请换一条更短的凭据（**不会截断后写进去**）",
                data.len()
            ));
        }

        let mut target = wide(name);
        let mut comment = wide(TARGET_PREFIX);
        let mut user = wide(USER_NAME);
        let mut blob = data.to_vec();
        let credential = windows::Win32::Security::Credentials::CREDENTIALW {
            Type: windows::Win32::Security::Credentials::CRED_TYPE_GENERIC,
            TargetName: windows::core::PWSTR(target.as_mut_ptr()),
            Comment: windows::core::PWSTR(comment.as_mut_ptr()),
            // Blob 就是**明文 UTF-8**（Python 侧同一个字节布局，对拍靠这一条）
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            // 本机档：跨登录会话都读得到，但不漫游（与 Python 侧同一个值）
            Persist: windows::Win32::Security::Credentials::CRED_PERSIST_LOCAL_MACHINE,
            UserName: windows::core::PWSTR(user.as_mut_ptr()),
            ..Default::default()
        };
        unsafe { windows::Win32::Security::Credentials::CredWriteW(&credential, 0) }
            .map_err(|error| format!("写不进系统钥匙串（{name}）：{error}"))
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        let target = wide(name);
        match unsafe {
            windows::Win32::Security::Credentials::CredDeleteW(
                windows::core::PCWSTR(target.as_ptr()),
                windows::Win32::Security::Credentials::CRED_TYPE_GENERIC,
                None,
            )
        } {
            Ok(()) => Ok(()),
            // 本来就没有：幂等（迁移器与"清除凭据"都会重跑）
            Err(error) if is_not_found(&error) => Ok(()),
            Err(error) => Err(format!("删不掉系统钥匙串里的这一条（{name}）：{error}")),
        }
    }
}

#[cfg(not(windows))]
impl SecretStore for Keychain {
    fn available(&self) -> bool {
        false
    }

    fn get(&self, _name: &str) -> Option<String> {
        // 读不到 = 没配（这台机器上"没有钥匙串"与"没配"在**读**这条路径上是同一件事）
        None
    }

    fn set(&self, _name: &str, _value: &str) -> Result<(), String> {
        Err("这台机器没有可用的系统钥匙串（Windows 凭据管理器）：写不进去**也不会**退回去写明文"
            .to_string())
    }

    fn delete(&self, _name: &str) -> Result<(), String> {
        Err("这台机器没有可用的系统钥匙串（Windows 凭据管理器）：没有可删的东西".to_string())
    }
}

/// 读一条，三种结果分得开：`Ok(Some)` 有、`Ok(None)` 没这一条、`Err` **真出错**。
///
/// 这个区分只有内部看得见（对外 `get` 把后两者都算"没配"），但 `available()` 的探针
/// 判据靠它——把"没有这一条"当成不可用，就恰好写反了。
#[cfg(windows)]
fn read(name: &str) -> Result<Option<String>, String> {
    use windows::Win32::Security::Credentials::{CredFree, CredReadW, CREDENTIALW};

    let target = wide(name);
    let mut pointer: *mut CREDENTIALW = std::ptr::null_mut();
    if let Err(error) = unsafe {
        CredReadW(
            windows::core::PCWSTR(target.as_ptr()),
            windows::Win32::Security::Credentials::CRED_TYPE_GENERIC,
            None,
            &mut pointer,
        )
    } {
        if is_not_found(&error) {
            return Ok(None);
        }
        return Err(format!("读不了系统钥匙串里的这一条（{name}）：{error}"));
    }
    if pointer.is_null() {
        return Ok(None);
    }
    let raw = unsafe {
        let credential = &*pointer;
        let size = credential.CredentialBlobSize as usize;
        if size == 0 || credential.CredentialBlob.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(credential.CredentialBlob, size).to_vec()
        }
    };
    // 这块内存是 API 分配的，只能由 CredFree 释放（**不能用 free**）
    unsafe { CredFree(pointer as *const std::ffi::c_void) };
    // 不是 UTF-8 串（别人往同一个名字里塞了别的东西）→ 当没配（与 Python 侧一致）
    Ok(String::from_utf8(raw).ok())
}

/// `ERROR_NOT_FOUND`（1168）：**没有这一条**——它不是错误，是"没配"。
#[cfg(windows)]
fn is_not_found(error: &windows::core::Error) -> bool {
    error.code()
        == windows::core::HRESULT::from_win32(
            windows::Win32::Foundation::ERROR_NOT_FOUND.0,
        )
}

/// 字符串 → 以 NUL 结尾的 UTF-16（Win32 的宽字符入参）。
#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
pub(crate) mod fake {
    //! 用例用的假钥匙串（**只给用例**）：一个在内存里的实现 + 一个"用不了"的实现。
    //!
    //! 为什么值得一个有状态的实现：迁移那几条判据（幂等、不许覆盖、写不了就别清明文）
    //! 都要"能读出上一次写了什么、写了几次"，而这正是真实现里最难在 CI 上覆盖的部分
    //! （对应 Python 侧的 `InMemorySecretStore`）。

    use super::SecretStore;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// 内存里的钥匙串。`new()` 是能用的那一档，`unavailable()` 是"这台机器没有它"那一档。
    #[derive(Default)]
    pub struct InMemoryStore {
        values: Mutex<HashMap<String, String>>,
        /// **写了几次**（"不许重复写"这条只能靠它钉：值一样看不出来写没写）。
        writes: Mutex<usize>,
        available: bool,
    }

    impl InMemoryStore {
        pub fn new() -> Self {
            Self {
                available: true,
                ..Self::default()
            }
        }

        pub fn unavailable() -> Self {
            Self::default()
        }

        /// 直接塞一条（模拟"这台机器上早就配过一把"）。
        pub fn seed(&self, name: &str, value: &str) {
            self.values
                .lock()
                .expect("锁没被污染")
                .insert(name.to_string(), value.to_string());
        }

        pub fn value(&self, name: &str) -> Option<String> {
            self.values.lock().expect("锁没被污染").get(name).cloned()
        }

        pub fn writes(&self) -> usize {
            *self.writes.lock().expect("锁没被污染")
        }

        pub fn names(&self) -> Vec<String> {
            let mut names: Vec<String> =
                self.values.lock().expect("锁没被污染").keys().cloned().collect();
            names.sort();
            names
        }
    }

    impl SecretStore for InMemoryStore {
        fn available(&self) -> bool {
            self.available
        }

        fn get(&self, name: &str) -> Option<String> {
            if !self.available {
                return None;
            }
            self.value(name)
        }

        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            if !self.available {
                return Err("这台机器没有可用的系统钥匙串（用例构造的）".to_string());
            }
            if value.is_empty() {
                return self.delete(name);
            }
            if value.len() > super::MAX_BLOB_BYTES {
                return Err(format!(
                    "这条秘密超过 {} 字节",
                    super::MAX_BLOB_BYTES
                ));
            }
            *self.writes.lock().expect("锁没被污染") += 1;
            self.values
                .lock()
                .expect("锁没被污染")
                .insert(name.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&self, name: &str) -> Result<(), String> {
            if !self.available {
                return Err("这台机器没有可用的系统钥匙串（用例构造的）".to_string());
            }
            self.values.lock().expect("锁没被污染").remove(name);
            Ok(())
        }
    }
}

#[cfg(test)]
pub(crate) mod real {
    //! 真机（真凭据管理器）那几条用例的**独占锁**。
    //!
    //! 为什么需要它：**凭据管理器对并发的写/删不是原子的**。实测过：四五条用例并行地
    //! 写/删各自那一条时，会出现"刚删掉、读回来也是空的，但 `cmdkey /list` 里还剩着它"
    //! （一条被别处的写"复活"）。把碰真钥匙串的用例串起来跑之后就不再出现。
    //!
    //! 这是**用例之间**的干扰，不是被测代码的性质：壳只在启动迁移与登录那一刻各写一次，
    //! 单线程、没有并发写。

    use std::sync::{Mutex, MutexGuard};

    static LOCK: Mutex<()> = Mutex::new(());

    /// 拿"真钥匙串用例"那把锁（**只在用例里用**）。
    pub(crate) fn lock() -> MutexGuard<'static, ()> {
        // 某条用例持锁时 panic 了不该把别的用例连锁拖死：锁被毒掉也照用
        LOCK.lock().unwrap_or_else(|error| error.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一次性的探测名字（**每次都不一样**：用例之间不互相踩，也不踩真机上的旧数据）。
    fn probe_name() -> String {
        let unique = uuid::Uuid::new_v4().simple().to_string();
        target_name("probe", &format!("cargo-{}", &unique[..8])).expect("拼得出名字")
    }

    /// 真值只打前 8 位（报告与日志里都不出现整串明文）。
    fn masked(value: &str) -> String {
        let head: String = value.chars().take(8).collect();
        format!("{head}…（共 {} 字节）", value.len())
    }

    // ---------------------------------------------------------------- 命名规则

    /// 同一个 NAS 的三种写法归一成**同一个名字**（否则改一处、另一处还是旧的）。
    #[test]
    fn the_three_spellings_normalize_to_one_name() {
        assert_eq!(
            normalize_origin("http://nas.test:8090/api/v1"),
            "http://nas.test:8090"
        );
        assert_eq!(
            normalize_origin("  HTTP://NAS.test:8090/  "),
            "http://nas.test:8090"
        );
        assert_eq!(normalize_origin("http://nas.test:8090"), "http://nas.test:8090");

        // path 丢掉之后，三种写法是同一把钥匙
        let with_path = nas_token_target("http://nas.test:8090/api/v1").expect("有名字");
        let with_slash = nas_token_target("http://nas.test:8090/").expect("有名字");
        let upper = nas_token_target("HTTP://NAS.test:8090").expect("有名字");
        assert_eq!(with_path, "kylab:nas_token:http://nas.test:8090");
        assert_eq!(with_slash, with_path);
        assert_eq!(upper, with_path);
    }

    /// **不替用户补 `http://`**：补了就会与"壳里填的是什么"分叉，而钥匙串里那一条
    /// 是按壳填的那个串找的。
    #[test]
    fn a_bare_host_is_not_given_a_scheme() {
        assert_eq!(normalize_origin("nas.test:8090"), "nas.test:8090");
        assert_eq!(normalize_origin("  NAS.test:8090  "), "nas.test:8090");
        assert_eq!(
            nas_token_target("nas.test:8090").expect("有名字"),
            "kylab:nas_token:nas.test:8090"
        );
        // 没有 host 的那种（`http://` 后面就空了）：也落到"整串小写"，不硬凑一个 host。
        // 注意末尾那个 `/` 先被第一条规则去掉了，所以是 `http:`——Python 侧
        // （`rstrip("/")` → `urlsplit("http:")` → netloc 空）得到的是同一个串
        assert_eq!(normalize_origin("http://"), "http:");
    }

    /// 空地址拼不出名字（要在名字里放它），**如实拒**。
    #[test]
    fn an_empty_origin_has_no_name() {
        assert_eq!(normalize_origin("   "), "");
        assert_eq!(normalize_origin("/"), "");
        assert!(nas_token_target("   ").is_err());
        assert!(nas_token_target("").is_err());
        // 用途那一段不许含分隔符（谁手抄一个名字出来就会踩这条）
        assert!(target_name("a:b", "mp_1").is_err());
        assert!(target_name("", "mp_1").is_err());
        assert!(target_name("probe", "  ").is_err());
    }

    /// `:` 在最后一段里是合法的（NAS 地址本来就有端口）——名字**只拼不拆**。
    #[test]
    fn a_port_survives_in_the_name() {
        assert_eq!(
            nas_token_target("http://nas.test:8090").expect("有名字"),
            "kylab:nas_token:http://nas.test:8090"
        );
    }

    // ---------------------------------------------------------------- 真机（Windows）

    /// **外部证据**：`cmdkey /list` 的输出（按系统 ANSI 代码页解码，Python 侧同一手法）。
    ///
    /// 标签是本地化的（中文 Windows 上是"目标/用户"），按 UTF-8 解会变成乱码；我们只断言
    /// ASCII 那几段（`target=<名字>` 与 User），所以乱码不影响判据。
    #[cfg(windows)]
    fn cmdkey_list() -> Option<String> {
        let done = std::process::Command::new("cmdkey")
            .arg("/list")
            .output()
            .ok()?;
        let mut bytes = done.stdout;
        bytes.extend_from_slice(&done.stderr);
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// 真机走一遍：写 → 读 → 改 → 删 → 再读（每一步都对着系统那份数据库）。
    #[cfg(windows)]
    #[test]
    fn the_system_keychain_round_trips_and_deletes() {
        let _guard = real::lock();
        if !Keychain.available() {
            eprintln!("跳过：这台机器上凭据管理器不可用");
            return;
        }
        let name = probe_name();
        let _ = Keychain.delete(&name); // 上一次跑到一半留下的可能性

        let first = Keychain.set(&name, "kylab_probe_值-with-utf8");
        let read_first = Keychain.get(&name);
        let overwritten = Keychain.set(&name, "second-value");
        let read_second = Keychain.get(&name);
        let deleted = Keychain.delete(&name);
        let read_after = Keychain.get(&name);
        let deleted_again = Keychain.delete(&name); // 幂等

        assert!(first.is_ok(), "{first:?}");
        assert_eq!(read_first.as_deref(), Some("kylab_probe_值-with-utf8"));
        assert!(overwritten.is_ok(), "{overwritten:?}");
        assert_eq!(read_second.as_deref(), Some("second-value"), "同一个名字再写就是覆盖");
        assert!(deleted.is_ok(), "{deleted:?}");
        assert_eq!(read_after, None);
        assert!(deleted_again.is_ok(), "本来就没有也算删成功：{deleted_again:?}");
    }

    /// 上限是**上限本身**（不是"大概能写"）：刚好写得进，多一字节拒。
    #[cfg(windows)]
    #[test]
    fn the_documented_limit_is_exactly_the_limit() {
        let _guard = real::lock();
        if !Keychain.available() {
            eprintln!("跳过：这台机器上凭据管理器不可用");
            return;
        }
        let name = probe_name();
        let _ = Keychain.delete(&name);

        let at_limit = Keychain.set(&name, &"a".repeat(MAX_BLOB_BYTES));
        let read_back = Keychain.get(&name);
        let over_limit = Keychain.set(&name, &"a".repeat(MAX_BLOB_BYTES + 1));
        let _ = Keychain.delete(&name);

        assert!(at_limit.is_ok(), "刚好 {MAX_BLOB_BYTES} 字节应当写得进：{at_limit:?}");
        assert_eq!(read_back.map(|value| value.len()), Some(MAX_BLOB_BYTES));
        assert!(over_limit.is_err(), "多一字节要如实拒（不截断）");
    }

    /// **外部证据**：`cmdkey /list` 里看得到 `kylab:…` 那一行（阶段 8 的物证）。
    ///
    /// 为什么值得一条用例：`get` 是我们自己的读回路径，"真的进了系统凭据管理器"这件事它
    /// 证明不了（一个只写进内存的假实现也能让读回通过）。`cmdkey` 读的是系统那份数据库，
    /// 而用户在"控制面板 → 凭据管理器"里看到的也是它。
    #[cfg(windows)]
    #[test]
    fn the_entry_is_visible_to_cmdkey() {
        let _guard = real::lock();
        if cmdkey_list().is_none() {
            eprintln!("跳过：这台机器上没有 cmdkey");
            return;
        }
        let name = probe_name();
        let needle = format!("target={name}");
        let _ = Keychain.delete(&name);

        let written = Keychain.set(&name, "kylab_probe_cmdkey");
        let appeared = wait_for_cmdkey(&needle, true);
        let user_line = appeared
            .as_deref()
            .unwrap_or_default()
            .lines()
            // 标签是本地化的（中文 Windows 上是"用户"），所以只认**分隔符 + 值**那一段：
            // `: kylab` 只会出现在 UserName 那一行（target 那一行是 `target=kylab:…`）
            .any(|line| line.contains(": kylab"));
        // **先删干净再断言**：断言失败也不该在用户的凭据管理器里留下我们的东西
        let _ = Keychain.delete(&name);
        let gone = wait_for_cmdkey(&needle, false);

        assert!(written.is_ok(), "{written:?}");
        assert!(appeared.is_some(), "凭据管理器里应当有它（{name}）");
        assert!(user_line, "那一条的 UserName 是 kylab");
        assert!(gone.is_some(), "用例跑完不该留下我们写的东西（{name}）");
    }

    /// 轮询 `cmdkey /list`，直到 `needle` 出现（`want = true`）或消失（`want = false`）。
    ///
    /// 为什么要轮询：`cmdkey` 是另一个进程、看的是系统那份数据库，而同一次 `cargo test` 里
    /// 还有别的用例在并发地写/删凭据——实测出现过"刚写完、紧接着那一次 `/list` 里还没有它"
    /// （一两百毫秒后就到了）。**判据没松**：真没写进去的话，轮询到超时也找不到。
    #[cfg(windows)]
    fn wait_for_cmdkey(needle: &str, want: bool) -> Option<String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let listing = cmdkey_list().unwrap_or_default();
            if listing.contains(needle) == want {
                return Some(listing);
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
    }

    /// 探针**只读不写**：`available()` 不会在用户的凭据管理器里留下任何一条。
    #[cfg(windows)]
    #[test]
    fn the_availability_probe_leaves_nothing_behind() {
        let _guard = real::lock();
        let _ = Keychain.available();
        assert_eq!(Keychain.get(PROBE_TARGET), None, "探针那个名字下不该有东西");
    }

    // ---------------------------------------------------------------- 跨侧对拍

    /// **跨侧对拍**（方案 §4.1 那条；阶段 8 的物证）：壳写 → 后端读；后端写 → 壳读。
    ///
    /// 为什么只能这样证明：名字与编码的规则在两侧各实现了一遍，"两侧对上了"这件事
    /// 对一次才知道——差一个字符，另一侧读到的就是"没配"（**静默**，表现为用户那把
    /// 钥匙不见了）。所以这条用例真的把后端 CLI 拉起来，对着同一台机器的凭据管理器读写。
    ///
    /// **只在给了 `KYLAB_KEYCHAIN_PROBE=1` 时跑**：它要一个装好的后端 venv
    /// （`backend/.venv/Scripts/python.exe`），而正常的 `cargo test` 不该依赖后端。
    /// 地址默认用探针地址（**不碰用户真正的 `nas` 那一条**）；要对着某个真地址对拍时
    /// 用 `KYLAB_KEYCHAIN_ORIGIN` 覆盖，例如：
    ///
    /// ```text
    /// KYLAB_KEYCHAIN_PROBE=1 KYLAB_KEYCHAIN_ORIGIN=http://nas:8090 cargo test --quiet -- --nocapture
    /// ```
    #[cfg(windows)]
    #[test]
    fn the_shell_and_the_backend_agree_on_the_same_entry() {
        // 拿锁：这一条也真写真删（见 `real` 模块）
        let _guard = real::lock();
        if std::env::var("KYLAB_KEYCHAIN_PROBE").as_deref() != Ok("1") {
            eprintln!("跳过：需要 KYLAB_KEYCHAIN_PROBE=1（它要 backend/.venv 那个 python）");
            return;
        }
        let origin = std::env::var("KYLAB_KEYCHAIN_ORIGIN")
            .unwrap_or_else(|_| "http://kylab-probe.invalid:8090".to_string());
        let target = nas_token_target(&origin).expect("地址能拼出名字");
        let backend = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("backend");
        // 后端 CLI 要一个 --data-dir（它顺手建库）；用临时目录，**不碰用户那份库**
        let data_dir = std::env::temp_dir().join("kylab-keychain-probe");

        // 壳写进去的那一串**故意带中文**：跨侧对拍要同时钉住"名字一样"与"编码都是 UTF-8"
        // （值里有一个非 ASCII 字符，两侧任一处编码不对，这个断言就会红）
        let from_shell = format!("kylab_probe_壳侧_{}", uuid::Uuid::new_v4().simple());
        let from_backend = format!("kylab_probe_backend_{}", uuid::Uuid::new_v4().simple());
        // 上一次跑到一半留下的可能性（也保证"壳写进去的就是我们这一串"）
        let _ = Keychain.delete(&target);

        // ---- 方向①：壳写 → 后端读（就是阶段 8 那条命令） ----
        let written = Keychain.set(&target, &from_shell);
        let read_by_backend = backend_nas_token(&backend, &data_dir, &origin, &["--show"]);
        eprintln!("① 壳写 {} → 后端读：{}", masked(&from_shell), read_by_backend.trim());

        // ---- 方向②：后端写 → 壳读 ----
        let written_by_backend = backend_nas_token(
            &backend,
            &data_dir,
            &origin,
            &["--set", from_backend.as_str()],
        );
        let read_by_shell = Keychain.get(&target);
        eprintln!(
            "② 后端写 {} → 壳读：{}",
            masked(&from_backend),
            read_by_shell.as_deref().map(masked).unwrap_or_else(|| "（没配）".into())
        );

        // 收干净：**先删再断言**，失败也不留东西
        let deleted = backend_nas_token(&backend, &data_dir, &origin, &["--delete"]);
        let left_behind = Keychain.get(&target);

        assert!(written.is_ok(), "{written:?}");
        assert_eq!(
            read_by_backend.trim(),
            from_shell,
            "后端读到的不是壳写进去的那一串（名字或编码对不上）"
        );
        assert!(written_by_backend.contains("已写入"), "{written_by_backend}");
        assert_eq!(
            read_by_shell.as_deref(),
            Some(from_backend.as_str()),
            "壳读到的不是后端写进去的那一串"
        );
        assert!(deleted.contains("已删除"), "{deleted}");
        assert_eq!(left_behind, None, "对拍跑完不该留下东西");

        if std::env::var("KYLAB_KEYCHAIN_KEEP").as_deref() == Ok("1") {
            // **故意再写回去**（只在显式要它时）：阶段 8 的人拿后端那条命令手工读一次，
            // 就是"壳写 → 后端读"最直接的那份物证。跑完自己删——
            // 后端 CLI 的 `--delete`，或 `cmdkey /delete:kylab:nas_token:<地址>`。
            let kept = Keychain.set(&target, &from_shell);
            eprintln!(
                "**已故意留下 {target}**（KYLAB_KEYCHAIN_KEEP=1，跑完自己删）：{:?}",
                kept.is_ok()
            );
        }
    }

    /// 跑后端那条 CLI（`python -m app.services.credentials nas-token …`），回它的输出。
    ///
    /// `KYLAB_KEYCHAIN_PROBE=1` 那条用例专用：它要 `backend/.venv`（装好的后端依赖），
    /// 而不给这个环境变量时整条用例都不跑。
    #[cfg(windows)]
    fn backend_nas_token(
        backend: &std::path::Path,
        data_dir: &std::path::Path,
        origin: &str,
        extra: &[&str],
    ) -> String {
        use std::ffi::OsString;

        let python: OsString = backend
            .join(".venv")
            .join("Scripts")
            .join("python.exe")
            .into_os_string();
        let data_dir: OsString = data_dir.as_os_str().to_owned();
        let output = std::process::Command::new(&python)
            .current_dir(backend)
            // 后端那份 CLI 自己也会 reconfigure，这里给足一层，免得中文在管道里变成乱码
            .env("PYTHONIOENCODING", "utf-8")
            .arg("-m")
            .arg("app.services.credentials")
            .arg("nas-token")
            .arg("--origin")
            .arg(origin)
            .arg("--data-dir")
            .arg(&data_dir)
            .args(extra)
            .output()
            .unwrap_or_else(|error| panic!("起不来后端 CLI（{}）：{error}", python.to_string_lossy()));
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        text
    }
}
