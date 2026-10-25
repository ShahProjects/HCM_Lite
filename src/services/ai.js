const db = require('../db');
const { HttpError, today, parseDate, addDays } = require('../util');
const { getSettings, lateAfter } = require('./core');
const A = require('./analytics');
const emps = require('./employees');
const leave = require('./leave');
const payroll = require('./payroll');

const cfg = () => ({ key: process.env.AI_API_KEY, base: (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''), model: process.env.AI_MODEL || 'llama-3.3-70b-versatile' });
const LIMIT = Number(process.env.AI_RATE_LIMIT || 20);

function checkRate(user) {
  const n = db.prepare("select count(*) c from ai_logs where user_id=? and created_at > datetime('now','-1 hour')").get(user.id).c;
  if (n >= LIMIT) throw new HttpError(429, `AI limit reached (${LIMIT} requests per hour). Please try again later.`);
}
async function callLLM(messages, tools) {
  const c = cfg();
  if (!c.key) throw new HttpError(503, 'AI assistant is not configured. Ask the admin to set AI_API_KEY.');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(c.base + '/chat/completions', {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key },
      body: JSON.stringify({ model: c.model, messages, temperature: 0.1, ...(tools ? { tools, tool_choice: 'auto' } : {}) }),
    });
    if (!r.ok) { const body = await r.text(); throw new Error(`AI provider ${r.status}: ${body.slice(0, 200)}`); }
    return (await r.json()).choices[0].message;
  } catch (e) {
    if (e.name === 'AbortError') throw new HttpError(504, 'The AI took too long to answer. Please try again, or use the normal screens.');
    if (e instanceof HttpError) throw e;
    console.error('[AI error]', e.message);
    throw new HttpError(502, 'The AI service is unavailable right now. Please try again, or use the normal screens.', e.message);
  } finally { clearTimeout(t); }
}
function log(user, kind, prompt, response, tools, ok, ms) {
  db.prepare('insert into ai_logs(user_id,kind,prompt,response,tools,ok,ms) values(?,?,?,?,?,?,?)').run(user.id, kind, String(prompt).slice(0, 4000), String(response || '').slice(0, 4000), tools ? JSON.stringify(tools) : null, ok ? 1 : 0, ms);
}

const policyText = () => {
  const s = getSettings(), types = db.prepare('select * from leave_types').all().map(t => `${t.name}: ${t.quota == null ? 'unlimited (unpaid)' : t.quota + ' days/year'}`).join('; ');
  return `COMPANY POLICY (answer policy questions ONLY from this text, otherwise say you do not know):
- Office start ${s.office_start}, grace ${s.grace_minutes} min. Check-in after ${lateAfter(s)} is Late. Working less than ${s.half_day_hours} hours is a Half day.
- Weekend days (0=Sun..6=Sat): ${s.weekend.join(',')}. Public holidays are not working days.
- One attendance record per employee per day; a second check-in is rejected. Absent = no record and no approved leave. Missing checkout = no check-out time.
- Leave quotas per year: ${types}. Leave counts working days only (weekends and holidays skipped). Overlapping leave or leave above balance is rejected. HR approves or rejects leave.
- Payroll: Gross = 1.5 x basic (HRA 40%, medical 10%). Per-day = gross / working days of month. Deductions: absent days + unpaid leave days + 0.5 x half days. Joiners/leavers are prorated. Annual tax on gross x 12 (illustrative): up to 600k 0%; 600k-1.2M 5%; 1.2M-2.4M 30k + 15%; 2.4M-3.6M 210k + 25%; above 3.6M 510k + 35%. Admin finalizes payroll and finalized months are locked.`;
};
const sys = user => `You are the HCM Lite assistant for ${getSettings().company_name || 'the company'}. Today is ${today()} (${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][parseDate(today()).getDay()]}).
The user is ${user.name}, role: ${user.role}. Use tools for any numbers about people, attendance, leave or payroll; never invent data. If a tool returns an error or "not allowed", politely explain that you cannot share that. Never reveal another employee's salary or personal data to an Employee. Always reply in the same language and script as the user's question: English gets English, Roman Urdu gets Roman Urdu; never use Urdu script unless the user wrote in it. Half day means the person attended but worked under the required hours, so they still checked in. Keep answers short and clear.
${policyText()}`;

