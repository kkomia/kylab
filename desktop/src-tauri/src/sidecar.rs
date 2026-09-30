//! 边车（壳自带的那份 Python 运行时）的**起停**（P4-4 片②）。
//!
//! ## 它在整条链上的位置
//!
//! ```text
//! 壳（Rust）  ──起──▶  sidecar-runtime\Scripts\python.exe -m app.sidecar
//!                        --server {base}/api/v1  --token {api_key}  --port 8765
//!                        --workspace <用户可写目录>  --data-dir <壳的数据目录>
//! 前端（app://） ──打──▶  http://127.0.0.1:8765/turn/stream
//! ```
//!
//! 边车按裁定「客户端永不直连 PG/S3」把循环、工具、沙箱放在本机，KB 与模型仍走服务器 ✓。
//!
//! ## 三条纪律（写进代码里，不是写进文档里）
//!
//! 1. **`--token` 只在命令行上传** ✗ —— 不写日志（命令行可能被同机器的别的进程看到，
//!    这一点在 `desktop/README.md` 里如实写明）；日志只记端口与启动结论 ✓；
//! 2. **端口优先抢 8765** ✓ —— 前端那份基址是**构建期**定的
//!    （`frontend/src/api/sidecar.ts::DEFAULT_SIDECAR_BASE`），顺延到别的端口前端就找不到它 ✗。
//!    所以先试 8765，被占才顺延，并且在返回里**如实带上最终端口**（引导页据此提示 ✓）；
//! 3. **不留孤儿 python** ✗ —— 正常退出走 `stop()`；壳崩了靠 Windows 的
//!    **Job Object（KILL_ON_JOB_CLOSE）** 把子进程一起收走 ✓（见 `job` 模块）。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 端口尝试范围：8765 是前端的默认值，后面几个是"被占了也别让用户干等"。
const PORT_RANGE: std::ops::RangeInclusive<u16> = 8765..=8769;

/// 等边车就绪的上限。冷启动要 import 一整套 fastapi/pydantic，10 秒级是常态。
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// 轮询间隔：够快（用户感觉不到）也不至于把 CPU 打满。
const POLL_INTERVAL: Duration = Duration::from_millis(400);

/// 留多少行 stderr 用来报错（**失败时要能说清**：python 缺失 / 端口全占 / 边车自己退了）。
const TAIL_LINES: usize = 20;

/// 边车运行时的目录名（`bundle.resources` 里映射成 `sidecar-runtime`）。
const RUNTIME_DIRNAME: &str = "sidecar-runtime";

/// 起好之后交给引导页的信息。
#[derive(Debug, Clone, serde::Serialize)]
pub struct Info {
    pub port: u16,
    /// `http://127.0.0.1:<port>`。
    pub base: String,
    /// **是不是抢到了前端默认的那个端口**（没抢到时引导页要提示一句）。
    pub on_default_port: bool,
}

pub struct Running {
    pub info: Info,
    child: Child,
    /// Windows：把子进程放进 Job Object，壳进程没了它一起没（见 `job`）。
    #[allow(dead_code)]
    job: Option<job::JobObject>,
    tail: Arc<Mutex<VecDeque<String>>>,
}

impl Running {
    /// 关掉边车（并尽量收掉它可能派生出来的子进程）。
    pub fn stop(&mut self) {
        let pid = self.child.id();
        #[cfg(windows)]
        {
            // 先按进程树杀：uvicorn 一般不起子进程，但真要起了就得一起收
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Job Object 在这里 drop：KILL_ON_JOB_CLOSE 会把还没死的部分一并收走
        self.job = None;
    }

    /// stderr 的末尾几行（报错时拼进消息里）。
    pub fn tail(&self) -> Vec<String> {
        self.tail
            .lock()
            .map(|lines| lines.iter().cloned().collect())
            .unwrap_or_default()
    }
}

/// 边车管理器：一个进程里只该有一个边车。
#[derive(Default)]
pub struct Manager {
    inner: Mutex<Option<Running>>,
}

impl Manager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 现在活着的边车地址（没起或已退出则 `None`）。
    pub fn info(&self) -> Option<Info> {
        let mut guard = self.inner.lock().ok()?;
        if let Some(running) = guard.as_mut() {
            // 顺手判一下它是不是已经自己退了（退了就当没起，下次会重新拉）
            match running.child.try_wait() {
                Ok(Some(_)) => {
                    *guard = None;
                    return None;
                }
                _ => {}
            }
        }
        guard.as_ref().map(|running| running.info.clone())
    }

