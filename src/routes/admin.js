import { Router } from 'express';
import { validateAdminParticipant } from '../../public/shared/validate.js';
import {
  COOKIE_NAME, clearCookieOptions, cookieOptions, passwordMatches, requireAdmin, signSession,
} from '../auth.js';
import { callRpc, runQuery } from '../db.js';
import { errors } from '../errors.js';
import { loadDashboard } from '../services/dashboard.js';
import { buildWorkbook, exportFilename } from '../services/export.js';
import { PHOTO_BUCKET, photoContentType } from '../services/photo.js';
import {
  generateQrImages, generateQrPng, generateQrZip, listQrEvents, listQrRegistrations,
  prepareQrPdfStream, qrPdfFilename, qrPngFilename, qrZipFilename,
} from '../services/qr.js';
import {
  attendanceFilename, buildAttendanceWorkbook, checkIn, listAttendanceDays, loadAttendance,
} from '../services/attendance.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function participantId(value) {
  if (!UUID_RE.test(value)) throw errors.notFound();
  return value;
}

function organisationId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw errors.notFound();
  return id;
}

async function currentPhotoPath(db, id) {
  const rows = await runQuery(db.from('attendees').select('photo_path').eq('id', id));
  return rows?.[0]?.photo_path ?? null;
}

// Best effort: storage lives outside the DB transaction, so a failed remove is only logged.
function dropPhoto(db, path, context) {
  if (!path) return;
  Promise.resolve(db.storage.from(PHOTO_BUCKET).remove([path]))
    .then(({ error }) => { if (error) throw error; })
    .catch((error) => console.warn(`Photo cleanup failed (${context}, ${path}):`, error.message));
}

