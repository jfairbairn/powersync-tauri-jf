use std::sync::Mutex;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod database;
mod error;

use database::DatabaseManager;

/// Plugin state wrapper
pub struct PowerSyncState(pub Mutex<DatabaseManager>);

/// Initialize the PowerSync plugin
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("powersync")
        .setup(|app, _api| {
            // Get app data directory for storing databases
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");

            // Initialize database manager
            let manager = DatabaseManager::new(app_data_dir);
            app.manage(PowerSyncState(Mutex::new(manager)));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open,
            commands::close,
            commands::execute,
            commands::execute_batch,
            commands::get_all,
            commands::get_optional,
            commands::begin_transaction,
            commands::commit_transaction,
            commands::rollback_transaction,
        ])
        .build()
}
