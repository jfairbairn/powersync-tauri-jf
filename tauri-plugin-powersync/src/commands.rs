use crate::database::{ExecuteResult, QueryResult, RowResult};
use crate::error::Result;
use crate::PowerSyncState;
use serde_json::Value as JsonValue;
use tauri::{command, AppHandle, Runtime, State};

/// Open a database connection
#[command]
pub async fn open<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
) -> Result<()> {
    let mut manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    manager.open(&name)
}

/// Close a database connection
#[command]
pub async fn close<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
) -> Result<()> {
    let mut manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    manager.close(&name)
}

/// Execute a SQL statement
#[command]
pub async fn execute<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<ExecuteResult> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let mut conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.execute(&sql, &params)
}

/// Execute a batch of SQL statements
#[command]
pub async fn execute_batch<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
    sql: String,
    params_batch: Vec<Vec<JsonValue>>,
) -> Result<ExecuteResult> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let mut conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.execute_batch(&sql, &params_batch)
}

/// Query and return all matching rows
#[command]
pub async fn get_all<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<QueryResult> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.get_all(&sql, &params)
}

/// Query and return a single optional row
#[command]
pub async fn get_optional<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<Option<RowResult>> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.get_optional(&sql, &params)
}

/// Begin a new transaction
#[command]
pub async fn begin_transaction<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
    is_write: bool,
) -> Result<String> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let mut conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.begin_transaction(is_write)
}

/// Commit a transaction
#[command]
pub async fn commit_transaction<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
    tx_id: String,
) -> Result<()> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let mut conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.commit_transaction(&tx_id)
}

/// Rollback a transaction
#[command]
pub async fn rollback_transaction<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
    tx_id: String,
) -> Result<()> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let mut conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.rollback_transaction(&tx_id)
}
