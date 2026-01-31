# tauri-plugin-powersync

A Tauri 2.0 plugin that provides SQLite database functionality using native Rust SQLite, designed for use with PowerSync.

## Why This Plugin?

When using PowerSync with Tauri on macOS, WebKit's SQLite implementation via IndexedDB + WASM can cause high CPU usage. This plugin bypasses that by using native Rust SQLite (rusqlite), providing better performance and reliability.

## Installation

### Rust (src-tauri/Cargo.toml)

```toml
[dependencies]
tauri-plugin-powersync = { git = "https://github.com/your-repo/tauri-plugin-powersync" }
```

### JavaScript

```bash
npm install @powersync/tauri
```

### Register the Plugin (src-tauri/src/lib.rs)

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_powersync::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Configure Permissions (src-tauri/capabilities/default.json)

```json
{
  "permissions": [
    "powersync:default"
  ]
}
```

## Usage

### Simple Database Operations

```typescript
import { TauriPowerSyncDatabase } from '@powersync/tauri';

const db = new TauriPowerSyncDatabase({ database: 'myapp' });
await db.init();

// Create tables
await db.execute(`
  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    description TEXT,
    completed INTEGER DEFAULT 0
  )
`);

// Insert data
await db.execute(
  'INSERT INTO todos (id, description) VALUES (?, ?)',
  ['1', 'Buy groceries']
);

// Query data
const todos = await db.getAll<{ id: string; description: string; completed: number }>(
  'SELECT * FROM todos'
);
console.log(todos);

// Use transactions
await db.writeTransaction(async (tx) => {
  await tx.execute('INSERT INTO todos (id, description) VALUES (?, ?)', ['2', 'Walk dog']);
  await tx.execute('UPDATE todos SET completed = 1 WHERE id = ?', ['1']);
});

// Close when done
await db.close();
```

### Using TauriDBAdapter with @powersync/common

For advanced use cases or integration with PowerSync's sync functionality:

```typescript
import { TauriDBAdapter } from '@powersync/tauri';

const adapter = new TauriDBAdapter('myapp');
await adapter.open();

// The adapter implements DBAdapter from @powersync/common
// Use it with PowerSync's AbstractPowerSyncDatabase or other utilities

await adapter.close();
```

## API Reference

### TauriPowerSyncDatabase

A simplified wrapper for SQLite operations.

| Method | Description |
|--------|-------------|
| `init()` | Initialize the database connection |
| `close()` | Close the database connection |
| `execute(sql, params?)` | Execute a SQL statement |
| `executeRaw(sql, params?)` | Execute and return raw array results |
| `getAll<T>(sql, params?)` | Query all matching rows |
| `getOptional<T>(sql, params?)` | Query single row or null |
| `get<T>(sql, params?)` | Query single row (throws if not found) |
| `executeBatch(sql, paramsBatch?)` | Execute batch statements |
| `readTransaction(callback)` | Run callback in read transaction |
| `writeTransaction(callback)` | Run callback in write transaction |
| `getAdapter()` | Get the underlying TauriDBAdapter |

### TauriDBAdapter

Full DBAdapter implementation compatible with @powersync/common.

Implements: `DBAdapter` interface from `@powersync/common`

## Current Limitations

1. **PowerSync Extension**: The PowerSync SQLite extension (powersync-sqlite-core) is not yet integrated. This means sync-specific SQL functions like `powersync_replace_schema()` are not available.

2. **Sync Functionality**: Full PowerSync sync requires additional implementation. The current version provides local SQLite operations only.

## Development

```bash
# Build Rust plugin
cargo build

# Build TypeScript
npm run build

# Run tests
npm test
```

## License

MIT
