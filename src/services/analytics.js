const db = require('../db');
const { today, addDays, eachDay, round1, parseDate } = require('../util');
const { getSettings, holidaySet, isWorking, effStatus, workingDays } = require('./core');

const first = d => d.slice(0, 8) + '01';
function matrix({ from, to, departmentId, employeeId }) {
  const s = getSettings(), tod = today(), end = to > tod ? tod : to;
  if (from > end) return [];
  const w = [], p = [];
  if (departmentId) { w.push('department_id=?'); p.push(departmentId); }
  if (employeeId) { w.push('id=?'); p.push(employeeId); }
  const emps = db.prepare(`select id, department_id, join_date, exit_date from employees ${w.length ? 'where ' + w.join(' and ') : ''}`).all(...p);
  const hs = holidaySet(from, end);
  const recs = new Map(db.prepare('select * from attendance where date between ? and ?').all(from, end).map(r => [r.employee_id + '|' + r.date, r]));
  const leaveSet = new Set();
  db.prepare("select employee_id,start_date,end_date from leave_requests where status='approved' and start_date<=? and end_date>=?").all(end, from)
    .forEach(l => eachDay(l.start_date < from ? from : l.start_date, l.end_date > end ? end : l.end_date).forEach(d => leaveSet.add(l.employee_id + '|' + d)));
  const days = eachDay(from, end).filter(d => isWorking(d, s, hs));
  const out = [];
  for (const e of emps) for (const d of days) {
    if (d < e.join_date || (e.exit_date && d > e.exit_date)) continue;
    const k = e.id + '|' + d, rec = recs.get(k); let st;
    if (rec) st = effStatus(rec, s, tod);
    else if (leaveSet.has(k)) st = 'on_leave';
    else if (d === tod) continue;
    else st = 'absent';
    out.push({ employee_id: e.id, department_id: e.department_id, date: d, status: st });
  }
  return out;
}
function summarize(rows) {
  const c = { present: 0, late: 0, half_day: 0, missing_checkout: 0, absent: 0, on_leave: 0 };
  rows.forEach(r => { c[r.status]++; });
  const total = rows.length, base = total - c.on_leave;
  return { ...c, expected_days: total,
    attendance_rate: base > 0 ? round1((c.present + c.late + c.missing_checkout + 0.5 * c.half_day) / base * 100) : null,
    late_pct: c.present + c.late > 0 ? round1(c.late / (c.present + c.late) * 100) : null,
    absenteeism_pct: total > 0 ? round1(c.absent / total * 100) : null };
}
function headcountOn(date, departmentId) {
  const w = ['join_date<=?', '(exit_date is null or exit_date>?)'], p = [date, date];
  if (departmentId) { w.push('department_id=?'); p.push(departmentId); }
  return db.prepare(`select count(*) c from employees where ${w.join(' and ')}`).get(...p).c;
}
function lateComers({ from, to, departmentId, employeeId }, limit = 5) {
  const m = matrix({ from, to, departmentId, employeeId }).filter(r => r.status === 'late');
  const cnt = {}; m.forEach(r => { cnt[r.employee_id] = (cnt[r.employee_id] || 0) + 1; });
  return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, n]) => {
    const e = db.prepare('select e.name, e.code, d.name department from employees e left join departments d on d.id=e.department_id where e.id=?').get(id);
    return { employee: e.name, code: e.code, department: e.department, late_days: n };
  });
}
function leaveDaysInRange(l, from, to) {
  const a = l.start_date < from ? from : l.start_date, b = l.end_date > to ? to : l.end_date;
  return a > b ? 0 : workingDays(a, b).length;
}
function leaveSummary({ from, to, departmentId, employeeId }) {
  const w = ["l.status='approved'", 'l.start_date<=?', 'l.end_date>=?'], p = [to, from];
  if (departmentId) { w.push('e.department_id=?'); p.push(departmentId); }
  if (employeeId) { w.push('l.employee_id=?'); p.push(employeeId); }
  const ls = db.prepare(`select l.*, e.department_id from leave_requests l join employees e on e.id=l.employee_id where ${w.join(' and ')}`).all(...p);
  const empCount = employeeId ? 1 : db.prepare(`select count(*) c from employees where status!='exited' ${departmentId ? 'and department_id=' + Number(departmentId) : ''}`).get().c;
  const types = db.prepare('select * from leave_types order by id').all();
  const by_type = types.map(t => {
    const days = ls.filter(l => l.type_id === t.id).reduce((a, l) => a + leaveDaysInRange(l, from, to), 0);
    return { type: t.name, approved_days: days, quota_per_employee: t.quota, utilization_pct: t.quota ? round1(days / (t.quota * empCount) * 100) : null };
  });
  const tod = today();
  const on_leave_today = db.prepare(`select e.name, t.name as type from leave_requests l join employees e on e.id=l.employee_id join leave_types t on t.id=l.type_id
    where l.status='approved' and l.start_date<=? and l.end_date>=? ${departmentId ? 'and e.department_id=' + Number(departmentId) : ''} ${employeeId ? 'and e.id=' + Number(employeeId) : ''}`).all(tod, tod);
  return { from, to, by_type, on_leave_today_count: on_leave_today.length, on_leave_today };
}
function absenteeismByDept(from, to) {
  return db.prepare('select id, name from departments order by name').all().map(d => {
    const s = summarize(matrix({ from, to, departmentId: d.id }));
    return { department: d.name, absent_days: s.absent, absenteeism_pct: s.absenteeism_pct, headcount: headcountOn(to > today() ? today() : to, d.id) };
  });
}
function trend(from, to, departmentId) {
  const rows = matrix({ from, to, departmentId }), by = {};
  rows.forEach(r => { (by[r.date] = by[r.date] || []).push(r); });
  return Object.keys(by).sort().slice(-31).map(d => ({ date: d, rate: summarize(by[d]).attendance_rate }));
}
function latestRun() { return db.prepare("select * from payroll_runs order by (status='finalized') desc, month desc limit 1").get(); }

