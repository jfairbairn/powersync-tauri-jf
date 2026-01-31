/**
 * @powersync/tauri - PowerSync Tauri Plugin
 *
 * This package provides a SQLite database adapter for Tauri applications
 * using native Rust SQLite instead of WASM SQLite.
 *
 * ## Quick Start with Full Sync
 *
 * For full PowerSync sync functionality:
 *
 * @example
 * ```typescript
 * import { PowerSyncDatabase } from '@powersync/tauri';
 * import { Schema, Table, column } from '@powersync/common';
 *
 * const schema = new Schema({
 *   todos: new Table({
 *     description: column.text,
 *     completed: column.integer,
 *   }),
 * });
 *
 * const db = new PowerSyncDatabase({
 *   database: 'myapp',
 *   schema,
 * });
 *
 * await db.init();
 *
 * // Connect to PowerSync service
 * await db.connect(myBackendConnector);
 *
 * // Use like a normal database - changes sync automatically
 * await db.execute('INSERT INTO todos (id, description) VALUES (uuid(), ?)', ['Buy milk']);
 * const todos = await db.getAll('SELECT * FROM todos');
 * ```
 *
 * ## Simple Database (No Sync)
 *
 * For simple SQLite operations without sync:
 *
 * @example
 * ```typescript
 * import { TauriPowerSyncDatabase } from '@powersync/tauri';
 *
 * const db = new TauriPowerSyncDatabase({ database: 'myapp' });
 * await db.init();
 *
 * await db.execute('CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT)');
 * await db.execute('INSERT INTO todos (id, title) VALUES (?, ?)', ['1', 'Buy milk']);
 *
 * const todos = await db.getAll('SELECT * FROM todos');
 * console.log(todos);
 * ```
 *
 * ## Using the Low-Level Adapter
 *
 * For direct adapter access:
 *
 * @example
 * ```typescript
 * import { TauriDBAdapter } from '@powersync/tauri';
 *
 * const adapter = new TauriDBAdapter('myapp');
 * await adapter.open();
 *
 * // Check if PowerSync extension is loaded
 * const loaded = await adapter.isPowerSyncLoaded();
 * if (loaded) {
 *   const version = await adapter.getPowerSyncVersion();
 *   console.log('PowerSync version:', version);
 * }
 * ```
 *
 * @packageDocumentation
 */

// Full sync database (recommended for most users)
export {
  TauriPowerSyncDatabaseFull,
  PowerSyncDatabase,
  type TauriPowerSyncDatabaseFullOptions,
} from './TauriPowerSyncDatabaseFull';

// Simple database (no sync, for offline-only or simple use cases)
export { TauriPowerSyncDatabase, type TauriPowerSyncDatabaseOptions } from './TauriPowerSyncDatabase';

// Low-level adapter
export { TauriDBAdapter } from './TauriDBAdapter';

// Streaming sync implementation (for advanced use cases)
export { TauriStreamingSyncImplementation } from './TauriStreamingSyncImplementation';

// Types
export type {
  ExecuteResult,
  QueryResult,
  TransactionContext,
  CrudEntry,
  CrudOperationData,
  SyncStatus,
  UploadQueueStats,
  DownloadProgress,
} from './types';
