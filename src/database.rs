use crate::error::{Error, Result};
use crate::extension;
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// A SQL parameter with explicit type information.
/// This allows proper handling of blobs vs arrays.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", content = "value")]
pub enum SqlParam {
    #[serde(rename = "null")]
    Null,
    #[serde(rename = "bool")]
    Bool(bool),
    #[serde(rename = "int")]
    Int(i64),
    #[serde(rename = "real")]
    Real(f64),
    #[serde(rename = "text")]
    Text(String),
    #[serde(rename = "blob")]
    Blob(Vec<u8>),
}

impl SqlParam {
    /// Convert to a rusqlite Value
    pub fn to_sql_value(&self) -> rusqlite::types::Value {
        match self {
            SqlParam::Null => rusqlite::types::Value::Null,
            SqlParam::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
            SqlParam::Int(i) => rusqlite::types::Value::Integer(*i),
            SqlParam::Real(f) => rusqlite::types::Value::Real(*f),
            SqlParam::Text(s) => rusqlite::types::Value::Text(s.clone()),
            SqlParam::Blob(b) => rusqlite::types::Value::Blob(b.clone()),
        }
    }
}

/// Convert a slice of SqlParams to rusqlite Values
fn sql_params_to_values(params: &[SqlParam]) -> Vec<rusqlite::types::Value> {
    params.iter().map(|p| p.to_sql_value()).collect()
}

/// Represents an active transaction or savepoint
pub struct Transaction {
    #[allow(dead_code)]
    pub id: String,
    #[allow(dead_code)]
    pub is_write: bool,
    pub completed: bool,
    /// If true, this is a savepoint (nested transaction), not a real transaction
    pub is_savepoint: bool,
    /// Savepoint name (only set if is_savepoint is true)
    pub savepoint_name: Option<String>,
}

/// A PowerSync-enabled SQLite connection
pub struct PowerSyncConnection {
    conn: Connection,
    transactions: HashMap<String, Transaction>,
    db_path: PathBuf,
    powersync_loaded: bool,
    /// Track transaction nesting depth for savepoint management
    transaction_depth: usize,
}

