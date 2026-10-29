import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import JSZip from 'jszip';
import { finished } from 'node:stream/promises';
import { callRpc, runQuery } from '../db.js';
import {
  createCredential, credentialHash, normaliseFallbackCode,
} from './credential.js';

const A4 = [595.28, 841.89];
const QR_RENDER_CONCURRENCY = 4;
const one = (value) => (Array.isArray(value) ? value[0] : value);

function company(attendee, organisations = []) {
  if (attendee.from_type === 'other') return attendee.organisation_name || '—';
  const matching = organisations.filter((organisation) => organisation.kind === attendee.from_type);
  const selected = matching.length ? matching : organisations;
  return selected.map((organisation) => organisation.name).filter(Boolean).join(', ') || '—';
}

function mapRows(rows) {
  return rows.map((row) => {
    const attendee = one(row.attendees) ?? {};
    return {
      registrationId: row.id,
      attendeeId: attendee.id,
      name: attendee.name || 'Unnamed attendee',
      company: company(attendee, row.registration_orgs ?? []),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listQrEvents(db) {
  const [events, registrations] = await Promise.all([
    runQuery(db.from('events').select('id, code, name, starts_at, status')),
    runQuery(db.from('event_registrations').select('event_id').eq('status', 'confirmed')),
  ]);
  const counts = new Map();
  registrations.forEach(({ event_id: id }) => counts.set(id, (counts.get(id) ?? 0) + 1));
  const priority = { open: 0, draft: 1, closed: 2, archived: 3 };
  return events.map((event) => ({ ...event, confirmed_registrations: counts.get(event.id) ?? 0 }))
    .sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9)
      || String(b.starts_at ?? '').localeCompare(String(a.starts_at ?? ''))
      || a.name.localeCompare(b.name));
}

async function loadBatch(db, eventId, registrationIds) {
  let query = db.from('event_registrations')
    .select('id, attendees(id, name, from_type, organisation_name), registration_orgs(kind, name)')
    .eq('event_id', eventId)
    .eq('status', 'confirmed');
  if (registrationIds?.length) query = query.in('id', registrationIds);
  const [events, rows] = await Promise.all([
    runQuery(db.from('events').select('id, code, name').eq('id', eventId)),
    runQuery(query),
  ]);
  if (!events[0]) return null;
  return { event: events[0], registrations: mapRows(rows) };
}

export async function listQrRegistrations(db, eventId) {
  const batch = await loadBatch(db, eventId);
  if (!batch) return null;
  const active = batch.registrations.length ? await runQuery(db.from('registration_credentials')
    .select('registration_id, print_token, fallback_code')
    .in('registration_id', batch.registrations.map((item) => item.registrationId))
    .eq('status', 'active')) : [];
  const existing = new Set(active
    .filter((row) => row.print_token && row.fallback_code)
    .map((row) => row.registration_id));
  return {
    event: batch.event,
    registrations: batch.registrations.map((item) => ({
      id: item.registrationId,
      attendee_id: item.attendeeId,
      name: item.name,
      company: item.company,
      has_qr: existing.has(item.registrationId),
    })),
  };
}

function candidate(registration) {
  const credential = createCredential();
  return {
    registration_id: registration.registrationId,
    token_hash: credential.tokenHash,
    fallback_code_hash: credential.fallbackHash,
    print_token: credential.token,
    fallback_code: credential.fallback,
  };
}

function recover(row) {
  const credential = { token: row?.print_token, fallback: row?.fallback_code };
  if (typeof credential.token !== 'string' || typeof credential.fallback !== 'string') {
    throw new Error('Stored QR credential has no printable values.');
  }
  if (credentialHash(credential.token) !== row.token_hash
      || credentialHash(normaliseFallbackCode(credential.fallback)) !== row.fallback_code_hash) {
    throw new Error('Stored QR credential failed its integrity check.');
  }
  return credential;
}

function qrUrl(baseUrl, token) {
  const url = new URL('/verify.html', baseUrl);
  url.hash = encodeURIComponent(token);
  return url.href;
}

function renderQr(baseUrl, token, width = 1200, margin = 4) {
  return QRCode.toBuffer(qrUrl(baseUrl, token), {
    type: 'png', width, margin, errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function prepareBatch(db, eventId, { registrationIds } = {}) {
  const batch = await loadBatch(db, eventId, registrationIds);
  if (!batch) return null;
  if (!batch.registrations.length) return { ...batch, empty: true };
  if (registrationIds?.length && batch.registrations.length !== registrationIds.length) {
    return { ...batch, invalidSelection: true };
  }
  const prepared = await callRpc(db, 'prepare_event_credentials', {
    p_event_id: eventId,
    p_items: batch.registrations.map((registration) => candidate(registration)),
  });
  const byRegistration = new Map(prepared.map((row) => [row.registration_id, row]));
  return {
    ...batch,
    credentials: batch.registrations.map((registration) => recover(byRegistration.get(registration.registrationId))),
  };
}

export async function generateQrPng(db, eventId, { registrationId, baseUrl }) {
  const batch = await prepareBatch(db, eventId, { registrationIds: [registrationId] });
  if (!batch || batch.empty || batch.invalidSelection) return batch;
  const credential = batch.credentials[0];
  return {
    ...batch,
    png: await renderQr(baseUrl, credential.token),
  };
}

export async function generateQrImages(db, eventId, { baseUrl, width = 360 } = {}) {
  const batch = await prepareBatch(db, eventId);
  if (!batch || batch.empty || batch.invalidSelection) return batch;
  return {
    ...batch,
    images: await mapConcurrent(
      batch.credentials,
      QR_RENDER_CONCURRENCY,
      (credential) => renderQr(baseUrl, credential.token, width, 3),
    ),
  };
}

export async function generateQrZip(db, eventId, { baseUrl, renderQrCode = renderQr } = {}) {
  const batch = await prepareBatch(db, eventId);
  if (!batch || batch.empty || batch.invalidSelection) return batch;
  const zip = new JSZip();
  const usedNames = new Map();
  const images = await mapConcurrent(
    batch.credentials,
    QR_RENDER_CONCURRENCY,
    (credential) => renderQrCode(baseUrl, credential.token),
  );
  for (let index = 0; index < batch.registrations.length; index += 1) {
    const registration = batch.registrations[index];
    const stem = `${safeName(registration.name)}-${safeName(registration.company, 'company')}-qr`;
    const occurrence = (usedNames.get(stem) ?? 0) + 1;
    usedNames.set(stem, occurrence);
    const filename = `${stem}${occurrence > 1 ? `-${occurrence}` : ''}.png`;
    zip.file(filename, images[index]);
  }
  return { ...batch, zip: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) };
}

function createPdfDocument(batch) {
  const doc = new PDFDocument({ autoFirstPage: false, size: A4, margin: 0, info: { Title: `${batch.event.name} QR codes` } });
  return doc;
}

async function populatePdf(doc, batch, baseUrl) {
  for (let index = 0; index < batch.registrations.length; index += 1) {
    const registration = batch.registrations[index];
    const credential = batch.credentials[index];
    const qr = await renderQr(baseUrl, credential.token, 1200, 3);
    doc.addPage({ size: A4, margin: 0 });
    doc.fillColor('#002b61').font('Helvetica-Bold').fontSize(24)
      .text(registration.name, 70, 130, { width: A4[0] - 140, align: 'center' });
    doc.image(qr, (A4[0] - 300) / 2, 205, { width: 300, height: 300 });
    doc.fillColor('#334e70').font('Helvetica').fontSize(13)
      .text(credential.fallback, 70, 530, { width: A4[0] - 140, align: 'center' });
  }
  doc.end();
}

export async function generateQrPdf(db, eventId, { registrationIds, baseUrl }) {
  const batch = await prepareBatch(db, eventId, { registrationIds });
  if (!batch || batch.empty || batch.invalidSelection) return batch;
  const doc = createPdfDocument(batch);
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const [, pdf] = await Promise.all([populatePdf(doc, batch, baseUrl), complete]);
  return { ...batch, pdf };
}

export async function prepareQrPdfStream(db, eventId, { registrationIds, baseUrl }) {
  const batch = await prepareBatch(db, eventId, { registrationIds });
  if (!batch || batch.empty || batch.invalidSelection) return batch;
  return {
    ...batch,
    async streamTo(output) {
      const doc = createPdfDocument(batch);
      doc.pipe(output);
      const complete = finished(output, { cleanup: true });
      try {
        await Promise.all([populatePdf(doc, batch, baseUrl), complete]);
      } catch (error) {
        doc.destroy(error);
        throw error;
      }
    },
  };
}

function safeName(value, fallback = 'attendee') {
  return String(value || fallback).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || fallback;
}

export const qrPngFilename = (registration) => `${safeName(registration.name)}-qr.png`;
export const qrPdfFilename = (event) => `${safeName(event.code || event.name || 'event')}-qr-codes.pdf`;
export const qrZipFilename = (event) => `${safeName(event.code || event.name || 'event')}-qr-codes.zip`;
