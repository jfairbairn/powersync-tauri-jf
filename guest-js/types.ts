import type { QueryResult as PowerSyncQueryResult } from '@powersync/common';

/**
 * Result of an execute operation
 */
export interface ExecuteResult {
  changes: number;
  lastInsertRowid: number;
  /** For SELECT statements, the column names */
  columns?: string[];
  /** For SELECT statements, the query results */
  rows?: Record<string, unknown>[];
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

/**
 * A CRUD entry from the ps_crud table
 */
export interface CrudEntry {
  /**
   * Unique ID of the CRUD entry
   */
  id: number;

  /**
   * Transaction ID (if part of a transaction group)
   */
  txId: number | null;

  /**
   * JSON-encoded operation data
   */
  data: string;
}

/**
 * Parsed CRUD operation data
 */
export interface CrudOperationData {
  /**
   * Operation type: PUT, PATCH, or DELETE
   */
  op: 'PUT' | 'PATCH' | 'DELETE';

  /**
   * Target table name
   */
  type: string;

  /**
   * Row ID
   */
  id: string;

  /**
   * Column data for PUT/PATCH operations
   */
  data?: Record<string, unknown>;
}

/**
 * Sync status information
 */
export interface SyncStatus {
  /**
   * Whether currently connected to the sync service
   */
  connected: boolean;

  /**
   * Whether a sync is currently in progress
   */
  downloading: boolean;

  /**
   * Whether uploads are currently in progress
   */
  uploading: boolean;

  /**
   * Last sync time (ISO 8601 string)
   */
  lastSyncedAt?: string;

  /**
   * Number of pending CRUD operations
   */
  hasPendingChanges: boolean;

  /**
   * Any error that occurred during sync
   */
  error?: string;
}

/**
 * Upload progress information
 */
export interface UploadQueueStats {
  /**
   * Number of pending CRUD operations
   */
  count: number;

  /**
   * Total size of pending operations in bytes
   */
  size?: number;
}

/**
 * Download progress information
 */
export interface DownloadProgress {
  /**
   * Total buckets being synced
   */
  totalBuckets: number;

  /**
   * Buckets completed
   */
  completedBuckets: number;

  /**
   * Total operations to apply
   */
  totalOperations: number;

  /**
   * Operations applied
   */
  appliedOperations: number;
}