const T = (name, description, properties = {}) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties } } });
const dateProps = { from: { type: 'string', description: 'YYYY-MM-DD, default first day of current month' }, to: { type: 'string', description: 'YYYY-MM-DD, default today' }, department: { type: 'string', description: 'department name (optional)' } };
const TOOLS = [
  T('get_headcount', 'Number of active employees (optionally in a department)', { department: { type: 'string' } }),
  T('get_attendance_summary', 'Attendance counts, attendance rate, late %, absenteeism for a date range', dateProps),
  T('get_late_comers', 'Employees ranked by number of late days in a date range', { ...dateProps, limit: { type: 'number' } }),
  T('get_leave_summary', 'Approved leave days by type and who is on leave today', dateProps),
  T('get_my_leave_balance', 'Leave balance (quota, used, pending, remaining) of the current employee', {}),
  T('get_payroll_summary', 'Payroll totals for a month (employees see only their own payslip)', { month: { type: 'string', description: 'YYYY-MM' } }),
  T('search_employees', 'Search employees by name/code/email, optionally by department', { query: { type: 'string' }, department: { type: 'string' } }),
];
const isStaff = u => u.role === 'admin' || u.role === 'hr';
function range(a) {
  const to = parseDate(a.to) ? a.to : today(), from = parseDate(a.from) ? a.from : A.first(to);
  return { from, to };
}
function deptId(name) {
  if (!name) return null;
  const d = db.prepare('select id from departments where lower(name)=lower(?)').get(String(name).trim());
  if (!d) throw new Error(`Unknown department "${name}"`);
  return d.id;
}
function todayCounts(dep, user) {
  const w = ['a.date=?'], p = [today()];
  if (dep) { w.push('e.department_id=?'); p.push(dep); }
  if (!isStaff(user)) { w.push('a.employee_id=?'); p.push(user.employeeId); }
  const r = db.prepare('select count(*) c, sum(a.check_out is not null) o from attendance a join employees e on e.id=a.employee_id where ' + w.join(' and ')).get(...p);
  return { checked_in_today: r.c, checked_out_today: r.o || 0 };
}
function runTool(name, a, user) {
  try {
    const dep = a.department ? deptId(a.department) : null, r = range(a);
    switch (name) {
      case 'get_headcount':
        if (!isStaff(user)) return { error: 'not allowed: only HR and Admin can see headcount' };
        return { headcount: A.headcountOn(today(), dep), department: a.department || 'all' };
      case 'get_attendance_summary': {
        const scope = isStaff(user) ? { departmentId: dep } : { employeeId: user.employeeId };
        return { ...r, scope: isStaff(user) ? (a.department || 'company') : 'own data', ...(() => { const s = A.summarize(A.matrix({ ...r, ...scope })); return { ...s, employee_days_attended: s.present + s.late + s.half_day + s.missing_checkout, note: "half_day = attended but worked under required hours" }; })(), ...todayCounts(isStaff(user) ? dep : null, user) };
      }
      case 'get_late_comers': {
        const scope = isStaff(user) ? { departmentId: dep } : { employeeId: user.employeeId };
        return { ...r, late_comers: A.lateComers({ ...r, ...scope }, Math.min(Number(a.limit) || 5, 20)) };
      }
      case 'get_leave_summary':
        return A.leaveSummary({ ...r, ...(isStaff(user) ? { departmentId: dep } : { employeeId: user.employeeId }) });
      case 'get_my_leave_balance':
        if (!user.employeeId) return { error: 'This account has no employee profile' };
        return { year: new Date().getFullYear(), balances: leave.balance(user.employeeId) };
      case 'get_payroll_summary': {
        const month = /^\d{4}-\d{2}$/.test(a.month || '') ? a.month : today().slice(0, 7);
        if (!isStaff(user)) {
          const p = db.prepare(`select p.gross,p.deduction,p.tax,p.net from payslips p join payroll_runs r on r.id=p.run_id where r.month=? and r.status='finalized' and p.employee_id=?`).get(month, user.employeeId);
          return p ? { month, own_payslip: p } : { month, note: 'No finalized payslip for that month' };
        }
        const run = db.prepare('select * from payroll_runs where month=?').get(month);
        if (!run) return { month, note: 'No payroll run for that month' };
        const t = db.prepare('select count(*) employees, round(sum(gross),2) gross, round(sum(deduction),2) deduction, round(sum(tax),2) tax, round(sum(net),2) net from payslips where run_id=?').get(run.id);
        return { month, status: run.status, ...t };
      }
      case 'search_employees': {
        if (!isStaff(user)) { const e = emps.get(user.employeeId); return { note: 'You can only see your own record', results: e ? [{ name: e.name, code: e.code, department: e.department, designation: e.designation }] : [] }; }
        const l = emps.list({ search: a.query, department_id: dep, limit: 10 });
        return { total: l.total, results: l.rows.map(e => ({ name: e.name, code: e.code, email: e.email, department: e.department, designation: e.designation, status: e.status, salary_basic: e.salary_basic })) };
      }
      default: return { error: 'unknown tool' };
    }
  } catch (e) { return { error: e.message }; }
}

