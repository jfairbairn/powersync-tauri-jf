/**
 * @powersync/tauri - PowerSync Tauri Plugin
 *
 * This package provides a SQLite database adapter for Tauri applications
 * using native Rust SQLite instead of WASM SQLite.
 *
 * ## Quick Start
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
 * ## Using with @powersync/common
 *
 * For integration with PowerSync's sync functionality, use TauriDBAdapter:
 *
 * @example
 * ```typescript
 * import { TauriDBAdapter } from '@powersync/tauri';
 * import { AbstractPowerSyncDatabase } from '@powersync/common';
 *
 * // Create the adapter
 * const adapter = new TauriDBAdapter('myapp');
 * await adapter.open();
 *
 * // Use with PowerSync - implementation depends on sync requirements
 * // See @powersync/common documentation for details
 * ```
 *
 * @packageDocumentation
 */

export { TauriPowerSyncDatabase, type TauriPowerSyncDatabaseOptions } from './TauriPowerSyncDatabase';
export { TauriDBAdapter } from './TauriDBAdapter';
export type { ExecuteResult, QueryResult, TransactionContext } from './types';
