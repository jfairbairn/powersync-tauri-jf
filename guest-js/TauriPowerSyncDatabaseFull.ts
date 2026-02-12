import type { BSON } from 'bson';
import {
  AbstractPowerSyncDatabase,
  type PowerSyncDatabaseOptionsWithDBAdapter,
  type PowerSyncBackendConnector,
  type RequiredAdditionalConnectionOptions,
  type StreamingSyncImplementation,
  type BucketStorageAdapter,
  type Schema,
  SqliteBucketStorage,
  AbstractRemote,
  type CreateSyncImplementationOptions,
  type RemoteConnector,
} from '@powersync/common';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { TauriDBAdapter } from './TauriDBAdapter';
import { TauriStreamingSyncImplementation } from './TauriStreamingSyncImplementation';
import { TauriWebSocket } from './TauriWebSocket';

/**
 * Options for creating a TauriPowerSyncDatabaseFull
 */
export interface TauriPowerSyncDatabaseFullOptions {
  /**
   * Database filename (without extension)
   */
  database: string;

  /**
   * PowerSync schema definition
   */
  schema: Schema;

  /**
   * Optional logger
   */
  logger?: any;
}

/**
 * Tauri-specific remote connector implementation.
 * Uses Tauri's HTTP plugin for fetch (bypasses CORS) and Tauri's WebSocket
 * plugin for streaming sync (bypasses tauri://localhost origin restrictions).
 */
class TauriRemote extends AbstractRemote {
  constructor(connector: RemoteConnector) {
    super(connector, undefined, {
      socketUrlTransformer: (url: string) => url.replace(/^http/, 'ws'),
      fetchImplementation: tauriFetch,
    });
  }

  async getBSON(): Promise<typeof BSON> {
    const bson = await import('bson');
    return bson as typeof BSON;
  }

  /**
   * Use Tauri's WebSocket plugin instead of the WebView's built-in WebSocket.
   * The built-in WebSocket sends Origin: tauri://localhost which sync servers reject.
   */
  createSocket(url: string): WebSocket {
    return new TauriWebSocket(url) as unknown as WebSocket;
  }
}

/**
 * Full PowerSync database implementation for Tauri with sync support.
 *
 * This extends AbstractPowerSyncDatabase to provide complete PowerSync
 * functionality including:
 * - Real-time sync with PowerSync backend
 * - CRUD tracking and upload
 * - Bucket storage for efficient sync
 *
 * @example
 * ```typescript
 * import { TauriPowerSyncDatabaseFull as PowerSyncDatabase } from '@powersync/tauri';
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
 * // Use like a normal database
 * await db.execute('INSERT INTO todos (id, description) VALUES (uuid(), ?)', ['Buy milk']);
 * const todos = await db.getAll('SELECT * FROM todos');
 * ```
 */
export class TauriPowerSyncDatabaseFull extends AbstractPowerSyncDatabase {
  constructor(options: TauriPowerSyncDatabaseFullOptions) {
    const adapter = new TauriDBAdapter(options.database);

    // Register user table names for sync notifications
    const tableNames = options.schema.tables.map((t) => t.name);
    adapter.registerUserTables(tableNames);

    const dbOptions: PowerSyncDatabaseOptionsWithDBAdapter = {
      database: adapter,
      schema: options.schema,
      logger: options.logger,
    };

    super(dbOptions);
  }

  /**
   * Get the underlying Tauri adapter (casts this.database to TauriDBAdapter)
   */
  private get tauriAdapter(): TauriDBAdapter {
    return this.database as TauriDBAdapter;
  }

  /**
   * Initialize the database.
   * Opens the underlying SQLite connection and sets up PowerSync.
   */
  async _initialize(): Promise<void> {
    await this.tauriAdapter.open();
  }

  /**
   * Open a database adapter from settings.
   * Not used in Tauri since we create the adapter directly.
   */
  protected openDBAdapter(): TauriDBAdapter {
    // This should not be called since we pass a DBAdapter directly
    throw new Error('openDBAdapter should not be called - adapter is provided directly');
  }

  protected generateBucketStorageAdapter(): BucketStorageAdapter {
    return new SqliteBucketStorage(this.database, this.logger);
  }

  /**
   * Generate the sync stream implementation.
   * Uses TauriStreamingSyncImplementation for Tauri-specific behavior.
   */
  protected generateSyncStreamImplementation(
    connector: PowerSyncBackendConnector,
    options: CreateSyncImplementationOptions & RequiredAdditionalConnectionOptions
  ): StreamingSyncImplementation {
    const remote = new TauriRemote(connector);
    return new TauriStreamingSyncImplementation({
      adapter: this.bucketStorageAdapter,
      remote,
      uploadCrud: async () => {
        await connector.uploadData(this);
      },
      identifier: this.database.name,
      logger: this.logger,
      ...options,
    });
  }

  /**
   * Get the underlying Tauri adapter for direct access to PowerSync extension methods.
   */
  getTauriAdapter(): TauriDBAdapter {
    return this.tauriAdapter;
  }

  /**
   * Check if the PowerSync extension is loaded.
   */
  async isPowerSyncLoaded(): Promise<boolean> {
    return this.tauriAdapter.isPowerSyncLoaded();
  }

  /**
   * Get the PowerSync extension version.
   */
  async getPowerSyncVersion(): Promise<string> {
    return this.tauriAdapter.getPowerSyncVersion();
  }
}

// Re-export as a more user-friendly name
export { TauriPowerSyncDatabaseFull as PowerSyncDatabase };
