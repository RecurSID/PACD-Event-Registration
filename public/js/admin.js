import { api } from './api.js';
import { renderCharts } from './charts.js';
import { prefersReducedMotion } from './motion.js';
import { mountRegistrationForm } from './registration-form.js';
import { EVENT_TIME_ZONE, SEAT_LIMITS } from '/shared/constants.js';
import { escapeHtml } from '/shared/form-logic.js';
import { filterOrganisations, filterParticipants, filterPending } from '/shared/admin-filters.js';

const $ = (selector) => document.querySelector(selector);
const SIDE = { supplier: 'Supplier', factory: 'Factory', other: 'Other' };
const STATUS = { missing: 'Missing', registered: 'Registered', full: 'Full' };

const view = { tab: 'participants', search: '', side: 'all', status: 'all' };
let data = null;
let attendanceDays = null;
let attendanceData = null;
let attendanceDayId = '';
let modalCleanup = null;

const formatTime = (iso) => new Date(iso).toLocaleString('en-GB', {
  timeZone: EVENT_TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const formatEventDate = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
  timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric',
});

// ---------- screens ----------

function showLogin() {
  closeModal();
  $('#dashboard').hidden = true;
  $('#login').hidden = false;
  $('#password').focus();
}

function showError(message) {
  const box = $('#dashboard').hidden ? $('#login-error') : $('#dash-error');
  box.textContent = message;
  box.hidden = false;
}

async function loadData() {
  data = await api('/api/admin/data');
  $('#login').hidden = true;
  $('#dashboard').hidden = false;
  $('#dash-error').hidden = true;
  $('#updated-at').textContent = `Updated ${formatTime(data.generated_at)}`;
  renderTiles();
  renderCharts(data, { onCoverageClick: showCoverage });
  if (view.tab === 'attendance') await loadAttendanceTab();
  else renderTab({ animate: true });
}

// A chart slice or legend "View" opens the Suppliers/Factories tab filtered to that status.
// The search box is cleared so the list shows exactly the organisations the chart counted.
function showCoverage(kind, status) {
  Object.assign(view, { tab: kind, status, side: 'all', search: '' });
  $('#search').value = '';
  renderTab({ animate: true });
  $('#tabs').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

// Runs an action; a 401 sends the admin back to the login screen, other errors show a message.
async function guarded(action) {
  try {
    await action();
  } catch (err) {
    if (err.status === 401) showLogin();
    else showError(err.message);
  }
}

const refresh = () => guarded(loadData);

// ---------- rendering ----------

// Last number shown per tile counter, so a refresh counts from the previous value instead of from 0.
const shownCounts = new Map();

function countUp(element) {
  const target = Number(element.dataset.count);
  const key = element.dataset.countKey;
  const start = shownCounts.get(key) ?? 0;
  shownCounts.set(key, target);
  if (prefersReducedMotion() || start === target) {
    element.textContent = String(target);
    return;
  }
  const duration = 800;
  const began = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - began) / duration);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = String(Math.round(start + (target - start) * eased));
    if (progress < 1) requestAnimationFrame(step);
  };
  element.textContent = String(start);
  requestAnimationFrame(step);
}

function renderTiles() {
  const s = data.summary;
  const counter = (key, value) => `<span data-count="${value}" data-count-key="${key}">${value}</span>`;
  const tile = (index, label, value, sub) =>
    `<div class="tile anim-rise" style="--i: ${index + 1}"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`;
  $('#tiles').innerHTML = [
    tile(0, 'Participants', counter('participants', s.participants.total), `supplier ${s.participants.supplier} · factory ${s.participants.factory} · other ${s.participants.other}`),
    tile(1, 'Suppliers', `${counter('suppliers', s.suppliers.list_registered)}/${s.suppliers.list_total}`, `missing ${s.suppliers.missing} · full ${s.suppliers.full}`),
    tile(2, 'Factories', `${counter('factories', s.factories.list_registered)}/${s.factories.list_total}`, `missing ${s.factories.missing} · full ${s.factories.full}`),
    tile(3, 'Pending approvals', counter('pending', s.pending), 'new organisations'),
  ].join('');
  $('#tiles').querySelectorAll('[data-count]').forEach(countUp);
}

