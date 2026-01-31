import { TauriDBAdapter } from '@powersync/tauri';
import { Schema, Table, column } from '@powersync/common';

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

  if (totalFailed === 0) {
    setStatus(`All ${totalPassed} tests passed!`, 'success');
  } else {
    setStatus(`${totalFailed} of ${totalPassed + totalFailed} tests failed`, 'error');
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
}

// =====================================================
// DBAdapter Interface Tests (PowerSync compatibility)
// =====================================================
async function runDBAdapterTests() {
  const suite: TestSuite = { name: 'DBAdapter Interface', tests: [] };
  suites.push(suite);
  log('Running DBAdapter interface tests...');

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
  const suite: TestSuite = { name: 'Schema Operations', tests: [] };
  suites.push(suite);
  log('Running Schema tests...');

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
  const suite: TestSuite = { name: 'CRUD Operations (PowerSync patterns)', tests: [] };
  suites.push(suite);
  log('Running CRUD tests...');

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
  const suite: TestSuite = { name: 'Data Type Handling', tests: [] };
  suites.push(suite);
  log('Running Data Type tests...');

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
