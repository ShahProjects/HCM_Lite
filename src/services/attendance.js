const db = require('../db');
const { HttpError, today, nowTime, hoursBetween, parseDate, haversine, round1 } = require('../util');
const { getSettings, effStatus, lateAfter, audit, notifyEmployee, notifyRoles } = require('./core');

const MAX_ACC = Number(process.env.GPS_MAX_ACCURACY || 100);
function needEmp(user) { if (!user.employeeId) throw new HttpError(403, 'Only employees can check in'); return user.employeeId; }
function withStatus(rec, s) { if (!rec) return null; const tod = today(); return { ...rec, status: effStatus(rec, s, tod), hours: rec.check_out ? round1(hoursBetween(rec.check_in, rec.check_out)) : null }; }

function checkIn(user, body = {}) {
  const empId = needEmp(user); const s = getSettings(); const date = today();
  const emp = db.prepare('select status from employees where id=?').get(empId);
  if (!emp || emp.status === 'exited') throw new HttpError(403, 'Employee is not active');
  if (db.prepare('select 1 from attendance where employee_id=? and date=?').get(empId, date)) throw new HttpError(409, 'You already checked in today');
  let source = 'web', lat = null, lng = null, dist = null;
  if (body.lat != null && body.lng != null) {
    lat = Number(body.lat); lng = Number(body.lng);
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw new HttpError(422, 'Invalid location');
  }
  if (body.source === 'camera') {
    if (s.office_lat == null || s.office_lng == null) throw new HttpError(422, 'Admin has not set the office location yet');
    if (Number(body.faceCount) !== 1) throw new HttpError(422, 'Exactly one face must be visible');
    if (lat == null) throw new HttpError(422, 'Location is required for camera check-in');
    if (!(Number(body.accuracy) <= MAX_ACC)) throw new HttpError(422, `GPS accuracy is worse than ${MAX_ACC} m (yours: ${Math.round(Number(body.accuracy))} m)`);
    dist = haversine(lat, lng, s.office_lat, s.office_lng);
    if (dist > s.office_radius) throw new HttpError(422, `You are ${Math.round(dist)} m from the office (allowed ${s.office_radius} m)`);
    source = 'camera';
  }
  const time = nowTime();
  const late = time.slice(0, 5) > lateAfter(s) ? 1 : 0;
  db.prepare('insert into attendance(employee_id,date,check_in,is_late,source,lat,lng,distance_m) values(?,?,?,?,?,?,?,?)').run(empId, date, time, late, source, lat, lng, dist);
  return withStatus(db.prepare('select * from attendance where employee_id=? and date=?').get(empId, date), s);
}
function verifyCamera(body, s) {
  if (s.office_lat == null || s.office_lng == null) throw new HttpError(422, 'Admin has not set the office location yet');
  if (Number(body.faceCount) !== 1) throw new HttpError(422, 'Exactly one face must be visible');
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(422, 'Location is required');
  if (!(Number(body.accuracy) <= MAX_ACC)) throw new HttpError(422, `GPS accuracy is worse than ${MAX_ACC} m (yours: ${Math.round(Number(body.accuracy))} m)`);
  const d = haversine(lat, lng, s.office_lat, s.office_lng);
  if (d > s.office_radius) throw new HttpError(422, 'You are ' + Math.round(d) + ' m from the office (allowed ' + s.office_radius + ' m)');
}
function checkOut(user, body = {}) {
  const empId = needEmp(user); const s = getSettings(); const date = today();
  const rec = db.prepare('select * from attendance where employee_id=? and date=?').get(empId, date);
  if (!rec) throw new HttpError(404, 'You have not checked in today');
  if (rec.check_out) throw new HttpError(409, 'You already checked out today');
  if (body.source === 'camera') verifyCamera(body, s);
  db.prepare('update attendance set check_out=? where id=?').run(nowTime(), rec.id);
  return withStatus(db.prepare('select * from attendance where id=?').get(rec.id), s);
}
function records({ employeeId, from, to }) {
  const s = getSettings();
  return db.prepare('select * from attendance where employee_id=? and date between ? and ? order by date').all(employeeId, from, to).map(r => withStatus(r, s));
}
function board(date) {
  const s = getSettings();
  const emps = db.prepare(`select e.id, e.code, e.name, d.name department from employees e left join departments d on d.id=e.department_id
    where e.join_date<=? and (e.exit_date is null or e.exit_date>=?) order by e.name`).all(date, date);
  const leaves = new Set(db.prepare("select employee_id from leave_requests where status='approved' and start_date<=? and end_date>=?").all(date, date).map(r => r.employee_id));
  return emps.map(e => {
    const r = db.prepare('select * from attendance where employee_id=? and date=?').get(e.id, date);
    const w = withStatus(r, s);
    return { ...e, check_in: r?.check_in || null, check_out: r?.check_out || null, source: r?.source || null, hours: w?.hours ?? null,
      status: w ? w.status : leaves.has(e.id) ? 'on_leave' : date < today() ? 'absent' : 'not_yet' };
  });
}
function requestCorrection(user, d) {
  const empId = needEmp(user);
  if (!parseDate(d.date) || d.date > today()) throw new HttpError(422, 'Date must be a valid past or current date');
  if (!d.reason || !String(d.reason).trim()) throw new HttpError(422, 'Reason is required');
  const t = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
  if (!d.check_in || !t.test(d.check_in)) throw new HttpError(422, 'Check-in time must be HH:MM');
  if (d.check_out && !t.test(d.check_out)) throw new HttpError(422, 'Check-out time must be HH:MM');
  if (db.prepare("select 1 from corrections where employee_id=? and date=? and status='pending'").get(empId, d.date)) throw new HttpError(409, 'A correction for that date is already pending');
  const id = db.prepare('insert into corrections(employee_id,date,check_in,check_out,reason) values(?,?,?,?,?)').run(empId, d.date, d.check_in.length === 5 ? d.check_in + ':00' : d.check_in, d.check_out ? (d.check_out.length === 5 ? d.check_out + ':00' : d.check_out) : null, String(d.reason).trim()).lastInsertRowid;
  notifyRoles(['hr'], 'Attendance correction request', `${user.name} requested a correction for ${d.date}`);
  audit(user, 'create', 'correction', id, null, d);
  return db.prepare('select * from corrections where id=?').get(id);
}
function listCorrections(user, status) {
  const w = [], p = [];
  if (user.role === 'employee') { w.push('c.employee_id=?'); p.push(user.employeeId); }
  if (status) { w.push('c.status=?'); p.push(status); }
  return db.prepare(`select c.*, e.name as employee, e.code from corrections c join employees e on e.id=c.employee_id ${w.length ? 'where ' + w.join(' and ') : ''} order by c.id desc limit 200`).all(...p);
}
function decideCorrection(user, id, approve, comment) {
  const c = db.prepare('select * from corrections where id=?').get(id);
  if (!c) throw new HttpError(404, 'Correction not found');
  if (c.status !== 'pending') throw new HttpError(409, 'Already decided');
  const s = getSettings();
  db.transaction(() => {
    if (approve) {
      const late = c.check_in.slice(0, 5) > lateAfter(s) ? 1 : 0;
      db.prepare(`insert into attendance(employee_id,date,check_in,check_out,is_late,source) values(?,?,?,?,?,'correction')
        on conflict(employee_id,date) do update set check_in=excluded.check_in, check_out=excluded.check_out, is_late=excluded.is_late, source='correction'`)
        .run(c.employee_id, c.date, c.check_in, c.check_out, late);
    }
    db.prepare('update corrections set status=?, decided_by=?, comment=? where id=?').run(approve ? 'approved' : 'rejected', user.id, comment || null, id);
  })();
  notifyEmployee(c.employee_id, `Correction ${approve ? 'approved' : 'rejected'}`, `Your correction for ${c.date} was ${approve ? 'approved' : 'rejected'}${comment ? ': ' + comment : ''}`);
  audit(user, approve ? 'approve' : 'reject', 'correction', id, { status: 'pending' }, { status: approve ? 'approved' : 'rejected', comment });
  return db.prepare('select * from corrections where id=?').get(id);
}
module.exports = { checkIn, checkOut, records, board, requestCorrection, listCorrections, decideCorrection, withStatus };
