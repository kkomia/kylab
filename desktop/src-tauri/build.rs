use std::path::Path;

fn main() {
    // **包内兜底那份前端**（`resources.rs` 的 `frontend-dist`）就是仓库里的
    // `frontend/dist` —— 它在 `.gitignore` 里，而 Tauri 的 `bundle.resources`
    // 碰到不存在的路径是**静默跳过**的（实测：少造边车运行时就是"包里没有它"）。
    // 那种包装出来还能打开，只是**界面退回引导页**，而这件事要等用户报上来才知道。
    //
    // 所以 release 构建（= 出包那一路）在这里**直接失败**，并说清怎么补救；
    // debug 构建（`cargo run` / `cargo test` / CI）不拦：开发态没有那份产物也能跑
    // （`resources::bundled_roots` 里那条"仓库里的 frontend/dist"就是它）。
    // 路径取干净一点（`desktop/src-tauri` 往上两级就是仓库根）：
    // 它会出现在报错信息与日志里，`..\..\` 那种写法读起来费劲。
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).expect("仓库根");
    let dist = repo.join("frontend").join("dist").join("index.html");
    // 前端产物一变就重跑一次（否则 cargo 会一直用上次的结论）
    println!("cargo:rerun-if-changed={}", dist.display());
    let release = std::env::var("PROFILE").map(|profile| profile != "debug").unwrap_or(false);
    if release && !dist.is_file() {
        panic!(
            "没有前端产物，包里就没有兜底界面（首启/断网时只剩引导页）：\n  {}\n\
             先在 frontend 里跑一次构建（`pnpm --dir frontend build`），再重新打包。\n\
             详见 desktop/README.md 的「打包安装包」一节。",
            dist.display()
        );
    }

    tauri_build::build()
}
