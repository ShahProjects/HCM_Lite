process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = 'test';
delete process.env.AI_API_KEY;
const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');
const { addDays, today, parseDate } = require('../src/util');

let base, server;
const tok = {};
async function call(method, path, body, t) {
  const r = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}
test.before(async () => { server = app.listen(0); base = 'http://localhost:' + server.address().port; });
test.after(() => server.close());

let deptId, emp, tempPw;
test('first run setup, login, org setup', async () => {
  assert.equal((await call('GET', '/setup/status')).body.initialized, false);
  assert.equal((await call('POST', '/setup', { company_name: 'Acme', email: 'admin@acme.com', password: 'admin12345' })).status, 201);
  assert.equal((await call('POST', '/setup', { company_name: 'X', email: 'a@b.com', password: 'admin12345' })).status, 409);
  const l = await call('POST', '/auth/login', { email: 'admin@acme.com', password: 'admin12345' });
  tok.admin = l.body.token; assert.ok(tok.admin);
  assert.equal((await call('POST', '/auth/login', { email: 'admin@acme.com', password: 'bad' })).status, 401);
  deptId = (await call('POST', '/departments', { name: 'Engineering' }, tok.admin)).body.id;
  assert.equal((await call('POST', '/departments', { name: 'Engineering' }, tok.admin)).status, 409);
  assert.equal((await call('POST', '/holidays', { date: addDays(today(), 1), name: 'Test Holiday' }, tok.admin)).status, 201);
  const hr = await call('POST', '/users', { email: 'hr@acme.com', name: 'Hina HR' }, tok.admin);
  assert.equal(hr.status, 201);
  const l2 = await call('POST', '/auth/login', { email: 'hr@acme.com', password: hr.body.temp_password });
  assert.equal((await call('GET', '/employees', null, l2.body.token)).status, 403); // must change pw
  assert.equal((await call('POST', '/auth/change-password', { current_password: hr.body.temp_password, new_password: 'hrpass1234' }, l2.body.token)).status, 200);
  tok.hr = (await call('POST', '/auth/login', { email: 'hr@acme.com', password: 'hrpass1234' })).body.token;
});

test('RBAC: HR cannot change settings or finalize; admin cannot register employee', async () => {
  assert.equal((await call('PUT', '/settings', { grace_minutes: 30 }, tok.hr)).status, 403);
  assert.equal((await call('GET', '/audit', null, tok.hr)).status, 403);
  assert.equal((await call('POST', '/employees', {}, tok.admin)).status, 403);
});

test('HR registers employees; validation + CSV dry run', async () => {
  const bad = await call('POST', '/employees', { name: 'X', email: 'nope', department_id: deptId, join_date: '2025-13-40', salary_basic: 0 }, tok.hr);
  assert.equal(bad.status, 422); assert.ok(bad.body.details.length >= 3);
  const r = await call('POST', '/employees', { name: 'Ali Khan', email: 'ali@acme.com', department_id: deptId, designation: 'Developer', join_date: '2025-01-01', salary_basic: 100000, gender: 'male' }, tok.hr);
  assert.equal(r.status, 201); emp = r.body.employee; tempPw = r.body.temp_password;
  await call('POST', '/employees', { name: 'Sara Ahmed', email: 'sara@acme.com', department_id: deptId, join_date: '2025-01-01', salary_basic: 80000 }, tok.hr);
  assert.equal((await call('POST', '/employees', { name: 'Dup', email: 'ali@acme.com', department_id: deptId, join_date: '2025-01-01', salary_basic: 1 }, tok.hr)).status, 422);
  const dry = await call('POST', '/employees/import?dryRun=1', { csv: 'name,email,department,join_date,salary_basic\nZed,zed@acme.com,Engineering,2025-02-01,50000\nBad,bad,Nowhere,xx,-1' }, tok.hr);
  assert.equal(dry.body.valid_count, 1); assert.ok(dry.body.errors.some(e => e.field === 'department' && e.row === 3));
  assert.equal((await call('GET', '/employees', null, tok.hr)).body.total, 2);
});

test('employee: forced password change, check-in 409, scope isolation', async () => {
  const l = await call('POST', '/auth/login', { email: 'ali@acme.com', password: tempPw });
  assert.equal(l.body.user.mustChange, true);
  assert.equal((await call('POST', '/auth/change-password', { current_password: tempPw, new_password: 'newpass123' }, l.body.token)).status, 200);
  tok.emp = (await call('POST', '/auth/login', { email: 'ali@acme.com', password: 'newpass123' })).body.token;
  assert.equal((await call('POST', '/attendance/check-in', {}, tok.emp)).status, 201);
  assert.equal((await call('POST', '/attendance/check-in', {}, tok.emp)).status, 409);
  assert.equal((await call('POST', '/attendance/check-out', {}, tok.emp)).status, 200);
  const other = (await call('GET', '/employees', null, tok.hr)).body.rows.find(e => e.email === 'sara@acme.com');
  assert.equal((await call('GET', '/employees/' + other.id, null, tok.emp)).status, 403);
  assert.equal((await call('GET', '/employees', null, tok.emp)).status, 403);
  assert.equal((await call('POST', '/attendance/check-in', {}, tok.hr)).status, 403);
});