async function chat(user, message, history = []) {
  if (!message || !String(message).trim()) throw new HttpError(422, 'Message is required');
  checkRate(user);
  const t0 = Date.now(), used = [];
  const msgs = [{ role: 'system', content: sys(user) },
    ...history.filter(h => h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string').slice(-6).map(h => ({ role: h.role, content: h.content.slice(0, 1500) })),
    { role: 'user', content: String(message).slice(0, 1500) }];
  try {
    for (let i = 0; i < 4; i++) {
      const m = await callLLM(msgs, TOOLS);
      if (!m.tool_calls || !m.tool_calls.length) {
        log(user, 'chat', message, m.content, used, true, Date.now() - t0);
        return { answer: m.content, tools_used: used.map(u => u.name), label: 'AI-generated' };
      }
      msgs.push(m);
      for (const tc of m.tool_calls) {
        let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        const out = runTool(tc.function.name, args, user);
        used.push({ name: tc.function.name, args });
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
      }
    }
    throw new HttpError(502, 'The AI could not finish that request. Please rephrase it.');
  } catch (e) { log(user, 'chat', message, e.message, used, false, Date.now() - t0); throw e; }
}

async function summarizeDashboard(user, filters) {
  checkRate(user);
  const data = A.dashboard(user, filters), t0 = Date.now();
  const slim = JSON.stringify(data).slice(0, 9000);
  try {
    const m = await callLLM([
      { role: 'system', content: 'You write dashboard insights for HR. Use ONLY the numbers in the JSON given. Return 3 to 5 short bullet points starting with "- ". Do not invent figures. If data is empty, say there is not enough data yet.' },
      { role: 'user', content: slim }]);
    log(user, 'summary', slim.slice(0, 500), m.content, null, true, Date.now() - t0);
    return { summary: m.content, label: 'AI-generated' };
  } catch (e) { log(user, 'summary', slim.slice(0, 500), e.message, null, false, Date.now() - t0); throw e; }
}

function extractJson(txt) { const m = String(txt || '').match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }
function validLeave(j) {
  if (!j) return null;
  const t = db.prepare('select * from leave_types where lower(name)=lower(?)').get(String(j.type || '').trim());
  if (!t || !parseDate(j.start) || !parseDate(j.end) || j.end < j.start) return null;
  return { type: t.name, type_id: t.id, start: j.start, end: j.end, reason: String(j.reason || '').slice(0, 300) };
}
async function smartLeave(user, text) {
  if (!text || !String(text).trim()) throw new HttpError(422, 'Describe the leave you need');
  checkRate(user);
  const t0 = Date.now(), tod = today();
  const types = db.prepare('select name from leave_types').all().map(t => t.name).join(', ');
  const prompt = `Today is ${tod} (${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][parseDate(tod).getDay()]}). Convert the employee's request into JSON only: {"type": one of [${types}], "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "reason": short text}. "next Monday" means the first Monday after today. Wedding, family event or personal errand = Casual; illness = Sick; vacation = Annual. Output JSON only, no extra text.`;
  let last = '';
  for (let i = 0; i < 2; i++) {
    try {
      const m = await callLLM([{ role: 'system', content: prompt }, { role: 'user', content: String(text).slice(0, 500) }]);
      last = m.content; const v = validLeave(extractJson(m.content));
      if (v) { log(user, 'smart_leave', text, m.content, null, true, Date.now() - t0); return { ...v, label: 'AI-generated', note: 'Review and confirm before submitting' }; }
    } catch (e) { log(user, 'smart_leave', text, e.message, null, false, Date.now() - t0); throw e; }
  }
  log(user, 'smart_leave', text, last, null, false, Date.now() - t0);
  throw new HttpError(422, 'Could not understand that request. Please fill the leave form manually.');
}
module.exports = { chat, summarizeDashboard, smartLeave, runTool, TOOLS };
