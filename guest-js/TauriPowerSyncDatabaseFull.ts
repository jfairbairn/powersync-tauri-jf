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
 * Uses Tauri's HTTP plugin which bypasses CORS restrictions.
 */
class TauriRemote extends AbstractRemote {
  constructor(connector: RemoteConnector) {
    // Wrap Tauri fetch with logging
    const debugFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      console.log('[TauriRemote] fetch:', url);
      console.log('[TauriRemote] init:', init);
      try {
        const response = await tauriFetch(input, init);
        console.log('[TauriRemote] response:', response.status, response.statusText);
        console.log('[TauriRemote] response.body type:', response.body?.constructor?.name);
        console.log('[TauriRemote] response.body:', response.body);

        // Try to read body for debugging
        if (url.includes('sync/stream')) {
          console.log('[TauriRemote] response.body:', response.body);
          console.log('[TauriRemote] response.bodyUsed:', response.bodyUsed);

          try {
            const clone = response.clone();
            console.log('[TauriRemote] clone.body:', clone.body);

            if (clone.body) {
              const reader = clone.body.getReader();
              console.log('[TauriRemote] got reader:', reader);

              reader.read().then(({ done, value }) => {
                console.log('[TauriRemote] first chunk - done:', done, 'length:', value?.length);
                if (value) {
                  const text = new TextDecoder().decode(value);
                  console.log('[TauriRemote] chunk text:', text.substring(0, 500));
                }
              }).catch(e => {
                console.error('[TauriRemote] reader.read() error:', e);
              });
            } else {
              console.log('[TauriRemote] clone.body is null!');
            }
          } catch (e) {
            console.error('[TauriRemote] clone/read error:', e);
          }
        }

        return response;
      } catch (e) {
        console.error('[TauriRemote] fetch error:', e);
        throw e;
      }
    };

    // Use Tauri's HTTP client which bypasses CORS
    super(connector, undefined, {
      socketUrlTransformer: (url: string) => {
        // Transform http(s):// to ws(s)://
        return url.replace(/^http/, 'ws');
      },
      // Use wrapped Tauri's fetch for debugging
      fetchImplementation: debugFetch,
    });
  }

  async getBSON(): Promise<typeof BSON> {
    // Dynamically import BSON when needed
    const bson = await import('bson');
    return bson as typeof BSON;
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

  /**
   * Generate the bucket storage adapter.
   * Uses SqliteBucketStorage from @powersync/common which works with any DBAdapter.
   */
  protected generateBucketStorageAdapter(): BucketStorageAdapter {
    console.log('[TauriPowerSyncDatabaseFull] Creating SqliteBucketStorage with database:', this.database.name);
    const storage = new SqliteBucketStorage(this.database, this.logger);

    // Wrap methods to debug
    const originalGetBucketStates = storage.getBucketStates.bind(storage);
    storage.getBucketStates = async () => {
      const result = await originalGetBucketStates();
      console.log('[BucketStorage] getBucketStates:', result);
      return result;
    };

    // Debug saveSyncData
    const originalSaveSyncData = storage.saveSyncData.bind(storage);
    storage.saveSyncData = async (batch: any) => {
      console.log('[BucketStorage] saveSyncData called with batch:', JSON.stringify(batch).substring(0, 500));
      try {
        const result = await originalSaveSyncData(batch);
        console.log('[BucketStorage] saveSyncData result:', result);
        return result;
      } catch (e) {
        console.error('[BucketStorage] saveSyncData error:', e);
        throw e;
      }
    };

    // Debug syncLocalDatabase
    const originalSyncLocalDatabase = storage.syncLocalDatabase.bind(storage);
    storage.syncLocalDatabase = async (checkpoint: any) => {
      console.log('[BucketStorage] syncLocalDatabase called with checkpoint:', checkpoint);
      try {
        const result = await originalSyncLocalDatabase(checkpoint);
        console.log('[BucketStorage] syncLocalDatabase result:', result);
        return result;
      } catch (e) {
        console.error('[BucketStorage] syncLocalDatabase error:', e);
        throw e;
      }
    };

    // Debug hasCrud
    const originalHasCrud = storage.hasCrud.bind(storage);
    storage.hasCrud = async () => {
      const result = await originalHasCrud();
      console.log('[BucketStorage] hasCrud:', result);
      return result;
    };

    // Debug updateLocalTarget
    const originalUpdateLocalTarget = storage.updateLocalTarget.bind(storage);
    storage.updateLocalTarget = async (cb: any) => {
      console.log('[BucketStorage] updateLocalTarget called');
      try {
        const result = await originalUpdateLocalTarget(cb);
        console.log('[BucketStorage] updateLocalTarget result:', result);
        return result;
      } catch (e) {
        console.error('[BucketStorage] updateLocalTarget error:', e);
        throw e;
      }
    };

    return storage;
  }

  /**
   * Generate the sync stream implementation.
   * Uses TauriStreamingSyncImplementation for Tauri-specific behavior.
   */
  protected generateSyncStreamImplementation(
    connector: PowerSyncBackendConnector,
    options: CreateSyncImplementationOptions & RequiredAdditionalConnectionOptions
  ): StreamingSyncImplementation {
    return new TauriStreamingSyncImplementation({
      adapter: this.bucketStorageAdapter,
      remote: new TauriRemote(connector),
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
