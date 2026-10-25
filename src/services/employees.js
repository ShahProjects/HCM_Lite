const db = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { HttpError, parseDate, today, pad } = require('../util');
const { audit, notifyRoles } = require('./core');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE = `select e.*, d.name as department, g.name as designation from employees e
  left join departments d on d.id=e.department_id left join designations g on g.id=e.designation_id`;
const tempPassword = () => crypto.randomBytes(5).toString('base64url') + '#1';

function nextCode() {
  let n = db.prepare('select count(*) c from employees').get().c + 1, code;
  do { code = 'EMP-' + pad(n++, 3); } while (db.prepare('select 1 from employees where code=?').get(code));
  return code;
}
function resolveDept(d) {
  if (d.department_id) return db.prepare('select * from departments where id=?').get(d.department_id);
  if (d.department) return db.prepare('select * from departments where lower(name)=lower(?)').get(String(d.department).trim());
  return null;
}
function resolveDesignation(d, create) {
  let name = d.designation && String(d.designation).trim();
  if (d.designation_id) return db.prepare('select * from designations where id=?').get(d.designation_id);
  if (!name) return null;
  let g = db.prepare('select * from designations where lower(name)=lower(?)').get(name);
  if (!g && create) g = { id: db.prepare('insert into designations(name) values(?)').run(name).lastInsertRowid, name };
  return g;
}
// returns {errors, clean}
function validateRow(d, excludeId, seen) {
  const errors = [], err = (field, reason) => errors.push({ field, reason });
  const clean = {};
  clean.name = String(d.name || '').trim(); if (!clean.name) err('name', 'required');
  clean.email = String(d.email || '').trim().toLowerCase();
  if (!clean.email) err('email', 'required'); else if (!EMAIL.test(clean.email)) err('email', 'invalid email');
  else {
    const dup = db.prepare('select id from employees where lower(email)=? and id is not ?').get(clean.email, excludeId || null)
      || db.prepare('select id from users where lower(email)=? and (employee_id is null or employee_id is not ?)').get(clean.email, excludeId || null);
    if (dup || (seen && seen.emails.has(clean.email))) err('email', 'already exists');
  }
  clean.code = String(d.code || '').trim();
  if (clean.code) {
    if (db.prepare('select id from employees where code=? and id is not ?').get(clean.code, excludeId || null) || (seen && seen.codes.has(clean.code))) err('code', 'already exists');
  }
  const dep = resolveDept(d); if (!dep) err('department', 'unknown department'); else clean.department_id = dep.id;
  if (d.designation_id && !resolveDesignation(d, false)) err('designation', 'unknown designation');
  clean.designation = d.designation; clean.designation_id = d.designation_id;
  if (!parseDate(d.join_date)) err('join_date', 'must be a valid ISO date YYYY-MM-DD'); else clean.join_date = d.join_date;
  const sal = Number(d.salary_basic); if (!(sal > 0)) err('salary_basic', 'must be greater than 0'); else clean.salary_basic = sal;
  if (d.gender) { const g = String(d.gender).toLowerCase(); if (!['male', 'female', 'other'].includes(g)) err('gender', 'male, female or other'); else clean.gender = g; }
  clean.phone = d.phone ? String(d.phone).trim() : null; clean.address = d.address ? String(d.address).trim() : null;
  if (d.status) { if (!['active', 'probation', 'exited'].includes(d.status)) err('status', 'active, probation or exited'); else clean.status = d.status; }
  if (d.exit_date) { if (!parseDate(d.exit_date)) err('exit_date', 'invalid date'); else clean.exit_date = d.exit_date; }
  return { errors, clean };
}

function createOne(d, actor, seen) {
  const { errors, clean } = validateRow(d, null, seen);
  if (errors.length) throw new HttpError(422, 'Validation failed', errors);
  const g = resolveDesignation(clean, true);
  const code = clean.code || nextCode();
  const pwd = tempPassword();
  const tx = db.transaction(() => {
    const id = db.prepare(`insert into employees(code,name,email,phone,address,gender,department_id,designation_id,join_date,status,salary_basic)
      values(?,?,?,?,?,?,?,?,?,?,?)`).run(code, clean.name, clean.email, clean.phone, clean.address, clean.gender || null, clean.department_id, g ? g.id : null,
      clean.join_date, clean.status || 'active', clean.salary_basic).lastInsertRowid;
    db.prepare('insert into users(email,name,password_hash,role,employee_id,must_change_password) values(?,?,?,?,?,1)')
      .run(clean.email, clean.name, bcrypt.hashSync(pwd, 10), 'employee', id);
    return id;
  });
  const id = tx();
  const emp = get(id);
  audit(actor, 'create', 'employee', id, null, { ...emp, salary_basic: '***' });
  return { employee: emp, temp_password: pwd };
}
const create = (d, actor) => createOne(d, actor);

