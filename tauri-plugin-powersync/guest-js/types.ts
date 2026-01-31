import type { QueryResult as PowerSyncQueryResult } from '@powersync/common';

/**
 * Result of an execute operation
 */
export interface ExecuteResult {
  changes: number;
  lastInsertRowid: number;
}

/**
 * Result of a query operation
 */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * Options for opening a PowerSync database
 */
export interface PowerSyncDatabaseOptions {
  /**
   * Database name (will be used as filename)
   */
  name: string;

  /**
   * PowerSync schema definition
   */
  schema: any; // Schema from @powersync/common

  /**
   * PowerSync backend connector
   */
  connector?: any; // PowerSyncBackendConnector from @powersync/common
}

/**
 * Transaction context passed to transaction callbacks
 */
export interface TransactionContext {
  /**
   * Execute a SQL statement within the transaction
   */
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;

  /**
   * Query all rows within the transaction
   */
  getAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Query a single optional row within the transaction
   */
  getOptional<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;

  /**
   * Rollback the transaction
   */
  rollback(): Promise<void>;
}
