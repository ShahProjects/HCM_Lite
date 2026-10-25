process.env.DB_FILE = ':memory:'; process.env.JWT_SECRET = 't'; process.env.AI_API_KEY = 'x'; process.env.AI_RATE_LIMIT = '6';
const test = require('node:test'); const assert = require('node:assert'); const http = require('http');
const { today, addDays, parseDate } = require('../src/util');
let llm, app, srv, base; const seen = [];
test.before(async () => {
  llm = http.createServer((req, res) => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
    const j = JSON.parse(b); const last = j.messages[j.messages.length - 1]; seen.push(last); let msg;
    if (j.tools && last.role === 'user') msg = /salary/i.test(last.content)
      ? { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_employees', arguments: '{"query":"Sara"}' } }] }
      : { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_headcount', arguments: '{}' } }] };
    else if (last.role === 'tool') msg = { role: 'assistant', content: 'RESULT ' + last.content };
    else { let d = today(); while (parseDate(d).getDay() !== 1) d = addDays(d, 1); msg = { role: 'assistant', content: 'Sure! ```json\n' + JSON.stringify({ type: 'Casual', start: d, end: addDays(d, 1), reason: 'Wedding' }) + '\n```' }; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: msg }] })); }); });
  await new Promise(r => llm.listen(0, r)); process.env.AI_BASE_URL = 'http://localhost:' + llm.address().port;
  app = require('../src/app'); srv = app.listen(0); base = 'http://localhost:' + srv.address().port;
});
test.after(() => { srv.close(); llm.close(); });
const call = async (m, p, b, t) => { const r = await fetch(base + '/api' + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
test('AI chat uses tools with user scope, smart leave validates, rate limit', async () => {
  await call('POST', '/setup', { company_name: 'A', email: 'a@a.com', password: 'password1' });
  const admin = (await call('POST', '/auth/login', { email: 'a@a.com', password: 'password1' })).body.token;
  const dep = (await call('POST', '/departments', { name: 'IT' }, admin)).body.id;
  const hr = (await call('POST', '/users', { email: 'h@a.com', name: 'H' }, admin)).body;
  let ht = (await call('POST', '/auth/login', { email: 'h@a.com', password: hr.temp_password })).body.token;
  await call('POST', '/auth/change-password', { current_password: hr.temp_password, new_password: 'hrhrhr123' }, ht);
  ht = (await call('POST', '/auth/login', { email: 'h@a.com', password: 'hrhrhr123' })).body.token;
  const e = (await call('POST', '/employees', { name: 'Ali', email: 'ali@a.com', department_id: dep, join_date: '2025-01-01', salary_basic: 5000 }, ht)).body;
  await call('POST', '/employees', { name: 'Sara', email: 'sara@a.com', department_id: dep, join_date: '2025-01-01', salary_basic: 99999 }, ht);
  let et = (await call('POST', '/auth/login', { email: 'ali@a.com', password: e.temp_password })).body.token;
  await call('POST', '/auth/change-password', { current_password: e.temp_password, new_password: 'alialiali1' }, et);
  et = (await call('POST', '/auth/login', { email: 'ali@a.com', password: 'alialiali1' })).body.token;
  const q = await call('POST', '/ai/chat', { message: 'How many employees?' }, ht);
  assert.equal(q.status, 200); assert.match(q.body.answer, /"headcount":2/); assert.equal(q.body.label, 'AI-generated');
  const sal = await call('POST', '/ai/chat', { message: "What is Sara's salary?" }, et);
  assert.ok(!sal.body.answer.includes('99999')); // tool returned only the employee's own record
  const sl = await call('POST', '/ai/smart-leave', { text: 'next monday and tuesday off for wedding' }, et);
  assert.equal(sl.status, 200); assert.equal(sl.body.type, 'Casual'); assert.equal(parseDate(sl.body.start).getDay(), 1);
  assert.equal((await call('POST', '/ai/smart-leave', { text: 'x' }, ht)).status, 403);
  const sm = await call('POST', '/ai/summary', { filters: {} }, ht); assert.equal(sm.status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/ai/chat', { message: 'again' }, ht)).status, 200);
  assert.equal((await call('POST', '/ai/chat', { message: 'again' }, ht)).status, 429);
});