function dashboard(user, f = {}) {
  const tod = today();
  const from = parseDate(f.from) ? f.from : first(tod), to = parseDate(f.to) ? f.to : tod;
  const departmentId = f.department_id ? Number(f.department_id) : null;
  if (user.role === 'employee') return employeeDashboard(user);
  const todayRows = matrix({ from: tod, to: tod, departmentId });
  const pending = db.prepare("select count(*) c from leave_requests where status='pending'").get().c + db.prepare("select count(*) c from corrections where status='pending'").get().c;
  const att = summarize(matrix({ from, to, departmentId }));
  const out = {
    filters: { from, to, department_id: departmentId },
    kpis: { headcount: headcountOn(to > tod ? tod : to, departmentId), present_today: todayRows.filter(r => ['present', 'late', 'half_day'].includes(r.status)).length + 0,
      on_leave_today: leaveSummary({ from: tod, to: tod, departmentId }).on_leave_today_count, late_today: todayRows.filter(r => r.status === 'late').length, pending_approvals: pending },
    attendance: att, attendance_trend: trend(from, to, departmentId), absenteeism_by_department: absenteeismByDept(from, to).filter(d => !departmentId || true),
    leave_by_type: leaveSummary({ from, to, departmentId }).by_type, top_late_comers: lateComers({ from, to, departmentId }, 5),
  };
  // present today counts everyone with a record today (including those currently checked in)
  out.kpis.present_today = db.prepare(`select count(*) c from attendance a join employees e on e.id=a.employee_id where a.date=? ${departmentId ? 'and e.department_id=' + departmentId : ''}`).get(tod).c;
  if (user.role === 'admin') {
    const yStart = tod.slice(0, 4) + '-01-01';
    const exits = db.prepare('select count(*) c from employees where exit_date between ? and ?').get(yStart, tod).c;
    const avgHc = (headcountOn(yStart, null) + headcountOn(tod, null)) / 2;
    const run = latestRun();
    const sums = run ? db.prepare('select coalesce(sum(gross),0) g, coalesce(sum(net),0) n from payslips where run_id=?').get(run.id) : { g: 0, n: 0 };
    out.kpis.attrition_ytd_pct = avgHc > 0 ? round1(exits / avgHc * 100) : 0;
    out.kpis.payroll_cost_gross = Math.round(sums.g); out.kpis.payroll_cost_net = Math.round(sums.n); out.kpis.payroll_month = run ? run.month : null;
    out.kpis.avg_salary = Math.round(db.prepare("select coalesce(avg(salary_basic*1.5),0) a from employees where status!='exited'").get().a);
    out.headcount_by_department = db.prepare(`select d.name department, count(e.id) headcount from departments d left join employees e on e.department_id=d.id and e.status!='exited' group by d.id order by d.name`).all();
    out.payroll_cost_by_department = run ? db.prepare(`select d.name department, round(sum(p.gross)) gross, round(sum(p.net)) net from payslips p join employees e on e.id=p.employee_id join departments d on d.id=e.department_id where p.run_id=? group by d.id`).all(run.id) : [];
    out.gender = db.prepare("select coalesce(gender,'unspecified') gender, count(*) count from employees where status!='exited' group by 1").all();
    const t = { '<1 year': 0, '1-3 years': 0, '3+ years': 0 };
    db.prepare("select join_date from employees where status!='exited'").all().forEach(e => { const y = (Date.now() - parseDate(e.join_date)) / 31557600000; t[y < 1 ? '<1 year' : y < 3 ? '1-3 years' : '3+ years']++; });
    out.tenure = Object.entries(t).map(([bucket, count]) => ({ bucket, count }));
    out.audit_feed = db.prepare('select id, actor, action, entity, created_at from audit_log order by id desc limit 8').all();
  }
  return out;
}
function employeeDashboard(user) {
  const empId = user.employeeId, tod = today(), s = getSettings();
  const att = require('./attendance');
  const weekStart = addDays(tod, -((parseDate(tod).getDay() + 6) % 7));
  const week = att.records({ employeeId: empId, from: weekStart, to: tod });
  const hours = week.reduce((a, r) => a + (r.hours || 0), 0);
  const month = summarize(matrix({ from: first(tod), to: tod, employeeId: empId }));
  return {
    today: att.withStatus(db.prepare('select * from attendance where employee_id=? and date=?').get(empId, tod), s),
    hours_this_week: round1(hours), weekly_target: 40, late_count_month: month.late, attendance: month,
    leave_balance: require('./leave').balance(empId),
    last_payslip: db.prepare(`select p.*, r.month from payslips p join payroll_runs r on r.id=p.run_id where p.employee_id=? and r.status='finalized' order by r.month desc limit 1`).get(empId) || null,
  };
}
module.exports = { matrix, summarize, headcountOn, lateComers, leaveSummary, dashboard, absenteeismByDept, trend, first };