function table(headers, rows, emptyText) {
  if (!rows.length) return `<p class="muted empty">${emptyText}</p>`;
  return `<table>
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((cells, i) => `<tr style="--i: ${Math.min(i, 15)}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

const orgLinks = (links) => links.map((o) =>
  `${escapeHtml(o.name)}${o.status === 'pending' ? ' <span class="badge pending">pending</span>' : ''} <code>${escapeHtml(o.code)}</code>`,
).join('<br>');

const peopleList = (people, withCodes = false) => people.map((p) =>
  `${escapeHtml(p.name)} <span class="muted">(${SIDE[p.from_type]})</span>${withCodes ? ` <code>${escapeHtml(p.code)}</code>` : ''}`,
).join('<br>');

function renderParticipants() {
  const rows = filterParticipants(data.participants, view);
  return table(
    ['Name', 'Designation', 'Email', 'Phone', 'From', 'Organisation', 'Suppliers', 'Factories', 'Photo', 'Registered', ''],
    rows.map((p) => [
      escapeHtml(p.name),
      escapeHtml(p.designation ?? ''),
      escapeHtml(p.email),
      escapeHtml(p.phone),
      SIDE[p.from_type],
      p.from_type === 'other' ? escapeHtml(p.organisation_name ?? '') : '—',
      p.suppliers.length ? orgLinks(p.suppliers) : '—',
      p.factories.length ? orgLinks(p.factories) : '—',
      p.photo_path
        ? `<a href="/api/admin/participants/${p.id}/photo" target="_blank" rel="noopener"><img class="photo-thumb" src="/api/admin/participants/${p.id}/photo" alt="Attendee photo"></a>`
        : '—',
      formatTime(p.created_at),
      `<span class="row-actions"><button type="button" class="btn small" data-qr="${p.id}">QR code</button>
       <button type="button" class="btn small" data-edit="${p.id}">Edit</button>
       <button type="button" class="btn small danger" data-delete="${p.id}">Delete</button></span>`,
    ]),
    'No participants match.',
  );
}

function renderOrganisations(kind) {
  const rows = filterOrganisations(data.organisations, { kind, search: view.search, status: view.status });
  const limit = SEAT_LIMITS[kind];
  return table(
    ['Name', 'Seats used', 'People', 'Status'],
    rows.map((o) => [
      `${escapeHtml(o.name)}${o.source === 'attendee' ? ' <span class="badge new">New</span>' : ''}`,
      o.seats_used > limit
        ? `${o.seats_used}/${limit} <span class="badge over">over limit</span>`
        : `${o.seats_used}/${limit}`,
      peopleList(o.people),
      `<span class="badge ${o.reg_status}">${STATUS[o.reg_status]}</span>`,
    ]),
    'No organisations match.',
  );
}

function renderPending() {
  const rows = filterPending(data.pending, view);
  return table(
    ['Kind', 'Name', 'People (code typed)', 'Added', ''],
    rows.map((o) => [
      SIDE[o.kind], escapeHtml(o.name), peopleList(o.people, true), formatTime(o.created_at),
      `<span class="row-actions"><button type="button" class="btn small primary" data-approve="${o.id}">Approve</button>
       <button type="button" class="btn small" data-merge="${o.id}">Merge into…</button></span>`,
    ]),
    'Nothing waiting for approval.',
  );
}

function renderAttendance() {
  if (!attendanceDays) return '<p class="muted empty">Loading attendance…</p>';
  if (!attendanceDays.length) return '<p class="muted empty">No event days exist yet.</p>';
  if (!attendanceData) return '<p class="muted empty">Loading attendance…</p>';
  const query = view.search.trim().toLocaleLowerCase();
  const rows = attendanceData.rows.filter((row) => !query ||
    [row.name, row.designation, row.organisation, row.attendance_status, row.registration_status]
      .some((value) => String(value ?? '').toLocaleLowerCase().includes(query)));
  const s = attendanceData.summary;
  return `<div class="attendance-summary">
    <div class="attendance-stat"><span class="muted">Registered</span><strong>${s.registered}</strong></div>
    <div class="attendance-stat"><span class="muted">Present</span><strong>${s.present}</strong></div>
    <div class="attendance-stat"><span class="muted">Pending</span><strong>${s.pending}</strong></div>
    ${s.inactive ? `<div class="attendance-stat"><span class="muted">Inactive</span><strong>${s.inactive}</strong></div>` : ''}
  </div>${table(
    ['Name', 'Designation', 'Organisation', 'Registration', 'Attendance', 'First check-in', 'Scanner'],
    rows.map((row) => [
      escapeHtml(row.name), escapeHtml(row.designation || '—'), escapeHtml(row.organisation),
      `<span class="badge ${escapeHtml(row.registration_status)}">${escapeHtml(row.registration_status)}</span>`,
      `<span class="badge ${escapeHtml(row.attendance_status)}">${row.attendance_status === 'present' ? 'Present' : 'Pending'}</span>`,
      row.checked_in_at ? formatTime(row.checked_in_at) : '—', escapeHtml(row.device_id || '—'),
    ]),
    'No attendees match.',
  )}`;
}

async function loadAttendanceTab() {
  attendanceData = null;
  renderTab();
  if (!attendanceDays) attendanceDays = (await api('/api/admin/attendance-days')).days;
  if (!attendanceDays.length) { renderTab({ animate: true }); return; }
  if (!attendanceDays.some((day) => day.id === attendanceDayId)) {
    attendanceDayId = (attendanceDays.find((day) => day.scan_enabled) ?? attendanceDays[0]).id;
  }
  renderChips();
  attendanceData = await api(`/api/admin/attendance?event_day_id=${encodeURIComponent(attendanceDayId)}`);
  renderTab({ animate: true });
}

function renderChips() {
  const chip = (group, value, label) =>
    `<button type="button" class="chip" data-chip-group="${group}" data-chip-value="${value}" aria-pressed="${view[group] === value}">${label}</button>`;
  let chips = [];
  if (view.tab === 'participants') {
    chips = [['all', 'All'], ['supplier', 'From supplier'], ['factory', 'From factory'], ['other', 'From other']].map(([v, l]) => chip('side', v, l));
  } else if (view.tab === 'supplier' || view.tab === 'factory') {
    chips = [['all', 'All'], ['missing', 'Missing'], ['registered', 'Registered'], ['full', 'Full']].map(([v, l]) => chip('status', v, l));
  } else if (view.tab === 'attendance' && attendanceDays?.length) {
    chips = [`<div class="attendance-controls">
      <label class="attendance-day-field" for="attendance-day"><span>Event day</span><select id="attendance-day">
      ${attendanceDays.map((day) => `<option value="${escapeHtml(day.id)}" ${day.id === attendanceDayId ? 'selected' : ''}>${escapeHtml(day.event.name)} · ${escapeHtml(day.label)} · ${formatEventDate(day.event_date)}</option>`).join('')}
      </select></label>
      <button type="button" class="btn attendance-export" data-attendance-export>Export attendance</button>
    </div>`];
  }
  $('#chips').classList.toggle('attendance-filters', view.tab === 'attendance');
  $('#chips').innerHTML = chips.join('');
}

function renderTabContent() {
  if (view.tab === 'participants') return renderParticipants();
  if (view.tab === 'pending') return renderPending();
  if (view.tab === 'attendance') return renderAttendance();
  return renderOrganisations(view.tab);
}

// animate: fade the table in and cascade its rows (tab/filter changes and data loads, not every search keystroke).
function renderTab({ animate = false } = {}) {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.tab === view.tab));
  });
  renderChips();
  $('#search').placeholder = view.tab === 'attendance' ? 'Search attendees…' : 'Search…';
  const tableWrap = $('#table');
  tableWrap.classList.remove('tab-enter');
  tableWrap.innerHTML = renderTabContent();
  if (animate) {
    void tableWrap.offsetWidth;
    tableWrap.classList.add('tab-enter');
  }
}

