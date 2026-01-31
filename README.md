# tauri-plugin-powersync-jf

A Tauri 2.0 plugin that provides PowerSync with native SQLite, designed as a drop-in replacement for `@powersync/web` that eliminates WASM CPU overhead.

## Why This Plugin?

WebKit-based apps (Tauri on macOS/iOS, etc.) suffer from severe CPU usage when running SQLite via WASM. The standard `@powersync/web` package uses WASM SQLite which causes the CPU to spin at 100%+ even when idle.

This plugin solves that by running SQLite natively via Rust (rusqlite), providing the same PowerSync API but without the WASM overhead.

## Installation

### From Registries (Recommended)

**Rust** (src-tauri/Cargo.toml):

```toml
[dependencies]
tauri-plugin-powersync-jf = "0.1.0"
```

**JavaScript**:

```bash
npm add @jfairbairn/tauri-plugin-powersync-jf
```

### From Git (Development/Beta)

**Rust** (src-tauri/Cargo.toml):

```toml
[dependencies]
tauri-plugin-powersync-jf = { git = "https://github.com/jfairbairn/powersync-tauri" }
```

**JavaScript**:

```bash
npm add github:jfairbairn/powersync-tauri
```

### Register the Plugin (src-tauri/src/lib.rs)

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_powersync_jf::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Configure Permissions (src-tauri/capabilities/default.json)

```json
{
  "permissions": [
    "powersync-jf:default"
  ]
}
```

## Usage

### Full Sync (Recommended)

```typescript
import { PowerSyncDatabase } from '@jfairbairn/tauri-plugin-powersync-jf';
import { Schema, Table, column } from '@powersync/common';

const schema = new Schema({
  todos: new Table({
    description: column.text,
    completed: column.integer,
  }),
});

const db = new PowerSyncDatabase({
  database: 'myapp',
  schema,
});

await db.init();

// Connect to PowerSync service
await db.connect(myBackendConnector);

// Use like a normal database - changes sync automatically
await db.execute('INSERT INTO todos (id, description) VALUES (uuid(), ?)', ['Buy milk']);
const todos = await db.getAll('SELECT * FROM todos');
```

### Simple Database (No Sync)

```typescript
import { TauriPowerSyncDatabase } from '@jfairbairn/tauri-plugin-powersync-jf';

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
import { TauriDBAdapter } from '@jfairbairn/tauri-plugin-powersync-jf';

const adapter = new TauriDBAdapter('myapp');
await adapter.open();

// The adapter implements DBAdapter from @powersync/common
// Use it with PowerSync's AbstractPowerSyncDatabase or other utilities

await adapter.close();
```

## API Reference

### PowerSyncDatabase

Full sync-enabled database - drop-in replacement for `@powersync/web`.

| Method | Description |
|--------|-------------|
| `init()` | Initialize the database connection |
| `connect(connector)` | Connect to PowerSync service and start syncing |
| `disconnect()` | Disconnect from sync service |
| `close()` | Close the database connection |
| `execute(sql, params?)` | Execute a SQL statement |
| `getAll<T>(sql, params?)` | Query all matching rows |
| `getOptional<T>(sql, params?)` | Query single row or null |
| `get<T>(sql, params?)` | Query single row (throws if not found) |
| `watch(sql, params?, options?)` | Reactive query that updates on changes |
| `writeTransaction(callback)` | Run callback in write transaction |
| `readTransaction(callback)` | Run callback in read transaction |

### TauriPowerSyncDatabase

A simplified wrapper for SQLite operations (no sync).

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

## Development

```bash
# Build Rust plugin (also builds PowerSync extension)
cargo build

# Build TypeScript
npm run build

# Run test app
npm run test:tauri:dev

# Run tests
npm test
```

## How It Works

The plugin automatically fetches the [powersync-sqlite-core](https://github.com/powersync-ja/powersync-sqlite-core) source during build if it's not present. This enables installation from both git and package registries without requiring manual submodule initialization.

## License

MIT
