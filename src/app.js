require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { sign, auth, authAny, role } = require('./auth');
const { HttpError, parseDate, today, monthRange } = require('./util');
const core = require('./services/core');
const emps = require('./services/employees');
const att = require('./services/attendance');
const leave = require('./services/leave');
const payroll = require('./services/payroll');
const analytics = require('./services/analytics');
const ai = require('./services/ai');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/csv', limit: '2mb' }));
const api = express.Router();
const ADMIN = role('admin'), HR = role('hr'), STAFF = role('admin', 'hr');
const need = (v, name) => { if (v == null || String(v).trim() === '') throw new HttpError(422, 'Validation failed', [{ field: name, reason: 'required' }]); return String(v).trim(); };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const strongEnough = p => typeof p === 'string' && p.length >= 8;
const idParam = req => { const n = Number(req.params.id); if (!Number.isInteger(n)) throw new HttpError(400, 'Invalid id'); return n; };

// ---------- first run + auth ----------
const initialized = () => db.prepare('select count(*) c from users').get().c > 0;
function createAdmin(company, name, email, password) {
  if (!EMAIL.test(email || '')) throw new HttpError(422, 'Validation failed', [{ field: 'email', reason: 'invalid email' }]);
  if (!strongEnough(password)) throw new HttpError(422, 'Validation failed', [{ field: 'password', reason: 'at least 8 characters' }]);
  db.transaction(() => {
    core.setSettings({ company_name: company });
    db.prepare("insert into users(email,name,password_hash,role) values(?,?,?,'admin')").run(email.toLowerCase(), name || 'Admin', bcrypt.hashSync(password, 10));
    const lt = db.prepare('insert or ignore into leave_types(name,quota,paid) values(?,?,?)');
    [['Annual', 14, 1], ['Sick', 8, 1], ['Casual', 10, 1], ['Unpaid', null, 0]].forEach(x => lt.run(...x));
  })();
  core.audit({ id: null, email, role: 'admin' }, 'first_run_setup', 'company', null, null, { company_name: company });
}
api.get('/setup/status', (req, res) => res.json({ initialized: initialized(), company_name: core.getSettings().company_name }));
api.post('/setup', (req, res) => {
  if (initialized()) throw new HttpError(409, 'Setup already completed');
  createAdmin(need(req.body.company_name, 'company_name'), req.body.name, need(req.body.email, 'email'), req.body.password);
  res.status(201).json({ ok: true });
});
const userOut = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, employeeId: u.employeeId ?? u.employee_id, mustChange: u.mustChange ?? !!u.must_change_password });
api.post('/auth/login', (req, res) => {
  const u = db.prepare('select * from users where email=?').get(String(req.body.email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) throw new HttpError(401, 'Wrong email or password');
  if (!u.active) throw new HttpError(403, 'This account is deactivated. Contact your administrator.');
  res.json({ token: sign(u), user: userOut(u) });
});
api.get('/auth/me', authAny, (req, res) => res.json({ user: userOut(req.user), settings: core.getSettings() }));
api.post('/auth/change-password', authAny, (req, res) => {
  const u = db.prepare('select * from users where id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.current_password || ''), u.password_hash)) throw new HttpError(401, 'Current password is wrong');
  if (!strongEnough(req.body.new_password)) throw new HttpError(422, 'New password must be at least 8 characters');
  if (req.body.new_password === req.body.current_password) throw new HttpError(422, 'New password must be different');
  db.prepare('update users set password_hash=?, must_change_password=0 where id=?').run(bcrypt.hashSync(req.body.new_password, 10), u.id);
  core.audit(req.user, 'change_password', 'user', u.id);
  res.json({ ok: true });
});
api.use(auth);

// ---------- settings + organization ----------
api.get('/settings', (req, res) => res.json(core.getSettings()));
api.put('/settings', ADMIN, (req, res) => { const b = core.getSettings(); const a = core.setSettings(req.body); core.audit(req.user, 'update', 'settings', null, b, a); res.json(a); });
function crud(table, label, fields, { unique } = {}) {
  const r = express.Router();
  r.get('/', (req, res) => res.json(db.prepare(`select * from ${table} order by ${table === 'holidays' ? 'date' : 'name'}`).all()));
  r.post('/', ADMIN, (req, res) => {
    const vals = fields.map(f => f.parse(req.body[f.name], f.name));
    try {
      const id = db.prepare(`insert into ${table}(${fields.map(f => f.name).join(',')}) values(${fields.map(() => '?').join(',')})`).run(...vals).lastInsertRowid;
      const row = db.prepare(`select * from ${table} where id=?`).get(id); core.audit(req.user, 'create', label, id, null, row); res.status(201).json(row);
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, `${label} already exists`); throw e; }
  });
  r.put('/:id', ADMIN, (req, res) => {
    const id = idParam(req), b = db.prepare(`select * from ${table} where id=?`).get(id); if (!b) throw new HttpError(404, 'Not found');
    const vals = fields.map(f => req.body[f.name] === undefined ? b[f.name] : f.parse(req.body[f.name], f.name));
    try { db.prepare(`update ${table} set ${fields.map(f => f.name + '=?').join(',')} where id=?`).run(...vals, id); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, `${label} already exists`); throw e; }
    const a = db.prepare(`select * from ${table} where id=?`).get(id); core.audit(req.user, 'update', label, id, b, a); res.json(a);
  });
  r.delete('/:id', ADMIN, (req, res) => {
    const id = idParam(req), b = db.prepare(`select * from ${table} where id=?`).get(id); if (!b) throw new HttpError(404, 'Not found');
    try { db.prepare(`delete from ${table} where id=?`).run(id); } catch (e) { if (/FOREIGN/.test(e.message)) throw new HttpError(409, `${label} is in use and cannot be deleted`); throw e; }
    core.audit(req.user, 'delete', label, id, b, null); res.json({ ok: true });
  });
  return r;
}
const txt = (v, n) => { if (!v || !String(v).trim()) throw new HttpError(422, 'Validation failed', [{ field: n, reason: 'required' }]); return String(v).trim(); };
api.use('/departments', crud('departments', 'department', [{ name: 'name', parse: txt }]));
api.use('/designations', crud('designations', 'designation', [{ name: 'name', parse: txt }]));
api.use('/leave-types', crud('leave_types', 'leave_type', [{ name: 'name', parse: txt },
  { name: 'quota', parse: v => { if (v === null || v === '' || v === undefined) return null; const n = Number(v); if (!(n >= 0)) throw new HttpError(422, 'Validation failed', [{ field: 'quota', reason: 'must be 0 or more (blank = unlimited)' }]); return n; } },
  { name: 'paid', parse: v => (v === 0 || v === false || v === '0' ? 0 : 1) }]));