    /// 停掉边车（幂等）。
    pub fn stop(&self) {
        let mut guard = match self.inner.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if let Some(mut running) = guard.take() {
            running.stop();
        }
    }

    /// **确保边车在跑**：已经在同一个 server 上跑着就复用；否则先停旧的再起新的。
    ///
    /// `runtime_root` 是边车运行时目录（`.../sidecar-runtime`）；
    /// `log_dir` 是壳的**配置目录**（日志落在它下面 —— 与 `main.rs` 里所有
    /// `logfile::log(&shell.dir, …)` 同一处，别传成数据目录：那会在数据目录里
    /// 长出一份没人知道的日志）。
    pub fn ensure(
        &self,
        runtime_root: &Path,
        log_dir: &Path,
        data_dir: &Path,
        workspace: &Path,
        server: &str,
        token: &str,
    ) -> Result<Info, String> {
        if token.trim().is_empty() {
            return Err("壳里还没有钥匙：先登录一次再起边车".to_string());
        }
        if let Some(info) = self.info() {
            return Ok(info);
        }

        let python = python_exe(runtime_root)?;
        // **用了哪一份运行时写进日志**（README 一直这么承诺，直到今天才真的写）：
        // 开发机上"包内那份（`target/release/sidecar-runtime`，`tauri build` 留下的）
        // 与仓库那份（`build/sidecar-runtime`）谁生效"是最容易踩的一处 —— 2026-09-30
        // 实测：改完 `build/` 重建，边车却一直跑旧代码，就是因为 `target/release/`
        // 里那份旧的**优先**。
        crate::logfile::log(log_dir, &format!("边车运行时：{}", runtime_root.display()));
        let port = pick_port()?;
        if port != *PORT_RANGE.start() {
            crate::logfile::log(
                log_dir,
                &format!(
                    "边车：{} 被占用，改用 {}（**前端默认打 {}**，若界面连不上就查这一条）",
                    PORT_RANGE.start(),
                    port,
                    PORT_RANGE.start()
                ),
            );
        }

        std::fs::create_dir_all(workspace)
            .map_err(|error| format!("工作区建不出来（{error}）：{}", workspace.display()))?;

        // ⚠️ `--token` 只在命令行传：**这一行不许进日志**（argv 同机器可见）
        let mut command = Command::new(&python);
        command
            .arg("-m")
            .arg("app.sidecar")
            .arg("--server")
            .arg(server)
            .arg("--token")
            .arg(token)
            .arg("--port")
            .arg(port.to_string())
            .arg("--workspace")
            .arg(workspace)
            .arg("--data-dir")
            .arg(data_dir)
            // 边车要 `app` 包在 import 路径上：运行时目录里就有 `app/`
            .current_dir(runtime_root)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW：别在用户面前闪一个黑框（壳是 GUI）
            command.creation_flags(0x0800_0000);
        }

        let mut child = command.spawn().map_err(|error| {
            format!(
                "边车起不来（{error}）：{}；出包前要先跑 scripts/build-sidecar-runtime.ps1",
                python.display()
            )
        })?;

