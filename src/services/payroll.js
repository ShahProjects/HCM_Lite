const db = require('../db');
const PDFDocument = require('pdfkit');
const { HttpError, monthRange, today, round2 } = require('../util');
const { getSettings, workingDays, audit, notifyEmployee } = require('./core');
const { matrix, summarize } = require('./analytics');

function annualTax(a) {
  if (a <= 600000) return 0;
  if (a <= 1200000) return (a - 600000) * 0.05;
  if (a <= 2400000) return 30000 + (a - 1200000) * 0.15;
  if (a <= 3600000) return 210000 + (a - 2400000) * 0.25;
  return 510000 + (a - 3600000) * 0.35;
}
function computeSlip(emp, month, mr, wdAll, s) {
  const basic = emp.salary_basic, hra = basic * 0.4, medical = basic * 0.1, gross = basic + hra + medical; // = 1.5 x basic
  const wd = wdAll.length, perDay = wd ? gross / wd : 0;
  const empDays = wdAll.filter(d => d >= emp.join_date && (!emp.exit_date || d <= emp.exit_date));
  const sum = summarize(matrix({ from: mr.from, to: mr.to, employeeId: emp.id }));
  const unpaidTypes = db.prepare('select id from leave_types where paid=0').all().map(t => t.id);
  let unpaid = 0;
  if (unpaidTypes.length) {
    const ls = db.prepare(`select start_date,end_date from leave_requests where employee_id=? and status='approved' and type_id in (${unpaidTypes.join(',')}) and start_date<=? and end_date>=?`).all(emp.id, mr.to, mr.from);
    const set = new Set(empDays);
    ls.forEach(l => workingDays(l.start_date < mr.from ? mr.from : l.start_date, l.end_date > mr.to ? mr.to : l.end_date, s).forEach(d => { if (set.has(d)) unpaid++; }));
  }
  const latePenalty = Math.floor(sum.late / 3) * 0.5; // bonus rule: 3 lates = 0.5 day
  const deductDays = sum.absent + unpaid + 0.5 * sum.half_day + latePenalty;
  const earned = perDay * empDays.length, deduction = perDay * deductDays;
  const payable = Math.max(0, earned - deduction);
  const tax = wd ? annualTax(gross * 12) / 12 * (empDays.length / wd) : 0;
  const net = Math.max(0, payable - tax);
  return { employee_id: emp.id, basic: round2(basic), gross: round2(gross), working_days: wd, employed_days: empDays.length, absent_days: sum.absent, unpaid_days: unpaid, half_days: sum.half_day,
    deduction: round2(deduction), tax: round2(tax), net: round2(net),
    details: JSON.stringify({ hra: round2(hra), medical: round2(medical), per_day: round2(perDay), late_days: sum.late, late_penalty_days: latePenalty, earned: round2(earned), payable_before_tax: round2(payable), annual_gross: round2(gross * 12), annual_tax: round2(annualTax(gross * 12)) }) };
}
function createDraft(user, month) {
  const mr = monthRange(month); if (!mr) throw new HttpError(422, 'Month must be YYYY-MM');
  if (mr.from > today()) throw new HttpError(422, 'Cannot run payroll for a future month');
  const existing = db.prepare('select * from payroll_runs where month=?').get(month);
  if (existing && existing.status === 'finalized') throw new HttpError(409, 'This month is finalized and locked');
  const s = getSettings(), wdAll = workingDays(mr.from, mr.to, s);
  const emps = db.prepare('select * from employees where join_date<=? and (exit_date is null or exit_date>=?)').all(mr.to, mr.from);
  if (!emps.length) throw new HttpError(422, 'No employees were employed in that month');
  const slips = emps.map(e => computeSlip(e, month, mr, wdAll, s));
  const runId = db.transaction(() => {
    let id;
    if (existing) { id = existing.id; db.prepare('delete from payslips where run_id=?').run(id); }
    else id = db.prepare('insert into payroll_runs(month,created_by) values(?,?)').run(month, user.id).lastInsertRowid;
    const ins = db.prepare('insert into payslips(run_id,employee_id,basic,gross,working_days,employed_days,absent_days,unpaid_days,half_days,deduction,tax,net,details) values(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    slips.forEach(p => ins.run(id, p.employee_id, p.basic, p.gross, p.working_days, p.employed_days, p.absent_days, p.unpaid_days, p.half_days, p.deduction, p.tax, p.net, p.details));
    return id;
  })();
  audit(user, existing ? 'regenerate_draft' : 'create_draft', 'payroll_run', runId, null, { month, employees: slips.length });
  return getRun(runId);
}
function getRun(id) {
  const run = db.prepare('select * from payroll_runs where id=?').get(id); if (!run) throw new HttpError(404, 'Payroll run not found');
  const slips = db.prepare('select p.*, e.name, e.code, d.name department from payslips p join employees e on e.id=p.employee_id left join departments d on d.id=e.department_id where run_id=? order by e.name').all(id);
  return { ...run, slips, totals: { gross: round2(slips.reduce((a, p) => a + p.gross, 0)), deduction: round2(slips.reduce((a, p) => a + p.deduction, 0)), tax: round2(slips.reduce((a, p) => a + p.tax, 0)), net: round2(slips.reduce((a, p) => a + p.net, 0)) } };
}
const listRuns = () => db.prepare('select r.*, (select count(*) from payslips where run_id=r.id) employees, (select coalesce(sum(net),0) from payslips where run_id=r.id) net_total from payroll_runs r order by month desc').all();
function finalize(user, id) {
  const run = db.prepare('select * from payroll_runs where id=?').get(id); if (!run) throw new HttpError(404, 'Payroll run not found');
  if (run.status === 'finalized') throw new HttpError(409, 'Already finalized');
  db.prepare("update payroll_runs set status='finalized', finalized_by=?, finalized_at=datetime('now') where id=?").run(user.id, id);
  db.prepare('select employee_id from payslips where run_id=?').all(id).forEach(p => notifyEmployee(p.employee_id, 'Payslip ready', `Your payslip for ${run.month} is available`));
  audit(user, 'finalize', 'payroll_run', id, { status: 'draft' }, { status: 'finalized', month: run.month });
  return getRun(id);
}
function mySlips(user) {
  return db.prepare(`select p.id, r.month, p.gross, p.deduction, p.tax, p.net from payslips p join payroll_runs r on r.id=p.run_id where p.employee_id=? and r.status='finalized' order by r.month desc`).all(user.employeeId);
}
function slipPdf(user, id) {
  const p = db.prepare('select p.*, r.month, r.status from payslips p join payroll_runs r on r.id=p.run_id where p.id=?').get(id);
  if (!p) throw new HttpError(404, 'Payslip not found');
  if (user.role === 'employee' && (p.employee_id !== user.employeeId || p.status !== 'finalized')) throw new HttpError(404, 'Payslip not found');
  const e = db.prepare('select e.*, d.name department, g.name designation from employees e left join departments d on d.id=e.department_id left join designations g on g.id=e.designation_id where e.id=?').get(p.employee_id);
  const det = JSON.parse(p.details || '{}'), co = getSettings().company_name || 'Company';
  const doc = new PDFDocument({ margin: 50 });
  doc.fontSize(20).text(co, { align: 'center' }).fontSize(13).text(`Payslip - ${p.month}${p.status === 'draft' ? ' (DRAFT)' : ''}`, { align: 'center' }).moveDown();
  doc.fontSize(11).text(`Employee: ${e.name} (${e.code})`).text(`Department: ${e.department || '-'}   Designation: ${e.designation || '-'}`).text(`Joined: ${e.join_date}`).moveDown();
  const row = (a, b) => { const y = doc.y; doc.text(a, 50, y, { width: 300 }); doc.text(b, 350, y, { width: 190, align: 'right' }); doc.moveDown(0.3); };
  row('Basic salary', p.basic.toFixed(2)); row('House rent allowance (40%)', (det.hra || 0).toFixed(2)); row('Medical allowance (10%)', (det.medical || 0).toFixed(2));
  row('Gross salary', p.gross.toFixed(2)); doc.moveDown(0.5);
  row(`Working days in month / employed`, `${p.working_days} / ${p.employed_days}`);
  row(`Absent days`, String(p.absent_days)); row('Unpaid leave days', String(p.unpaid_days)); row('Half days', String(p.half_days));
  row('Attendance deduction', '- ' + p.deduction.toFixed(2)); row('Income tax (monthly)', '- ' + p.tax.toFixed(2)); doc.moveDown(0.5);
  doc.fontSize(14).text(`Net pay: ${p.net.toFixed(2)}`, 50, doc.y, { align: 'right' });
  doc.moveDown(2).fontSize(8).fillColor('gray').text('Tax slab is illustrative. System generated payslip.', { align: 'center' });
  doc.end();
  return { doc, filename: `payslip-${e.code}-${p.month}.pdf` };
}
module.exports = { createDraft, getRun, listRuns, finalize, mySlips, slipPdf, annualTax };
