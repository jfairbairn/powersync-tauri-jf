import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TauriPowerSyncDatabase } from '@powersync/tauri';

// Helper to generate unique database names for test isolation
function createTestDbName(): string {
  return `test-crud-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe('TauriPowerSyncDatabase CRUD Operations', () => {
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

  describe('execute', () => {
    it('should insert a row', async () => {
      const result = await db.execute(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        ['1', 'Test todo', 0]
      );
      expect(result.rowsAffected).toBe(1);
    });

    it('should update a row', async () => {
      await db.execute(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        ['1', 'Test todo', 0]
      );
      const result = await db.execute(
        'UPDATE todos SET completed = ? WHERE id = ?',
        [1, '1']
      );
      expect(result.rowsAffected).toBe(1);
    });

    it('should delete a row', async () => {
      await db.execute(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        ['1', 'Test todo', 0]
      );
      const result = await db.execute('DELETE FROM todos WHERE id = ?', ['1']);
      expect(result.rowsAffected).toBe(1);
    });
  });

  describe('getAll', () => {
    it('should return all rows', async () => {
      await db.execute(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        ['1', 'Todo 1', 0]
      );
      await db.execute(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        ['2', 'Todo 2', 1]
      );
      const rows = await db.getAll<{ id: string; description: string; completed: number }>(
        'SELECT * FROM todos ORDER BY id'
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].description).toBe('Todo 1');
      expect(rows[1].description).toBe('Todo 2');
    });

    it('should support parameterized queries', async () => {
      await db.execute(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        ['1', 'Todo 1', 0]
      );
      await db.execute(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        ['2', 'Todo 2', 1]
      );
      const rows = await db.getAll<{ id: string }>('SELECT * FROM todos WHERE completed = ?', [1]);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('2');
    });
  });

  describe('getOptional', () => {
    it('should return a single row', async () => {
      await db.execute(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        ['1', 'Test todo', 0]
      );
      const row = await db.getOptional<{ description: string }>(
        'SELECT * FROM todos WHERE id = ?',
        ['1']
      );
      expect(row).not.toBeNull();
      expect(row?.description).toBe('Test todo');
    });

    it('should return null for no match', async () => {
      const row = await db.getOptional('SELECT * FROM todos WHERE id = ?', ['nonexistent']);
      expect(row).toBeNull();
    });
  });

  describe('get', () => {
    it('should return a single row', async () => {
      await db.execute(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        ['1', 'Test todo', 0]
      );
      const row = await db.get<{ id: string; description: string }>(
        'SELECT * FROM todos WHERE id = ?',
        ['1']
      );
      expect(row.id).toBe('1');
      expect(row.description).toBe('Test todo');
    });

    it('should throw for no match', async () => {
      await expect(
        db.get('SELECT * FROM todos WHERE id = ?', ['nonexistent'])
      ).rejects.toThrow();
    });
  });

  describe('executeBatch', () => {
    it('should insert multiple rows', async () => {
      const result = await db.executeBatch(
        'INSERT INTO todos (id, description, completed) VALUES (?, ?, ?)',
        [
          ['1', 'Todo 1', 0],
          ['2', 'Todo 2', 0],
          ['3', 'Todo 3', 1],
        ]
      );
      expect(result.rowsAffected).toBe(3);

      const rows = await db.getAll('SELECT * FROM todos ORDER BY id');
      expect(rows).toHaveLength(3);
    });
  });
});
