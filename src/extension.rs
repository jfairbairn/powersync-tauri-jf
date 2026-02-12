//! PowerSync extension loading utilities
//!
//! This module handles locating and loading the PowerSync SQLite extension
//! from the application's resources directory.

use crate::error::Result;
#[cfg(not(powersync_static))]
use crate::error::Error;
#[cfg(not(powersync_static))]
use std::path::PathBuf;

/// Get the extension path from build time (set by build.rs)
#[cfg(not(powersync_static))]
pub fn get_build_time_extension_path() -> Option<PathBuf> {
    option_env!("POWERSYNC_EXT_PATH").map(PathBuf::from)
}

/// Get the extension filename for the current platform
#[cfg(not(powersync_static))]
pub fn get_extension_filename() -> &'static str {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        "libpowersync.dylib"
    }
    #[cfg(target_os = "linux")]
    {
        "libpowersync.so"
    }
    #[cfg(target_os = "windows")]
    {
        "powersync.dll"
    }
}

/// Find the PowerSync extension in the given resource directory
#[cfg(not(powersync_static))]
pub fn find_extension(resource_dir: &PathBuf) -> Result<PathBuf> {
    let filename = get_extension_filename();

    // Check in resource directory root
    let path = resource_dir.join(filename);
    if path.exists() {
        return Ok(path);
    }

    // Check in libs subdirectory
    let path = resource_dir.join("libs").join(filename);
    if path.exists() {
        return Ok(path);
    }

    // Check in native subdirectory
    let path = resource_dir.join("native").join(filename);
    if path.exists() {
        return Ok(path);
    }

    Err(Error::ExtensionNotFound(format!(
        "PowerSync extension '{}' not found in {:?}",
        filename, resource_dir
    )))
}

#[cfg(not(powersync_static))]
/// Load the PowerSync extension into a SQLite connection
///
/// # Safety
///
/// This function enables extension loading and loads a native library.
/// The extension path must point to a valid PowerSync SQLite extension.
pub fn load_extension(
    conn: &rusqlite::Connection,
    extension_path: &PathBuf,
) -> Result<()> {
    // Enable extension loading
    unsafe {
        conn.load_extension_enable()?;
    }

    // Load the extension
    // The entry point is sqlite3_powersync_init (automatically detected by SQLite)
    let result = unsafe { conn.load_extension(extension_path, None) };

    // Disable extension loading for security
    conn.load_extension_disable()?;

    result.map_err(|e| Error::ExtensionLoad(e.to_string()))?;

    Ok(())
}

/// Initialize PowerSync after the extension is loaded
pub fn init_powersync(conn: &rusqlite::Connection) -> Result<()> {
    conn.query_row("SELECT powersync_init()", [], |_| Ok(()))?;
    Ok(())
}

/// Check if PowerSync functions are available
pub fn has_powersync(conn: &rusqlite::Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM pragma_function_list WHERE name = 'powersync_init'",
        [],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or(false)
}

/// Get the PowerSync extension version
pub fn get_powersync_version(conn: &rusqlite::Connection) -> Result<String> {
    let version: String = conn.query_row(
        "SELECT powersync_rs_version()",
        [],
        |row| row.get(0),
    )?;
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extension_filename() {
        let filename = get_extension_filename();
        assert!(!filename.is_empty());
        #[cfg(target_os = "macos")]
        assert_eq!(filename, "libpowersync.dylib");
        #[cfg(target_os = "linux")]
        assert_eq!(filename, "libpowersync.so");
        #[cfg(target_os = "windows")]
        assert_eq!(filename, "powersync.dll");
    }
}
