import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  missingReferencedPhotos,
  readTable,
  renderDatabaseSql,
  sha256,
  sqlValue,
} from '../../src/services/backup.js';
import { safeBackupPath, verifyBackupDirectory } from '../../src/services/backup-files.js';

test('SQL values are escaped without losing types', () => {
  assert.equal(sqlValue(null), 'null');
  assert.equal(sqlValue(true), 'true');
  assert.equal(sqlValue(42), '42');
  assert.equal(sqlValue("O'Reilly"), "'O''Reilly'");
  assert.throws(() => sqlValue(Number.NaN), /non-finite/);
});

test('database export embeds migrations, rows, and repairs the identity sequence', () => {
  const sql = renderDatabaseSql({
    generatedAt: '2026-10-13T00:00:00.000Z',
    migrations: [{ name: '001_schema.sql', sql: 'create table example (id int);\n' }],
    tables: {
      organisations: [{ id: 7, kind: 'supplier', name: "A&B's", source: 'list', status: 'approved', created_at: 'now', code: null }],
      attendees: [],
      attendee_orgs: [],
    },
  });

  assert.match(sql, /-- ==== 001_schema\.sql ====/);
  assert.match(sql, /overriding system value values \(7, 'supplier', 'A&B''s'/);
  assert.match(sql, /select setval\(pg_get_serial_sequence/);
  assert.match(sql, /commit;\n$/);
});

test('missing referenced photos are detected', () => {
  const tables = { attendees: [{ photo_path: 'kept.jpg' }, { photo_path: 'missing.png' }, { photo_path: null }] };
  assert.deepEqual(missingReferencedPhotos(tables, [{ path: 'kept.jpg' }]), ['missing.png']);
});

test('sha256 is stable for buffers and strings', () => {
  assert.equal(sha256('hello'), sha256(Buffer.from('hello')));
  assert.equal(sha256('hello').length, 64);
});

test('pre-migration backups omit an optional column that does not exist yet', async () => {
  const selections = [];
  const db = {
    from: () => {
      let columns;
      const query = {
        select(value) { columns = value; selections.push(value); return query; },
        order() { return query; },
        range() {
          return columns.includes('print_token')
            ? Promise.resolve({ data: null, error: { code: '42703', message: 'column registration_credentials.print_token does not exist' } })
            : Promise.resolve({ data: [{ id: 'credential-1' }], error: null, count: 1 });
        },
      };
      return query;
    },
  };
  const rows = await readTable(db, {
    name: 'registration_credentials',
    columns: ['id', 'print_token'], optionalColumns: ['print_token'], order: ['id'],
  });
  assert.deepEqual(rows, [{ id: 'credential-1' }]);
  assert.deepEqual(selections, ['id,print_token', 'id']);
});

test('backup paths cannot escape the selected directory', () => {
  assert.match(safeBackupPath('C:/safe', 'storage/photos/a.jpg'), /storage[\\/]photos[\\/]a\.jpg$/);
  assert.throws(() => safeBackupPath('C:/safe', '../secret'), /Unsafe backup path/);
  assert.throws(() => safeBackupPath('C:/safe', '/absolute'), /Unsafe backup path/);
});

test('a backup directory is verified from its SHA-256 file and manifest', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'registration-backup-'));
  const databaseSql = 'begin;\ncommit;\n';
  const manifest = JSON.stringify({
    formatVersion: 1,
    application: 'primark-event-registration',
    files: [{ path: 'database.sql', bytes: databaseSql.length, sha256: sha256(databaseSql) }],
    storage: { bucket: 'attendee-photos', objectCount: 0 },
  }, null, 2) + '\n';
  await writeFile(path.join(directory, 'database.sql'), databaseSql);
  await writeFile(path.join(directory, 'manifest.json'), manifest);
  await writeFile(
    path.join(directory, 'checksums.sha256'),
    `${sha256(databaseSql)}  database.sql\n${sha256(manifest)}  manifest.json\n`,
  );

  const result = await verifyBackupDirectory(directory);
  assert.equal(result.checkedFiles, 2);
  assert.equal(result.manifest.storage.objectCount, 0);
});
