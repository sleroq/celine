use std::{env, path::PathBuf, process::Command};

fn main() {
    for path in [
        "web/src",
        "web/index.html",
        "web/package.json",
        "web/bun.lock",
        "web/tsconfig.json",
        "web/vite.config.ts",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rerun-if-env-changed=BUN");
    println!("cargo:rerun-if-env-changed=CELINE_API_ID");
    println!("cargo:rerun-if-env-changed=CELINE_API_HASH");

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR")).join("web");
    run_bun(&[
        "run",
        "build",
        "--outDir",
        output.to_str().expect("UTF-8 output path"),
    ]);
}

fn run_bun(args: &[&str]) {
    let bun = env::var_os("BUN").unwrap_or_else(|| "bun".into());
    let status = Command::new(bun)
        .args(args)
        .current_dir("web")
        .status()
        .expect("Bun is required to build Celine's web interface");
    assert!(
        status.success(),
        "Frontend command failed: bun {}",
        args.join(" ")
    );
}
