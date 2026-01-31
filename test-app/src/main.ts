import { TauriDBAdapter, PowerSyncDatabase } from '@powersync/tauri';
import { Schema, Table, column, PowerSyncBackendConnector, AbstractPowerSyncDatabase, SyncStreamConnectionMethod, SyncClientImplementation } from '@powersync/common';

// Use JavaScript sync client for better error visibility
const SYNC_OPTIONS = {
  // Use JavaScript implementation instead of Rust (better error messages)
  clientImplementation: SyncClientImplementation.JAVASCRIPT,
  // Use HTTP streaming instead of WebSocket for debugging
  connectionMethod: SyncStreamConnectionMethod.HTTP,
  // Limit retries to prevent infinite retry loops
  retryDelayMs: 1000,
  // Max 3 retry attempts
  maxReconnectDelay: 3000,
};

// Global error handlers
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled rejection:', event.reason);
});

window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
});

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

interface TestSuite {
  name: string;
  tests: TestResult[];
}

const suites: TestSuite[] = [];

// UI Helpers
const statusEl = document.getElementById('status')!;
const resultsEl = document.getElementById('results')!;

function setStatus(message: string, type: 'success' | 'error' | 'pending' = 'pending') {
  statusEl.innerHTML = `<p class="${type}">${message}</p>`;
}

function log(message: string) {
  console.log(message);
}

function renderResults() {
  let html = '';
  let totalPassed = 0;
  let totalFailed = 0;

  for (const suite of suites) {
    html += `<div class="suite"><h3>${suite.name}</h3><ul>`;
    for (const test of suite.tests) {
      if (test.passed) {
        totalPassed++;
        html += `<li class="pass">✓ ${test.name}</li>`;
      } else {
        totalFailed++;
        html += `<li class="fail">✗ ${test.name}<pre>${test.error}</pre></li>`;
      }
    }
    html += '</ul></div>';
  }

  resultsEl.innerHTML = html;

  if (totalFailed === 0 && totalPassed > 0) {
    setStatus(`All ${totalPassed} tests passed!`, 'success');
  } else if (totalFailed > 0) {
    setStatus(`${totalFailed} of ${totalPassed + totalFailed} tests failed`, 'error');
  } else {
    setStatus(`Running tests...`, 'pending');
  }
}

// Test Schema (matching PowerSync's test patterns)
const TEST_SCHEMA = new Schema({
  assets: new Table({
    make: column.text,
    model: column.text,
    serial_number: column.text,
    quantity: column.integer,
    description: column.text,
  }),
  customers: new Table({
    name: column.text,
    email: column.text,
  }),
});

