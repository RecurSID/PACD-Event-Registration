import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, errorHandler, errors, fromDbError } from '../../src/errors.js';

const dbError = (message, details = null, code = 'P0001') => ({ message, details, hint: null, code });

test('SEAT_FULL becomes 409 naming the side, per-kind limit and organisations', () => {
  const err = fromDbError(dbError('SEAT_FULL', JSON.stringify({ side: 'factory', orgs: ['Aspire (1)', 'Windy (2)'] })));
  assert.ok(err instanceof AppError);
  assert.equal(err.code, 'SEAT_FULL');
  assert.equal(err.status, 409);
  assert.equal(err.message, 'Already full (factory limit 1): Aspire (1); Windy (2). Remove them or contact the event team.');
  const supplier = fromDbError(dbError('SEAT_FULL', JSON.stringify({ side: 'supplier', orgs: ['Padma'] })));
  assert.equal(supplier.message, 'Already full (supplier limit 2): Padma. Remove them or contact the event team.');
});

test('DUPLICATE_EMAIL becomes 409 with the spec message', () => {
  const err = fromDbError(dbError('DUPLICATE_EMAIL'));
  assert.equal(err.status, 409);
  assert.equal(err.message, 'This email is already registered. Contact the event team to change it.');
});

test('MERGE_OVER_LIMIT becomes 409 with the projected count and per-kind limit', () => {
  const err = fromDbError(dbError('MERGE_OVER_LIMIT', JSON.stringify({ target: 'PADMA TEXTILES LTD', side: 'supplier', count: 3 })));
  assert.equal(err.status, 409);
  assert.equal(err.message, 'PADMA TEXTILES LTD would have 3 supplier attendees (limit 2). Merge anyway?');
  assert.deepEqual(err.extra, { count: 3 });
  const factory = fromDbError(dbError('MERGE_OVER_LIMIT', JSON.stringify({ target: 'Aspire (24040)', side: 'factory', count: 2 })));
  assert.equal(factory.message, 'Aspire (24040) would have 2 factory attendees (limit 1). Merge anyway?');
});

test('NOT_FOUND and ORG_NOT_FOUND become 404', () => {
  for (const code of ['NOT_FOUND', 'ORG_NOT_FOUND']) {
    const err = fromDbError(dbError(code, '42'));
    assert.equal(err.code, code);
    assert.equal(err.status, 404);
    assert.equal(err.message, 'That record no longer exists. Refresh and try again.');
  }
});

test('VALIDATION from the database becomes 400 with a field entry', () => {
  const err = fromDbError(dbError('VALIDATION', 'orgs'));
  assert.equal(err.status, 400);
  assert.deepEqual(err.extra, { fields: { orgs: 'Invalid value.' } });
});

test('network failures and lock timeouts become 503, anything else 500', () => {
  assert.equal(fromDbError({ message: 'TypeError: fetch failed', details: '', hint: '', code: '' }).status, 503);
  assert.equal(fromDbError(dbError('deadlock detected', null, '40P01')).status, 503);
  // Foreign-key race: the organisation was removed (e.g. merged) while a registration referenced it.
  const fkRace = fromDbError(dbError('insert or update on table "attendee_orgs" violates foreign key constraint', null, '23503'));
  assert.equal(fkRace.status, 503);
  assert.equal(fkRace.code, 'DB_UNAVAILABLE');
  const other = fromDbError(dbError('relation "x" does not exist', null, '42P01'));
  assert.equal(other.status, 500);
  assert.equal(other.message, 'Something went wrong, please try again.');
});

function fakeRes() {
  return {
    headersSent: false,
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('errorHandler delegates errors after a streamed response has started', (t) => {
  t.mock.method(console, 'error', () => {});
  const error = new Error('stream failed');
  const res = { ...fakeRes(), headersSent: true };
  let delegated;
  errorHandler(error, { method: 'POST', originalUrl: '/api/admin/events/id/qrs.pdf' }, res, (err) => { delegated = err; });
  assert.equal(delegated, error);
  assert.equal(res.statusCode, 0);
});

test('errorHandler writes AppErrors as { error, message, ...extra }', () => {
  const res = fakeRes();
  errorHandler(errors.validation({ name: 'Too short.' }), { method: 'POST', originalUrl: '/api/register' }, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'VALIDATION', message: 'Please check the highlighted fields.', fields: { name: 'Too short.' } });
});

test('errorHandler hides unexpected errors behind a generic 500 and logs them', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const res = fakeRes();
  errorHandler(new Error('secret db detail'), { method: 'GET', originalUrl: '/api/x' }, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'INTERNAL', message: 'Something went wrong, please try again.' });
  assert.equal(logged.mock.callCount(), 1);
});

test('errorHandler turns body parse errors into VALIDATION', () => {
  const res = fakeRes();
  errorHandler(Object.assign(new Error('bad json'), { type: 'entity.parse.failed', status: 400 }), { method: 'POST', originalUrl: '/api/register' }, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'VALIDATION');
});
