const COMMANDS: &[&str] = &[
    // Database operations
    "open",
    "close",
    "execute",
    "execute_batch",
    "get_all",
    "get_optional",
    "begin_transaction",
    "commit_transaction",
    "rollback_transaction",
    // PowerSync extension operations
    "get_powersync_version",
    "is_powersync_loaded",
    "replace_schema",
    "powersync_control",
    "get_crud_batch",
    "remove_crud",
    "has_pending_crud",
    "get_write_checkpoint",
];

fn main() {
    // Build the PowerSync loadable extension
    build_powersync_extension();

    tauri_plugin::Builder::new(COMMANDS).build();
}

/// Build the PowerSync SQLite extension as a loadable module
fn build_powersync_extension() {
    use std::env;
    use std::path::PathBuf;
    use std::process::Command;

    // Get the path to the powersync-sqlite-core submodule
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let core_dir = manifest_dir.join("deps/powersync-sqlite-core");

    // Check if the submodule exists
    if !core_dir.exists() {
        println!("cargo:warning=PowerSync extension submodule not found at {:?}", core_dir);
        println!("cargo:warning=Run: git submodule add https://github.com/powersync-ja/powersync-sqlite-core.git deps/powersync-sqlite-core");
        return;
    }

    // Get target directory
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let target_dir = out_dir.join("powersync-ext");
    std::fs::create_dir_all(&target_dir).ok();

    // Determine the target triple
    let target = env::var("TARGET").unwrap();

    // Build the loadable extension
    println!("cargo:warning=Building PowerSync extension for target: {}", target);

    let status = Command::new("cargo")
        .current_dir(&core_dir)
        .args([
            "build",
            "--release",
            "-p", "powersync_loadable",
            "--target-dir", target_dir.to_str().unwrap(),
        ])
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:warning=PowerSync extension built successfully");

            // Copy the built extension to the output directory
            let ext_name = if cfg!(target_os = "macos") {
                "libpowersync.dylib"
            } else if cfg!(target_os = "windows") {
                "powersync.dll"
            } else {
                "libpowersync.so"
            };

            let built_ext = target_dir.join("release").join(ext_name);
            let dest_ext = out_dir.join(ext_name);

            if built_ext.exists() {
                std::fs::copy(&built_ext, &dest_ext).ok();
                println!("cargo:warning=Extension copied to {:?}", dest_ext);
                // Pass the extension path to the compiled code
                println!("cargo:rustc-env=POWERSYNC_EXT_PATH={}", dest_ext.display());
            }
        }
        Ok(s) => {
            println!("cargo:warning=Failed to build PowerSync extension: exit code {:?}", s.code());
        }
        Err(e) => {
            println!("cargo:warning=Failed to run cargo for PowerSync extension: {}", e);
        }
    }

    // Tell cargo to rerun if the core source changes
    println!("cargo:rerun-if-changed={}", core_dir.join("crates").display());
}