export function adminRoutes({ db, config, loginDelayMs }) {
  const router = Router();

  router.post('/login', async (req, res) => {
    if (!passwordMatches(req.body?.password, config.adminPassword)) {
      await wait(loginDelayMs);
      throw errors.unauthorised('Wrong password.');
    }
    res.cookie(COOKIE_NAME, signSession(config.sessionSecret), cookieOptions(config));
    res.json({ ok: true });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, clearCookieOptions(config));
    res.json({ ok: true });
  });

  router.use(requireAdmin(config));

  router.get('/data', async (_req, res) => {
    const data = await loadDashboard(db);
    res.set('Cache-Control', 'no-store');
    res.json(data);
  });

  router.get('/export', async (req, res) => {
    const data = await loadDashboard(db);
    const event = (await listQrEvents(db)).find((item) => item.confirmed_registrations > 0);
    let qrImages = [];
    if (event) {
      const result = await generateQrImages(db, event.id, {
        baseUrl: `${req.protocol}://${req.get('host')}`,
      });
      qrImages = result?.images?.map((png, index) => ({
        attendeeId: result.registrations[index].attendeeId,
        png,
      })) ?? [];
    }
    const buffer = await buildWorkbook(data, { qrEvent: event, qrImages }).xlsx.writeBuffer();
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFilename(new Date(data.generated_at))}"`,
      'Cache-Control': 'no-store',
    });
    res.send(Buffer.from(buffer));
  });

  router.get('/qr-events', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ events: await listQrEvents(db) });
  });

  router.get('/events/:id/qr-registrations', async (req, res) => {
    const eventId = participantId(req.params.id);
    const result = await listQrRegistrations(db, eventId);
    if (!result) throw errors.notFound();
    res.set('Cache-Control', 'no-store');
    res.json(result);
  });

  router.get('/attendance-days', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ days: await listAttendanceDays(db) });
  });

  router.post('/attendance/check-in', async (req, res) => {
    const result = await checkIn(db, req.body);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  });

  router.get('/attendance', async (req, res) => {
    const data = await loadAttendance(db, req.query.event_day_id);
    res.set('Cache-Control', 'no-store');
    res.json(data);
  });

  router.get('/attendance/export', async (req, res) => {
    const data = await loadAttendance(db, req.query.event_day_id);
    const buffer = await buildAttendanceWorkbook(data).xlsx.writeBuffer();
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${attendanceFilename(data)}"`,
      'Cache-Control': 'no-store',
    });
    res.send(Buffer.from(buffer));
  });

  router.post('/events/:id/qrs.pdf', async (req, res) => {
    const eventId = participantId(req.params.id);
    let registrationIds;
    if (req.body?.registration_ids !== undefined) {
      if (!Array.isArray(req.body.registration_ids)
          || !req.body.registration_ids.length
          || req.body.registration_ids.length > 2000
          || req.body.registration_ids.some((id) => !UUID_RE.test(id))
          || new Set(req.body.registration_ids).size !== req.body.registration_ids.length) {
        throw errors.validation({ registration_ids: 'Select between 1 and 2,000 unique attendees.' });
      }
      registrationIds = req.body.registration_ids;
    }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const batch = await prepareQrPdfStream(db, eventId, {
      registrationIds,
      baseUrl,
    });
    if (!batch) throw errors.notFound();
    if (batch.empty) throw errors.conflict('This event has no confirmed registrations to print.');
    if (batch.invalidSelection) throw errors.conflict('One or more selected registrations are no longer confirmed. Refresh and try again.');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${qrPdfFilename(batch.event)}"`,
      'Cache-Control': 'no-store',
    });
    await batch.streamTo(res);
  });

  router.post('/events/:id/qrs.zip', async (req, res) => {
    const eventId = participantId(req.params.id);
    const batch = await generateQrZip(db, eventId, {
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
    if (!batch) throw errors.notFound();
    if (batch.empty) throw errors.conflict('This event has no confirmed registrations to download.');
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${qrZipFilename(batch.event)}"`,
      'Content-Length': String(batch.zip.length),
      'Cache-Control': 'no-store',
    });
    res.send(batch.zip);
  });

  router.post('/events/:id/qr.png', async (req, res) => {
    const eventId = participantId(req.params.id);
    const registrationId = participantId(req.body?.registration_id);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await generateQrPng(db, eventId, {
      registrationId,
      baseUrl,
    });
    if (!result) throw errors.notFound();
    if (result.empty || result.invalidSelection) {
      throw errors.conflict('This registration is no longer available. Refresh and try again.');
    }
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `inline; filename="${qrPngFilename(result.registrations[0])}"`,
      'Content-Length': String(result.png.length),
      'Cache-Control': 'no-store',
    });
    res.send(result.png);
  });

  router.get('/participants/:id/photo', async (req, res) => {
    const id = participantId(req.params.id);
    const path = await currentPhotoPath(db, id);
    if (!path) throw errors.notFound();
    const { data, error } = await db.storage.from(PHOTO_BUCKET).download(path);
    if (error || !data) throw errors.notFound();
    res.set({ 'Content-Type': photoContentType(path), 'Cache-Control': 'private, max-age=300' });
    res.send(Buffer.from(await data.arrayBuffer()));
  });

  router.post('/participants', async (req, res) => {
    const result = validateAdminParticipant(req.body);
    if (!result.ok) throw errors.validation(result.fields);
    const id = await callRpc(db, 'admin_register_attendee', { p: result.value });
    res.status(201).json({ id });
  });

  router.put('/participants/:id', async (req, res) => {
    const id = participantId(req.params.id);
    const result = validateAdminParticipant(req.body);
    if (!result.ok) throw errors.validation(result.fields);
    const oldPath = await currentPhotoPath(db, id);
    await callRpc(db, 'update_attendee', { p_id: id, p: result.value });
    if (oldPath !== result.value.photo_path) dropPhoto(db, oldPath, 'photo replaced');
    res.json({ ok: true });
  });

  router.delete('/participants/:id', async (req, res) => {
    const id = participantId(req.params.id);
    const oldPath = await currentPhotoPath(db, id);
    await callRpc(db, 'delete_attendee', { p_id: id });
    dropPhoto(db, oldPath, 'attendee deleted');
    res.json({ ok: true });
  });

  router.post('/organisations/:id/approve', async (req, res) => {
    await callRpc(db, 'approve_org', { p_id: organisationId(req.params.id) });
    res.json({ ok: true });
  });

  router.post('/organisations/:id/merge', async (req, res) => {
    const sourceId = organisationId(req.params.id);
    const targetId = req.body?.target_id;
    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      throw errors.validation({ target_id: 'Choose an organisation to merge into.' });
    }
    const seats_used = await callRpc(db, 'merge_org', {
      p_source: sourceId,
      p_target: targetId,
      p_allow_over_limit: req.body.allow_over_limit === true,
    });
    res.json({ ok: true, seats_used });
  });

  return router;
}