api.use('/holidays', crud('holidays', 'holiday', [{ name: 'date', parse: (v, n) => { if (!parseDate(v)) throw new HttpError(422, 'Validation failed', [{ field: n, reason: 'valid date YYYY-MM-DD required' }]); return v; } }, { name: 'name', parse: txt }]));

// ---------- users ----------
const tempPwd = () => require('crypto').randomBytes(5).toString('base64url') + '#1';
api.get('/users', ADMIN, (req, res) => res.json(db.prepare('select id,email,name,role,employee_id,active,must_change_password,created_at from users order by id').all()));
api.post('/users', ADMIN, (req, res) => {
  const email = need(req.body.email, 'email').toLowerCase(), name = need(req.body.name, 'name');
  if (!EMAIL.test(email)) throw new HttpError(422, 'Validation failed', [{ field: 'email', reason: 'invalid email' }]);
  if (db.prepare('select 1 from users where email=?').get(email) || db.prepare('select 1 from employees where lower(email)=?').get(email)) throw new HttpError(409, 'Email already in use');
  const pwd = tempPwd();
  const id = db.prepare("insert into users(email,name,password_hash,role,must_change_password) values(?,?,?,'hr',1)").run(email, name, bcrypt.hashSync(pwd, 10)).lastInsertRowid;
  core.audit(req.user, 'create', 'user', id, null, { email, role: 'hr' });
  res.status(201).json({ id, email, role: 'hr', temp_password: pwd });
});
function userAction(path, fn) {
  api.post(`/users/:id/${path}`, ADMIN, (req, res) => {
    const id = idParam(req), u = db.prepare('select * from users where id=?').get(id); if (!u) throw new HttpError(404, 'User not found');
    if (u.id === req.user.id) throw new HttpError(409, 'You cannot do this to your own account');
    res.json(fn(u, req));
  });
}
userAction('deactivate', u => { db.prepare('update users set active=0 where id=?').run(u.id); core.audit({ id: 0, email: 'admin', role: 'admin' }, 'deactivate', 'user', u.id, { active: 1 }, { active: 0 }); return { ok: true }; });
userAction('reactivate', u => { db.prepare('update users set active=1 where id=?').run(u.id); return { ok: true }; });
userAction('reset-password', (u, req) => { const p = tempPwd(); db.prepare('update users set password_hash=?, must_change_password=1 where id=?').run(bcrypt.hashSync(p, 10), u.id); core.audit(req.user, 'reset_password', 'user', u.id); return { temp_password: p }; });