        let tail = Arc::new(Mutex::new(VecDeque::with_capacity(TAIL_LINES)));
        if let Some(stderr) = child.stderr.take() {
            let sink = Arc::clone(&tail);
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if let Ok(mut lines) = sink.lock() {
                        if lines.len() == TAIL_LINES {
                            lines.pop_front();
                        }
                        lines.push_back(line);
                    }
                }
            });
        }

        let job = job::assign(&child).map_err(|error| {
            // 收不到 Job 不算致命：正常退出那条路仍然收得干净，只是"壳崩了"这一路弱一点
            crate::logfile::log(log_dir, &format!("边车：Job Object 没挂上（{error}）"));
            error
        });
        let job = job.ok();

        let base = format!("http://127.0.0.1:{port}");
        let mut running = Running {
            info: Info {
                port,
                base: base.clone(),
                on_default_port: port == *PORT_RANGE.start(),
            },
            child,
            job,
            tail,
        };

        // 等它真的能应答：**起不来要能说清**，所以分三种失败各给一句话
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if let Ok(Some(status)) = running.child.try_wait() {
                let tail = running.tail();
                return Err(format!(
                    "边车起来就退了（退出码 {}）：{}",
                    status.code().map(|code| code.to_string()).unwrap_or_else(|| "被信号结束".into()),
                    if tail.is_empty() {
                        "（没有 stderr 输出）".to_string()
                    } else {
                        tail.join(" / ")
                    }
                ));
            }
            if health_ok(&base) {
                break;
            }
            if Instant::now() >= deadline {
                let tail = running.tail();
                return Err(format!(
                    "边车 {} 秒没起来（{}）：{}",
                    READY_TIMEOUT.as_secs(),
                    base,
                    if tail.is_empty() {
                        "（没有 stderr 输出）".to_string()
                    } else {
                        tail.join(" / ")
                    }
                ));
            }
            std::thread::sleep(POLL_INTERVAL);
        }

        let info = running.info.clone();
        crate::logfile::log(
            log_dir,
            &format!(
                "边车已就绪：{}（端口 {}，工作区 {}，数据目录 {}；token 只在命令行传，不落日志）",
                base,
                port,
                workspace.display(),
                data_dir.display()
            ),
        );
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "边车状态锁被污染了".to_string())?;
        *guard = Some(running);
        Ok(info)
    }
}

/// 边车运行时的解释器：先在**包内**找（安装版），再在仓库里找（`cargo run` 开发时）。
pub fn python_exe(runtime_root: &Path) -> Result<PathBuf, String> {
    let candidate = runtime_root.join("Scripts").join("python.exe");
    if candidate.is_file() {
        return Ok(candidate);
    }
    Err(format!(
        "边车运行时不在包里：{}（出包前先跑 scripts/build-sidecar-runtime.ps1，它会生成 build/sidecar-runtime）",
        candidate.display()
    ))
}

/// 包内运行时目录：`<resource_dir>/sidecar-runtime`（`bundle.resources` 的映射）。
pub fn bundled_runtime(resource_dir: &Path) -> PathBuf {
    resource_dir.join(RUNTIME_DIRNAME)
}

/// 开发时的运行时目录：仓库根的 `build/sidecar-runtime`
/// （`cargo run` 时 `resource_dir()` 指向 target 目录，里面没有它）。
///
/// 落在 `build/` 而不是 `dist/`（2026-09-29 搬家）：`dist/` 这个名字在前后端工具链里
/// 到处都是（`frontend/dist/` 是前端产物），仓库根再放一份边车运行时容易看错。
pub fn dev_runtime() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("build")
        .join(RUNTIME_DIRNAME)
}

/// 先包内、后仓库：哪个有解释器用哪个（两条都能跑，选中的那个会写进日志）。
pub fn resolve_runtime(resource_dir: &Path, log_dir: &Path) -> PathBuf {
    let bundled = bundled_runtime(resource_dir);
    if python_exe(&bundled).is_ok() {
        return bundled;
    }
    let dev = dev_runtime();
    if python_exe(&dev).is_ok() {
        crate::logfile::log(
            log_dir,
            &format!("边车：包内没有运行时，改用仓库里的 {}", dev.display()),
        );
        return dev;
    }
    bundled
}

/// 挑一个能用的端口：**8765 优先**，被占才顺延。
fn pick_port() -> Result<u16, String> {
    for port in PORT_RANGE {
        // 探一下能不能绑：能绑就说明没人占（随后立刻释放，交给边车去绑）
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err(format!(
        "端口 {}–{} 都被别的进程占着：先关掉占用它的程序（它多半是上一次没退干净的边车）",
        PORT_RANGE.start(),
        PORT_RANGE.end()
    ))
}

/// 探边车的 `/health`（起没起来以它为准，不看进程还在不在）。
fn health_ok(base: &str) -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(800))
        .build();
    match agent.get(&format!("{base}/health")).call() {
        Ok(response) => response.status() == 200,
        Err(_) => false,
    }
}

