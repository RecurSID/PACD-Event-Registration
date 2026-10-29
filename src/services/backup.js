import { createHash } from 'node:crypto';

export const BACKUP_BUCKET = 'attendee-photos';

export const BACKUP_TABLES = [
  {
    name: 'organisations',
    columns: ['id', 'kind', 'name', 'source', 'status', 'created_at', 'code'],
    order: ['id'],
    overrideIdentity: true,
  },
  {
    name: 'attendees',
    columns: [
      'id',
      'name',
      'email',
      'phone',
      'from_type',
      'created_at',
      'updated_at',
      'designation',
      'organisation_name',
      'photo_path',
    ],
    order: ['id'],
  },
  {
    name: 'attendee_orgs',
    columns: ['attendee_id', 'org_id', 'code'],
    order: ['attendee_id', 'org_id'],
  },
  {
    name: 'events',
    columns: ['id', 'code', 'name', 'subtitle', 'timezone', 'starts_at', 'ends_at', 'status', 'created_at', 'updated_at', 'venue', 'organiser'],
    order: ['id'],
  },
  {
    name: 'event_days',
    columns: ['id', 'event_id', 'event_date', 'label', 'check_in_opens_at', 'check_in_closes_at', 'created_at'],
    order: ['event_id', 'event_date'],
  },
  {
    name: 'event_registrations',
    columns: ['id', 'event_id', 'attendee_id', 'status', 'created_at', 'updated_at'],
    order: ['event_id', 'id'],
  },
  {
    name: 'registration_orgs',
    columns: ['registration_id', 'org_id', 'kind', 'name', 'code'],
    order: ['registration_id', 'kind', 'name'],
  },
  {
    name: 'registration_credentials',
    columns: [
      'id', 'registration_id', 'token_hash', 'fallback_code_hash', 'status', 'issued_at',
      'revoked_at', 'print_token', 'fallback_code',
    ],
    // Allows a safety backup immediately before migration 013 adds these columns.
    optionalColumns: ['print_token', 'fallback_code'],
    order: ['registration_id', 'issued_at'],
  },
  {
    name: 'attendance',
    columns: ['id', 'registration_id', 'event_day_id', 'first_scanned_at', 'scanned_at_device', 'received_at', 'device_id', 'scan_id', 'source'],
    order: ['event_day_id', 'first_scanned_at'],
  },
];

const PAGE_SIZE = 1_000;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sqlValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot export a non-finite number.');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function renderDatabaseSql({ migrations, tables, generatedAt }) {
  const lines = [
    '-- Primark Event Registration - PostgreSQL logical export',
    `-- Generated ${generatedAt} by scripts/backup.js`,
    '-- Schema: ordered migrations. Data: application tables. Storage is in the sibling storage directory.',
    '-- Restore only into a new, empty Supabase project.',
    'begin;',
    '',
  ];

  for (const migration of migrations) {
    lines.push(`-- ==== ${migration.name} ====`, migration.sql.trimEnd(), '');
  }

  for (const table of BACKUP_TABLES) {
    const rows = tables[table.name] ?? [];
    lines.push(`-- ==== ${table.name}: ${rows.length} rows ====`);
    const columns = table.columns.map(quoteIdentifier).join(', ');
    const identityClause = table.overrideIdentity ? ' overriding system value' : '';
    for (const row of rows) {
      const values = table.columns.map((column) => sqlValue(row[column])).join(', ');
      lines.push(
        `insert into public.${quoteIdentifier(table.name)} (${columns})${identityClause} values (${values});`,
      );
    }
    lines.push('');
  }

  lines.push(
    '-- Explicit identity inserts do not advance the sequence.',
    "select setval(pg_get_serial_sequence('public.organisations', 'id'), coalesce((select max(id) from public.organisations), 1), true);",
    '',
    'commit;',
    '',
  );
  return lines.join('\n');
}

export async function readTable(db, table, pageSize = PAGE_SIZE) {
  const rows = [];
  let expectedCount;

  for (let offset = 0; ; offset += pageSize) {
    let query = db
      .from(table.name)
      .select(table.columns.join(','), { count: offset === 0 ? 'exact' : undefined });
    for (const column of table.order) query = query.order(column, { ascending: true });

    const { data, error, count } = await query.range(offset, offset + pageSize - 1);
    if (error) {
      const optional = table.optionalColumns?.find((column) => table.columns.includes(column)
        && (error.code === '42703' || error.message?.includes(column)));
      if (optional) {
        return readTable(db, {
          ...table,
          columns: table.columns.filter((column) => column !== optional),
          optionalColumns: table.optionalColumns.filter((column) => column !== optional),
        }, pageSize);
      }
      throw new Error(`Could not back up ${table.name}: ${error.message}`);
    }
    if (offset === 0) expectedCount = count;
    rows.push(...data);
    if (data.length < pageSize) break;
  }

  if (expectedCount !== null && expectedCount !== undefined && rows.length !== expectedCount) {
    throw new Error(`Row count changed while backing up ${table.name}: expected ${expectedCount}, read ${rows.length}.`);
  }
  return rows;
}

export async function readApplicationTables(db) {
  const entries = await Promise.all(BACKUP_TABLES.map(async (table) => [table.name, await readTable(db, table)]));
  return Object.fromEntries(entries);
}

export async function listStorageObjects(db, bucket = BACKUP_BUCKET, prefix = '') {
  const objects = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db.storage.from(bucket).list(prefix, {
      limit: PAGE_SIZE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(`Could not list ${bucket}/${prefix}: ${error.message}`);

    for (const entry of data) {
      const objectPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) objects.push(...await listStorageObjects(db, bucket, objectPath));
      else objects.push({ path: objectPath, size: entry.metadata?.size ?? null });
    }
    if (data.length < PAGE_SIZE) break;
  }
  return objects;
}

export function missingReferencedPhotos(tables, objects) {
  const stored = new Set(objects.map((object) => object.path));
  return (tables.attendees ?? [])
    .map((attendee) => attendee.photo_path)
    .filter((photoPath) => photoPath && !stored.has(photoPath));
}
