import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import QRCode from 'qrcode';
import { buildDashboard } from '../../src/services/dashboard.js';
import { buildWorkbook, exportFilename, formatDhaka } from '../../src/services/export.js';
import { fixtureAttendees, fixtureNow, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const data = () => buildDashboard({ orgs: fixtureOrgs, attendees: fixtureAttendees, now: fixtureNow });

async function roundTrip(workbook) {
  const buffer = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer);
  return loaded;
}

const headers = (sheet) => sheet.getRow(1).values.slice(1);
const column = (sheet, n) => sheet.getColumn(n).values.slice(2);

test('times and filenames use Asia/Dhaka (UTC+6)', () => {
  assert.equal(formatDhaka('2026-09-17T08:00:00Z'), '2026-09-17 14:00');
  assert.equal(formatDhaka('2026-09-17T20:05:00Z'), '2026-09-18 02:05');
  assert.equal(exportFilename(new Date('2026-09-17T08:30:00Z')), 'registrations-2026-09-17-1430.xlsx');
});

test('the workbook has the seven sheets in order, each with a bold frozen filtered header', async () => {
  const wb = await roundTrip(buildWorkbook(data()));
  assert.deepEqual(wb.worksheets.map((s) => s.name), [
    'Summary', 'Participants', 'Participant-Orgs', 'Suppliers', 'Factories', 'Missing', 'Pending',
  ]);
  for (const sheet of wb.worksheets) {
    assert.equal(sheet.getRow(1).getCell(1).font?.bold, true, `${sheet.name} header bold`);
    assert.equal(sheet.views[0]?.state, 'frozen', `${sheet.name} frozen`);
    assert.ok(sheet.autoFilter, `${sheet.name} has filters`);
  }
});

test('Summary lists every dashboard number', async () => {
  const wb = await roundTrip(buildWorkbook(data()));
  const summary = Object.fromEntries(
    wb.getWorksheet('Summary').getSheetValues().slice(2).map((row) => [row[1], row[2]]),
  );
  assert.equal(summary['Exported at (Asia/Dhaka)'], '2026-09-17 14:30');
  assert.equal(summary.Participants, 4);
  assert.equal(summary['Participants from factories'], 2);
  assert.equal(summary['Participants from other orgs'], 1);
  assert.equal(summary['Suppliers registered (from list)'], 1);
  assert.equal(summary['Suppliers on list'], 2);
  assert.equal(summary['Factories full'], 1);
  assert.equal(summary['Pending approvals'], 1);
});

test('Participants has one row per person with designation, organisation and photo columns', async () => {
  const sheet = (await roundTrip(buildWorkbook(data()))).getWorksheet('Participants');
  assert.deepEqual(headers(sheet), [
    'Name', 'Designation', 'Email', 'Phone', 'From', 'Suppliers', 'Supplier codes',
    'Factories', 'Factory codes', 'Organisation (other)', 'Photo', 'Registered at', 'QR code',
  ]);
  assert.equal(sheet.rowCount, 5);
  assert.deepEqual(sheet.getRow(2).values.slice(1), [
    'Rahim Uddin', 'Merchandiser', 'rahim@example.com', '+8801711000001', 'Factory',
    'Padma Textiles Ltd', 'S-1', 'Aspire Garments (24040); Rainbow Knit Ltd', 'F-3; R-5', '', 'Y', '2026-09-17 14:00', '',
  ]);
  assert.deepEqual(sheet.getRow(5).values.slice(1), [
    'Nadia Islam', 'Sustainability Lead', 'nadia@example.com', '+8801711000004', 'Other',
    '', '', '', '', 'Primark Limited', 'N', '2026-09-17 17:00', '',
  ]);
});

test('Participants embeds supplied QR PNGs in the rightmost column', async () => {
  const png = await QRCode.toBuffer('https://example.com/verify#test', { type: 'png', width: 120 });
  const workbook = await roundTrip(buildWorkbook(data(), {
    qrEvent: { name: 'Event 2026' },
    qrImages: [{ attendeeId: 'a1', png }],
  }));
  const sheet = workbook.getWorksheet('Participants');
  assert.equal(sheet.getImages().length, 1);
  assert.equal(sheet.getRow(2).height, 96);
  assert.equal(sheet.getColumn(13).values[1], 'QR code');
});

test('Participant-Orgs has one row per person–organisation link', async () => {
  const sheet = (await roundTrip(buildWorkbook(data()))).getWorksheet('Participant-Orgs');
  assert.deepEqual(headers(sheet), ['Name', 'Email', 'Phone', 'From', 'Org kind', 'Org name', 'Code', 'Uses seat', 'Org status']);
  assert.equal(sheet.rowCount, 1 + 5);
  assert.deepEqual(column(sheet, 8), ['N', 'Y', 'Y', 'Y', 'Y']);
});

test('Suppliers, Factories, Missing and Pending sheets match the dashboard', async () => {
  const wb = await roundTrip(buildWorkbook(data()));
  const suppliers = wb.getWorksheet('Suppliers');
  assert.deepEqual(headers(suppliers), ['Name', 'Source', 'Status', 'Seats used', 'Linked count', 'Registration status', 'People']);
  assert.deepEqual(column(suppliers, 1), ['New Supplier Co', 'Padma Textiles Ltd', 'Pearl Global']);
  assert.deepEqual(column(suppliers, 6), ['Missing', 'Registered', 'Missing']);
  assert.equal(suppliers.getRow(3).getCell(7).value, 'Rahim Uddin (Factory); Salma Begum (Supplier)');

  assert.deepEqual(column(wb.getWorksheet('Factories'), 6), ['Full', 'Missing']);
  assert.deepEqual(column(wb.getWorksheet('Missing'), 2), ['New Supplier Co', 'Pearl Global', 'Windy Apparels (20096)']);

  const pending = wb.getWorksheet('Pending');
  assert.deepEqual(headers(pending), ['Kind', 'Name', 'People', 'Codes typed', 'Created at']);
  assert.deepEqual(pending.getRow(2).values.slice(1), ['Factory', 'Rainbow Knit Ltd', 'Rahim Uddin (Factory)', 'R-5', '2026-09-17 12:15']);
});