// ---------- dialogs ----------

const modal = $('#modal');

function openModal(html) {
  closeModal();
  $('#modal-body').innerHTML = html;
  document.documentElement.classList.add('modal-open');
  modal.showModal();
}

function closeModal() {
  if (modalCleanup) modalCleanup();
  modalCleanup = null;
  if (modal.open) modal.close();
  $('#modal-body').innerHTML = '';
  document.documentElement.classList.remove('modal-open', 'qr-preview-open');
}

modal.addEventListener('cancel', (event) => { event.preventDefault(); closeModal(); });

function showModalError(html) {
  const box = $('#modal-error');
  box.innerHTML = html;
  box.hidden = false;
}

async function runModalAction(action) {
  try {
    await action();
    closeModal();
    await refresh();
  } catch (err) {
    if (err.status === 401) showLogin();
    else showModalError(escapeHtml(err.message));
  }
}

function openAddParticipant() {
  openModal(`
    <div class="modal-head"><h2>Add participant</h2><button type="button" class="btn small" data-close>Close</button></div>
    <div id="add-participant-form" class="admin-add-form"></div>`);
  const form = mountRegistrationForm($('#add-participant-form'), {
    orgs: data.organisations,
    submitLabel: 'Add participant',
    showSeatStatus: false,
    requireFullName: false,
    keepOrgPickerOpen: true,
    optionalFields: true,
    onSubmit: async (payload) => {
      try {
        await api('/api/admin/participants', { method: 'POST', body: payload });
      } catch (err) {
        if (err.status === 401) { showLogin(); return; }
        throw err;
      }
      closeModal();
      await refresh();
    },
  });
  modalCleanup = () => form.destroy();
}

