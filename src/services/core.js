const db = require('../db');
const { HttpError, parseDate, eachDay, hoursBetween } = require('../util');

const DEFAULTS = { company_name: '', office_start: '09:00', grace_minutes: '15', half_day_hours: '5', weekend: '0,6', office_lat: '', office_lng: '', office_radius: '150' };
function getSettings() {
  const o = { ...DEFAULTS };
  db.prepare('select key,value from settings').all().forEach(r => { o[r.key] = r.value; });
  const num = v => (v === '' || v == null ? null : Number(v));
  return {
    company_name: o.company_name, office_start: o.office_start, grace_minutes: Number(o.grace_minutes),
    half_day_hours: Number(o.half_day_hours), weekend: o.weekend.split(',').filter(x => x !== '').map(Number),
    office_lat: num(o.office_lat), office_lng: num(o.office_lng), office_radius: Number(o.office_radius),
  };
}
function setSettings(d) {
  const errs = [];
  const put = {};
  if (d.company_name !== undefined) { if (!String(d.company_name).trim()) errs.push({ field: 'company_name', reason: 'required' }); else put.company_name = String(d.company_name).trim(); }
  if (d.office_start !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.office_start)) errs.push({ field: 'office_start', reason: 'use HH:MM' }); else put.office_start = d.office_start; }
  if (d.grace_minutes !== undefined) { const n = Number(d.grace_minutes); if (!(n >= 0 && n <= 180)) errs.push({ field: 'grace_minutes', reason: '0-180' }); else put.grace_minutes = n; }
  if (d.half_day_hours !== undefined) { const n = Number(d.half_day_hours); if (!(n > 0 && n <= 12)) errs.push({ field: 'half_day_hours', reason: '0-12' }); else put.half_day_hours = n; }
  if (d.weekend !== undefined) { const w = Array.isArray(d.weekend) ? d.weekend.map(Number) : String(d.weekend).split(',').map(Number); if (w.some(x => !(x >= 0 && x <= 6))) errs.push({ field: 'weekend', reason: 'days 0-6' }); else put.weekend = w.join(','); }
  if (d.office_lat !== undefined && d.office_lat !== '' && d.office_lat !== null) { const n = Number(d.office_lat); if (!(n >= -90 && n <= 90)) errs.push({ field: 'office_lat', reason: '-90..90' }); else put.office_lat = n; }
  if (d.office_lng !== undefined && d.office_lng !== '' && d.office_lng !== null) { const n = Number(d.office_lng); if (!(n >= -180 && n <= 180)) errs.push({ field: 'office_lng', reason: '-180..180' }); else put.office_lng = n; }
  if (d.office_radius !== undefined) { const n = Number(d.office_radius); if (!(n > 0)) errs.push({ field: 'office_radius', reason: 'must be > 0' }); else put.office_radius = n; }
  if (errs.length) throw new HttpError(422, 'Validation failed', errs);
  const up = db.prepare('insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value');
  db.transaction(() => Object.entries(put).forEach(([k, v]) => up.run(k, String(v))))();
  return getSettings();
}

const holidaySet = (from, to) => new Set(db.prepare('select date from holidays where date between ? and ?').all(from, to).map(r => r.date));
const isWorking = (date, s, hs) => !s.weekend.includes(parseDate(date).getDay()) && !hs.has(date);
const workingDays = (from, to, s = getSettings()) => { const hs = holidaySet(from, to); return eachDay(from, to).filter(d => isWorking(d, s, hs)); };

function effStatus(rec, s, tod) {
  if (rec.check_out && hoursBetween(rec.check_in, rec.check_out) < s.half_day_hours) return 'half_day';
  if (!rec.check_out && rec.date < tod) return 'missing_checkout';
  return rec.is_late ? 'late' : 'present';
}
function lateAfter(s) {
  const [h, m] = s.office_start.split(':').map(Number);
  const t = h * 60 + m + s.grace_minutes;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function audit(actor, action, entity, entityId, before, after) {
  db.prepare('insert into audit_log(actor_id,actor,action,entity,entity_id,before_json,after_json) values(?,?,?,?,?,?,?)')
    .run(actor ? actor.id : null, actor ? `${actor.email} (${actor.role})` : 'system', action, entity, entityId == null ? null : String(entityId),
      before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after));
}
function notify(userId, title, body) { if (userId) db.prepare('insert into notifications(user_id,title,body) values(?,?,?)').run(userId, title, body || ''); }
function notifyEmployee(empId, title, body) { const u = db.prepare('select id from users where employee_id=?').get(empId); if (u) notify(u.id, title, body); }
function notifyRoles(roles, title, body) { db.prepare(`select id from users where active=1 and role in (${roles.map(() => '?').join(',')})`).all(...roles).forEach(u => notify(u.id, title, body)); }

module.exports = { getSettings, setSettings, holidaySet, isWorking, workingDays, effStatus, lateAfter, audit, notify, notifyEmployee, notifyRoles };
