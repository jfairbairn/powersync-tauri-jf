use crate::error::{Error, Result};
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
}

impl PowerSyncConnection {
    /// Open a new PowerSync database connection
    pub fn open(name: &str, app_data_dir: &PathBuf) -> Result<Self> {
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

        // Initialize PowerSync extension
        // The powersync_core crate registers via sqlite3_auto_extension
        // so functions should be available automatically

        // Enable WAL mode for better concurrent access
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        // Initialize PowerSync if the function exists
        let has_powersync: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_function_list WHERE name = 'powersync_init'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if has_powersync {
            conn.execute("SELECT powersync_init()", [])?;
        }

        Ok(Self {
            conn,
            transactions: HashMap::new(),
            db_path,
        })
    }

    /// Execute a SQL statement with parameters
    pub fn execute(&mut self, sql: &str, params: &[JsonValue]) -> Result<ExecuteResult> {
        let params = json_to_sql_params(params);
        let changes = self.conn.execute(sql, params_from_iter(params))?;
        let last_insert_rowid = self.conn.last_insert_rowid();

        Ok(ExecuteResult {
            changes: changes as i64,
            last_insert_rowid,
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
}

/// Result of an execute operation
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExecuteResult {
    pub changes: i64,
    #[serde(rename = "lastInsertRowid")]
    pub last_insert_rowid: i64,
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
}

impl DatabaseManager {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            databases: HashMap::new(),
            app_data_dir,
        }
    }

    pub fn open(&mut self, name: &str) -> Result<()> {
        if !self.databases.contains_key(name) {
            let conn = PowerSyncConnection::open(name, &self.app_data_dir)?;
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
