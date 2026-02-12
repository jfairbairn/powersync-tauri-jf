import { invoke as rawInvoke } from '@tauri-apps/api/core';

/**
 * Tauri's invoke() rejects with a plain string on Rust errors.
 * PowerSync expects Error objects (reads .name/.message/.stack).
 * This wrapper ensures rejections are always proper Error instances.
 */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await rawInvoke<T>(cmd, args);
  } catch (e) {
    if (e instanceof Error) throw e;
    throw new Error(typeof e === 'string' ? e : JSON.stringify(e));
  }
}
import type {
  DBAdapter,
  DBAdapterListener,
  DBLockOptions,
  LockContext,
  QueryResult,
  Transaction,
  BatchedUpdateNotification,
  UpdateNotification,
} from '@powersync/common';
import { BaseObserver, RowUpdateType } from '@powersync/common';
import type { ExecuteResult, QueryResult as TauriQueryResult, CrudEntry } from './types';

// PowerSync internal table name for CRUD entries
const PS_CRUD_TABLE = 'ps_crud';

/**
 * Tagged union type for SQL parameters.
 * This matches the Rust SqlParam enum for proper serialization.
 */
type SqlParam =
  | { type: 'null' }
  | { type: 'bool'; value: boolean }
  | { type: 'int'; value: number }
  | { type: 'real'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; value: number[] };

/**
 * Convert a JavaScript value to a typed SqlParam for Rust.
 * This ensures blobs and other types are properly serialized.
 */
function toSqlParam(p: unknown): SqlParam {
  if (p === null || p === undefined) {
    return { type: 'null' };
  }
  if (typeof p === 'boolean') {
    return { type: 'bool', value: p };
  }
  if (typeof p === 'number') {
    // Distinguish integers from floats
    return Number.isInteger(p)
      ? { type: 'int', value: p }
      : { type: 'real', value: p };
  }
  if (typeof p === 'string') {
    return { type: 'text', value: p };
  }
  if (p instanceof Uint8Array) {
    return { type: 'blob', value: Array.from(p) };
  }
  if (ArrayBuffer.isView(p)) {
    // Handle other typed arrays
    return { type: 'blob', value: Array.from(new Uint8Array(p.buffer, p.byteOffset, p.byteLength)) };
  }
  if (p instanceof ArrayBuffer) {
    return { type: 'blob', value: Array.from(new Uint8Array(p)) };
  }
  // Fallback: serialize as JSON text
  return { type: 'text', value: JSON.stringify(p) };
}

/**
 * Convert an array of parameters to typed SqlParams.
 */
function toSqlParams(params: unknown[] | undefined): SqlParam[] {
  if (!params) return [];
  return params.map(toSqlParam);
}

// PowerSync internal table for sync operations
const PS_OPERATIONS_TABLE = 'powersync_operations';

/**
 * Extract table names from SQL statement for change notifications.
 * This is a simple parser that handles common cases.
 */
