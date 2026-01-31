import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TauriPowerSyncDatabase } from '@powersync/tauri';

// Helper to generate unique database names for test isolation
function createTestDbName(): string {
  return `test-tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe('TauriPowerSyncDatabase Transactions', () => {
  let db: TauriPowerSyncDatabase;

  beforeEach(async () => {
    db = new TauriPowerSyncDatabase({
      database: createTestDbName(),
    });
    await db.init();

    // Create test table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        description TEXT,
        completed INTEGER DEFAULT 0
      )
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  describe('writeTransaction', () => {
    it('should commit on success', async () => {
      await db.writeTransaction(async (tx) => {
        await tx.execute(
          'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
          ['1', 'Test todo', 0]
        );
      });
      const rows = await db.getAll('SELECT * FROM todos');
      expect(rows).toHaveLength(1);
    });

    it('should rollback on error', async () => {
      try {
        await db.writeTransaction(async (tx) => {
          await tx.execute(
            'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
            ['1', 'Test todo', 0]
          );
          throw new Error('Intentional error');
        });
      } catch {
        // Expected
      }
      const rows = await db.getAll('SELECT * FROM todos');
      expect(rows).toHaveLength(0);
    });

    it('should support multiple operations', async () => {
      await db.writeTransaction(async (tx) => {
        await tx.execute(
          'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
          ['1', 'Todo 1', 0]
        );
        await tx.execute(
          'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
          ['2', 'Todo 2', 0]
        );
        await tx.execute('UPDATE todos SET completed = ? WHERE id = ?', [1, '1']);
      });
      const rows = await db.getAll<{ id: string; completed: number }>(
        'SELECT * FROM todos ORDER BY id'
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].completed).toBe(1);
      expect(rows[1].completed).toBe(0);
    });

    it('should return value from transaction', async () => {
      const result = await db.writeTransaction(async (tx) => {
        await tx.execute(
          'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
          ['1', 'Test todo', 0]
        );
        return 'success';
      });
      expect(result).toBe('success');
    });
  });

  describe('readTransaction', () => {
    it('should allow reads', async () => {
      await db.execute(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        ['1', 'Test todo', 0]
      );
      const result = await db.readTransaction(async (tx) => {
        return await tx.getAll('SELECT * FROM todos');
      });
      expect(result).toHaveLength(1);
    });

    it('should return value from transaction', async () => {
      await db.execute(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        ['1', 'Test todo', 0]
      );
      const count = await db.readTransaction(async (tx) => {
        const rows = await tx.getAll('SELECT * FROM todos');
        return rows.length;
      });
      expect(count).toBe(1);
    });
  });

  describe('nested operations', () => {
    it('should support queries within transactions', async () => {
      await db.writeTransaction(async (tx) => {
        await tx.execute(
          'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
          ['1', 'Test todo', 0]
        );
        const rows = await tx.getAll('SELECT * FROM todos');
        expect(rows).toHaveLength(1);
      });
    });

    it('should support getOptional within transactions', async () => {
      await db.writeTransaction(async (tx) => {
        await tx.execute(
          'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
          ['1', 'Test todo', 0]
        );
        const row = await tx.getOptional<{ id: string }>('SELECT * FROM todos WHERE id = ?', ['1']);
        expect(row).not.toBeNull();
        expect(row?.id).toBe('1');
      });
    });
  });
});
