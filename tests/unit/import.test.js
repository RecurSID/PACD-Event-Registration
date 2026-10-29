import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseList, readOrganisationLists } from '../../src/services/import.js';

test('parseList trims rows, skips blanks and keeps commas inside names', () => {
  const rows = parseList('code|name\n 84016 | BIOWORLD INTERNATIONAL LTD FOB \n\n83666|HONG KONG DIJIA TUO TECHNOLOGY CO., LIMITED\n', 'supplier');
  assert.deepEqual(rows, [
    { kind: 'supplier', code: '84016', name: 'BIOWORLD INTERNATIONAL LTD FOB' },
    { kind: 'supplier', code: '83666', name: 'HONG KONG DIJIA TUO TECHNOLOGY CO., LIMITED' },
  ]);
});

test('parseList rejects a malformed line and a wrong header', () => {
  assert.throws(() => parseList('code|name\nNO-PIPE-HERE\n', 'supplier'), /line 2/i);
  assert.throws(() => parseList('name|code\n68740|ABA\n', 'supplier'), /header/i);
});

async function writeLists(t, suppliers, factories) {
  const dir = await mkdtemp(path.join(tmpdir(), 'import-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'suppliers.psv'), suppliers);
  await writeFile(path.join(dir, 'factories.psv'), factories);
  return dir;
}

test('readOrganisationLists reads both files from a directory', async (t) => {
  const dir = await writeLists(t, 'code|name\n68740|ABA FASHIONS LTD\n', 'code|name\n24718|AB Apparels Ltd\n');
  assert.deepEqual(await readOrganisationLists(dir), [
    { kind: 'supplier', code: '68740', name: 'ABA FASHIONS LTD' },
    { kind: 'factory', code: '24718', name: 'AB Apparels Ltd' },
  ]);
});

test('the committed data files parse to 89 suppliers and 168 factories, all with codes', async () => {
  const dir = path.join(import.meta.dirname, '..', '..', 'scripts', 'data');
  const orgs = await readOrganisationLists(dir);
  const suppliers = orgs.filter((o) => o.kind === 'supplier');
  const factories = orgs.filter((o) => o.kind === 'factory');
  assert.equal(suppliers.length, 89);
  assert.equal(factories.length, 168);
  assert.ok(orgs.every((o) => /^[0-9]{5}$/.test(o.code) && o.name.length > 0));
});
