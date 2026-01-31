# PowerSync Tauri Plugin Development Guide

## Project Overview

This is `tauri-plugin-powersync`, a Tauri 2.0 plugin that provides SQLite database functionality using native Rust SQLite (rusqlite). It's designed to replace WASM-based SQLite implementations that cause high CPU usage in WebKit on macOS.

## Current Status

**Working:**
- Native SQLite via rusqlite
- Full DBAdapter interface implementation
- Transactions (read and write)
- Batch operations
- TypeScript bindings

**TODO:**
- Integrate powersync-sqlite-core extension for sync features
- Table update notifications via rusqlite update_hook
- Full sync stream implementation

## Architecture

```
JS: TauriPowerSyncDatabase → TauriDBAdapter → invoke()
                                    ↓
Rust: commands.rs → database.rs → rusqlite (bundled SQLite)
```

## Key Files

| File | Purpose |
|------|---------|
| `src/lib.rs` | Plugin entry, registers commands |
| `src/commands.rs` | Tauri command handlers |
| `src/database.rs` | rusqlite connection management |
| `src/error.rs` | Error types |
| `guest-js/TauriDBAdapter.ts` | DBAdapter implementation |
| `guest-js/TauriPowerSyncDatabase.ts` | Simplified public API |

## Development Commands

```bash
# Build Rust plugin
cargo build

# Build JS bindings
npm run build

# Run tests
npm test

# Format code
cargo fmt && npm run format
```

## Testing in a Tauri App

1. Add to your app's `src-tauri/Cargo.toml`:
   ```toml
   [dependencies]
   tauri-plugin-powersync = { path = "../tauri-plugin-powersync" }
   ```

2. Register in `src-tauri/src/lib.rs`:
   ```rust
   tauri::Builder::default()
       .plugin(tauri_plugin_powersync::init())
   ```

3. Add permissions to `src-tauri/capabilities/default.json`:
   ```json
   { "permissions": ["powersync:default"] }
   ```

4. Use in your frontend:
   ```typescript
   import { TauriPowerSyncDatabase } from '@powersync/tauri';
   const db = new TauriPowerSyncDatabase({ database: 'test' });
   await db.init();
   ```

## PowerSync Extension Integration (TODO)

The powersync-sqlite-core repo provides the SQLite extension, but integrating it requires one of:

1. **Build as loadable extension**: Build `powersync_loadable` as a .dylib/.so and load via `rusqlite::Connection::load_extension()`

2. **Custom SQLite build**: Compile powersync_core with rusqlite's bundled SQLite source

3. **FFI approach**: Use the `sqlite` crate from powersync-sqlite-core which provides raw SQLite bindings

The extension provides:
- `powersync_init()` - Initialize PowerSync
- `powersync_replace_schema(json)` - Set up sync schema
- Internal tables: `ps_data_*`, `ps_crud`, `ps_buckets`

## DBAdapter Interface

TauriDBAdapter implements @powersync/common's DBAdapter:

```typescript
interface DBAdapter {
  name: string;
  execute(sql, params?): Promise<QueryResult>;
  executeRaw(sql, params?): Promise<any[][]>;
  executeBatch(sql, paramsBatch?): Promise<QueryResult>;
  getAll<T>(sql, params?): Promise<T[]>;
  getOptional<T>(sql, params?): Promise<T | null>;
  get<T>(sql, params?): Promise<T>;
  readTransaction<T>(fn): Promise<T>;
  writeTransaction<T>(fn): Promise<T>;
  readLock<T>(fn): Promise<T>;
  writeLock<T>(fn): Promise<T>;
  refreshSchema(): Promise<void>;
  close(): Promise<void>;
}
```

## Common Issues

### "Database not initialized"
Call `db.init()` before using the database.

### Transaction errors
Transactions use IDs passed across IPC. Each transaction must be committed or rolled back before starting another.

### Build errors on different platforms
The bundled SQLite feature in rusqlite compiles SQLite from source. Ensure you have a C compiler (gcc, clang, or MSVC).

## References

- [PowerSync JS SDK](https://github.com/powersync-ja/powersync-js)
- [powersync-sqlite-core](https://github.com/powersync-ja/powersync-sqlite-core)
- [Tauri Plugin Development](https://v2.tauri.app/develop/plugins/)
- [rusqlite docs](https://docs.rs/rusqlite)