// ---------- employees ----------
api.get('/employees/me', (req, res) => { if (!req.user.employeeId) throw new HttpError(404, 'No employee profile'); const e = emps.get(req.user.employeeId); res.json(e); });
api.patch('/employees/me', role('employee'), (req, res) => res.json(emps.selfUpdate(req.user.employeeId, { phone: req.body.phone, address: req.body.address }, req.user)));
api.get('/employees/export', HR, (req, res) => { res.type('text/csv').attachment('employees.csv').send(emps.exportCsv()); });
api.post('/employees/import', HR, (req, res) => {
  const csv = typeof req.body === 'string' ? req.body : req.body.csv;
  res.json(emps.importCsv(csv, req.query.dryRun === '1' || req.query.dryRun === 'true' || req.body.dryRun === true, req.user));
});
api.get('/employees', STAFF, (req, res) => res.json(emps.list(req.query)));
api.post('/employees', HR, (req, res) => res.status(201).json(emps.create(req.body, req.user)));
api.get('/employees/:id', (req, res) => {
  const id = idParam(req);
  if (req.user.role === 'employee' && id !== req.user.employeeId) throw new HttpError(403, 'You can only view your own profile');
  const p = emps.profile360(id);
  if (req.user.role === 'employee') delete p.employee.salary_basic;
  res.json(p);
});
api.put('/employees/:id', HR, (req, res) => res.json(emps.update(idParam(req), req.body, req.user)));

// ---------- attendance ----------
api.post('/attendance/check-in', role('employee'), (req, res) => res.status(201).json(att.checkIn(req.user, req.body)));
api.post('/attendance/check-out', role('employee'), (req, res) => res.json(att.checkOut(req.user, req.body)));
api.get('/attendance/me', role('employee'), (req, res) => {
  const mr = monthRange(req.query.month || today().slice(0, 7)); if (!mr) throw new HttpError(422, 'month must be YYYY-MM');
  res.json({ month: req.query.month || today().slice(0, 7), records: att.records({ employeeId: req.user.employeeId, ...mr }), summary: analytics.summarize(analytics.matrix({ ...mr, employeeId: req.user.employeeId })) });
});
api.get('/attendance/board', STAFF, (req, res) => { const d = req.query.date || today(); if (!parseDate(d)) throw new HttpError(422, 'date must be YYYY-MM-DD'); res.json({ date: d, rows: att.board(d) }); });
api.get('/attendance/employee/:id', STAFF, (req, res) => {
  const mr = monthRange(req.query.month || today().slice(0, 7)); if (!mr) throw new HttpError(422, 'month must be YYYY-MM');
  res.json({ records: att.records({ employeeId: idParam(req), ...mr }) });
});
api.post('/attendance/corrections', role('employee'), (req, res) => res.status(201).json(att.requestCorrection(req.user, req.body)));
api.get('/attendance/corrections', (req, res) => res.json(att.listCorrections(req.user, req.query.status)));
api.post('/attendance/corrections/:id/decide', HR, (req, res) => res.json(att.decideCorrection(req.user, idParam(req), req.body.approve === true, req.body.comment)));