#[cfg(windows)]
mod job {
    //! Windows Job Object：**子进程随壳一起退出**（壳崩了也不留孤儿 python）。
    //!
    //! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的语义是"最后一个指向这个 job 的句柄被关掉时，
    //! job 里的进程全被杀掉"——壳进程一没（正常退出或崩溃），句柄就没了，
    //! 于是边车跟着走 ✓。这比"退出时记得 kill"可靠：崩溃时没有代码会跑 ✓。
    //!
    //! 为什么用 `windows` 而不是 `windows-sys`：实测 windows-sys 0.52 / 0.59 / 0.61 的
    //! `Win32::System::JobObjects` 里**只有常量与结构体，没有 `CreateJobObjectW` 那几个函数** ✗
    //! （那个 crate 只覆盖一部分 API）。`windows` 高阶层才有 ✓，而它本来就在依赖树里 ✓。

    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct JobObject(isize);

    impl Drop for JobObject {
        fn drop(&mut self) {
            // 关掉最后一个句柄 → job 里的进程（边车）一起被杀 ✓
            unsafe {
                let _ = CloseHandle(HANDLE(self.0 as _));
            }
        }
    }

    pub fn assign(child: &Child) -> Result<JobObject, String> {
        unsafe {
            let job = CreateJobObjectW(None, None).map_err(|e| format!("CreateJobObjectW：{e}"))?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                let _ = CloseHandle(job);
                return Err(format!("SetInformationJobObject：{error}"));
            }
            let process = HANDLE(child.as_raw_handle() as _);
            if let Err(error) = AssignProcessToJobObject(job, process) {
                let _ = CloseHandle(job);
                return Err(format!("AssignProcessToJobObject：{error}"));
            }
            // 存成 `isize` 而不是裸指针：`HANDLE` 是 `*mut c_void`，**不是 `Send`** ✗，
            // 而它要跟着 `Manager` 进 Tauri 的全局状态（`Shell` 必须 Send + Sync）✓。
            Ok(JobObject(job.0 as isize))
        }
    }
}

#[cfg(not(windows))]
mod job {
    //! 非 Windows：没有 Job Object 这一套；退出时靠 `stop()`（`RunEvent::Exit`）。
    use std::process::Child;

    pub struct JobObject;