function extractTablesFromSql(sql: string): string[] {
  const tables: string[] = [];

  // Match INSERT INTO table_name
  const insertMatch = sql.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'`]?(\w+)["'`]?/i);
  if (insertMatch) {
    const table = insertMatch[1];
    tables.push(table);
    // PowerSync triggers write to ps_crud when user tables are modified
    // Include ps_crud in notifications to trigger CRUD upload
    if (!table.startsWith('ps_') && table !== PS_OPERATIONS_TABLE) {
      tables.push(PS_CRUD_TABLE);
    }
  }

  // Match UPDATE table_name
  const updateMatch = sql.match(/UPDATE\s+["'`]?(\w+)["'`]?/i);
  if (updateMatch) {
    const table = updateMatch[1];
    tables.push(table);
    // PowerSync triggers write to ps_crud when user tables are modified
    if (!table.startsWith('ps_') && table !== PS_OPERATIONS_TABLE) {
      tables.push(PS_CRUD_TABLE);
    }
  }

  // Match DELETE FROM table_name
  const deleteMatch = sql.match(/DELETE\s+FROM\s+["'`]?(\w+)["'`]?/i);
  if (deleteMatch) {
    const table = deleteMatch[1];
    tables.push(table);
    // PowerSync triggers write to ps_crud when user tables are modified
    if (!table.startsWith('ps_') && table !== PS_OPERATIONS_TABLE) {
      tables.push(PS_CRUD_TABLE);
    }
  }

  return tables;
}

/**
 * Check if a table name is a PowerSync internal table.
 * When these tables are modified, user tables may have been updated by the extension.
 */
function isPowerSyncInternalTable(tableName: string): boolean {
  return tableName === 'powersync_operations' ||
         tableName.startsWith('ps_') ||
         tableName.startsWith('ps_data_');
}

/**
 * Determine the operation type from SQL statement.
 */
function getOperationType(sql: string): RowUpdateType | null {
  const sqlUpper = sql.trim().toUpperCase();
  if (sqlUpper.startsWith('INSERT')) {
    return RowUpdateType.SQLITE_INSERT;
  }
  if (sqlUpper.startsWith('UPDATE')) {
    return RowUpdateType.SQLITE_UPDATE;
  }
  if (sqlUpper.startsWith('DELETE')) {
    return RowUpdateType.SQLITE_DELETE;
  }
  return null;
}

/**
 * DBAdapter implementation that bridges to the Tauri PowerSync plugin.
 *
 * This adapter provides the SQLite interface that PowerSync expects,
 * routing all database operations through Tauri's IPC to native Rust SQLite.
 */
export class TauriDBAdapter extends BaseObserver<DBAdapterListener> implements DBAdapter {
  readonly name: string;
  private closed = false;
  private pendingUpdates: Set<string> = new Set();
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private userTables: Set<string> = new Set();

  constructor(name: string) {
    super();
    this.name = name;
  }

  /**
   * Register user table names for sync notifications.
   * Called during schema initialization.
   */
  registerUserTables(tableNames: string[]): void {
    for (const name of tableNames) {
      this.userTables.add(name);
    }
  }

  /**
   * Queue table updates for batched notification.
   * Uses microtask to batch synchronous operations while still firing quickly.
   */
  private queueTableUpdate(tables: string[]): void {
    for (const table of tables) {
      this.pendingUpdates.add(table);
    }

    // Use microtask for immediate but batched notification
    // This fires after the current synchronous code completes
    if (!this.updateTimer) {
      this.updateTimer = setTimeout(() => {
        this.fireTableUpdates();
      }, 0);
    }
  }

  /**
   * Fire pending table update notifications to listeners.
   */
  private fireTableUpdates(): void {
    this.updateTimer = null;
    if (this.pendingUpdates.size === 0) {
      return;
    }

    const tables = Array.from(this.pendingUpdates);
    this.pendingUpdates.clear();

    const event: BatchedUpdateNotification = {
      tables,
      groupedUpdates: {},
      rawUpdates: [],
    };

    this.iterateListeners((cb) => cb.tablesUpdated?.(event));
  }

  /**
   * Open the database connection
   */
  async open(): Promise<void> {
    await invoke('plugin:powersync-jf|open', { name: this.name });
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await invoke('plugin:powersync-jf|close', { name: this.name });
  }

  /**
   * Execute a SQL statement
   */
  async execute(sql: string, params?: any[]): Promise<QueryResult> {
    const result = await invoke<ExecuteResult>('plugin:powersync-jf|execute', {
      name: this.name,
      sql,
      params: toSqlParams(params),
    });

    // Detect table changes and notify listeners
    const detectedTables = extractTablesFromSql(sql);

    // Check if any PowerSync internal tables were modified
    // If so, user tables may have been updated by the extension - notify all of them
    const modifiedInternalTable = detectedTables.some(isPowerSyncInternalTable);

    if (modifiedInternalTable && this.userTables.size > 0) {
      // PowerSync internal operation - notify all user tables
      this.queueTableUpdate(Array.from(this.userTables));
    } else if (detectedTables.length > 0) {
      // Regular write operation - notify detected tables
      this.queueTableUpdate(detectedTables);
    }

    // For SELECT statements, the Rust side returns the actual rows
    const rowsArray = result.rows ?? [];

    return {
      insertId: result.lastInsertRowid,
      rowsAffected: result.changes,
      rows: {
        _array: rowsArray,
        length: rowsArray.length,
        item: (i: number) => rowsArray[i] ?? null,
      },
    };
  }

  /**
   * Execute a SQL statement and return raw results (array of arrays)
   */
  async executeRaw(sql: string, params?: any[]): Promise<any[][]> {
    const result = await invoke<TauriQueryResult>('plugin:powersync-jf|get_all', {
      name: this.name,
      sql,
      params: toSqlParams(params),
    });

    // Convert row objects to arrays of values
    return result.rows.map((row) => result.columns.map((col) => row[col]));
  }

  /**
   * Execute a read-only query and return all results
   */
  async getAll<T>(sql: string, params?: any[]): Promise<T[]> {
    const result = await invoke<TauriQueryResult>('plugin:powersync-jf|get_all', {
      name: this.name,
      sql,
      params: toSqlParams(params),
    });

    return result.rows as T[];
  }

  /**
   * Execute a read-only query and return a single optional result
   */
  async getOptional<T>(sql: string, params?: any[]): Promise<T | null> {
    const result = await invoke<Record<string, unknown> | null>('plugin:powersync-jf|get_optional', {
      name: this.name,
      sql,
      params: toSqlParams(params),
    });

    return result as T | null;
  }

  /**
   * Execute a read-only query and return a single result (throws if not found)
   */
  async get<T>(sql: string, params?: any[]): Promise<T> {
    const result = await this.getOptional<T>(sql, params);
    if (result === null) {
      throw new Error('Query returned no results');
    }
    return result;
  }

  /**
   * Execute a batch of SQL statements with the same SQL but different parameters
   */
  async executeBatch(sql: string, paramsBatch?: any[][]): Promise<QueryResult> {
    const result = await invoke<ExecuteResult>('plugin:powersync-jf|execute_batch', {
      name: this.name,
      sql,
      paramsBatch: (paramsBatch ?? []).map(toSqlParams),
    });

    // Notify listeners about table changes
    // Always notify for batch operations
    const tables = extractTablesFromSql(sql);
    if (tables.length > 0) {
      this.queueTableUpdate(tables);
    }

    return {
      insertId: result.lastInsertRowid,
      rowsAffected: result.changes,
      rows: {
        _array: [],
        length: 0,
        item: () => null,
      },
    };
  }

  /**
   * Run a callback within a read transaction
   */
  async readTransaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    options?: DBLockOptions
  ): Promise<T> {
    return this.transaction(callback, false);
  }

  /**
   * Run a callback within a write transaction
   */
  async writeTransaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    options?: DBLockOptions
  ): Promise<T> {
    return this.transaction(callback, true);
  }

  /**
   * Internal transaction implementation
   * The Rust side handles nesting automatically via savepoints.
   */
  private async transaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    isWrite: boolean
  ): Promise<T> {
    // Always use begin_transaction - Rust side handles nesting with savepoints
    const txId = await invoke<string>('plugin:powersync-jf|begin_transaction', {
      name: this.name,
      isWrite,
    });

    const self = this;
    // Track tables modified during this transaction
    const modifiedTables = new Set<string>();
    // Track if transaction was already finalized by callback
    let finalized = false;

    const tx: Transaction = {
      execute: async (sql: string, params?: any[]): Promise<QueryResult> => {
        const result = await invoke<ExecuteResult>('plugin:powersync-jf|execute', {
          name: self.name,
          sql,
          params: toSqlParams(params),
        });

        // Track table changes for notification after commit
        // Always track for INSERT/UPDATE/DELETE (views with triggers may not report changes)
        const tables = extractTablesFromSql(sql);
        for (const table of tables) {
          modifiedTables.add(table);
        }

        // For SELECT statements, the Rust side returns the actual rows
        const rowsArray = result.rows ?? [];

        return {
          insertId: result.lastInsertRowid,
          rowsAffected: result.changes,
          rows: {
            _array: rowsArray,
            length: rowsArray.length,
            item: (i: number) => rowsArray[i] ?? null,
          },
        };
      },

      executeRaw: async (sql: string, params?: any[]): Promise<any[][]> => {
        const result = await invoke<TauriQueryResult>('plugin:powersync-jf|get_all', {
          name: self.name,
          sql,
          params: toSqlParams(params),
        });
        // powersync_control() is a SELECT that internally modifies user tables.
        // extractTablesFromSql() can't detect this, so notify all user tables.
        if (sql.includes('powersync_control') && self.userTables.size > 0) {
          for (const table of self.userTables) {
            modifiedTables.add(table);
          }
        }
        return result.rows.map((row) => result.columns.map((col) => row[col]));
      },

      getAll: async <R>(sql: string, params?: any[]): Promise<R[]> => {
        const result = await invoke<TauriQueryResult>('plugin:powersync-jf|get_all', {
          name: self.name,
          sql,
          params: toSqlParams(params),
        });
        return result.rows as R[];
      },

      getOptional: async <R>(sql: string, params?: any[]): Promise<R | null> => {
        const result = await invoke<Record<string, unknown> | null>(
          'plugin:powersync-jf|get_optional',
          {
            name: self.name,
            sql,
            params: toSqlParams(params),
          }
        );
        return result as R | null;
      },

      get: async <R>(sql: string, params?: any[]): Promise<R> => {
        const result = await tx.getOptional<R>(sql, params);
        if (result === null) {
          throw new Error('Query returned no results');
        }
        return result;
      },

      rollback: async (): Promise<QueryResult> => {
        finalized = true;
        await invoke('plugin:powersync-jf|rollback_transaction', {
          name: self.name,
          txId,
        });
        return { rowsAffected: 0, rows: { _array: [], length: 0, item: () => null } };
      },

      commit: async (): Promise<QueryResult> => {
        finalized = true;
        await invoke('plugin:powersync-jf|commit_transaction', {
          name: self.name,
          txId,
        });
        // Notify listeners about tables modified in the transaction
        if (modifiedTables.size > 0) {
          self.queueTableUpdate(Array.from(modifiedTables));
        }
        return { rowsAffected: 0, rows: { _array: [], length: 0, item: () => null } };
      },
    };

    try {
      const result = await callback(tx);

      // Only commit if not already finalized by the callback
      if (!finalized) {
        await invoke('plugin:powersync-jf|commit_transaction', {
          name: this.name,
          txId,
        });

        // Notify listeners about tables modified in the transaction
        if (modifiedTables.size > 0) {
          this.queueTableUpdate(Array.from(modifiedTables));
        }
      }

      return result;
    } catch (error) {
      // Only rollback if not already finalized
      if (!finalized) {
        try {
          await invoke('plugin:powersync-jf|rollback_transaction', {
            name: this.name,
            txId,
          });
        } catch {
          // Ignore rollback errors
        }
      }
      throw error;
    }
  }

  /**
   * Acquire a read lock and run a callback
   */
  async readLock<T>(callback: (ctx: LockContext) => Promise<T>, options?: DBLockOptions): Promise<T> {
    const ctx: LockContext = {
      execute: (sql, params) => this.execute(sql, params),
      executeRaw: (sql, params) => this.executeRaw(sql, params),
      getAll: (sql, params) => this.getAll(sql, params),
      getOptional: (sql, params) => this.getOptional(sql, params),
      get: (sql, params) => this.get(sql, params),
    };
    return callback(ctx);
  }

  /**
   * Acquire a write lock and run a callback
   */
  async writeLock<T>(callback: (ctx: LockContext) => Promise<T>, options?: DBLockOptions): Promise<T> {
    return this.writeTransaction(async (tx) => {
      const ctx: LockContext = {
        execute: (sql, params) => tx.execute(sql, params),
        executeRaw: (sql, params) => tx.executeRaw(sql, params),
        getAll: (sql, params) => tx.getAll(sql, params),
        getOptional: (sql, params) => tx.getOptional(sql, params),
        get: (sql, params) => tx.get(sql, params),
      };
      return callback(ctx);
    });
  }

  /**
   * Refresh the schema - no-op for now
   */
  async refreshSchema(): Promise<void> {
    // No-op - schema is managed by PowerSync extension
  }

  // =====================================================
  // PowerSync Extension Methods
  // =====================================================

  /**
   * Check if the PowerSync extension is loaded
   */
  async isPowerSyncLoaded(): Promise<boolean> {
    return invoke<boolean>('plugin:powersync-jf|is_powersync_loaded', {
      name: this.name,
    });
  }

  /**
   * Get the PowerSync extension version
   */
  async getPowerSyncVersion(): Promise<string> {
    return invoke<string>('plugin:powersync-jf|get_powersync_version', {
      name: this.name,
    });
  }

  /**
   * Replace the PowerSync schema
   * @param schemaJson JSON-encoded schema definition
   */
  async replaceSchema(schemaJson: string): Promise<void> {
    await invoke('plugin:powersync-jf|replace_schema', {
      name: this.name,
      schemaJson,
    });
  }

  /**
   * Execute a PowerSync control operation
   * @param op Operation name
   * @param payload JSON-encoded operation payload
   * @returns JSON-encoded result
   */
  async powerSyncControl(op: string, payload: string): Promise<string> {
    return invoke<string>('plugin:powersync-jf|powersync_control', {
      name: this.name,
      op,
      payload,
    });
  }

  /**
   * Get a batch of pending CRUD entries
   * @param limit Maximum number of entries to return (default: 100)
   */
  async getCrudBatch(limit?: number): Promise<CrudEntry[]> {
    return invoke<CrudEntry[]>('plugin:powersync-jf|get_crud_batch', {
      name: this.name,
      limit,
    });
  }

  /**
   * Remove CRUD entries up to and including the given ID
   * @param crudId Maximum CRUD entry ID to remove
   */
  async removeCrud(crudId: number): Promise<void> {
    await invoke('plugin:powersync-jf|remove_crud', {
      name: this.name,
      crudId,
    });
  }

  /**
   * Check if there are pending CRUD entries
   */
  async hasPendingCrud(): Promise<boolean> {
    return invoke<boolean>('plugin:powersync-jf|has_pending_crud', {
      name: this.name,
    });
  }

  /**
   * Get the current write checkpoint
   */
  async getWriteCheckpoint(): Promise<string | null> {
    return invoke<string | null>('plugin:powersync-jf|get_write_checkpoint', {
      name: this.name,
    });
  }
}