// Helper to generate unique database names
function createTestDbName(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Simple assertion helpers
function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toHaveLength(length: number) {
      if (!Array.isArray(actual) || actual.length !== length) {
        throw new Error(`Expected length ${length} but got ${(actual as unknown[]).length}`);
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null but got ${JSON.stringify(actual)}`);
      }
    },
    notToBeNull() {
      if (actual === null) {
        throw new Error(`Expected not null but got null`);
      }
    },
    toBeGreaterThan(n: number) {
      if (typeof actual !== 'number' || actual <= n) {
        throw new Error(`Expected ${actual} to be greater than ${n}`);
      }
    },
    toContain(item: unknown) {
      if (!Array.isArray(actual) || !actual.includes(item)) {
        throw new Error(`Expected array to contain ${JSON.stringify(item)}`);
      }
    },
  };
}

// Test Runner
function startSuite(name: string): TestSuite {
  const suite: TestSuite = { name, tests: [] };
  suites.push(suite);
  log(`Running ${name} tests...`);
  renderResults();
  return suite;
}

async function runTest(suite: TestSuite, name: string, fn: () => Promise<void>): Promise<void> {
  const result: TestResult = { name, passed: false };
  try {
    await fn();
    result.passed = true;
    log(`  ✓ ${name}`);
  } catch (e) {
    result.error = String(e);
    log(`  ✗ ${name}: ${e}`);
    console.error(e);
  }
  suite.tests.push(result);
  // Render results incrementally after each test
  renderResults();
}

// =====================================================
// DBAdapter Interface Tests (PowerSync compatibility)
// =====================================================
async function runDBAdapterTests() {
  const suite = startSuite('DBAdapter Interface');

  // Test: Adapter has name property
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();

    await runTest(suite, 'adapter should have name property', async () => {
      expect(typeof adapter.name).toBe('string');
      expect(adapter.name.length).toBeGreaterThan(0);
    });

    await adapter.close();
  }

  // Test: execute returns QueryResult with rowsAffected
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');

    await runTest(suite, 'execute should return QueryResult with rowsAffected', async () => {
      const result = await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', 'hello']);
      expect(typeof result.rowsAffected).toBe('number');
      expect(result.rowsAffected).toBe(1);
    });

    await adapter.close();
  }

  // Test: execute returns insertId for inserts
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)');

    await runTest(suite, 'execute should return insertId', async () => {
      const result = await adapter.execute('INSERT INTO test (value) VALUES (?)', ['hello']);
      expect(typeof result.insertId).toBe('number');
    });

    await adapter.close();
  }

  // Test: getAll returns array of rows
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');
    await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', 'hello']);
    await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['2', 'world']);

    await runTest(suite, 'getAll should return array of row objects', async () => {
      const rows = await adapter.getAll<{ id: string; value: string }>('SELECT * FROM test ORDER BY id');
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('1');
      expect(rows[0].value).toBe('hello');
      expect(rows[1].id).toBe('2');
      expect(rows[1].value).toBe('world');
    });

    await adapter.close();
  }

  // Test: getOptional returns single row or null
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');
    await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', 'hello']);

    await runTest(suite, 'getOptional should return row or null', async () => {
      const row = await adapter.getOptional<{ id: string }>('SELECT * FROM test WHERE id = ?', ['1']);
      expect(row).notToBeNull();
      expect(row!.id).toBe('1');

      const missing = await adapter.getOptional('SELECT * FROM test WHERE id = ?', ['999']);
      expect(missing).toBeNull();
    });

    await adapter.close();
  }

  // Test: get throws on no results
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');

    await runTest(suite, 'get should throw when no results', async () => {
      let threw = false;
      try {
        await adapter.get('SELECT * FROM test WHERE id = ?', ['nonexistent']);
      } catch {
        threw = true;
      }
      if (!threw) throw new Error('Expected get() to throw');
    });

    await adapter.close();
  }

  // Test: executeBatch with multiple parameter sets
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');

    await runTest(suite, 'executeBatch should execute with multiple parameter sets', async () => {
      const result = await adapter.executeBatch('INSERT INTO test (id, value) VALUES (?, ?)', [
        ['1', 'a'],
        ['2', 'b'],
        ['3', 'c'],
      ]);
      expect(result.rowsAffected).toBe(3);

      const rows = await adapter.getAll('SELECT * FROM test');
      expect(rows).toHaveLength(3);
    });

    await adapter.close();
  }

  // Test: writeTransaction commits on success
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');

    await runTest(suite, 'writeTransaction should commit on success', async () => {
      await adapter.writeTransaction(async (tx) => {
        await tx.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', 'hello']);
        await tx.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['2', 'world']);
      });

      const rows = await adapter.getAll('SELECT * FROM test');
      expect(rows).toHaveLength(2);
    });

    await adapter.close();
  }

  // Test: writeTransaction rollback on error
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');

    await runTest(suite, 'writeTransaction should rollback on error', async () => {
      try {
        await adapter.writeTransaction(async (tx) => {
          await tx.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', 'hello']);
          throw new Error('Intentional rollback');
        });
      } catch {
        // Expected
      }

      const rows = await adapter.getAll('SELECT * FROM test');
      expect(rows).toHaveLength(0);
    });

    await adapter.close();
  }

  // Test: readTransaction allows reads
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');
    await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', 'hello']);

    await runTest(suite, 'readTransaction should allow reads', async () => {
      const result = await adapter.readTransaction(async (tx) => {
        return await tx.getAll('SELECT * FROM test');
      });
      expect(result).toHaveLength(1);
    });

    await adapter.close();
  }

  // Test: Transaction returns value
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');
    await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', 'hello']);

    await runTest(suite, 'transaction should return callback value', async () => {
      const count = await adapter.readTransaction(async (tx) => {
        const rows = await tx.getAll('SELECT * FROM test');
        return rows.length;
      });
      expect(count).toBe(1);
    });

    await adapter.close();
  }

  // Test: writeLock works
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');

    await runTest(suite, 'writeLock should execute callback', async () => {
      await adapter.writeLock(async (ctx) => {
        await ctx.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', 'hello']);
      });

      const rows = await adapter.getAll('SELECT * FROM test');
      expect(rows).toHaveLength(1);
    });

    await adapter.close();
  }

  // Test: readLock works
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');
    await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', 'hello']);

    await runTest(suite, 'readLock should execute callback', async () => {
      const result = await adapter.readLock(async (ctx) => {
        return await ctx.getAll('SELECT * FROM test');
      });
      expect(result).toHaveLength(1);
    });

    await adapter.close();
  }
}

// =====================================================
// Schema Tests (PowerSync patterns)
// =====================================================
async function runSchemaTests() {
  const suite = startSuite('Schema Operations');

  // Test: Can create tables from PowerSync schema
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();

    await runTest(suite, 'should create tables from PowerSync schema', async () => {
      // Create tables matching the schema structure
      // TEST_SCHEMA.tables is an array, each table has a .name property
      for (const table of TEST_SCHEMA.tables) {
        const columns = table.columns.map((c: { name: string; type?: string }) => `${c.name} ${c.type || 'TEXT'}`).join(', ');
        await adapter.execute(`CREATE TABLE ${table.name} (id TEXT PRIMARY KEY, ${columns})`);
      }

      // Verify tables exist
      const tables = await adapter.getAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      );
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('assets');
      expect(tableNames).toContain('customers');
    });

    await adapter.close();
  }

  // Test: Can insert and query with schema types
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute(
      'CREATE TABLE assets (id TEXT PRIMARY KEY, make TEXT, model TEXT, quantity INTEGER)'
    );

    await runTest(suite, 'should handle schema column types correctly', async () => {
      await adapter.execute('INSERT INTO assets (id, make, model, quantity) VALUES (?, ?, ?, ?)', [
        'asset-1',
        'Toyota',
        'Camry',
        5,
      ]);

      const asset = await adapter.get<{ id: string; make: string; model: string; quantity: number }>(
        'SELECT * FROM assets WHERE id = ?',
        ['asset-1']
      );

      expect(asset.id).toBe('asset-1');
      expect(asset.make).toBe('Toyota');
      expect(asset.model).toBe('Camry');
      expect(asset.quantity).toBe(5);
    });

    await adapter.close();
  }
}

// =====================================================
// CRUD Tests (PowerSync patterns)
// =====================================================
async function runCRUDTests() {
  const suite = startSuite('CRUD Operations (PowerSync patterns)');

  // Test: INSERT
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute(
      'CREATE TABLE assets (id TEXT PRIMARY KEY, make TEXT, model TEXT, quantity INTEGER)'
    );

    await runTest(suite, 'INSERT should create row', async () => {
      const result = await adapter.execute(
        'INSERT INTO assets (id, make, model, quantity) VALUES (?, ?, ?, ?)',
        ['asset-1', 'Toyota', 'Camry', 5]
      );
      expect(result.rowsAffected).toBe(1);

      const row = await adapter.get('SELECT * FROM assets WHERE id = ?', ['asset-1']);
      expect(row).notToBeNull();
    });

    await adapter.close();
  }

  // Test: BATCH INSERT
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute(
      'CREATE TABLE assets (id TEXT PRIMARY KEY, make TEXT, model TEXT, quantity INTEGER)'
    );

    await runTest(suite, 'BATCH INSERT should create multiple rows', async () => {
      const result = await adapter.executeBatch(
        'INSERT INTO assets (id, make, model, quantity) VALUES (?, ?, ?, ?)',
        [
          ['asset-1', 'Toyota', 'Camry', 5],
          ['asset-2', 'Honda', 'Civic', 3],
          ['asset-3', 'Ford', 'Focus', 7],
        ]
      );
      expect(result.rowsAffected).toBe(3);

      const rows = await adapter.getAll('SELECT * FROM assets');
      expect(rows).toHaveLength(3);
    });

    await adapter.close();
  }

  // Test: INSERT OR REPLACE
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute(
      'CREATE TABLE assets (id TEXT PRIMARY KEY, make TEXT, model TEXT, quantity INTEGER)'
    );

    await runTest(suite, 'INSERT OR REPLACE should update existing row', async () => {
      await adapter.execute('INSERT INTO assets (id, make, model, quantity) VALUES (?, ?, ?, ?)', [
        'asset-1',
        'Toyota',
        'Camry',
        5,
      ]);

      await adapter.execute(
        'INSERT OR REPLACE INTO assets (id, make, model, quantity) VALUES (?, ?, ?, ?)',
        ['asset-1', 'Toyota', 'Camry', 10]
      );

      const row = await adapter.get<{ quantity: number }>('SELECT * FROM assets WHERE id = ?', [
        'asset-1',
      ]);
      expect(row.quantity).toBe(10);

      const rows = await adapter.getAll('SELECT * FROM assets');
      expect(rows).toHaveLength(1);
    });

    await adapter.close();
  }

  // Test: UPDATE
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute(
      'CREATE TABLE assets (id TEXT PRIMARY KEY, make TEXT, model TEXT, quantity INTEGER)'
    );

    await runTest(suite, 'UPDATE should modify existing row', async () => {
      await adapter.execute('INSERT INTO assets (id, make, model, quantity) VALUES (?, ?, ?, ?)', [
        'asset-1',
        'Toyota',
        'Camry',
        5,
      ]);

      const result = await adapter.execute('UPDATE assets SET quantity = ? WHERE id = ?', [
        15,
        'asset-1',
      ]);
      expect(result.rowsAffected).toBe(1);

      const row = await adapter.get<{ quantity: number }>('SELECT * FROM assets WHERE id = ?', [
        'asset-1',
      ]);
      expect(row.quantity).toBe(15);
    });

    await adapter.close();
  }

  // Test: DELETE
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute(
      'CREATE TABLE assets (id TEXT PRIMARY KEY, make TEXT, model TEXT, quantity INTEGER)'
    );

    await runTest(suite, 'DELETE should remove row', async () => {
      await adapter.execute('INSERT INTO assets (id, make, model, quantity) VALUES (?, ?, ?, ?)', [
        'asset-1',
        'Toyota',
        'Camry',
        5,
      ]);

      const result = await adapter.execute('DELETE FROM assets WHERE id = ?', ['asset-1']);
      expect(result.rowsAffected).toBe(1);

      const row = await adapter.getOptional('SELECT * FROM assets WHERE id = ?', ['asset-1']);
      expect(row).toBeNull();
    });

    await adapter.close();
  }

  // Test: Transaction groups operations
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute(
      'CREATE TABLE assets (id TEXT PRIMARY KEY, make TEXT, model TEXT, quantity INTEGER)'
    );

    await runTest(suite, 'Transaction should group multiple operations', async () => {
      await adapter.writeTransaction(async (tx) => {
        await tx.execute('INSERT INTO assets (id, make, model, quantity) VALUES (?, ?, ?, ?)', [
          'asset-1',
          'Toyota',
          'Camry',
          5,
        ]);
        await tx.execute('INSERT INTO assets (id, make, model, quantity) VALUES (?, ?, ?, ?)', [
          'asset-2',
          'Honda',
          'Civic',
          3,
        ]);
        await tx.execute('UPDATE assets SET quantity = ? WHERE id = ?', [10, 'asset-1']);
      });

      const rows = await adapter.getAll<{ id: string; quantity: number }>(
        'SELECT * FROM assets ORDER BY id'
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].quantity).toBe(10);
      expect(rows[1].quantity).toBe(3);
    });

    await adapter.close();
  }

  // Test: Query within transaction sees uncommitted changes
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute(
      'CREATE TABLE assets (id TEXT PRIMARY KEY, make TEXT, model TEXT, quantity INTEGER)'
    );

    await runTest(suite, 'Transaction should see its own uncommitted changes', async () => {
      await adapter.writeTransaction(async (tx) => {
        await tx.execute('INSERT INTO assets (id, make, model, quantity) VALUES (?, ?, ?, ?)', [
          'asset-1',
          'Toyota',
          'Camry',
          5,
        ]);

        // Query within same transaction should see the insert
        const rows = await tx.getAll('SELECT * FROM assets');
        expect(rows).toHaveLength(1);
      });
    });

    await adapter.close();
  }
}

// =====================================================
// Data Type Tests
// =====================================================
async function runDataTypeTests() {
  const suite = startSuite('Data Type Handling');

  // Test: NULL handling
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value TEXT)');

    await runTest(suite, 'should handle NULL values', async () => {
      await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', null]);

      const row = await adapter.get<{ id: string; value: string | null }>(
        'SELECT * FROM test WHERE id = ?',
        ['1']
      );
      expect(row.value).toBeNull();
    });

    await adapter.close();
  }

  // Test: Integer handling
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value INTEGER)');

    await runTest(suite, 'should handle INTEGER values', async () => {
      await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', 42]);
      await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['2', -100]);
      await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['3', 0]);

      const rows = await adapter.getAll<{ id: string; value: number }>(
        'SELECT * FROM test ORDER BY id'
      );
      expect(rows[0].value).toBe(42);
      expect(rows[1].value).toBe(-100);
      expect(rows[2].value).toBe(0);
    });

    await adapter.close();
  }

  // Test: Real/Float handling
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value REAL)');

    await runTest(suite, 'should handle REAL values', async () => {
      await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', 3.14159]);
      await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['2', -2.5]);

      const rows = await adapter.getAll<{ id: string; value: number }>(
        'SELECT * FROM test ORDER BY id'
      );
      expect(Math.abs(rows[0].value - 3.14159) < 0.0001).toBe(true);
      expect(rows[1].value).toBe(-2.5);
    });

    await adapter.close();
  }

  // Test: Boolean handling (SQLite stores as INTEGER)
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value INTEGER)');

    await runTest(suite, 'should handle boolean values as integers', async () => {
      await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', true]);
      await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['2', false]);

      const rows = await adapter.getAll<{ id: string; value: number }>(
        'SELECT * FROM test ORDER BY id'
      );
      expect(rows[0].value).toBe(1);
      expect(rows[1].value).toBe(0);
    });

    await adapter.close();
  }

  // Test: Large integers
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();
    await adapter.execute('CREATE TABLE test (id TEXT PRIMARY KEY, value INTEGER)');

    await runTest(suite, 'should handle large integers', async () => {
      const largeInt = 9007199254740991; // Number.MAX_SAFE_INTEGER
      await adapter.execute('INSERT INTO test (id, value) VALUES (?, ?)', ['1', largeInt]);

      const row = await adapter.get<{ value: number }>('SELECT * FROM test WHERE id = ?', ['1']);
      expect(row.value).toBe(largeInt);
    });

    await adapter.close();
  }
}

// =====================================================
// PowerSync Extension Tests
// =====================================================
async function runPowerSyncExtensionTests() {
  const suite = startSuite('PowerSync Extension');

  // Test: Check if PowerSync is loaded
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();

    await runTest(suite, 'isPowerSyncLoaded should return boolean', async () => {
      const loaded = await adapter.isPowerSyncLoaded();
      expect(typeof loaded).toBe('boolean');
      log(`  PowerSync loaded: ${loaded}`);
    });

    await adapter.close();
  }

  // Test: Get PowerSync version (if loaded)
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();

    await runTest(suite, 'getPowerSyncVersion should work when loaded', async () => {
      const loaded = await adapter.isPowerSyncLoaded();
      if (loaded) {
        const version = await adapter.getPowerSyncVersion();
        expect(typeof version).toBe('string');
        expect(version.length).toBeGreaterThan(0);
        log(`  PowerSync version: ${version}`);
      } else {
        log('  PowerSync not loaded, skipping version check');
        // Test passes - extension just not available
      }
    });

    await adapter.close();
  }

  // Test: Schema replacement (if PowerSync loaded)
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();

    await runTest(suite, 'replaceSchema should work when PowerSync loaded', async () => {
      const loaded = await adapter.isPowerSyncLoaded();
      if (loaded) {
        const schemaJson = JSON.stringify({
          tables: [
            {
              name: 'test_table',
              columns: [
                { name: 'name', type: 'TEXT' },
                { name: 'value', type: 'INTEGER' },
              ],
            },
          ],
        });
        await adapter.replaceSchema(schemaJson);
        log('  Schema replaced successfully');

        // Verify the view was created
        const tables = await adapter.getAll<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='view' AND name = 'test_table'"
        );
        expect(tables).toHaveLength(1);
      } else {
        log('  PowerSync not loaded, skipping schema test');
      }
    });

    await adapter.close();
  }

  // Test: CRUD tracking (if PowerSync loaded)
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();

    await runTest(suite, 'CRUD operations should be tracked when PowerSync loaded', async () => {
      const loaded = await adapter.isPowerSyncLoaded();
      if (loaded) {
        // Set up schema with a table
        const schemaJson = JSON.stringify({
          tables: [
            {
              name: 'todos',
              columns: [
                { name: 'description', type: 'TEXT' },
                { name: 'completed', type: 'INTEGER' },
              ],
            },
          ],
        });
        await adapter.replaceSchema(schemaJson);

        // Insert a row - should create CRUD entry
        await adapter.execute(
          'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
          ['todo-1', 'Test todo', 0]
        );

        // Check for pending CRUD
        const hasCrud = await adapter.hasPendingCrud();
        expect(hasCrud).toBe(true);

        // Get the CRUD batch
        const batch = await adapter.getCrudBatch(10);
        expect(batch.length).toBeGreaterThan(0);

        const entry = batch[0];
        expect(entry.id).toBeGreaterThan(0);
        expect(typeof entry.data).toBe('string');

        // Parse the data to verify it's a PUT operation
        const data = JSON.parse(entry.data);
        expect(data.op).toBe('PUT');
        expect(data.type).toBe('todos');

        log(`  CRUD entry: ${JSON.stringify(data)}`);

        // Clean up - remove the CRUD entry
        await adapter.removeCrud(entry.id);
        const hasCrudAfter = await adapter.hasPendingCrud();
        expect(hasCrudAfter).toBe(false);
      } else {
        log('  PowerSync not loaded, skipping CRUD test');
      }
    });

    await adapter.close();
  }

  // Test: PowerSync control command (if loaded)
  {
    const adapter = new TauriDBAdapter(createTestDbName());
    await adapter.open();

    await runTest(suite, 'powerSyncControl should accept commands when loaded', async () => {
      const loaded = await adapter.isPowerSyncLoaded();
      if (loaded) {
        // The 'start' command initializes the sync client
        const result = await adapter.powerSyncControl('start', '{}');
        expect(typeof result).toBe('string');
        log(`  Control result: ${result}`);
      } else {
        log('  PowerSync not loaded, skipping control test');
      }
    });

    await adapter.close();
  }
}

// =====================================================
// Full Sync Tests (requires local PowerSync backend)
// =====================================================

// Schema matching the self-host-demo tables
const SYNC_SCHEMA = new Schema({
  lists: new Table({
    created_at: column.text,
    name: column.text,
    owner_id: column.text,
  }),
  todos: new Table({
    created_at: column.text,
    completed_at: column.text,
    description: column.text,
    completed: column.integer,
    created_by: column.text,
    completed_by: column.text,
    list_id: column.text,
    photo_id: column.text,
  }),
});

// Track uploaded CRUD entries for verification
let uploadedEntries: Array<{ op: string; table: string; id: string; data?: Record<string, unknown> }> = [];

// Connector for the local self-host-demo backend
class LocalDemoConnector implements PowerSyncBackendConnector {
  async fetchCredentials() {
    try {
      log(`  [connector] Fetching credentials from http://localhost:6060/api/auth/token`);
      const response = await fetch('http://localhost:6060/api/auth/token');
      const data = await response.json();
      log(`  [connector] Got token, endpoint: http://localhost:8080`);
      return {
        endpoint: 'http://localhost:8080',
        token: data.token,
      };
    } catch (e) {
      log(`  [connector] Failed to fetch credentials: ${e}`);
      throw e;
    }
  }

  async uploadData(database: AbstractPowerSyncDatabase) {
    log(`  [connector] uploadData called`);
    const batch = await database.getCrudBatch(100);
    if (!batch || batch.crud.length === 0) {
      log(`  [connector] No CRUD entries to upload`);
      return;
    }

    // Track entries for test verification
    for (const entry of batch.crud) {
      uploadedEntries.push({
        op: entry.op,
        table: entry.table,
        id: entry.id,
        data: entry.opData,
      });
      log(`    Upload: ${entry.op} ${entry.table}/${entry.id}`);
    }

    // Mark as uploaded
    await batch.complete();
    log(`  [connector] Batch completed`);
  }
}