function openEdit(id) {
  const person = data.participants.find((p) => p.id === id);
  if (!person) return;
  openModal(`
    <div class="modal-head"><h2>Edit ${escapeHtml(person.name)}</h2><button type="button" class="btn small" data-close>Close</button></div>
    <div id="edit-form"></div>`);
  const form = mountRegistrationForm($('#edit-form'), {
    orgs: data.organisations,
    initial: person,
    submitLabel: 'Save changes',
    showSeatStatus: false,
    requireFullName: false,
    keepOrgPickerOpen: true,
    optionalFields: true,
    onSubmit: async (payload) => {
      try {
        await api(`/api/admin/participants/${id}`, { method: 'PUT', body: payload });
      } catch (err) {
        if (err.status === 401) { showLogin(); return; }
        throw err;
      }
      closeModal();
      await refresh();
    },
  });
  modalCleanup = () => form.destroy();
}

function confirmDelete(id) {
  const person = data.participants.find((p) => p.id === id);
  if (!person) return;
  const freed = [...person.suppliers, ...person.factories].filter((o) => o.uses_seat).map((o) => o.name);
  openModal(`
    <h2>Delete ${escapeHtml(person.name)}?</h2>
    <p>${freed.length ? `This frees seats at ${escapeHtml(freed.join('; '))}.` : 'This person does not hold any seats.'}</p>
    <p class="alert" id="modal-error" role="alert" hidden></p>
    <div class="modal-actions">
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn danger" id="confirm-delete">Delete</button>
    </div>`);
  $('#confirm-delete').addEventListener('click', () =>
    runModalAction(() => api(`/api/admin/participants/${id}`, { method: 'DELETE' })));
}

function openMerge(id) {
  const source = data.pending.find((o) => String(o.id) === id);
  if (!source) return;
  const plural = source.kind === 'supplier' ? 'suppliers' : 'factories';
  openModal(`
    <h2>Merge “${escapeHtml(source.name)}”</h2>
    <p>Moves its ${source.people.length} registration link(s) into an approved ${source.kind} and removes this pending name.</p>
    <div class="field">
      <label for="merge-target">Merge into</label>
      <select id="merge-target" placeholder="Search ${plural}…"></select>
    </div>
    <p class="alert" id="modal-error" role="alert" hidden></p>
    <div class="modal-actions">
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn primary" id="confirm-merge">Merge</button>
    </div>`);
  const picker = new window.TomSelect('#merge-target', {
    maxOptions: 500,
    options: data.organisations
      .filter((o) => o.kind === source.kind)
      .map((o) => ({ value: String(o.id), text: `${o.name} (${o.seats_used}/${SEAT_LIMITS[o.kind]})` })),
    // A warning (e.g. "Merge anyway?") belongs to the previous choice.
    onChange: () => {
      const box = $('#modal-error');
      box.hidden = true;
      box.innerHTML = '';
    },
  });
  modalCleanup = () => picker.destroy();

  // targetIdOverride: "Merge anyway" merges the organisation the warning was about.
  const merge = async (allowOverLimit, targetIdOverride) => {
    const targetId = targetIdOverride ?? Number(picker.getValue());
    if (!targetId) { showModalError('Choose an organisation to merge into.'); return; }
    try {
      await api(`/api/admin/organisations/${source.id}/merge`, {
        method: 'POST',
        body: { target_id: targetId, allow_over_limit: allowOverLimit },
      });
      closeModal();
      await refresh();
    } catch (err) {
      if (err.status === 401) { showLogin(); return; }
      if (err.code === 'MERGE_OVER_LIMIT') {
        showModalError(`${escapeHtml(err.message)} <button type="button" class="btn small danger" id="merge-anyway">Merge anyway</button>`);
        $('#merge-anyway').addEventListener('click', () => merge(true, targetId));
        return;
      }
      showModalError(escapeHtml(err.message));
    }
  };
  $('#confirm-merge').addEventListener('click', () => merge(false));
}

