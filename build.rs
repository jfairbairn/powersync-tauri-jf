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
    // Register custom cfg so rustc doesn't warn about it
    println!("cargo:rustc-check-cfg=cfg(powersync_static)");

    // Build the PowerSync extension (static on iOS, loadable on desktop)
    build_powersync_extension();

    tauri_plugin::Builder::new(COMMANDS).build();
}

/// Build the PowerSync SQLite extension.
///
/// On iOS, builds as a static library and links it directly (since iOS
/// doesn't allow dynamic extension loading). On other platforms, builds
/// as a loadable module (.dylib/.so/.dll).
fn build_powersync_extension() {
    use std::env;
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let target = env::var("TARGET").unwrap();

    let is_ios = target.contains("apple-ios");

    // Check for submodule first (development/submodule setup)
    let submodule_dir = manifest_dir.join("deps/powersync-sqlite-core");
    let cloned_dir = out_dir.join("powersync-sqlite-core");

    // Determine which source directory to use
    let core_dir = if submodule_dir.join("Cargo.toml").exists() {
        // Use existing submodule
        submodule_dir
    } else {
        // Clone to OUT_DIR if not already done (supports git/crates.io installation)
        if !cloned_dir.join("Cargo.toml").exists() {
            println!("cargo:warning=PowerSync extension source not found, cloning from GitHub...");

            // Remove empty/partial directory if it exists
            if cloned_dir.exists() {
                std::fs::remove_dir_all(&cloned_dir).ok();
            }

            let status = Command::new("git")
                .args([
                    "clone",
                    "--depth",
                    "1",
                    "https://github.com/powersync-ja/powersync-sqlite-core.git",
                    cloned_dir.to_str().unwrap(),
                ])
                .status();

            match status {
                Ok(s) if s.success() => {
                    println!("cargo:warning=Successfully cloned powersync-sqlite-core");
                }
                Ok(s) => {
                    println!(
                        "cargo:warning=Failed to clone powersync-sqlite-core: exit code {:?}",
                        s.code()
                    );
                    return;
                }
                Err(e) => {
                    println!("cargo:warning=Failed to run git clone: {}", e);
                    println!("cargo:warning=Make sure git is installed and accessible");
                    return;
                }
            }
        }
        cloned_dir
    };

    // Get target directory for extension build
    let target_dir = out_dir.join("powersync-ext");
    std::fs::create_dir_all(&target_dir).ok();

    if is_ios {
        build_static_extension(&core_dir, &target_dir, &out_dir, &target);
    } else {
        build_loadable_extension(&core_dir, &target_dir, &out_dir);
    }

    // Tell cargo to rerun if the core source changes
    println!("cargo:rerun-if-changed={}", core_dir.join("crates").display());
}

/// Build as a static library for iOS and link it directly.
fn build_static_extension(core_dir: &std::path::Path, target_dir: &std::path::Path, out_dir: &std::path::Path, target: &str) {
    use std::process::Command;

    println!("cargo:warning=Building PowerSync STATIC extension for iOS target: {}", target);

    let status = Command::new("cargo")
        .current_dir(core_dir)
        .args([
            "build",
            "--release",
            "-p", "powersync_static",
            "--target", target,
            "--target-dir", target_dir.to_str().unwrap(),
        ])
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:warning=PowerSync static extension built successfully");

            // The static lib is at target/<target>/release/libpowersync.a
            let lib_dir = target_dir.join(target).join("release");
            let built_lib = lib_dir.join("libpowersync.a");

            if built_lib.exists() {
                // Copy to out_dir so we can reference it
                let dest = out_dir.join("libpowersync.a");
                std::fs::copy(&built_lib, &dest).ok();

                // Tell cargo to link the static library
                println!("cargo:rustc-link-search=native={}", out_dir.display());
                println!("cargo:rustc-link-lib=static=powersync");

                // Tell the code to use static init instead of load_extension
                println!("cargo:rustc-cfg=powersync_static");
            } else {
                println!("cargo:warning=Static lib not found at {:?}", built_lib);
            }
        }
        Ok(s) => {
            println!("cargo:warning=Failed to build PowerSync static extension: exit code {:?}", s.code());
        }
        Err(e) => {
            println!("cargo:warning=Failed to run cargo for PowerSync static extension: {}", e);
        }
    }
}

/// Build as a loadable extension (.dylib/.so/.dll) for desktop.
fn build_loadable_extension(core_dir: &std::path::Path, target_dir: &std::path::Path, out_dir: &std::path::Path) {
    use std::process::Command;

    println!("cargo:warning=Building PowerSync loadable extension");

    let status = Command::new("cargo")
        .current_dir(core_dir)
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
}