function get(id) { return db.prepare(BASE + ' where e.id=?').get(id); }
function update(id, d, actor) {
  const before = get(id); if (!before) throw new HttpError(404, 'Employee not found');
  const merged = { ...before, ...d };
  if (d.department && !d.department_id) merged.department_id = undefined;
  if (d.department_id === undefined && !d.department) merged.department = undefined;
  const { errors, clean } = validateRow({ ...merged, code: d.code ?? before.code }, id);
  if (errors.length) throw new HttpError(422, 'Validation failed', errors);
  const g = resolveDesignation({ designation: d.designation, designation_id: d.designation_id }, true);
  const status = clean.status || before.status;
  let exit = clean.exit_date || before.exit_date;
  if (status === 'exited' && !exit) exit = today();
  if (status !== 'exited') exit = null;
  db.transaction(() => {
    db.prepare(`update employees set code=?,name=?,email=?,phone=?,address=?,gender=?,department_id=?,designation_id=?,join_date=?,status=?,exit_date=?,salary_basic=? where id=?`)
      .run(clean.code || before.code, clean.name, clean.email, clean.phone, clean.address, clean.gender || before.gender, clean.department_id,
        g ? g.id : before.designation_id, clean.join_date, status, exit, clean.salary_basic, id);
    db.prepare('update users set email=?, name=?, active=? where employee_id=?').run(clean.email, clean.name, status === 'exited' ? 0 : 1, id);
  })();
  const after = get(id);
  const mask = e => ({ ...e, salary_basic: undefined });
  audit(actor, 'update', 'employee', id, mask(before), mask(after));
  if (before.salary_basic !== after.salary_basic) audit(actor, 'update_salary', 'employee', id, { salary_basic: before.salary_basic }, { salary_basic: after.salary_basic });
  return after;
}
function selfUpdate(empId, d, actor) {
  const before = get(empId);
  db.prepare('update employees set phone=?, address=? where id=?').run(d.phone ?? before.phone, d.address ?? before.address, empId);
  const after = get(empId);
  audit(actor, 'update_profile', 'employee', empId, { phone: before.phone, address: before.address }, { phone: after.phone, address: after.address });
  return after;
}
function list({ search, department_id, status, page = 1, limit = 20 }) {
  const w = [], p = [];
  if (search) { w.push('(e.name like ? or e.email like ? or e.code like ?)'); const q = `%${search}%`; p.push(q, q, q); }
  if (department_id) { w.push('e.department_id=?'); p.push(department_id); }
  if (status) { w.push('e.status=?'); p.push(status); }
  const where = w.length ? ' where ' + w.join(' and ') : '';
  page = Math.max(1, Number(page) || 1); limit = Math.min(100, Math.max(1, Number(limit) || 20));
  const total = db.prepare(`select count(*) c from employees e${where}`).get(...p).c;
  const rows = db.prepare(BASE + where + ' order by e.id desc limit ? offset ?').all(...p, limit, (page - 1) * limit);
  return { rows, total, page, limit };
}

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}
function importCsv(text, dryRun, actor) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(422, 'CSV needs a header row and at least one data row');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const required = ['name', 'email', 'department', 'join_date', 'salary_basic'];
  const missing = required.filter(r => !head.includes(r));
  if (missing.length) throw new HttpError(422, 'Missing required columns', missing.map(m => ({ row: 1, field: m, reason: 'column missing' })));
  const seen = { emails: new Set(), codes: new Set() };
  const errors = [], valid = [];
  rows.slice(1).forEach((r, i) => {
    const d = {}; head.forEach((h, k) => { d[h] = (r[k] || '').trim(); });
    const { errors: es, clean } = validateRow(d, null, seen);
    if (es.length) es.forEach(e => errors.push({ row: i + 2, ...e }));
    else { valid.push(d); seen.emails.add(clean.email); if (clean.code) seen.codes.add(clean.code); }
  });
  const result = { total: rows.length - 1, valid_count: valid.length, error_count: errors.length, errors, dry_run: !!dryRun, created: [] };
  if (!dryRun) {
    valid.forEach(d => { const r = createOne(d, actor); result.created.push({ code: r.employee.code, name: r.employee.name, email: r.employee.email, temp_password: r.temp_password }); });
    audit(actor, 'csv_import', 'employee', null, null, { created: result.created.length, skipped: errors.length });
  }
  return result;
}
function exportCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cols = ['code', 'name', 'email', 'phone', 'department', 'designation', 'join_date', 'status', 'gender', 'salary_basic'];
  const rows = db.prepare(BASE + ' order by e.id').all();
  return [cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n');
}

function profile360(id) {
  const e = get(id); if (!e) throw new HttpError(404, 'Employee not found');
  const { summarize, matrix } = require('./analytics');
  const { fmtDate, addDays } = require('../util');
  const to = today(), from = addDays(to, -29);
  const att = summarize(matrix({ from, to, employeeId: id }));
  const leave = require('./leave');
  return {
    employee: e, attendance_last_30_days: att, leave_balance: leave.balance(id),
    recent_leaves: db.prepare('select l.*, t.name as type from leave_requests l join leave_types t on t.id=l.type_id where employee_id=? order by l.id desc limit 5').all(id),
    last_payslip: db.prepare(`select p.*, r.month, r.status from payslips p join payroll_runs r on r.id=p.run_id where p.employee_id=? and r.status='finalized' order by r.month desc limit 1`).get(id) || null,
  };
}
module.exports = { create, update, selfUpdate, get, list, importCsv, exportCsv, profile360, BASE };