async function exportExcel(includeQr = false) {
  const url = includeQr ? '/api/admin/export?include_qr=1' : '/api/admin/export';
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) throw Object.assign(new Error('Please log in again.'), { status: 401 });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || 'Export failed, please try again.');
  }
  const blob = await res.blob();
  const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'registrations.xlsx';
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function downloadQrPdf(eventId, registrationIds, button) {
  button.disabled = true;
  button.textContent = 'Generating PDF…';
  try {
    const res = await fetch(`/api/admin/events/${eventId}/qrs.pdf`, {
      method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/pdf', 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationIds ? { registration_ids: registrationIds } : {}),
    });
    if (res.status === 401) throw Object.assign(new Error('Please log in again.'), { status: 401 });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || 'QR generation failed, please try again.');
    }
    const blob = await res.blob();
    const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'qr-codes.pdf';
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    closeModal();
  } finally {
    button.disabled = false;
    button.textContent = button.dataset.defaultLabel;
  }
}

async function downloadQrZip(eventId, button) {
  button.disabled = true;
  button.textContent = 'Generating ZIP…';
  try {
    const res = await fetch(`/api/admin/events/${eventId}/qrs.zip`, {
      method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/zip' },
    });
    if (res.status === 401) throw Object.assign(new Error('Please log in again.'), { status: 401 });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || 'QR ZIP generation failed, please try again.');
    }
    saveBlob(
      await res.blob(),
      /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'qr-codes.zip',
    );
    closeModal();
  } finally {
    button.disabled = false;
    button.textContent = button.dataset.defaultLabel;
  }
}

async function fetchIndividualQr(eventId, registrationId) {
  const response = await fetch(`/api/admin/events/${eventId}/qr.png`, {
    method: 'POST', credentials: 'same-origin',
    headers: { Accept: 'image/png', 'Content-Type': 'application/json' },
    body: JSON.stringify({ registration_id: registrationId }),
  });
  if (response.status === 401) throw Object.assign(new Error('Please log in again.'), { status: 401 });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || 'QR generation failed.');
  }
  return {
    blob: await response.blob(),
    filename: /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'attendee-qr.png',
  };
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