impl PowerSyncConnection {
    /// Open a new PowerSync database connection
    pub fn open(name: &str, app_data_dir: &PathBuf, resource_dir: Option<&PathBuf>) -> Result<Self> {
        let db_path = app_data_dir.join(format!("{}.db", name));

        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;

        // Enable WAL mode for better concurrent access
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        // Try to load the PowerSync extension
        // First try the build-time path (for development), then the resource directory (for bundled apps)
        let mut powersync_loaded = false;

        // Try build-time path first (set by build.rs during compilation)
        if let Some(build_path) = extension::get_build_time_extension_path() {
            if build_path.exists() {
                match extension::load_extension(&conn, &build_path) {
                    Ok(()) => {
                        log::info!("Loaded PowerSync extension from build path: {:?}", build_path);
                        powersync_loaded = true;
                    }
                    Err(e) => {
                        log::warn!("Failed to load PowerSync extension from build path: {}", e);
                    }
                }
            }
        }

        // Fall back to resource directory (for bundled apps)
        if !powersync_loaded {
            if let Some(res_dir) = resource_dir {
                match extension::find_extension(res_dir) {
                    Ok(ext_path) => {
                        match extension::load_extension(&conn, &ext_path) {
                            Ok(()) => {
                                log::info!("Loaded PowerSync extension from {:?}", ext_path);
                                powersync_loaded = true;
                            }
                            Err(e) => {
                                log::warn!("Failed to load PowerSync extension: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        log::debug!("PowerSync extension not found: {}", e);
                    }
                }
            }
        }

        // Initialize PowerSync if available (either from extension or linked statically)
        if !powersync_loaded {
            powersync_loaded = extension::has_powersync(&conn);
        }

        if powersync_loaded {
            extension::init_powersync(&conn)?;
            log::info!("PowerSync initialized");
        }

        Ok(Self {
            conn,
            transactions: HashMap::new(),
            db_path,
            powersync_loaded,
            transaction_depth: 0,
        })
    }

    /// Execute a SQL statement with parameters
    ///
    /// If the SQL is a SELECT statement, it will be executed as a query
    /// and the results will be returned in the `rows` field.
    /// This is needed because PowerSync extension functions use SELECT to return values.
    pub fn execute(&mut self, sql: &str, params: &[SqlParam]) -> Result<ExecuteResult> {
        let params = sql_params_to_values(params);
        let sql_upper = sql.trim_start().to_uppercase();

        // Check if this is a SELECT or other query that returns results
        if sql_upper.starts_with("SELECT") || sql_upper.starts_with("PRAGMA") {
            // For SELECT statements, actually return the results
            // This is needed because SqliteBucketStorage uses execute() for
            // PowerSync extension functions like powersync_sync_data()
            let mut stmt = self.conn.prepare(sql)?;

            let column_count = stmt.column_count();
            let columns: Vec<String> = (0..column_count)
                .map(|i| stmt.column_name(i).unwrap_or("").to_string())
                .collect();

            let rows = stmt
                .query_map(params_from_iter(params), |row| {
                    let mut row_data: HashMap<String, JsonValue> = HashMap::new();
                    for (i, col_name) in columns.iter().enumerate() {
                        let value = sqlite_value_to_json(row, i);
                        row_data.insert(col_name.clone(), value);
                    }
                    Ok(row_data)
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;

            return Ok(ExecuteResult {
                changes: 0,
                last_insert_rowid: 0,
                columns: Some(columns),
                rows: Some(rows),
            });
        }

        let changes = self.conn.execute(sql, params_from_iter(params))?;
        let last_insert_rowid = self.conn.last_insert_rowid();

        Ok(ExecuteResult {
            changes: changes as i64,
            last_insert_rowid,
            columns: None,
            rows: None,
        })
    }

    /// Execute a batch of SQL statements
    /// Uses a savepoint to allow nesting within an existing transaction.
    pub fn execute_batch(
        &mut self,
        sql: &str,
        params_batch: &[Vec<SqlParam>],
    ) -> Result<ExecuteResult> {
        // Use savepoint instead of transaction to support nesting
        let savepoint_name = format!("batch_{}", uuid::Uuid::new_v4().to_string().replace("-", ""));
        self.conn.execute(&format!("SAVEPOINT {}", savepoint_name), [])?;

        let mut total_changes = 0i64;
        let mut last_rowid = 0i64;

        let result = (|| {
            for params in params_batch {
                let params = sql_params_to_values(params);
                let changes = self.conn.execute(sql, params_from_iter(params))?;
                total_changes += changes as i64;
                last_rowid = self.conn.last_insert_rowid();
            }
            Ok::<_, crate::error::Error>(())
        })();

        match result {
            Ok(()) => {
                self.conn.execute(&format!("RELEASE SAVEPOINT {}", savepoint_name), [])?;
                Ok(ExecuteResult {
                    changes: total_changes,
                    last_insert_rowid: last_rowid,
                    columns: None,
                    rows: None,
                })
            }
            Err(e) => {
                let _ = self.conn.execute(&format!("ROLLBACK TO SAVEPOINT {}", savepoint_name), []);
                let _ = self.conn.execute(&format!("RELEASE SAVEPOINT {}", savepoint_name), []);
                Err(e)
            }
        }
    }

    /// Query and return all matching rows
    pub fn get_all(&self, sql: &str, params: &[SqlParam]) -> Result<QueryResult> {
        let params = sql_params_to_values(params);
        let mut stmt = self.conn.prepare(sql)?;

        let column_count = stmt.column_count();
        let columns: Vec<String> = (0..column_count)
            .map(|i| stmt.column_name(i).unwrap_or("").to_string())
            .collect();

        let rows = stmt
            .query_map(params_from_iter(params), |row| {
                let mut row_data: HashMap<String, JsonValue> = HashMap::new();
                for (i, col_name) in columns.iter().enumerate() {
                    let value = sqlite_value_to_json(row, i);
                    row_data.insert(col_name.clone(), value);
                }
                Ok(row_data)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(QueryResult { columns, rows })
    }

    /// Query and return a single optional row
    pub fn get_optional(&self, sql: &str, params: &[SqlParam]) -> Result<Option<RowResult>> {
        let result = self.get_all(sql, params)?;
        Ok(result.rows.into_iter().next())
    }

    /// Begin a new transaction or savepoint if already in a transaction
    pub fn begin_transaction(&mut self, is_write: bool) -> Result<String> {
        let tx_id = Uuid::new_v4().to_string();

        if self.transaction_depth > 0 {
            // Already in a transaction, use savepoint for nesting
            let savepoint_name = format!("sp_{}", tx_id.replace("-", ""));
            self.conn.execute(&format!("SAVEPOINT {}", savepoint_name), [])?;

            self.transactions.insert(
                tx_id.clone(),
                Transaction {
                    id: tx_id.clone(),
                    is_write,
                    completed: false,
                    is_savepoint: true,
                    savepoint_name: Some(savepoint_name),
                },
            );
        } else {
            // Start a real transaction
            let sql = if is_write {
                "BEGIN IMMEDIATE"
            } else {
                "BEGIN"
            };

            self.conn.execute(sql, [])?;

            self.transactions.insert(
                tx_id.clone(),
                Transaction {
                    id: tx_id.clone(),
                    is_write,
                    completed: false,
                    is_savepoint: false,
                    savepoint_name: None,
                },
            );
        }

        self.transaction_depth += 1;
        Ok(tx_id)
    }

    /// Commit a transaction or release savepoint
    pub fn commit_transaction(&mut self, tx_id: &str) -> Result<()> {
        let tx = self
            .transactions
            .get_mut(tx_id)
            .ok_or_else(|| Error::TransactionNotFound(tx_id.to_string()))?;

        if tx.completed {
            return Err(Error::TransactionCompleted(tx_id.to_string()));
        }

        if tx.is_savepoint {
            // Release savepoint
            if let Some(ref savepoint_name) = tx.savepoint_name {
                self.conn.execute(&format!("RELEASE SAVEPOINT {}", savepoint_name), [])?;
            }
            self.transactions.remove(tx_id);
            self.transaction_depth = self.transaction_depth.saturating_sub(1);

            // Check if there's a deferred commit that should now be executed
            self.check_deferred_commits()?;
        } else {
            // Real transaction - only commit if no active savepoints
            if self.transaction_depth == 1 {
                self.conn.execute("COMMIT", [])?;
                self.transactions.remove(tx_id);
                self.transaction_depth = 0;
            } else {
                // Mark as pending commit - will be committed when depth reaches 1
                tx.completed = true;
            }
        }

        Ok(())
    }

    /// Rollback a transaction or savepoint
    pub fn rollback_transaction(&mut self, tx_id: &str) -> Result<()> {
        let tx = self
            .transactions
            .get(tx_id)
            .ok_or_else(|| Error::TransactionNotFound(tx_id.to_string()))?;

        if tx.completed {
            return Err(Error::TransactionCompleted(tx_id.to_string()));
        }

        if tx.is_savepoint {
            // Rollback to savepoint and release it
            if let Some(ref savepoint_name) = tx.savepoint_name {
                self.conn.execute(&format!("ROLLBACK TO SAVEPOINT {}", savepoint_name), [])?;
                self.conn.execute(&format!("RELEASE SAVEPOINT {}", savepoint_name), [])?;
            }
        } else {
            self.conn.execute("ROLLBACK", [])?;
        }

        self.transactions.remove(tx_id);
        self.transaction_depth = self.transaction_depth.saturating_sub(1);

        // Check if there's a deferred commit that should now be executed
        self.check_deferred_commits()?;

        Ok(())
    }

    /// Check for and execute any deferred commits when depth allows
    fn check_deferred_commits(&mut self) -> Result<()> {
        if self.transaction_depth == 1 {
            let deferred_tx_id = self.transactions.iter()
                .find(|(_, tx)| tx.completed && !tx.is_savepoint)
                .map(|(id, _)| id.clone());

            if let Some(tx_id) = deferred_tx_id {
                self.conn.execute("COMMIT", [])?;
                self.transactions.remove(&tx_id);
                self.transaction_depth = 0;
            }
        }
        Ok(())
    }

    /// Get the database file path
    pub fn path(&self) -> &PathBuf {
        &self.db_path
    }

    /// Check if PowerSync extension is loaded
    pub fn is_powersync_loaded(&self) -> bool {
        self.powersync_loaded
    }

    /// Get the PowerSync extension version
    pub fn get_powersync_version(&self) -> Result<String> {
        if !self.powersync_loaded {
            return Err(Error::PowerSyncNotInitialized);
        }
        extension::get_powersync_version(&self.conn)
    }

    /// Replace the PowerSync schema
    pub fn replace_schema(&self, schema_json: &str) -> Result<()> {
        if !self.powersync_loaded {
            return Err(Error::PowerSyncNotInitialized);
        }
        self.conn.query_row(
            "SELECT powersync_replace_schema(?)",
            [schema_json],
            |_| Ok(()),
        )?;
        Ok(())
    }

    /// Execute a PowerSync control operation
    pub fn powersync_control(&self, op: &str, payload: &str) -> Result<String> {
        if !self.powersync_loaded {
            return Err(Error::PowerSyncNotInitialized);
        }
        let result: String = self.conn.query_row(
            "SELECT powersync_control(?, ?)",
            [op, payload],
            |row| row.get(0),
        )?;
        Ok(result)
    }

    /// Get a batch of pending CRUD entries
    pub fn get_crud_batch(&self, limit: i64) -> Result<Vec<CrudEntry>> {
        if !self.powersync_loaded {
            return Err(Error::PowerSyncNotInitialized);
        }
        let mut stmt = self.conn.prepare(
            "SELECT id, tx_id, data FROM ps_crud ORDER BY id LIMIT ?"
        )?;
        let entries = stmt
            .query_map([limit], |row| {
                Ok(CrudEntry {
                    id: row.get(0)?,
                    tx_id: row.get(1)?,
                    data: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    /// Remove CRUD entries up to and including the given ID
    pub fn remove_crud(&mut self, crud_id: i64) -> Result<()> {
        if !self.powersync_loaded {
            return Err(Error::PowerSyncNotInitialized);
        }
        self.conn.execute(
            "DELETE FROM ps_crud WHERE id <= ?",
            [crud_id],
        )?;
        Ok(())
    }

    /// Check if there are any CRUD entries pending
    pub fn has_pending_crud(&self) -> Result<bool> {
        if !self.powersync_loaded {
            return Err(Error::PowerSyncNotInitialized);
        }
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM ps_crud",
            [],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Get the current write checkpoint
    pub fn get_write_checkpoint(&self) -> Result<Option<String>> {
        if !self.powersync_loaded {
            return Err(Error::PowerSyncNotInitialized);
        }
        let result: Option<String> = self.conn.query_row(
            "SELECT powersync_last_synced_at()",
            [],
            |row| row.get(0),
        ).ok();
        Ok(result)
    }
}

/// A CRUD entry from ps_crud table
#[derive(Debug, Clone, serde::Serialize)]
pub struct CrudEntry {
    pub id: i64,
    #[serde(rename = "txId")]
    pub tx_id: Option<i64>,
    pub data: String,
}

/// Result of an execute operation
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExecuteResult {
    pub changes: i64,
    #[serde(rename = "lastInsertRowid")]
    pub last_insert_rowid: i64,
    /// For SELECT statements, the query results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<RowResult>>,
}

/// Result of a query operation
#[derive(Debug, Clone, serde::Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<RowResult>,
}

pub type RowResult = HashMap<String, JsonValue>;

/// Database manager holding all open connections
pub struct DatabaseManager {
    databases: HashMap<String, Arc<Mutex<PowerSyncConnection>>>,
    app_data_dir: PathBuf,
    resource_dir: Option<PathBuf>,
}

impl DatabaseManager {
    pub fn new(app_data_dir: PathBuf, resource_dir: Option<PathBuf>) -> Self {
        Self {
            databases: HashMap::new(),
            app_data_dir,
            resource_dir,
        }
    }

    pub fn open(&mut self, name: &str) -> Result<()> {
        if !self.databases.contains_key(name) {
            let conn = PowerSyncConnection::open(name, &self.app_data_dir, self.resource_dir.as_ref())?;
            self.databases
                .insert(name.to_string(), Arc::new(Mutex::new(conn)));
        }
        Ok(())
    }

    pub fn close(&mut self, name: &str) -> Result<()> {
        self.databases.remove(name);
        Ok(())
    }

    pub fn get(&self, name: &str) -> Result<Arc<Mutex<PowerSyncConnection>>> {
        self.databases
            .get(name)
            .cloned()
            .ok_or_else(|| Error::DatabaseNotFound(name.to_string()))
    }
}


/// Convert a SQLite row value to JSON
fn sqlite_value_to_json(row: &rusqlite::Row, idx: usize) -> JsonValue {
    use rusqlite::types::ValueRef;

    match row.get_ref(idx) {
        Ok(ValueRef::Null) => JsonValue::Null,
        Ok(ValueRef::Integer(i)) => JsonValue::Number(i.into()),
        Ok(ValueRef::Real(f)) => {
            serde_json::Number::from_f64(f).map_or(JsonValue::Null, JsonValue::Number)
        }
        Ok(ValueRef::Text(s)) => {
            JsonValue::String(String::from_utf8_lossy(s).into_owned())
        }
        Ok(ValueRef::Blob(b)) => {
            // Encode blob as base64 string
            use base64::Engine;
            JsonValue::String(base64::engine::general_purpose::STANDARD.encode(b))
        }
        Err(_) => JsonValue::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sql_param_deserialization() {
        // Test null
        let json = r#"{"type":"null"}"#;
        let param: SqlParam = serde_json::from_str(json).unwrap();
        assert!(matches!(param, SqlParam::Null));

        // Test text
        let json = r#"{"type":"text","value":"hello"}"#;
        let param: SqlParam = serde_json::from_str(json).unwrap();
        assert!(matches!(param, SqlParam::Text(s) if s == "hello"));

        // Test int
        let json = r#"{"type":"int","value":42}"#;
        let param: SqlParam = serde_json::from_str(json).unwrap();
        assert!(matches!(param, SqlParam::Int(42)));

        // Test blob
        let json = r#"{"type":"blob","value":[1,2,3]}"#;
        let param: SqlParam = serde_json::from_str(json).unwrap();
        assert!(matches!(param, SqlParam::Blob(b) if b == vec![1, 2, 3]));

        // Test array of params
        let json = r#"[{"type":"text","value":"schema json here"}]"#;
        let params: Vec<SqlParam> = serde_json::from_str(json).unwrap();
        assert_eq!(params.len(), 1);
        assert!(matches!(&params[0], SqlParam::Text(s) if s == "schema json here"));
    }
}
