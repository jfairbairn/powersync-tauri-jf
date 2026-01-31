import { invoke } from '@tauri-apps/api/core';
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
import { BaseObserver } from '@powersync/common';
import type { ExecuteResult, QueryResult as TauriQueryResult } from './types';

/**
 * DBAdapter implementation that bridges to the Tauri PowerSync plugin.
 *
 * This adapter provides the SQLite interface that PowerSync expects,
 * routing all database operations through Tauri's IPC to native Rust SQLite.
 */
export class TauriDBAdapter extends BaseObserver<DBAdapterListener> implements DBAdapter {
  readonly name: string;
  private closed = false;

  constructor(name: string) {
    super();
    this.name = name;
  }

  /**
   * Open the database connection
   */
  async open(): Promise<void> {
    await invoke('plugin:powersync|open', { name: this.name });
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await invoke('plugin:powersync|close', { name: this.name });
  }

  /**
   * Execute a SQL statement
   */
  async execute(sql: string, params?: any[]): Promise<QueryResult> {
    const result = await invoke<ExecuteResult>('plugin:powersync|execute', {
      name: this.name,
      sql,
      params: params ?? [],
    });

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
   * Execute a SQL statement and return raw results (array of arrays)
   */
  async executeRaw(sql: string, params?: any[]): Promise<any[][]> {
    const result = await invoke<TauriQueryResult>('plugin:powersync|get_all', {
      name: this.name,
      sql,
      params: params ?? [],
    });

    // Convert row objects to arrays of values
    return result.rows.map((row) => result.columns.map((col) => row[col]));
  }

  /**
   * Execute a read-only query and return all results
   */
  async getAll<T>(sql: string, params?: any[]): Promise<T[]> {
    const result = await invoke<TauriQueryResult>('plugin:powersync|get_all', {
      name: this.name,
      sql,
      params: params ?? [],
    });

    return result.rows as T[];
  }

  /**
   * Execute a read-only query and return a single optional result
   */
  async getOptional<T>(sql: string, params?: any[]): Promise<T | null> {
    const result = await invoke<Record<string, unknown> | null>('plugin:powersync|get_optional', {
      name: this.name,
      sql,
      params: params ?? [],
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
    const result = await invoke<ExecuteResult>('plugin:powersync|execute_batch', {
      name: this.name,
      sql,
      paramsBatch: paramsBatch ?? [],
    });

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
   */
  private async transaction<T>(
    callback: (tx: Transaction) => Promise<T>,
    isWrite: boolean
  ): Promise<T> {
    const txId = await invoke<string>('plugin:powersync|begin_transaction', {
      name: this.name,
      isWrite,
    });

    const self = this;

    const tx: Transaction = {
      execute: async (sql: string, params?: any[]): Promise<QueryResult> => {
        const result = await invoke<ExecuteResult>('plugin:powersync|execute', {
          name: self.name,
          sql,
          params: params ?? [],
        });

        return {
          insertId: result.lastInsertRowid,
          rowsAffected: result.changes,
          rows: {
            _array: [],
            length: 0,
            item: () => null,
          },
        };
      },

      executeRaw: async (sql: string, params?: any[]): Promise<any[][]> => {
        const result = await invoke<TauriQueryResult>('plugin:powersync|get_all', {
          name: self.name,
          sql,
          params: params ?? [],
        });
        return result.rows.map((row) => result.columns.map((col) => row[col]));
      },

      getAll: async <R>(sql: string, params?: any[]): Promise<R[]> => {
        const result = await invoke<TauriQueryResult>('plugin:powersync|get_all', {
          name: self.name,
          sql,
          params: params ?? [],
        });
        return result.rows as R[];
      },

      getOptional: async <R>(sql: string, params?: any[]): Promise<R | null> => {
        const result = await invoke<Record<string, unknown> | null>(
          'plugin:powersync|get_optional',
          {
            name: self.name,
            sql,
            params: params ?? [],
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
        await invoke('plugin:powersync|rollback_transaction', {
          name: self.name,
          txId,
        });
        return { rowsAffected: 0, rows: { _array: [], length: 0, item: () => null } };
      },

      commit: async (): Promise<QueryResult> => {
        await invoke('plugin:powersync|commit_transaction', {
          name: self.name,
          txId,
        });
        return { rowsAffected: 0, rows: { _array: [], length: 0, item: () => null } };
      },
    };

    try {
      const result = await callback(tx);
      await invoke('plugin:powersync|commit_transaction', {
        name: this.name,
        txId,
      });
      return result;
    } catch (error) {
      try {
        await invoke('plugin:powersync|rollback_transaction', {
          name: this.name,
          txId,
        });
      } catch {
        // Ignore rollback errors
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
}
