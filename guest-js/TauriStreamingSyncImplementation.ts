import {
  AbstractStreamingSyncImplementation,
  type AbstractStreamingSyncImplementationOptions,
  type LockOptions,
} from '@powersync/common';

/**
 * Streaming sync implementation for Tauri.
 *
 * Tauri applications run as single-instance desktop apps, so we don't need
 * the complex locking mechanisms required for web apps with multiple tabs.
 */
export class TauriStreamingSyncImplementation extends AbstractStreamingSyncImplementation {
  constructor(options: AbstractStreamingSyncImplementationOptions) {
    super(options);
  }

  /**
   * Obtain a lock for sync operations.
   *
   * In Tauri, we use a simple approach since there's no multi-tab concern.
   * The lock callback is executed directly without any actual locking mechanism.
   *
   * For CRUD operations, we rely on SQLite's built-in locking.
   * For sync operations, only one sync stream runs at a time.
   */
  async obtainLock<T>(lockOptions: LockOptions<T>): Promise<T> {
    // Check if aborted before starting
    if (lockOptions.signal?.aborted) {
      throw new Error('Lock aborted');
    }

    // Execute the callback directly
    // SQLite handles the actual database locking
    return lockOptions.callback();
  }
}