async function showQrPreview(eventId, registration, { onBack } = {}) {
  const manager = $('#qr-manager');
  const preview = $('#qr-preview') ?? $('#modal-body');
  const previousModalScroll = modal.scrollTop;
  if (manager) manager.hidden = true;
  modal.scrollTop = 0;
  preview.hidden = false;
  preview.classList.add('qr-preview');
  preview.innerHTML = '<p class="muted empty">Generating QR code…</p>';
  document.documentElement.classList.add('qr-preview-open');
  let url;
  try {
    const { blob, filename } = await fetchIndividualQr(eventId, registration.id);
    url = URL.createObjectURL(blob);
    preview.innerHTML = `
      <div class="modal-head"><h2>${escapeHtml(registration.name)}</h2><button type="button" class="btn small" data-close>Close</button></div>
      <img class="qr-preview-image" src="${url}" alt="QR code for ${escapeHtml(registration.name)}">
      <div class="modal-actions qr-preview-actions">
        ${onBack ? '<button type="button" class="btn" id="qr-back">Back</button>' : ''}
        <button type="button" class="btn" id="qr-print">Print</button>
        <button type="button" class="btn primary" id="qr-download">Download</button>
      </div>`;
    $('#qr-download').addEventListener('click', () => saveBlob(blob, filename));
    $('#qr-print').addEventListener('click', () => window.print());
    if (onBack) $('#qr-back').addEventListener('click', () => {
      URL.revokeObjectURL(url);
      url = null;
      preview.hidden = true;
      preview.classList.remove('qr-preview');
      preview.innerHTML = '';
      manager.hidden = false;
      document.documentElement.classList.remove('qr-preview-open');
      onBack();
      requestAnimationFrame(() => { modal.scrollTop = previousModalScroll; });
    });
    const previousCleanup = modalCleanup;
    modalCleanup = () => {
      if (url) URL.revokeObjectURL(url);
      previousCleanup?.();
    };
  } catch (error) {
    document.documentElement.classList.remove('qr-preview-open');
    if (manager) manager.hidden = false;
    preview.hidden = Boolean(manager);
    preview.classList.remove('qr-preview');
    preview.innerHTML = '';
    throw error;
  }
}

async function findQrRegistration(attendeeId) {
  const { events } = await api('/api/admin/qr-events');
  for (const event of events) {
    const result = await api(`/api/admin/events/${event.id}/qr-registrations`);
    const registration = result.registrations.find((item) => item.attendee_id === attendeeId);
    if (registration) return { event, registration };
  }
  throw new Error('This attendee is not registered for an event.');
}

async function openIndividualQr(attendeeId) {
  openModal('<p class="muted empty">Loading QR code…</p>');
  try {
    const { event, registration } = await findQrRegistration(attendeeId);
    await showQrPreview(event.id, registration);
  } catch (error) {
    closeModal();
    throw error;
  }
}

