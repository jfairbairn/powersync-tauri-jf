use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Database not found: {0}")]
    DatabaseNotFound(String),

    #[error("Transaction not found: {0}")]
    TransactionNotFound(String),

    #[error("Transaction already completed: {0}")]
    TransactionCompleted(String),

    #[error("Invalid parameter: {0}")]
    InvalidParameter(String),

    #[error("Lock error: {0}")]
    Lock(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Extension not found: {0}")]
    ExtensionNotFound(String),

    #[error("Extension load error: {0}")]
    ExtensionLoad(String),

    #[error("PowerSync not initialized")]
    PowerSyncNotInitialized,
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