    pub fn assign(_child: &Child) -> Result<JobObject, String> {
        Err("这个平台上没有 Job Object".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_path_is_where_the_bundle_puts_it() {
        let root = PathBuf::from("C:/app/resources");
        assert_eq!(
            bundled_runtime(&root),
            PathBuf::from("C:/app/resources/sidecar-runtime")
        );
        assert_eq!(
            python_exe(&bundled_runtime(&root)).unwrap_err().contains("scripts/build-sidecar-runtime.ps1"),
            true
        );
    }

    /// 端口优先 8765：这里把 8765 占住，`pick_port` 必须顺延（而不是报错）。
    #[test]
    fn the_default_port_is_preferred_and_busy_ones_are_skipped() {
        let nailed = TcpListener::bind(("127.0.0.1", *PORT_RANGE.start()));
        let Ok(nailed) = nailed else {
            eprintln!("跳过：8765 已经被占着，这条的前提不成立");
            return;
        };
        let picked = pick_port().expect("顺延一个");
        assert_ne!(picked, *PORT_RANGE.start());
        assert!(PORT_RANGE.contains(&picked));
        drop(nailed);
    }

    #[test]
    fn an_empty_token_is_refused_before_spawning() {
        let manager = Manager::new();
        let error = manager
            .ensure(
                Path::new("C:/nope"),
                Path::new("C:/tmp/logs"),
                Path::new("C:/tmp"),
                Path::new("C:/tmp/ws"),
                "http://x/api/v1",
                "  ",
            )
            .unwrap_err();
        assert!(error.contains("还没有钥匙"), "{error}");
    }

    /// **端到端（P4-4 片② 的验收）**：壳起边车 → 真走一轮带工具的对话。
    ///
    /// 判据与整个 P4 一致：`steps` 里**有一步 `tool` 非空** ✓、`recorded == true` ✓
    /// （`recorded=true` 还顺带证明"边车把这一轮写回了服务器"那条链是通的 ✓）。
    ///
    /// 只在给了 `KYLAB_TEST_SERVER` + `KYLAB_TEST_API_KEY` 时跑；工作区与数据目录都用
    /// **工作区内的临时目录**（`KYLAB_TEST_TMP`，默认 `dist` 旁边的 `.desktop-test`）。
    #[test]
    fn the_shell_starts_a_sidecar_that_really_runs_a_tool_turn() {
        let (Ok(server), Ok(key)) = (
            std::env::var("KYLAB_TEST_SERVER"),
            std::env::var("KYLAB_TEST_API_KEY"),
        ) else {
            eprintln!("跳过：需要 KYLAB_TEST_SERVER 与 KYLAB_TEST_API_KEY");
            return;
        };
        let root = std::env::var("KYLAB_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dev_runtime().join("..").join("..").join(".desktop-test"));
        let log_dir = root.join("logs");
        let data_dir = root.join("data");
        let workspace = root.join("workspace");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&workspace).expect("建工作区");
        std::fs::write(workspace.join("hello.txt"), "边车精简运行时：本地工作区里的内容 42\n")
            .expect("写 hello.txt");

        let runtime = dev_runtime();
        let api_base = format!("{}/api/v1", server.trim_end_matches('/'));
        eprintln!("边车运行时：{}；后端：{}", runtime.display(), api_base);
        let manager = Manager::new();
        let info = manager
            .ensure(&runtime, &log_dir, &data_dir, &workspace, &api_base, &key)
            .expect("壳起边车");
        eprintln!("① 边车已就绪：{}（端口 {}，默认端口 {}）", info.base, info.port, info.on_default_port);
        assert!(PORT_RANGE.contains(&info.port));

        // 拿一条属于这个令牌的会话（`recorded=true` 要有会话可写回）
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build();
        let conversations: serde_json::Value = agent
            .get(&format!("{api_base}/conversations"))
            .set("Authorization", &format!("Bearer {key}"))
            .call()
            .expect("列会话")
            .into_json()
            .expect("会话 JSON");
        let conversation_id = conversations["items"][0]["id"].as_str().unwrap_or("").to_string();
        assert!(!conversation_id.is_empty(), "这个令牌下没有会话：{conversations}");

        let turn: serde_json::Value = agent
            .post(&format!("{}/turn", info.base))
            .send_json(serde_json::json!({
                "conversation_id": conversation_id,
                "message": "用 read_file 工具读工作区里的 hello.txt（where 填 workspace），然后把你读到的原文原样告诉我。",
            }))
            .expect("跑一轮")
            .into_json()
            .expect("轮次 JSON");

        let steps = turn["steps"].as_array().cloned().unwrap_or_default();
        let tool_steps: Vec<&serde_json::Value> = steps
            .iter()
            .filter(|step| step["tool"].as_str().map(|name| !name.is_empty()).unwrap_or(false))
            .collect();
        eprintln!(
            "② /turn → steps={} 其中 tool 非空 {}；recorded={}；answer={}",
            steps.len(),
            tool_steps.len(),
            turn["recorded"],
            turn["answer"].as_str().unwrap_or("").chars().take(40).collect::<String>()
        );
        for step in &tool_steps {
            eprintln!(
                "   tool={} status={} args={} result={}",
                step["tool"], step["status"], step["args"], step["result"]
            );
        }
        assert!(!tool_steps.is_empty(), "没有任何一步带 tool：{turn}");
        assert_eq!(turn["recorded"], serde_json::Value::Bool(true), "这一轮没写回服务器");

        // ③ 收干净：停掉之后端口要能立刻再绑（证明进程真的退出了）
        manager.stop();
        std::thread::sleep(Duration::from_millis(800));
        let rebound = TcpListener::bind(("127.0.0.1", info.port));
        eprintln!("③ 停掉边车：端口 {} 立刻可再绑 = {}", info.port, rebound.is_ok());
        assert!(rebound.is_ok(), "边车没退干净：{} 还被占着", info.port);
        assert!(manager.info().is_none());
    }
}
