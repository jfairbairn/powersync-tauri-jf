use crate::database::{CrudEntry, ExecuteResult, QueryResult, RowResult, SqlParam};
use crate::error::{Error, Result};
use crate::PowerSyncState;
use tauri::{command, AppHandle, Runtime, State};

/// Reject SQL statements that reference powersync_core internals.
/// Checked against the prepared statement template only, not bound parameter values.
fn validate_sql(sql: &str) -> Result<()> {
    if sql.contains("powersync_core") {
        return Err(Error::ForbiddenSql(
            "SQL must not reference powersync_core".to_string(),
        ));
    }
    Ok(())
}

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
    params: Vec<SqlParam>,
) -> Result<ExecuteResult> {
    validate_sql(&sql)?;
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
    params_batch: Vec<Vec<SqlParam>>,
) -> Result<ExecuteResult> {
    validate_sql(&sql)?;
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
    params: Vec<SqlParam>,
) -> Result<QueryResult> {
    validate_sql(&sql)?;
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
    params: Vec<SqlParam>,
) -> Result<Option<RowResult>> {
    validate_sql(&sql)?;
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

// =====================================================
// PowerSync Extension Commands
// =====================================================

/// Get the PowerSync extension version
#[command]
pub async fn get_powersync_version<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
) -> Result<String> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.get_powersync_version()
}

/// Check if PowerSync extension is loaded
#[command]
pub async fn is_powersync_loaded<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
) -> Result<bool> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    Ok(conn.is_powersync_loaded())
}

/// Replace the PowerSync schema
#[command]
pub async fn replace_schema<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
    schema_json: String,
) -> Result<()> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.replace_schema(&schema_json)
}

/// Execute a PowerSync control operation
#[command]
pub async fn powersync_control<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
    op: String,
    payload: String,
) -> Result<String> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.powersync_control(&op, &payload)
}

/// Get a batch of pending CRUD entries
#[command]
pub async fn get_crud_batch<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
    limit: Option<i64>,
) -> Result<Vec<CrudEntry>> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.get_crud_batch(limit.unwrap_or(100))
}

/// Remove CRUD entries up to and including the given ID
#[command]
pub async fn remove_crud<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
    crud_id: i64,
) -> Result<()> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let mut conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.remove_crud(crud_id)
}

/// Check if there are pending CRUD entries
#[command]
pub async fn has_pending_crud<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
) -> Result<bool> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.has_pending_crud()
}

/// Get the current write checkpoint
#[command]
pub async fn get_write_checkpoint<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, PowerSyncState>,
    name: String,
) -> Result<Option<String>> {
    let manager = state.0.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    let conn = manager.get(&name)?;
    let conn = conn.lock().map_err(|e| crate::error::Error::Lock(e.to_string()))?;
    conn.get_write_checkpoint()
}
