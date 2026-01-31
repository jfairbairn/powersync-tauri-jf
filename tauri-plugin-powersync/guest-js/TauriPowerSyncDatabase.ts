import { TauriDBAdapter } from './TauriDBAdapter';
import type { QueryResult } from '@powersync/common';

/**
 * Options for creating a TauriPowerSyncDatabase
 */
export interface TauriPowerSyncDatabaseOptions {
  /**
   * Database filename (without extension)
   */
  database: string;
}

/**
 * PowerSync database wrapper for Tauri.
 *
 * This provides a simplified interface for SQLite operations using native
 * Rust SQLite via the tauri-plugin-powersync plugin.
 *
 * For full PowerSync sync functionality, use TauriDBAdapter with @powersync/common's
 * AbstractPowerSyncDatabase implementation.
 *
 * @example
 * ```typescript
 * import { TauriPowerSyncDatabase } from '@powersync/tauri';
 *
 * const db = new TauriPowerSyncDatabase({ database: 'myapp' });
 * await db.init();
 *
 * // Create tables
 * await db.execute(`
 *   CREATE TABLE IF NOT EXISTS todos (
 *     id TEXT PRIMARY KEY,
 *     description TEXT,
 *     completed INTEGER DEFAULT 0
 *   )
 * `);
 *
 * // Insert data
 * await db.execute(
 *   'INSERT INTO todos (id, description) VALUES (?, ?)',
 *   ['1', 'Buy groceries']
 * );
 *
 * // Query data
 * const todos = await db.getAll('SELECT * FROM todos');
 * ```
 */
export class TauriPowerSyncDatabase {
  private adapter: TauriDBAdapter;
  private initialized = false;

  constructor(options: TauriPowerSyncDatabaseOptions) {
    this.adapter = new TauriDBAdapter(options.database);
  }

  /**
   * Initialize the database connection
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.adapter.open();
    this.initialized = true;
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (!this.initialized) return;
    await this.adapter.close();
    this.initialized = false;
  }

  /**
   * Get the underlying database adapter.
   * Use this for advanced operations or to integrate with @powersync/common.
   */
  getAdapter(): TauriDBAdapter {
    return this.adapter;
  }

  /**
   * Get the database name
   */
  get name(): string {
    return this.adapter.name;
  }

  /**
   * Execute a SQL statement
   */
  async execute(sql: string, params?: any[]): Promise<QueryResult> {
    this.ensureInitialized();
    return this.adapter.execute(sql, params);
  }

  /**
   * Execute a SQL statement and return raw results
   */
  async executeRaw(sql: string, params?: any[]): Promise<any[][]> {
    this.ensureInitialized();
    return this.adapter.executeRaw(sql, params);
  }

  /**
   * Query all rows
   */
  async getAll<T = Record<string, unknown>>(sql: string, params?: any[]): Promise<T[]> {
    this.ensureInitialized();
    return this.adapter.getAll<T>(sql, params);
  }

  /**
   * Query a single optional row
   */
  async getOptional<T = Record<string, unknown>>(sql: string, params?: any[]): Promise<T | null> {
    this.ensureInitialized();
    return this.adapter.getOptional<T>(sql, params);
  }

  /**
   * Query a single row (throws if not found)
   */
  async get<T = Record<string, unknown>>(sql: string, params?: any[]): Promise<T> {
    this.ensureInitialized();
    return this.adapter.get<T>(sql, params);
  }

  /**
   * Execute a batch of SQL statements
   */
  async executeBatch(sql: string, paramsBatch?: any[][]): Promise<QueryResult> {
    this.ensureInitialized();
    return this.adapter.executeBatch(sql, paramsBatch);
  }

  /**
   * Run a callback within a read transaction
   */
  async readTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    this.ensureInitialized();
    return this.adapter.readTransaction(callback);
  }

  /**
   * Run a callback within a write transaction
   */
  async writeTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    this.ensureInitialized();
    return this.adapter.writeTransaction(callback);
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Database not initialized. Call init() first.');
    }
  }
}
