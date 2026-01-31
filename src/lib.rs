use std::sync::Mutex;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod database;
mod error;
mod extension;

use database::DatabaseManager;

/// Plugin state wrapper
pub struct PowerSyncState(pub Mutex<DatabaseManager>);

/// Initialize the PowerSync plugin
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("powersync-jf")
        .setup(|app, _api| {
            // Get app data directory for storing databases
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");

            // Get resource directory for PowerSync extension
            let resource_dir = app.path().resource_dir().ok();

            // Initialize database manager with resource directory for extension loading
            let manager = DatabaseManager::new(app_data_dir, resource_dir);
            app.manage(PowerSyncState(Mutex::new(manager)));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Database operations
            commands::open,
            commands::close,
            commands::execute,
            commands::execute_batch,
            commands::get_all,
            commands::get_optional,
            commands::begin_transaction,
            commands::commit_transaction,
            commands::rollback_transaction,
            // PowerSync extension operations
            commands::get_powersync_version,
            commands::is_powersync_loaded,
            commands::replace_schema,
            commands::powersync_control,
            commands::get_crud_batch,
            commands::remove_crud,
            commands::has_pending_crud,
            commands::get_write_checkpoint,
        ])
        .build()
}
