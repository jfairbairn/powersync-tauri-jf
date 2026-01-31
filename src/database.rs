use crate::error::{Error, Result};
use crate::extension;
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Represents an active transaction
pub struct Transaction {
    #[allow(dead_code)]
    pub id: String,
    #[allow(dead_code)]
    pub is_write: bool,
    pub completed: bool,
}

/// A PowerSync-enabled SQLite connection
pub struct PowerSyncConnection {
    conn: Connection,
    transactions: HashMap<String, Transaction>,
    db_path: PathBuf,
    powersync_loaded: bool,
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
        })
    }

    /// Execute a SQL statement with parameters
    ///
    /// If the SQL is a SELECT statement, it will be executed as a query
    /// and the results will be returned in the `rows` field.
    /// This is needed because PowerSync extension functions use SELECT to return values.
    pub fn execute(&mut self, sql: &str, params: &[JsonValue]) -> Result<ExecuteResult> {
        let params = json_to_sql_params(params);
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
    pub fn execute_batch(
        &mut self,
        sql: &str,
        params_batch: &[Vec<JsonValue>],
    ) -> Result<ExecuteResult> {
        let tx = self.conn.transaction()?;
        let mut total_changes = 0i64;
        let mut last_rowid = 0i64;

        for params in params_batch {
            let params = json_to_sql_params(params);
            let changes = tx.execute(sql, params_from_iter(params))?;
            total_changes += changes as i64;
            last_rowid = tx.last_insert_rowid();
        }

        tx.commit()?;

        Ok(ExecuteResult {
            changes: total_changes,
            last_insert_rowid: last_rowid,
            columns: None,
            rows: None,
        })
    }

    /// Query and return all matching rows
    pub fn get_all(&self, sql: &str, params: &[JsonValue]) -> Result<QueryResult> {
        let params = json_to_sql_params(params);
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
    pub fn get_optional(&self, sql: &str, params: &[JsonValue]) -> Result<Option<RowResult>> {
        let result = self.get_all(sql, params)?;
        Ok(result.rows.into_iter().next())
    }

    /// Begin a new transaction
    pub fn begin_transaction(&mut self, is_write: bool) -> Result<String> {
        let tx_id = Uuid::new_v4().to_string();

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
            },
        );

        Ok(tx_id)
    }

    /// Commit a transaction
    pub fn commit_transaction(&mut self, tx_id: &str) -> Result<()> {
        let tx = self
            .transactions
            .get_mut(tx_id)
            .ok_or_else(|| Error::TransactionNotFound(tx_id.to_string()))?;

        if tx.completed {
            return Err(Error::TransactionCompleted(tx_id.to_string()));
        }

        self.conn.execute("COMMIT", [])?;
        tx.completed = true;
        self.transactions.remove(tx_id);

        Ok(())
    }

    /// Rollback a transaction
    pub fn rollback_transaction(&mut self, tx_id: &str) -> Result<()> {
        let tx = self
            .transactions
            .get_mut(tx_id)
            .ok_or_else(|| Error::TransactionNotFound(tx_id.to_string()))?;

        if tx.completed {
            return Err(Error::TransactionCompleted(tx_id.to_string()));
        }

        self.conn.execute("ROLLBACK", [])?;
        tx.completed = true;
        self.transactions.remove(tx_id);

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

/// Convert JSON values to SQLite-compatible parameters
fn json_to_sql_params(params: &[JsonValue]) -> Vec<rusqlite::types::Value> {
    params
        .iter()
        .map(|v| match v {
            JsonValue::Null => rusqlite::types::Value::Null,
            JsonValue::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
            JsonValue::Number(n) => {
                if let Some(i) = n.as_i64() {
                    rusqlite::types::Value::Integer(i)
                } else if let Some(f) = n.as_f64() {
                    rusqlite::types::Value::Real(f)
                } else {
                    rusqlite::types::Value::Null
                }
            }
            JsonValue::String(s) => rusqlite::types::Value::Text(s.clone()),
            JsonValue::Array(_) | JsonValue::Object(_) => {
                rusqlite::types::Value::Text(v.to_string())
            }
        })
        .collect()
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
