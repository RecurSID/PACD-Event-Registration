import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredential, credentialHash } from '../../src/services/credential.js';
import { check, payload, pick, register, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

describe('credentials and attendance', { skip: skipReason }, () => {
  let db;
  let fixture;

  before(() => { db = testDb(); });
  beforeEach(async () => {
    await wipe(db);
    const { factory } = await seedOrgs(db, {
      factory: { kind: 'factory', name: 'Attendance Test Factory', code: 'AT-1' },
    });
    const attendeeId = await check(register(db, payload({ orgs: [pick(factory)] })));
    const [event] = await check(db.from('events').insert({
      code: 'attendance-test', name: 'Attendance Test', status: 'open',
    }).select('id'));
    const days = await check(db.from('event_days').insert([
      { event_id: event.id, event_date: '2030-01-01', label: 'Day 1' },
      { event_id: event.id, event_date: '2030-01-02', label: 'Day 2' },
    ]).select('id, label'));
    const [registration] = await check(db.from('event_registrations').insert({
      event_id: event.id, attendee_id: attendeeId,
    }).select('id'));
    const credential = createCredential();
    await check(db.rpc('issue_registration_credential', {
      p_registration_id: registration.id,
      p_token_hash: credential.tokenHash,
      p_fallback_code_hash: credential.fallbackHash,
    }));
    fixture = { attendeeId, event, days, registration, credential };
  });

  const scan = (hash, dayId, scanId = randomUUID()) => db.rpc('check_in_registration', {
    p_credential_hash: hash,
    p_event_day_id: dayId,
    p_scan_id: scanId,
    p_device_id: 'test-device',
    p_scanned_at_device: new Date().toISOString(),
    p_source: 'online',
  });

  test('first scan checks in, repeats are idempotent, and another day is independent', async () => {
    const firstId = randomUUID();
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id, firstId))).status, 'CHECKED_IN');
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id, firstId))).status, 'ALREADY_CHECKED_IN');
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id))).status, 'ALREADY_CHECKED_IN');
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[1].id))).status, 'CHECKED_IN');
    assert.equal((await check(db.from('attendance').select('id'))).length, 2);
  });

  test('rotation revokes the old QR while the replacement remains valid', async () => {
    const replacement = createCredential();
    await check(db.rpc('issue_registration_credential', {
      p_registration_id: fixture.registration.id,
      p_token_hash: replacement.tokenHash,
      p_fallback_code_hash: replacement.fallbackHash,
    }));
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id))).status, 'REVOKED');
    assert.equal((await check(scan(replacement.tokenHash, fixture.days[0].id))).status, 'CHECKED_IN');
    const credentials = await check(db.from('registration_credentials').select('status').eq('registration_id', fixture.registration.id));
    assert.deepEqual(credentials.map((row) => row.status).sort(), ['active', 'revoked']);
  });

  test('print preparation issues once and reuses the same credential on every reprint', async () => {
    const first = createCredential();
    const second = createCredential();
    const prepare = (credential) => db.rpc('prepare_event_credentials', {
      p_event_id: fixture.event.id,
      p_items: [{
        registration_id: fixture.registration.id,
        token_hash: credential.tokenHash,
        fallback_code_hash: credential.fallbackHash,
        print_token: credential.token,
        fallback_code: credential.fallback,
      }],
    });
    const firstRows = await check(prepare(first));
    const secondRows = await check(prepare(second));
    assert.equal(firstRows[0].issued, true);
    assert.equal(secondRows[0].issued, false);
    assert.equal(secondRows[0].token_hash, first.tokenHash);
    assert.equal(secondRows[0].print_token, first.token);
    assert.equal(secondRows[0].fallback_code, first.fallback);
  });

  test('new attendees automatically join the current event with organisation snapshots', async () => {
    const { factory } = await seedOrgs(db, {
      factory: { kind: 'factory', name: 'New Registration Factory', code: 'NEW-1' },
    });
    const attendeeId = await check(register(db, payload({ email: 'new-event-link@example.com', orgs: [pick(factory)] })));
    const registrations = await check(db.from('event_registrations')
      .select('id, registration_orgs(kind, name, code)')
      .eq('event_id', fixture.event.id)
      .eq('attendee_id', attendeeId));
    assert.equal(registrations.length, 1);
    assert.deepEqual(registrations[0].registration_orgs, [{ kind: 'factory', name: 'New Registration Factory', code: 'NEW-1' }]);
  });

  test('invalid, wrong-event, cancelled, and closed-event scans return stable statuses', async () => {
    assert.equal((await check(scan(credentialHash('ER1.unknown'), fixture.days[0].id))).status, 'INVALID');
    assert.equal((await check(scan(fixture.credential.tokenHash, randomUUID()))).status, 'WRONG_EVENT');
    await check(db.from('event_registrations').update({ status: 'cancelled' }).eq('id', fixture.registration.id));
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id))).status, 'REVOKED');
    await check(db.from('event_registrations').update({ status: 'confirmed' }).eq('id', fixture.registration.id));
    await check(db.from('events').update({ status: 'closed' }).eq('id', fixture.event.id));
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id))).status, 'OUTSIDE_CHECKIN_WINDOW');
  });
});