// ---------- leave ----------
api.get('/leave/balance', role('employee'), (req, res) => res.json(leave.balance(req.user.employeeId)));
api.get('/leave', (req, res) => res.json(leave.list(req.user, req.query)));
api.post('/leave', role('employee'), (req, res) => res.status(201).json(leave.apply(req.user, req.body)));
api.post('/leave/:id/cancel', role('employee'), (req, res) => res.json(leave.cancel(req.user, idParam(req))));
api.post('/leave/:id/decide', HR, (req, res) => res.json(leave.decide(req.user, idParam(req), req.body.approve === true, req.body.comment)));

// ---------- payroll ----------
api.post('/payroll/runs', HR, (req, res) => res.status(201).json(payroll.createDraft(req.user, req.body.month)));
api.get('/payroll/runs', STAFF, (req, res) => res.json(payroll.listRuns()));
api.get('/payroll/runs/:id', STAFF, (req, res) => res.json(payroll.getRun(idParam(req))));
api.post('/payroll/runs/:id/finalize', ADMIN, (req, res) => res.json(payroll.finalize(req.user, idParam(req))));
api.get('/payslips', role('employee'), (req, res) => res.json(payroll.mySlips(req.user)));
api.get('/payslips/:id/pdf', (req, res) => { const { doc, filename } = payroll.slipPdf(req.user, idParam(req)); res.type('application/pdf').attachment(filename); doc.pipe(res); });

// ---------- dashboard, ai ----------
api.get('/dashboard', (req, res) => res.json(analytics.dashboard(req.user, req.query)));
api.post('/ai/chat', async (req, res) => res.json(await ai.chat(req.user, req.body.message, req.body.history)));
api.post('/ai/summary', STAFF, async (req, res) => res.json(await ai.summarizeDashboard(req.user, req.body.filters || {})));
api.post('/ai/smart-leave', role('employee'), async (req, res) => res.json(await ai.smartLeave(req.user, req.body.text)));

// ---------- comms + audit ----------
api.get('/announcements', (req, res) => res.json(db.prepare('select a.*, u.name author from announcements a left join users u on u.id=a.author_id order by a.id desc limit 50').all()));
api.post('/announcements', STAFF, (req, res) => {
  const title = need(req.body.title, 'title'), body = need(req.body.body, 'body');
  const id = db.prepare('insert into announcements(title,body,author_id) values(?,?,?)').run(title, body, req.user.id).lastInsertRowid;
  db.prepare('select id from users where active=1 and id!=?').all(req.user.id).forEach(u => core.notify(u.id, 'Announcement: ' + title, body.slice(0, 120)));
  core.audit(req.user, 'create', 'announcement', id, null, { title });
  res.status(201).json({ id });
});
api.get('/notifications', (req, res) => res.json({ rows: db.prepare('select * from notifications where user_id=? order by id desc limit 50').all(req.user.id), unread: db.prepare('select count(*) c from notifications where user_id=? and read=0').get(req.user.id).c }));
api.post('/notifications/read', (req, res) => { db.prepare('update notifications set read=1 where user_id=?').run(req.user.id); res.json({ ok: true }); });
api.get('/audit', ADMIN, (req, res) => {
  const w = [], p = [];
  if (req.query.entity) { w.push('entity=?'); p.push(req.query.entity); }
  if (req.query.action) { w.push('action=?'); p.push(req.query.action); }
  const page = Math.max(1, Number(req.query.page) || 1), limit = 50;
  const rows = db.prepare(`select * from audit_log ${w.length ? 'where ' + w.join(' and ') : ''} order by id desc limit ? offset ?`).all(...p, limit, (page - 1) * limit);
  res.json({ rows, page });
});

api.use((req, res, next) => next(new HttpError(404, 'Not found')));
app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use((req, res, next) => (req.method === 'GET' && !req.path.startsWith('/api') ? res.sendFile(path.join(__dirname, '..', 'public', 'index.html')) : next()));
app.use((err, req, res, next) => { // eslint-disable-line
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err); res.status(500).json({ error: 'Something went wrong on the server' });
});

// first run from env (optional)
if (!initialized() && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  try { createAdmin(process.env.COMPANY_NAME || 'My Company', 'Admin', process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD); console.log('Admin created from env'); } catch (e) { console.error('Env admin setup failed:', e.message); }
}
module.exports = app;