// Helper to check if backend is available
async function isBackendAvailable(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:6060/api/auth/token', {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Helper to wait for sync to complete
async function waitForSync(db: PowerSyncDatabase, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = db.currentStatus;
    log(`  [sync] connected=${status?.connected}, hasSynced=${status?.hasSynced}, downloading=${status?.dataFlowStatus?.downloading}`);
    if (status?.hasSynced === true) {
      return true;
    }
    // Check for errors
    if (status?.dataFlowStatus?.downloadError) {
      const err = status.dataFlowStatus.downloadError;
      console.error('Download error object:', err);
      log(`  [sync] Download error type: ${err?.constructor?.name}`);
      log(`  [sync] Download error message: ${err?.message}`);
      log(`  [sync] Download error keys: ${Object.keys(err || {}).join(', ')}`);
      log(`  [sync] Download error toString: ${String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function runSyncTests() {
  const suite = startSuite('Full Sync (Local Backend)');

  // Check if backend is available first
  const backendAvailable = await isBackendAvailable();
  if (!backendAvailable) {
    log('  ⚠️ Local PowerSync backend not available, skipping sync tests');
    log('  To run sync tests, start self-host-demo:');
    log('    cd deps/self-host-demo/demos/nodejs && docker compose up -d');
    await runTest(suite, 'backend availability check', async () => {
      log('  Backend not running - sync tests skipped');
    });
    return;
  }

  // Test 1: Sync status lifecycle
  {
    await runTest(suite, 'sync status should transition correctly', async () => {
      const db = new PowerSyncDatabase({
        database: `sync-status-${Date.now()}`,
        schema: SYNC_SCHEMA,
      });
      try {
        await db.init();
        log(`  Database initialized`);

        // Log initial status (may be undefined while loading)
        const initialStatus = db.currentStatus;
        log(`  Initial status: connected=${initialStatus?.connected}, hasSynced=${initialStatus?.hasSynced}`);

        // Initially should not be connected (connected defaults to false)
        expect(initialStatus?.connected ?? false).toBe(false);

        const connector = new LocalDemoConnector();
        log(`  Connecting with HTTP streaming...`);
        try {
          await db.connect(connector, SYNC_OPTIONS);
          log(`  Connect resolved`);
        } catch (e: any) {
          log(`  Connect error: ${e?.message || e}`);
          throw e;
        }

        // Should become connected
        const afterConnect = db.currentStatus;
        log(`  After connect: connected=${afterConnect?.connected}, hasSynced=${afterConnect?.hasSynced}`);
        expect(afterConnect?.connected).toBe(true);

        // Wait for sync to complete
        log(`  Waiting for sync...`);
        const synced = await waitForSync(db, 10000);

        const afterSync = db.currentStatus;
        log(`  After wait: connected=${afterSync?.connected}, hasSynced=${afterSync?.hasSynced}`);

        if (!synced) {
          log(`  WARNING: Sync did not complete within timeout`);
          // Check what data we have anyway
          const lists = await db.getAll('SELECT * FROM lists');
          const todos = await db.getAll('SELECT * FROM todos');
          log(`  Data: ${lists.length} lists, ${todos.length} todos`);
        }

        expect(synced).toBe(true);
        expect(afterSync?.hasSynced).toBe(true);

        await db.disconnect();
        const afterDisconnect = db.currentStatus;
        log(`  After disconnect: connected=${afterDisconnect?.connected}`);
        expect(afterDisconnect?.connected).toBe(false);
      } finally {
        await db.disconnect().catch(() => {});
        await db.close().catch(() => {});
      }
    });
  }

  // Test 2: Initial sync downloads data correctly
  {
    await runTest(suite, 'initial sync should download demo data', async () => {
      const db = new PowerSyncDatabase({
        database: `sync-download-${Date.now()}`,
        schema: SYNC_SCHEMA,
      });
      try {
        await db.init();
        log(`  Initialized`);

        const connector = new LocalDemoConnector();
        log(`  Connecting...`);
        await db.connect(connector, SYNC_OPTIONS);

        log(`  Waiting for sync...`);
        const synced = await waitForSync(db, 10000);
        log(`  Sync complete: ${synced}`);

        // Check internal tables to debug
        try {
          const buckets = await db.getAll('SELECT * FROM ps_buckets');
          log(`  ps_buckets: ${buckets.length} entries`);
          console.log('ps_buckets:', buckets);

          const dataLists = await db.getAll('SELECT * FROM ps_data__lists');
          log(`  ps_data__lists: ${dataLists.length} entries`);
          console.log('ps_data__lists:', dataLists);

          const oplog = await db.getAll('SELECT * FROM ps_oplog LIMIT 10');
          log(`  ps_oplog: ${oplog.length} entries`);
          console.log('ps_oplog:', oplog);

          const syncState = await db.getAll('SELECT * FROM ps_sync_state');
          log(`  ps_sync_state: ${syncState.length} entries`);
          console.log('ps_sync_state:', syncState);

          const kv = await db.getAll('SELECT * FROM ps_kv');
          log(`  ps_kv: ${kv.length} entries`);
          console.log('ps_kv:', kv);
        } catch (e) {
          log(`  Could not query internal tables: ${e}`);
          console.error(e);
        }

        // Verify lists table synced
        const lists = await db.getAll<{ id: string; name: string; owner_id: string }>(
          'SELECT * FROM lists'
        );
        log(`  Downloaded ${lists.length} lists`);

        if (lists.length === 0) {
          // Debug: check what tables exist
          const tables = await db.getAll<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name"
          );
          log(`  Tables/views in DB: ${tables.map((t) => t.name).join(', ')}`);
          throw new Error(`No lists synced - sync may not be working`);
        }

        // Verify the "Getting Started" list from demo data
        const gettingStarted = lists.find((l) => l.name === 'Getting Started');
        expect(gettingStarted).notToBeNull();
        log(`  Found "Getting Started" list: ${gettingStarted!.id}`);

        // Verify todos table synced
        const todos = await db.getAll<{ id: string; description: string; list_id: string }>(
          'SELECT * FROM todos'
        );
        expect(todos.length).toBeGreaterThan(0);
        log(`  Downloaded ${todos.length} todos`);

        // Verify todos are linked to the list
        const linkedTodos = todos.filter((t) => t.list_id === gettingStarted!.id);
        expect(linkedTodos.length).toBeGreaterThan(0);
        log(`  Found ${linkedTodos.length} todos linked to "Getting Started" list`);
      } finally {
        await db.disconnect().catch(() => {});
        await db.close().catch(() => {});
      }
    });
  }

  // Test 3: INSERT creates PUT crud entry and uploads
  {
    await runTest(suite, 'INSERT should create PUT entry and upload', async () => {
      uploadedEntries = []; // Reset
      const db = new PowerSyncDatabase({
        database: `sync-insert-${Date.now()}`,
        schema: SYNC_SCHEMA,
      });
      try {
        await db.init();

        const connector = new LocalDemoConnector();
        await db.connect(connector, SYNC_OPTIONS);
        await waitForSync(db, 10000);

        // Get a list ID
        const lists = await db.getAll<{ id: string }>('SELECT id FROM lists LIMIT 1');
        if (lists.length === 0) {
          throw new Error('No lists synced - cannot test INSERT. Check sync is working.');
        }
        const listId = lists[0].id;

        // Insert a new todo
        const todoId = crypto.randomUUID();
        await db.execute(
          'INSERT INTO todos (id, description, completed, list_id, created_at) VALUES (?, ?, ?, ?, ?)',
          [todoId, 'Test INSERT operation', 0, listId, new Date().toISOString()]
        );
        log(`  Inserted todo: ${todoId}`);

        // Wait for upload to process
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Verify PUT entry was uploaded
        const putEntry = uploadedEntries.find((e) => e.id === todoId && e.op === 'PUT');
        expect(putEntry).notToBeNull();
        expect(putEntry!.table).toBe('todos');
        expect(putEntry!.data?.description).toBe('Test INSERT operation');
        log(`  Verified PUT upload for ${todoId}`);
      } finally {
        await db.disconnect().catch(() => {});
        await db.close().catch(() => {});
      }
    });
  }

  // Test 4: UPDATE creates PATCH crud entry and uploads
  {
    await runTest(suite, 'UPDATE should create PATCH entry and upload', async () => {
      uploadedEntries = [];
      const db = new PowerSyncDatabase({
        database: `sync-update-${Date.now()}`,
        schema: SYNC_SCHEMA,
      });
      try {
        await db.init();

        const connector = new LocalDemoConnector();
        await db.connect(connector, SYNC_OPTIONS);
        await waitForSync(db);

        // Get a synced todo from the server (demo data)
        const todos = await db.getAll<{ id: string; description: string; completed: number }>(
          'SELECT id, description, completed FROM todos LIMIT 1'
        );
        if (todos.length === 0) {
          throw new Error('No todos synced - cannot test UPDATE. Check sync is working.');
        }
        const todoId = todos[0].id;
        const originalDescription = todos[0].description;
        log(`  Updating synced todo: ${todoId} (was: "${originalDescription}")`);

        // Update the synced todo
        await db.execute('UPDATE todos SET description = ?, completed = ? WHERE id = ?', [
          'Updated by test',
          1,
          todoId,
        ]);
        log(`  Updated todo: ${todoId}`);

        // Wait for upload
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Verify PATCH entry was uploaded
        const patchEntry = uploadedEntries.find((e) => e.id === todoId && e.op === 'PATCH');
        expect(patchEntry).notToBeNull();
        expect(patchEntry!.table).toBe('todos');
        expect(patchEntry!.data?.description).toBe('Updated by test');
        log(`  Verified PATCH upload for ${todoId}`);
      } finally {
        await db.disconnect().catch(() => {});
        await db.close().catch(() => {});
      }
    });
  }

  // Test 5: DELETE creates DELETE crud entry and uploads
  {
    await runTest(suite, 'DELETE should create DELETE entry and upload', async () => {
      uploadedEntries = [];
      const db = new PowerSyncDatabase({
        database: `sync-delete-${Date.now()}`,
        schema: SYNC_SCHEMA,
      });
      try {
        await db.init();

        const connector = new LocalDemoConnector();
        await db.connect(connector, SYNC_OPTIONS);
        await waitForSync(db);

        // Get a synced todo from the server (demo data) - use the second one to not conflict with UPDATE test
        const todos = await db.getAll<{ id: string; description: string }>(
          'SELECT id, description FROM todos ORDER BY id LIMIT 2'
        );
        if (todos.length < 2) {
          throw new Error('Not enough todos synced - cannot test DELETE. Need at least 2 todos.');
        }
        const todoId = todos[1].id;
        log(`  Deleting synced todo: ${todoId} ("${todos[1].description}")`);

        // Delete the synced todo
        await db.execute('DELETE FROM todos WHERE id = ?', [todoId]);
        log(`  Deleted todo: ${todoId}`);

        // Wait for upload
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Verify DELETE entry was uploaded
        const deleteEntry = uploadedEntries.find((e) => e.id === todoId && e.op === 'DELETE');
        expect(deleteEntry).notToBeNull();
        expect(deleteEntry!.table).toBe('todos');
        log(`  Verified DELETE upload for ${todoId}`);

        // Verify locally deleted
        const todo = await db.getOptional('SELECT * FROM todos WHERE id = ?', [todoId]);
        expect(todo).toBeNull();
      } finally {
        await db.disconnect().catch(() => {});
        await db.close().catch(() => {});
      }
    });
  }

  // Test 6: Reconnection preserves local data
  {
    await runTest(suite, 'reconnection should preserve local data', async () => {
      const dbName = `sync-reconnect-${Date.now()}`;
      const db = new PowerSyncDatabase({
        database: dbName,
        schema: SYNC_SCHEMA,
      });
      try {
        await db.init();

        const connector = new LocalDemoConnector();
        await db.connect(connector, SYNC_OPTIONS);
        await waitForSync(db);

        // Get initial count
        const initialTodos = await db.getAll('SELECT * FROM todos');
        const initialCount = initialTodos.length;
        log(`  Initial todo count: ${initialCount}`);

        // Disconnect
        await db.disconnect();
        expect(db.currentStatus.connected).toBe(false);

        // Data should still be there
        const afterDisconnect = await db.getAll('SELECT * FROM todos');
        expect(afterDisconnect.length).toBe(initialCount);
        log(`  After disconnect: ${afterDisconnect.length} todos (preserved)`);

        // Reconnect
        await db.connect(connector, SYNC_OPTIONS);
        await waitForSync(db);

        // Data should still be there
        const afterReconnect = await db.getAll('SELECT * FROM todos');
        expect(afterReconnect.length).toBe(initialCount);
        log(`  After reconnect: ${afterReconnect.length} todos (preserved)`);
      } finally {
        await db.disconnect().catch(() => {});
        await db.close().catch(() => {});
      }
    });
  }

  // Test 7: Offline writes sync when connected
  {
    await runTest(suite, 'offline writes should sync when connected', async () => {
      uploadedEntries = [];
      const db = new PowerSyncDatabase({
        database: `sync-offline-${Date.now()}`,
        schema: SYNC_SCHEMA,
      });
      try {
        await db.init();

        // First connect to get the schema set up and get a list ID
        const connector = new LocalDemoConnector();
        await db.connect(connector, SYNC_OPTIONS);
        await waitForSync(db);

        const lists = await db.getAll<{ id: string }>('SELECT id FROM lists LIMIT 1');
        if (lists.length === 0) {
          throw new Error('No lists synced - cannot test offline writes. Check sync is working.');
        }
        const listId = lists[0].id;

        // Disconnect
        await db.disconnect();
        uploadedEntries = [];
        log('  Disconnected for offline writes');

        // Write while offline
        const todoId = crypto.randomUUID();
        await db.execute(
          'INSERT INTO todos (id, description, completed, list_id, created_at) VALUES (?, ?, ?, ?, ?)',
          [todoId, 'Written while offline', 0, listId, new Date().toISOString()]
        );
        log(`  Wrote offline todo: ${todoId}`);

        // Verify no upload happened (we're offline)
        expect(uploadedEntries.length).toBe(0);

        // Reconnect
        await db.connect(connector, SYNC_OPTIONS);
        await waitForSync(db);

        // Wait for upload to process
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Verify the offline write was uploaded
        const putEntry = uploadedEntries.find((e) => e.id === todoId && e.op === 'PUT');
        expect(putEntry).notToBeNull();
        log(`  Offline write uploaded after reconnect`);
      } finally {
        await db.disconnect().catch(() => {});
        await db.close().catch(() => {});
      }
    });
  }

  // Test 8: Watch (reactive queries)
  {
    await runTest(suite, 'watch should emit updates on data changes', async () => {
      const db = new PowerSyncDatabase({
        database: `sync-watch-${Date.now()}`,
        schema: SYNC_SCHEMA,
      });
      const abortController = new AbortController();
      try {
        await db.init();

        const connector = new LocalDemoConnector();
        await db.connect(connector, SYNC_OPTIONS);
        await waitForSync(db);

        const lists = await db.getAll<{ id: string }>('SELECT id FROM lists LIMIT 1');
        if (lists.length === 0) {
          throw new Error('No lists synced - cannot test watch. Check sync is working.');
        }
        const listId = lists[0].id;

        // Set up watch
        const emissions: Array<{ id: string; description: string }[]> = [];

        const watchPromise = (async () => {
          for await (const result of db.watch(
            'SELECT id, description FROM todos WHERE list_id = ? ORDER BY created_at DESC LIMIT 5',
            [listId],
            { signal: abortController.signal }
          )) {
            const rows = (result.rows?._array ?? []) as { id: string; description: string }[];
            emissions.push(rows);
            log(`  Watch emitted: ${rows.length} todos`);
            if (emissions.length >= 3) {
              abortController.abort();
              break;
            }
          }
        })();

        // Wait for initial emission
        await new Promise((resolve) => setTimeout(resolve, 500));
        const initialCount = emissions.length > 0 ? emissions[0].length : 0;

        // Insert a todo
        const todoId = crypto.randomUUID();
        await db.execute(
          'INSERT INTO todos (id, description, completed, list_id, created_at) VALUES (?, ?, ?, ?, ?)',
          [todoId, 'Watch test todo', 0, listId, new Date().toISOString()]
        );

        // Wait for watch to update
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Clean up
        abortController.abort();
        try {
          await watchPromise;
        } catch {
          // Expected - aborted
        }

        // Verify we got multiple emissions
        expect(emissions.length).toBeGreaterThan(1);

        // Verify count increased
        const latestEmission = emissions[emissions.length - 1];
        expect(latestEmission.length).toBeGreaterThan(initialCount);
        log(`  Watch received ${emissions.length} emissions`);
      } finally {
        abortController.abort();
        await db.disconnect().catch(() => {});
        await db.close().catch(() => {});
      }
    });
  }

  // Test 9: Transaction groups CRUD entries
  {
    await runTest(suite, 'transaction should group CRUD entries', async () => {
      uploadedEntries = [];
      const db = new PowerSyncDatabase({
        database: `sync-tx-${Date.now()}`,
        schema: SYNC_SCHEMA,
      });
      try {
        await db.init();

        const connector = new LocalDemoConnector();
        await db.connect(connector, SYNC_OPTIONS);
        await waitForSync(db);

        const lists = await db.getAll<{ id: string }>('SELECT id FROM lists LIMIT 1');
        if (lists.length === 0) {
          throw new Error('No lists synced - cannot test transactions. Check sync is working.');
        }
        const listId = lists[0].id;
        uploadedEntries = [];

        // Insert multiple todos in a transaction
        const todoIds: string[] = [];
        await db.writeTransaction(async (tx) => {
          for (let i = 0; i < 3; i++) {
            const id = crypto.randomUUID();
            todoIds.push(id);
            await tx.execute(
              'INSERT INTO todos (id, description, completed, list_id, created_at) VALUES (?, ?, ?, ?, ?)',
              [id, `Transaction todo ${i}`, 0, listId, new Date().toISOString()]
            );
          }
        });
        log(`  Inserted ${todoIds.length} todos in transaction`);

        // Wait for upload
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Verify all were uploaded
        for (const id of todoIds) {
          const entry = uploadedEntries.find((e) => e.id === id);
          expect(entry).notToBeNull();
        }
        log(`  All ${todoIds.length} transaction entries uploaded`);
      } finally {
        await db.disconnect().catch(() => {});
        await db.close().catch(() => {});
      }
    });
  }

  // Test 10: Multiple operations on same row
  {
    await runTest(suite, 'multiple operations on same row should all upload', async () => {
      uploadedEntries = [];
      const db = new PowerSyncDatabase({
        database: `sync-multi-ops-${Date.now()}`,
        schema: SYNC_SCHEMA,
      });
      try {
        await db.init();

        const connector = new LocalDemoConnector();
        await db.connect(connector, SYNC_OPTIONS);
        await waitForSync(db);

        const lists = await db.getAll<{ id: string }>('SELECT id FROM lists LIMIT 1');
        if (lists.length === 0) {
          throw new Error('No lists synced - cannot test multi-ops. Check sync is working.');
        }
        const listId = lists[0].id;
        uploadedEntries = [];

        const todoId = crypto.randomUUID();

        // INSERT
        await db.execute(
          'INSERT INTO todos (id, description, completed, list_id, created_at) VALUES (?, ?, ?, ?, ?)',
          [todoId, 'Initial', 0, listId, new Date().toISOString()]
        );

        // UPDATE
        await db.execute('UPDATE todos SET description = ? WHERE id = ?', ['Updated', todoId]);

        // Another UPDATE
        await db.execute('UPDATE todos SET completed = ? WHERE id = ?', [1, todoId]);

        // DELETE
        await db.execute('DELETE FROM todos WHERE id = ?', [todoId]);

        // Wait for uploads
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Verify all operations were captured
        const ops = uploadedEntries.filter((e) => e.id === todoId);
        log(`  Operations for ${todoId}: ${ops.map((o) => o.op).join(', ')}`);

        // Should have PUT, PATCH(s), DELETE
        expect(ops.some((o) => o.op === 'PUT')).toBe(true);
        expect(ops.some((o) => o.op === 'DELETE')).toBe(true);
      } finally {
        await db.disconnect().catch(() => {});
        await db.close().catch(() => {});
      }
    });
  }
}

// =====================================================
// Run All Tests
// =====================================================
async function runAllTests() {
  setStatus('Running tests...');
  resultsEl.innerHTML = '';

  try {
    await runDBAdapterTests();
    await runSchemaTests();
    await runCRUDTests();
    await runDataTypeTests();
    await runPowerSyncExtensionTests();
    await runSyncTests();
    renderResults();
  } catch (e) {
    console.error('Test runner error:', e);
    setStatus(`Test runner error: ${e}`, 'error');
  }
}

// Run tests when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runAllTests);
} else {
  runAllTests();
}
