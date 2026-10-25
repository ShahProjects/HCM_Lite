const db = require('../db');
const { HttpError, parseDate, today, eachDay } = require('../util');
const { getSettings, workingDays, audit, notifyEmployee, notifyRoles } = require('./core');

function balance(empId, year = new Date().getFullYear()) {
  const types = db.prepare('select * from leave_types order by id').all();
  const from = `${year}-01-01`, to = `${year}-12-31`;
  return types.map(t => {
    const used = db.prepare("select coalesce(sum(days),0) d from leave_requests where employee_id=? and type_id=? and status='approved' and start_date between ? and ?").get(empId, t.id, from, to).d;
    const pending = db.prepare("select coalesce(sum(days),0) d from leave_requests where employee_id=? and type_id=? and status='pending' and start_date between ? and ?").get(empId, t.id, from, to).d;
    return { type_id: t.id, type: t.name, paid: !!t.paid, quota: t.quota, used, pending, remaining: t.quota == null ? null : t.quota - used - pending };
  });
}
function apply(user, d) {
  const empId = user.employeeId; if (!empId) throw new HttpError(403, 'Only employees can apply for leave');
  let t = d.type_id ? db.prepare('select * from leave_types where id=?').get(d.type_id) : db.prepare('select * from leave_types where lower(name)=lower(?)').get(String(d.type || ''));
  if (!t) throw new HttpError(422, 'Unknown leave type');
  if (!parseDate(d.start) || !parseDate(d.end)) throw new HttpError(422, 'Start and end must be valid dates (YYYY-MM-DD)');
  if (d.end < d.start) throw new HttpError(422, 'End date is before start date');
  if (!d.reason || !String(d.reason).trim()) throw new HttpError(422, 'Reason is required');
  if (d.start < today() && !user.allowPast) throw new HttpError(422, 'Leave cannot start in the past');
  const days = workingDays(d.start, d.end).length;
  if (days === 0) throw new HttpError(422, 'Selected dates have no working days (weekend or holiday)');
  const overlap = db.prepare("select id from leave_requests where employee_id=? and status in ('pending','approved') and start_date<=? and end_date>=?").get(empId, d.end, d.start);
  if (overlap) throw new HttpError(422, 'These dates overlap another leave request');
  if (t.quota != null) {
    const b = balance(empId, Number(d.start.slice(0, 4))).find(x => x.type_id === t.id);
    if (days > b.remaining) throw new HttpError(422, `Not enough ${t.name} balance: ${b.remaining} day(s) left, ${days} requested`);
  }
  const id = db.prepare('insert into leave_requests(employee_id,type_id,start_date,end_date,days,reason) values(?,?,?,?,?,?)').run(empId, t.id, d.start, d.end, days, String(d.reason).trim()).lastInsertRowid;
  notifyRoles(['hr'], 'New leave request', `${user.name} requested ${days} day(s) of ${t.name} leave`);
  audit(user, 'create', 'leave', id, null, { type: t.name, start: d.start, end: d.end, days });
  return get(id);
}
const SEL = `select l.*, t.name as type, e.name as employee, e.code from leave_requests l join leave_types t on t.id=l.type_id join employees e on e.id=l.employee_id`;
const get = id => db.prepare(SEL + ' where l.id=?').get(id);
function list(user, { status, employee_id } = {}) {
  const w = [], p = [];
  if (user.role === 'employee') { w.push('l.employee_id=?'); p.push(user.employeeId); }
  else if (employee_id) { w.push('l.employee_id=?'); p.push(employee_id); }
  if (status) { w.push('l.status=?'); p.push(status); }
  return db.prepare(SEL + (w.length ? ' where ' + w.join(' and ') : '') + ' order by l.id desc limit 300').all(...p);
}
function decide(user, id, approve, comment) {
  const l = get(id); if (!l) throw new HttpError(404, 'Leave request not found');
  if (l.status !== 'pending') throw new HttpError(409, 'This request was already decided or cancelled');
  if (!approve && !(comment && String(comment).trim())) throw new HttpError(422, 'A comment is required when rejecting');
  db.prepare('update leave_requests set status=?, comment=?, decided_by=? where id=?').run(approve ? 'approved' : 'rejected', comment || null, user.id, id);
  notifyEmployee(l.employee_id, `Leave ${approve ? 'approved' : 'rejected'}`, `Your ${l.type} leave (${l.start_date} to ${l.end_date}) was ${approve ? 'approved' : 'rejected'}${comment ? ': ' + comment : ''}`);
  audit(user, approve ? 'approve' : 'reject', 'leave', id, { status: 'pending' }, { status: approve ? 'approved' : 'rejected', comment });
  return get(id);
}
function cancel(user, id) {
  const l = get(id); if (!l || l.employee_id !== user.employeeId) throw new HttpError(404, 'Leave request not found');
  if (!['pending', 'approved'].includes(l.status)) throw new HttpError(409, 'Only pending or approved leave can be cancelled');
  if (l.start_date < today()) throw new HttpError(409, 'Leave that has already started cannot be cancelled');
  db.prepare("update leave_requests set status='cancelled' where id=?").run(id);
  audit(user, 'cancel', 'leave', id, { status: l.status }, { status: 'cancelled' });
  return get(id);
}
module.exports = { balance, apply, list, decide, cancel, get };
