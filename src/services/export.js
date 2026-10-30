import ExcelJS from 'exceljs';
import { EVENT_TIME_ZONE } from '../../public/shared/constants.js';

const SIDE = { supplier: 'Supplier', factory: 'Factory', other: 'Other' };
const REG_STATUS = { missing: 'Missing', registered: 'Registered', full: 'Full' };
const ORG_STATUS = { approved: 'Approved', pending: 'Pending' };

function dhakaParts(value) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: EVENT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

export function formatDhaka(value) {
  const p = dhakaParts(value);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function exportFilename(date) {
  const p = dhakaParts(date);
  return `registrations-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}.xlsx`;
}

const names = (list) => list.map((x) => x.name).join('; ');
const codes = (list) => list.map((x) => x.code).join('; ');
const peopleText = (people) => people.map((p) => `${p.name} (${SIDE[p.from_type]})`).join('; ');

// columns: [header, key, width]
function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  sheet.getRow(1).font = { bold: true };
  sheet.addRows(rows);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
}

const ORG_COLUMNS = [
  ['Name', 'name', 45],
  ['Source', 'source', 10],
  ['Status', 'status', 12],
  ['Seats used', 'seats_used', 12],
  ['Linked count', 'linked_count', 13],
  ['Registration status', 'reg_status', 20],
  ['People', 'people', 60],
];

const orgRow = (o) => ({
  name: o.name,
  source: o.source === 'list' ? 'List' : 'New',
  status: ORG_STATUS[o.status],
  seats_used: o.seats_used,
  linked_count: o.linked_count,
  reg_status: REG_STATUS[o.reg_status],
  people: peopleText(o.people),
});

export function buildWorkbook(data, { qrEvent, qrImages = [] } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(data.generated_at);
  const s = data.summary;

  addSheet(workbook, 'Summary', [['Item', 'item', 40], ['Value', 'value', 20]], [
    { item: `Exported at (${EVENT_TIME_ZONE})`, value: formatDhaka(data.generated_at) },
    { item: 'Participants', value: s.participants.total },
    { item: 'Participants from suppliers', value: s.participants.supplier },
    { item: 'Participants from factories', value: s.participants.factory },
    { item: 'Participants from other orgs', value: s.participants.other },
    { item: 'Suppliers registered (from list)', value: s.suppliers.list_registered },
    { item: 'Suppliers on list', value: s.suppliers.list_total },
    { item: 'Suppliers missing', value: s.suppliers.missing },
    { item: 'Suppliers full', value: s.suppliers.full },
    { item: 'Factories registered (from list)', value: s.factories.list_registered },
    { item: 'Factories on list', value: s.factories.list_total },
    { item: 'Factories missing', value: s.factories.missing },
    { item: 'Factories full', value: s.factories.full },
    { item: 'Pending approvals', value: s.pending },
    ...(qrEvent ? [{ item: 'QR code event', value: qrEvent.name }] : []),
  ]);

  const participantColumns = [
    ['Name', 'name', 25], ['Designation', 'designation', 22], ['Email', 'email', 30], ['Phone', 'phone', 18],
    ['From', 'from', 10], ['Suppliers', 'suppliers', 45], ['Supplier codes', 'supplier_codes', 20],
    ['Factories', 'factories', 45], ['Factory codes', 'factory_codes', 20],
    ['Organisation (other)', 'organisation', 30], ['Photo', 'photo', 8], ['Registered at', 'registered_at', 18],
    ...(qrEvent ? [['QR code', 'qr_code', 20]] : []),
  ];
  const participants = addSheet(workbook, 'Participants', participantColumns, data.participants.map((p) => ({
    name: p.name,
    designation: p.designation,
    email: p.email,
    phone: p.phone,
    from: SIDE[p.from_type],
    suppliers: names(p.suppliers),
    supplier_codes: codes(p.suppliers),
    factories: names(p.factories),
    factory_codes: codes(p.factories),
    organisation: p.organisation_name ?? '',
    photo: p.photo_path ? 'Y' : 'N',
    registered_at: formatDhaka(p.created_at),
    ...(qrEvent ? { qr_code: '' } : {}),
  })));
  const qrByAttendee = new Map(qrImages.map((item) => [item.attendeeId, item.png]));
  data.participants.forEach((participant, index) => {
    const png = qrByAttendee.get(participant.id);
    if (!png) return;
    const rowNumber = index + 2;
    participants.getRow(rowNumber).height = 96;
    const imageId = workbook.addImage({ buffer: png, extension: 'png' });
    participants.addImage(imageId, {
      tl: { col: 12.15, row: rowNumber - 0.9 },
      ext: { width: 118, height: 118 },
      editAs: 'oneCell',
    });
  });

  addSheet(workbook, 'Participant-Orgs', [
    ['Name', 'name', 25], ['Email', 'email', 30], ['Phone', 'phone', 18], ['From', 'from', 10],
    ['Org kind', 'kind', 10], ['Org name', 'org_name', 45], ['Code', 'code', 15],
    ['Uses seat', 'uses_seat', 10], ['Org status', 'org_status', 12],
  ], data.participants.flatMap((p) => [
    ...p.suppliers.map((o) => ['supplier', o]),
    ...p.factories.map((o) => ['factory', o]),
  ].map(([kind, o]) => ({
    name: p.name,
    email: p.email,
    phone: p.phone,
    from: SIDE[p.from_type],
    kind: SIDE[kind],
    org_name: o.name,
    code: o.code,
    uses_seat: o.uses_seat ? 'Y' : 'N',
    org_status: ORG_STATUS[o.status],
  }))));

  addSheet(workbook, 'Suppliers', ORG_COLUMNS, data.organisations.filter((o) => o.kind === 'supplier').map(orgRow));
  addSheet(workbook, 'Factories', ORG_COLUMNS, data.organisations.filter((o) => o.kind === 'factory').map(orgRow));

  const missing = ['supplier', 'factory'].flatMap((kind) =>
    data.organisations.filter((o) => o.kind === kind && o.reg_status === 'missing'));
  addSheet(workbook, 'Missing', [['Kind', 'kind', 12], ['Name', 'name', 50]],
    missing.map((o) => ({ kind: SIDE[o.kind], name: o.name })));

  addSheet(workbook, 'Pending', [
    ['Kind', 'kind', 12], ['Name', 'name', 45], ['People', 'people', 50], ['Codes typed', 'codes', 25], ['Created at', 'created_at', 18],
  ], data.pending.map((o) => ({
    kind: SIDE[o.kind],
    name: o.name,
    people: peopleText(o.people),
    codes: codes(o.people),
    created_at: formatDhaka(o.created_at),
  })));

  return workbook;
}
