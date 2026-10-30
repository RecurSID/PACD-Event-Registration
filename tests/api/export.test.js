import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { COOKIE_NAME, signSession } from '../../src/auth.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';
import { fixtureAttendees, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

test('GET /api/admin/export requires a session', async () => {
  const res = await request(createApp({ db: fakeDb(), config: testConfig, loginDelayMs: 0 })).get('/api/admin/export');
  assert.equal(res.status, 401);
});

test('GET /api/admin/export downloads the original workbook without generating QR codes', async () => {
  const db = fakeDb({
    tables: {
      org_status: { data: fixtureOrgs, error: null },
      attendees: { data: fixtureAttendees, error: null },
    },
  });
  const res = await request(createApp({ db, config: testConfig, loginDelayMs: 0 }))
    .get('/api/admin/export')
    .set('Cookie', `${COOKIE_NAME}=${signSession(testConfig.sessionSecret)}`)
    .buffer(true)
    .parse(binary);

  assert.equal(res.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body);
  assert.equal(workbook.getWorksheet('Participants').columnCount, 12);
  assert.equal(workbook.getWorksheet('Participants').getImages().length, 0);
  assert.equal(db.calls.some((call) => call.fn === 'prepare_event_credentials'), false);
});

test('GET /api/admin/export?include_qr=1 embeds participant QR images', async () => {
  const db = fakeDb({
    tables: {
      org_status: { data: fixtureOrgs, error: null },
      attendees: { data: fixtureAttendees, error: null },
      events: { data: [{
        id: '11111111-1111-4111-8111-111111111111', code: 'event-2026', name: 'Event 2026',
        starts_at: '2026-11-04T03:00:00Z', status: 'open',
      }], error: null },
      event_registrations: { data: [{
        id: '22222222-2222-4222-8222-222222222222', event_id: '11111111-1111-4111-8111-111111111111',
        attendees: { id: 'a1', name: 'Rahim Uddin', from_type: 'factory', organisation_name: null },
        registration_orgs: [{ kind: 'factory', name: 'Aspire Garments' }],
      }], error: null },
    },
    rpc: {
      prepare_event_credentials: ({ p_items: items }) => ({
        data: items.map((item) => ({ ...item, issued: true })), error: null,
      }),
    },
  });
  const res = await request(createApp({ db, config: testConfig, loginDelayMs: 0 }))
    .get('/api/admin/export?include_qr=1')
    .set('Cookie', `${COOKIE_NAME}=${signSession(testConfig.sessionSecret)}`)
    .buffer(true)
    .parse(binary);

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(res.headers['content-disposition'], /^attachment; filename="registrations-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx"$/);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body);
  assert.equal(workbook.worksheets.length, 7);
  assert.equal(workbook.getWorksheet('Participants').rowCount, 5);
  assert.equal(workbook.getWorksheet('Participants').getImages().length, 1);
});