async function openQrs() {
  const { events } = await api('/api/admin/qr-events');
  if (!events.length) throw new Error('Create an event before generating QR codes.');
  openModal(`
    <div id="qr-manager">
    <div class="modal-head"><h2>QR codes</h2><button type="button" class="btn small" data-close>Close</button></div>
    <div class="field">
      <label for="qr-event">Event</label>
      <select id="qr-event">
        ${events.map((event) => `<option value="${escapeHtml(event.id)}">${escapeHtml(event.name)} — ${event.confirmed_registrations} confirmed</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="qr-search">Find attendees</label>
      <input id="qr-search" type="search" placeholder="Search name or company…">
    </div>
    <div class="qr-selection-head">
      <label><input id="qr-select-visible" type="checkbox"> Select visible</label>
      <strong id="qr-selected-count">0 selected</strong>
    </div>
    <div class="qr-selection" id="qr-selection"><p class="muted empty">Loading attendees…</p></div>
    <p class="alert" id="modal-error" role="alert" hidden></p>
    <div class="modal-actions">
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn" id="generate-all" data-default-label="Download all PDF">Download all PDF</button>
      <button type="button" class="btn" id="generate-zip" data-default-label="Download all ZIP">Download all ZIP</button>
      <button type="button" class="btn primary" id="generate-qrs" data-default-label="Download selected">Download selected</button>
    </div>
    </div>
    <section id="qr-preview" hidden></section>`);
  let registrations = [];
  const selected = new Set();

  const visibleRegistrations = () => {
    const query = $('#qr-search').value.trim().toLocaleLowerCase();
    return registrations.filter((item) => !query || `${item.name} ${item.company}`.toLocaleLowerCase().includes(query));
  };
  const renderChoices = () => {
    const visible = visibleRegistrations();
    $('#qr-selection').innerHTML = visible.length ? visible.map((item) => `
      <div class="qr-choice">
        <label><input type="checkbox" value="${escapeHtml(item.id)}" ${selected.has(item.id) ? 'checked' : ''}>
        <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.company)}</small></span>
        </label>
        <span class="row-actions"><button type="button" class="btn small" data-view-qr="${escapeHtml(item.id)}">View / download</button></span>
      </div>`).join('') : '<p class="muted empty">No attendees match.</p>';
    $('#qr-selected-count').textContent = `${selected.size} selected`;
    $('#qr-select-visible').checked = visible.length > 0 && visible.every((item) => selected.has(item.id));
    $('#generate-qrs').disabled = selected.size === 0;
    $('#qr-selection').querySelectorAll('input').forEach((input) => input.addEventListener('change', () => {
      if (input.checked) selected.add(input.value); else selected.delete(input.value);
      renderChoices();
    }));
    $('#qr-selection').querySelectorAll('[data-view-qr]').forEach((button) => button.addEventListener('click', () => {
      const registration = registrations.find((item) => item.id === button.dataset.viewQr);
      if (registration) guarded(() => showQrPreview($('#qr-event').value, registration, { onBack: () => {} }));
    }));
  };

  const loadChoices = async () => {
    selected.clear();
    $('#qr-selection').innerHTML = '<p class="muted empty">Loading attendees…</p>';
    const result = await api(`/api/admin/events/${$('#qr-event').value}/qr-registrations`);
    registrations = result.registrations;
    renderChoices();
  };

  const generate = async (button, ids) => {
    try {
      await downloadQrPdf($('#qr-event').value, ids, button);
    } catch (err) {
      if (err.status === 401) showLogin();
      else showModalError(escapeHtml(err.message));
    }
  };
  $('#generate-qrs').addEventListener('click', () => generate($('#generate-qrs'), [...selected]));
  $('#generate-all').addEventListener('click', () => generate($('#generate-all'), undefined));
  $('#generate-zip').addEventListener('click', async () => {
    try {
      await downloadQrZip($('#qr-event').value, $('#generate-zip'));
    } catch (err) {
      if (err.status === 401) showLogin();
      else showModalError(escapeHtml(err.message));
    }
  });
  $('#qr-event').addEventListener('change', () => guarded(loadChoices));
  $('#qr-search').addEventListener('input', renderChoices);
  $('#qr-select-visible').addEventListener('change', (event) => {
    visibleRegistrations().forEach((item) => event.target.checked ? selected.add(item.id) : selected.delete(item.id));
    renderChoices();
  });
  await loadChoices();
}

async function exportAttendance() {
  if (!attendanceDayId) throw new Error('Choose an event day.');
  const res = await fetch(`/api/admin/attendance/export?event_day_id=${encodeURIComponent(attendanceDayId)}`, { credentials: 'same-origin' });
  if (res.status === 401) throw Object.assign(new Error('Please log in again.'), { status: 401 });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || 'Attendance export failed.');
  }
  const blob = await res.blob();
  const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'attendance.xlsx';
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

// ---------- events ----------

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const d = button.dataset;
  if (d.tab) {
    Object.assign(view, { tab: d.tab, side: 'all', status: 'all' });
    if (d.tab === 'attendance') guarded(loadAttendanceTab);
    else renderTab({ animate: true });
  } else if (d.chipGroup) {
    view[d.chipGroup] = d.chipValue;
    renderTab({ animate: true });
  } else if ('qrs' in d) guarded(() => openQrs());
  else if (d.qr) guarded(() => openIndividualQr(d.qr));
  else if (d.edit) openEdit(d.edit);
  else if (d.delete) confirmDelete(d.delete);
  else if (d.approve) guarded(async () => {
    await api(`/api/admin/organisations/${d.approve}/approve`, { method: 'POST' });
    await loadData();
  });
  else if (d.merge) openMerge(d.merge);
  else if ('attendanceExport' in d) guarded(exportAttendance);
  else if ('close' in d) closeModal();
});

document.addEventListener('change', (event) => {
  if (event.target.id !== 'attendance-day') return;
  attendanceDayId = event.target.value;
  guarded(loadAttendanceTab);
});

$('#search').addEventListener('input', (event) => {
  view.search = event.target.value;
  renderTab();
});

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = $('#login-error');
  const button = event.target.querySelector('button');
  errorBox.hidden = true;
  button.disabled = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    await refresh();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('#refresh').addEventListener('click', refresh);
$('#add-participant').addEventListener('click', openAddParticipant);
$('#export').addEventListener('click', () => guarded(exportExcel));
$('#export-with-qrs').addEventListener('click', () => guarded(() => exportExcel(true)));
$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  data = null;
  attendanceDays = null;
  attendanceData = null;
  showLogin();
});

refresh();