test('leave: working days, overlap 422, over-balance 422, approve', async () => {
  // find a Monday-Tuesday pair at least 7 days ahead, avoiding the holiday
  let d = addDays(today(), 7); while (parseDate(d).getDay() !== 1) d = addDays(d, 1);
  const ok = await call('POST', '/leave', { type: 'Casual', start: d, end: addDays(d, 1), reason: 'wedding' }, tok.emp);
  assert.equal(ok.status, 201); assert.equal(ok.body.days, 2);
  assert.equal((await call('POST', '/leave', { type: 'Casual', start: d, end: d, reason: 'x' }, tok.emp)).status, 422); // overlap
  let d2 = addDays(d, 14);
  assert.equal((await call('POST', '/leave', { type: 'Sick', start: d2, end: addDays(d2, 20), reason: 'x' }, tok.emp)).status, 422); // over balance
  assert.equal((await call('POST', `/leave/${ok.body.id}/decide`, { approve: true }, tok.admin)).status, 403);
  const dec = await call('POST', `/leave/${ok.body.id}/decide`, { approve: true, comment: 'enjoy' }, tok.hr);
  assert.equal(dec.body.status, 'approved');
  const bal = (await call('GET', '/leave/balance', null, tok.emp)).body.find(b => b.type === 'Casual');
  assert.equal(bal.remaining, 8);
  assert.ok((await call('GET', '/notifications', null, tok.emp)).body.unread >= 1);
});

test('payroll: draft, finalize by admin only, locked, payslip pdf, employee isolation', async () => {
  const month = today().slice(0, 7);
  assert.equal((await call('POST', '/payroll/runs', { month }, tok.admin)).status, 403);
  const run = await call('POST', '/payroll/runs', { month }, tok.hr);
  assert.equal(run.status, 201);
  const ali = run.body.slips.find(s => s.code === emp.code);
  assert.equal(ali.gross, 150000); // 1.5 x basic
  assert.equal(ali.tax, 10000); // 1.8M annual: 30k + 15% of 600k = 120k, /12
  assert.equal((await call('POST', `/payroll/runs/${run.body.id}/finalize`, {}, tok.hr)).status, 403);
  assert.equal((await call('GET', '/payslips', null, tok.emp)).body.length, 0); // draft hidden
  assert.equal((await call('POST', `/payroll/runs/${run.body.id}/finalize`, {}, tok.admin)).body.status, 'finalized');
  assert.equal((await call('POST', '/payroll/runs', { month }, tok.hr)).status, 409); // locked
  const mine = (await call('GET', '/payslips', null, tok.emp)).body;
  assert.equal(mine.length, 1);
  const pdf = await call('GET', `/payslips/${mine[0].id}/pdf`, null, tok.emp);
  assert.equal(pdf.status, 200); assert.ok(String(pdf.body).startsWith('%PDF'));
  const other = run.body.slips.find(s => s.code !== emp.code);
  assert.equal((await call('GET', `/payslips/${other.id}/pdf`, null, tok.emp)).status, 404);
});

test('tax slab maths', () => {
  const { annualTax } = require('../src/services/payroll');
  assert.equal(annualTax(600000), 0); assert.equal(annualTax(1200000), 30000);
  assert.equal(annualTax(2400000), 210000); assert.equal(annualTax(3600000), 510000);
  assert.equal(annualTax(4000000), 510000 + 140000);
});

test('dashboards, audit log, AI graceful failure and tool scoping', async () => {
  const hd = (await call('GET', '/dashboard', null, tok.hr)).body;
  assert.equal(hd.kpis.headcount, 2); assert.equal(hd.kpis.present_today, 1);
  const ad = (await call('GET', '/dashboard', null, tok.admin)).body;
  assert.ok(ad.kpis.payroll_cost_gross > 0);
  const ed = (await call('GET', '/dashboard', null, tok.emp)).body;
  assert.equal(ed.today.check_in != null, true);
  const audit = (await call('GET', '/audit', null, tok.admin)).body.rows;
  assert.ok(audit.some(a => a.action === 'finalize') && audit.some(a => a.action === 'approve'));
  assert.equal((await call('POST', '/ai/chat', { message: 'hi' }, tok.emp)).status, 503);
  const { runTool } = require('../src/services/ai');
  const empUser = { role: 'employee', employeeId: emp.id, name: 'Ali' };
  assert.ok(runTool('get_headcount', {}, empUser).error);
  const s = runTool('search_employees', { query: 'Sara' }, empUser);
  assert.equal(s.results.length, 1); assert.equal(s.results[0].name, 'Ali Khan'); assert.equal(s.results[0].salary_basic, undefined);
  const hrUser = { role: 'hr', name: 'H' };
  assert.equal(runTool('get_headcount', {}, hrUser).headcount, hd.kpis.headcount); // AI == dashboard
});
