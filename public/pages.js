/* HCM Lite pages */
const PAGES = {};
const isStaff = () => S.user.role !== 'employee';
const depts = async () => (S.depts = await api('/departments'));
const deptOpts = () => S.depts.map(d => ({ v: d.id, t: d.name }));
const qs = o => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
async function download(path, name) { await run(async () => { const b = await api(path, { blob: true }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }); }

/* ---------- dashboards ---------- */
PAGES.dashboard = async el => (isStaff() ? dashStaff(el) : dashEmployee(el));
async function dashStaff(el) {
  await depts();
  const f = S.dashF || (S.dashF = { from: '', to: '', department_id: '' });
  el.innerHTML = `<h1>${S.user.role === 'admin' ? 'Company' : 'HR'} dashboard</h1>
  <form class="card row" id="flt">${field('From', 'from', { type: 'date', value: f.from })}${field('To', 'to', { type: 'date', value: f.to })}${field('Department', 'department_id', { options: deptOpts(), value: f.department_id })}<div class="f"><button class="btn">Apply</button> <button type="button" class="btn vio" id="sum">Summarize with AI</button></div></form>
  <div id="aisum"></div><div id="dash"><p class="muted">Loading…</p></div>`;
  const load = async () => {
    const d = await api('/dashboard?' + qs(f)), k = d.kpis, a = d.attendance;
    const A = S.user.role === 'admin';
    $('#dash').innerHTML = `<div class="grid g4" style="margin-bottom:1rem">
      ${kpi('Headcount', k.headcount, 't')}${kpi('Present today', k.present_today, 't')}${kpi('On leave today', k.on_leave_today, 'v')}${kpi('Late today', k.late_today, 'o')}${kpi('Pending approvals', k.pending_approvals, 'r')}
      ${A ? kpi('Attrition YTD', k.attrition_ytd_pct + '%', 'r') + kpi('Payroll cost (gross' + (k.payroll_month ? ' ' + k.payroll_month : '') + ')', fmt(k.payroll_cost_gross), 't') + kpi('Average salary (gross)', fmt(k.avg_salary), 'v') : ''}
      ${kpi('Attendance rate', a.attendance_rate == null ? '-' : a.attendance_rate + '%', 't')}${kpi('Late %', a.late_pct == null ? '-' : a.late_pct + '%', 'o')}${kpi('Absenteeism', a.absenteeism_pct == null ? '-' : a.absenteeism_pct + '%', 'r')}</div>
    <div class="grid g2"><div class="card"><h3>Attendance trend</h3>${spark(d.attendance_trend)}</div>
    <div class="card"><h3>Absenteeism by department</h3>${bars(d.absenteeism_by_department.map(x => ({ label: x.department, value: x.absenteeism_pct || 0 })), { suffix: '%' })}</div>
    <div class="card"><h3>Leave by type (approved days)</h3>${bars(d.leave_by_type.map(x => ({ label: x.type, value: x.approved_days })))}</div>
    <div class="card"><h3>Top 5 late-comers</h3>${table([{ h: 'Employee', f: r => esc(r.employee) }, { h: 'Dept', f: r => esc(r.department) }, { h: 'Late days', f: r => r.late_days }], d.top_late_comers, { empty: 'No late arrivals in this period.' })}</div>
    ${A ? `<div class="card"><h3>Headcount by department</h3>${bars(d.headcount_by_department.map(x => ({ label: x.department, value: x.headcount })))}</div>
    <div class="card"><h3>Payroll cost by department (net)</h3>${bars(d.payroll_cost_by_department.map(x => ({ label: x.department, value: x.net })))}</div>
    <div class="card"><h3>Gender</h3>${bars(d.gender.map(x => ({ label: x.gender, value: x.count })))}</div>
    <div class="card"><h3>Tenure</h3>${bars(d.tenure.map(x => ({ label: x.bucket, value: x.count })))}</div>
    <div class="card" style="grid-column:1/-1"><h3>Recent activity</h3>${table([{ h: 'When (UTC)', f: r => esc(r.created_at) }, { h: 'Who', f: r => esc(r.actor) }, { h: 'Action', f: r => esc(r.action + ' ' + r.entity) }], d.audit_feed, { empty: 'No activity yet.' })}</div>` : ''}</div>`;
  };
  $('#flt').onsubmit = e => { e.preventDefault(); Object.assign(f, formObj(e.target)); run(load); };
  $('#sum').onclick = ev => run(async () => { $('#aisum').innerHTML = '<div class="aibox muted">Thinking…</div>'; try { const r = await api('/ai/summary', { method: 'POST', body: { filters: f } }); $('#aisum').innerHTML = `<div class="aibox">${esc(r.summary)}<br><small class="muted">AI-generated, based only on the numbers below</small></div>`; } catch (e) { $('#aisum').innerHTML = `<div class="aibox">${esc(e.message)}</div>`; } }, ev.target);
  await run(load);
}
async function dashEmployee(el) {
  const [d, ann] = await Promise.all([api('/dashboard'), api('/announcements')]);
  const t = d.today;
  el.innerHTML = `<h1>Hello, ${esc(S.user.name.split(' ')[0])}</h1><div class="grid g2">
  <div class="card"><h2>Today</h2><div id="ci">${t ? `<p>Checked in at <b>${esc(t.check_in)}</b> ${badge(t.status)}${t.check_out ? `<br>Checked out at <b>${esc(t.check_out)}</b> (${t.hours} h)` : ''}</p>` : '<p class="muted">You have not checked in yet.</p>'}</div>
  <div class="row"><button class="btn" id="ci-in" ${t ? 'disabled' : ''}>Check in</button><button class="btn sec" id="ci-out" ${!t || t.check_out ? 'disabled' : ''}>Check out</button><button class="btn vio" id="ci-cam" ${t ? 'disabled' : ''}>Camera check-in</button><button class="btn vio" id="ci-camout" ${!t || t.check_out ? 'disabled' : ''}>Camera check-out</button></div></div>
  <div class="grid g4">${kpi('Hours this week / 40', d.hours_this_week, 't')}${kpi('Late days this month', d.late_count_month, 'o')}${kpi('Attendance rate', d.attendance.attendance_rate == null ? '-' : d.attendance.attendance_rate + '%', 'v')}${kpi('Last payslip (net)', d.last_payslip ? fmt(d.last_payslip.net) : 'none yet', 'r')}</div>
  <div class="card"><h2>Leave left</h2>${table([{ h: 'Type', f: r => esc(r.type) }, { h: 'Remaining', f: r => r.remaining == null ? 'Unlimited' : r.remaining }, { h: 'Used', f: r => r.used }, { h: 'Pending', f: r => r.pending }], d.leave_balance)}</div>
  <div class="card"><h2>Announcements</h2>${ann.length ? ann.slice(0, 4).map(a => `<p><b>${esc(a.title)}</b><br>${esc(a.body)}<br><span class="small muted">${esc(a.created_at)} UTC</span></p>`).join('') : '<div class="empty">No announcements.</div>'}</div></div>`;
  $('#ci-in').onclick = e => run(async () => { await api('/attendance/check-in', { method: 'POST', body: {} }); toast('Checked in'); route(); }, e.target);
  $('#ci-out').onclick = e => run(async () => { await api('/attendance/check-out', { method: 'POST' }); toast('Checked out'); route(); }, e.target);
  $('#ci-cam').onclick = () => cameraCheckIn('in'); $('#ci-camout').onclick = () => cameraCheckIn('out');
}
let faceLib;
async function loadFaceApi() {
  if (faceLib) return faceLib;
  await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.js'; s.onload = ok; s.onerror = () => no(new Error('Could not load the face detection library. Check your internet connection.')); document.head.append(s); });
  await faceapi.nets.tinyFaceDetector.loadFromUri('https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/');
  return (faceLib = faceapi);
}
async function cameraCheckIn(mode = 'in') {
  const m = modal('Camera check-' + mode, '<p class="muted">Face and location are checked. The photo is not stored.</p><video id="vid" autoplay playsinline muted style="width:100%;border-radius:10px;background:#000"></video><p id="st" class="small muted">Starting camera…</p><button class="btn" id="go" disabled>Check in</button>');
  let stream; const st = t => { $('#st').textContent = t; };
  const stop = () => stream && stream.getTracks().forEach(t => t.stop());
  m.el.closest('.modal-bg').addEventListener('click', stop);
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } }); $('#vid').srcObject = stream; } catch { return st('Camera not available or permission denied. Use normal check-in.'); }
  st('Loading face detection…'); let fa;
  try { fa = await loadFaceApi(); } catch (e) { return st(e.message); }
  $('#go').disabled = false; st('Look at the camera, then press Check in.');
  $('#go').onclick = e => run(async () => {
    const faces = await fa.detectAllFaces($('#vid'), new fa.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }));
    if (faces.length !== 1) throw new Error(faces.length ? 'More than one face detected' : 'No face detected. Face the camera in good light.');
    const pos = await new Promise((ok, no) => navigator.geolocation.getCurrentPosition(ok, () => no(new Error('Location permission is needed')), { enableHighAccuracy: true, timeout: 10000 }));
    await api('/attendance/check-' + mode, { method: 'POST', body: { source: 'camera', faceCount: faces.length, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } });
    stop(); m.close(); toast('Camera check-' + mode + ' done'); route();
  }, e.target);
}

/* ---------- settings + org + users ---------- */
PAGES.settings = async el => {
  const s = await api('/settings'), days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  el.innerHTML = `<h1>Company settings</h1><form class="card" id="f"><div class="row">${field('Company name', 'company_name', { value: s.company_name })}${field('Office start', 'office_start', { type: 'time', value: s.office_start })}${field('Grace (minutes)', 'grace_minutes', { type: 'number', value: s.grace_minutes })}${field('Half day if under (hours)', 'half_day_hours', { type: 'number', value: s.half_day_hours, attrs: ' step="0.5"' })}</div>
  <label>Weekend days</label><div class="row" style="margin-bottom:.8rem">${days.map((d, i) => `<label style="display:inline-flex;gap:.3rem;align-items:center;color:var(--ink)"><input type="checkbox" style="width:auto" name="wk" value="${i}" ${s.weekend.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div>
  <h3>Office location (for camera check-in)</h3><div class="row">${field('Latitude', 'office_lat', { type: 'number', value: s.office_lat ?? '', attrs: ' step="any"' })}${field('Longitude', 'office_lng', { type: 'number', value: s.office_lng ?? '', attrs: ' step="any"' })}${field('Radius (m)', 'office_radius', { type: 'number', value: s.office_radius })}<div class="f"><button type="button" class="btn sec" id="here">Use my current location</button></div></div>
  <button class="btn">Save settings</button> <span class="small muted">Changes apply to new records only.</span></form>`;
  $('#here').onclick = () => navigator.geolocation.getCurrentPosition(p => { $('[name=office_lat]').value = p.coords.latitude.toFixed(6); $('[name=office_lng]').value = p.coords.longitude.toFixed(6); }, () => toast('Location permission denied', true));
  $('#f').onsubmit = e => { e.preventDefault(); run(async () => { const d = formObj(e.target); d.weekend = $$('[name=wk]:checked', e.target).map(x => Number(x.value)); delete d.wk; S.settings = await api('/settings', { method: 'PUT', body: d }); toast('Settings saved'); }, $('button.btn:not(.sec)', e.target)); };
};
PAGES.org = async el => {
  const [dp, dg, lt, hd] = await Promise.all([api('/departments'), api('/designations'), api('/leave-types'), api('/holidays')]);
  const sec = (title, key, items, cols, form) => `<div class="card"><h2>${title}</h2>${table([...cols, { h: '', f: r => `<button class="btn red sm" data-del="${key}/${r.id}">Delete</button>`, cls: 'right' }], items, { empty: 'None yet. Add the first one below.' })}<form data-add="${key}" class="row" style="margin-top:.8rem">${form}<div class="f"><button class="btn">Add</button></div></form></div>`;
  el.innerHTML = `<h1>Organization setup</h1><div class="grid g2">
  ${sec('Departments', 'departments', dp, [{ h: 'Name', f: r => esc(r.name) }], field('Name', 'name', { required: true }))}
  ${sec('Designations', 'designations', dg, [{ h: 'Name', f: r => esc(r.name) }], field('Name', 'name', { required: true }))}
  ${sec('Leave types and yearly quota', 'leave-types', lt, [{ h: 'Name', f: r => esc(r.name) }, { h: 'Quota', f: r => r.quota == null ? 'Unlimited' : r.quota }, { h: 'Paid', f: r => r.paid ? 'Yes' : 'No' }], field('Name', 'name', { required: true }) + field('Quota (blank = unlimited)', 'quota', { type: 'number' }) + field('Paid', 'paid', { options: [{ v: 1, t: 'Paid' }, { v: 0, t: 'Unpaid' }], blank: false }))}
  ${sec('Public holidays', 'holidays', hd, [{ h: 'Date', f: r => esc(r.date) }, { h: 'Name', f: r => esc(r.name) }], field('Date', 'date', { type: 'date', required: true }) + field('Name', 'name', { required: true }))}</div>`;
  $$('[data-add]', el).forEach(f => { f.onsubmit = e => { e.preventDefault(); run(async () => { const d = formObj(f); if (d.quota === '') d.quota = null; await api('/' + f.dataset.add, { method: 'POST', body: d }); toast('Added'); route(); }); }; });
  $$('[data-del]', el).forEach(b => { b.onclick = () => confirm('Delete this item?') && run(async () => { await api('/' + b.dataset.del, { method: 'DELETE' }); toast('Deleted'); route(); }); });
};
PAGES.users = async el => {
  const us = await api('/users');
  el.innerHTML = `<h1>Logins</h1><div class="card"><h2>Create HR login</h2><form id="f" class="row">${field('Name', 'name', { required: true })}${field('Email', 'email', { type: 'email', required: true })}<div class="f"><button class="btn">Create HR login</button></div></form></div>
  <div class="card"><h2>All logins</h2>${table([{ h: 'Name', f: r => esc(r.name) }, { h: 'Email', f: r => esc(r.email) }, { h: 'Role', f: r => `<span class="pill ${r.role}">${r.role}</span>` }, { h: 'Status', f: r => badge(r.active ? 'active' : 'exited').replace('exited', 'deactivated') }, { h: '', cls: 'right nowrap', f: r => r.role === 'admin' ? '' : `<button class="btn sec sm" data-a="reset-password" data-id="${r.id}">Reset password</button> <button class="btn ${r.active ? 'red' : ''} sm" data-a="${r.active ? 'deactivate' : 'reactivate'}" data-id="${r.id}">${r.active ? 'Deactivate' : 'Reactivate'}</button>` }], us)}</div>`;
  $('#f').onsubmit = e => { e.preventDefault(); run(async () => { const r = await api('/users', { method: 'POST', body: formObj(e.target) }); modal('HR login created', `<p>Share this temporary password once. They must change it on first sign-in.</p><p><b>${esc(r.email)}</b><br>Temporary password: <code>${esc(r.temp_password)}</code></p>`); route(); }, $('button', e.target)); };
  $$('[data-a]', el).forEach(b => { b.onclick = () => run(async () => { const r = await api(`/users/${b.dataset.id}/${b.dataset.a}`, { method: 'POST' }); if (r.temp_password) modal('Password reset', `<p>Temporary password: <code>${esc(r.temp_password)}</code></p>`); else { toast('Done'); route(); } }); });
};

/* ---------- employees ---------- */
PAGES.employees = async el => {
  await depts(); const hr = S.user.role === 'hr';
  const f = S.empF || (S.empF = { search: '', department_id: '', status: '', page: 1 });
  el.innerHTML = `<div class="top"><h1>Employees</h1><div class="row">${hr ? '<button class="btn" id="new">Register employee</button><button class="btn sec" id="imp">Import CSV</button><button class="btn sec" id="exp">Export CSV</button>' : ''}</div></div>
  <form class="card row" id="flt">${field('Search', 'search', { value: f.search })}${field('Department', 'department_id', { options: deptOpts(), value: f.department_id })}${field('Status', 'status', { options: ['active', 'probation', 'exited'].map(x => ({ v: x, t: x })), value: f.status })}<div class="f"><button class="btn">Filter</button></div></form><div id="list"></div>`;
  const load = async () => {
    const r = await api('/employees?' + qs({ ...f, limit: 15 }));
    $('#list').innerHTML = `<div class="card">${table([{ h: 'Code', f: x => esc(x.code) }, { h: 'Name', f: x => `<b>${esc(x.name)}</b><br><span class="small muted">${esc(x.email)}</span>` }, { h: 'Department', f: x => esc(x.department) }, { h: 'Designation', f: x => esc(x.designation || '-') }, { h: 'Joined', f: x => esc(x.join_date) }, { h: 'Status', f: x => badge(x.status) }], r.rows, { click: true, empty: hr ? 'No employees yet. Click "Register employee" to add the first one.' : 'No employees registered yet.' })}
    <div class="row" style="margin-top:.7rem"><span class="muted small">${r.total} employee(s), page ${r.page}</span><button class="btn sec sm" id="pv" ${r.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn sec sm" id="nx" ${r.page * r.limit >= r.total ? 'disabled' : ''}>Next</button></div></div>`;
    $$('#list tr.click').forEach(tr => { tr.onclick = () => emp360(r.rows[tr.dataset.i].id, hr, load); });
    $('#pv') && ($('#pv').onclick = () => { f.page--; run(load); }); $('#nx') && ($('#nx').onclick = () => { f.page++; run(load); });
  };
  $('#flt').onsubmit = e => { e.preventDefault(); Object.assign(f, formObj(e.target), { page: 1 }); run(load); };
  if (hr) {
    $('#new').onclick = () => empForm(null, load);
    $('#exp').onclick = () => download('/employees/export', 'employees.csv');
    $('#imp').onclick = importCsvModal(load);
  }
  await run(load);
};
function empForm(e, done) {
  const v = e || {};
  const m = modal(e ? 'Edit ' + e.name : 'Register employee', `<form id="ef"><div class="row">${field('Full name', 'name', { value: v.name, required: true })}${field('Email (login)', 'email', { type: 'email', value: v.email, required: true })}${field('Employee code (auto if blank)', 'code', { value: v.code })}${field('Phone', 'phone', { value: v.phone })}
  ${field('Department', 'department_id', { options: deptOpts(), value: v.department_id, required: true })}${field('Designation', 'designation', { value: v.designation })}${field('Join date', 'join_date', { type: 'date', value: v.join_date, required: true })}${field('Gender', 'gender', { options: ['male', 'female', 'other'].map(x => ({ v: x, t: x })), value: v.gender })}
  ${field('Basic salary', 'salary_basic', { type: 'number', value: v.salary_basic, required: true, attrs: ' min="1" step="any"' })}${e ? field('Status', 'status', { options: ['active', 'probation', 'exited'].map(x => ({ v: x, t: x })), value: v.status, blank: false }) : field('Status', 'status', { options: ['active', 'probation'].map(x => ({ v: x, t: x })), value: 'probation', blank: false })}${field('Address', 'address', { value: v.address, wide: true })}</div>
  <p class="small muted">Gross = 1.5 x basic (HRA 40%, medical 10%). ${e ? '' : 'A login is created with a temporary password.'}</p><button class="btn">${e ? 'Save changes' : 'Register'}</button></form>`);
  $('#ef', m.el).onsubmit = ev => { ev.preventDefault(); run(async () => {
    const d = formObj(ev.target); if (e) d.exit_date = d.status === 'exited' ? (e.exit_date || undefined) : undefined;
    const r = await api(e ? '/employees/' + e.id : '/employees', { method: e ? 'PUT' : 'POST', body: d }); m.close();
    if (!e) modal('Employee registered', `<p><b>${esc(r.employee.name)}</b> (${esc(r.employee.code)}) can now sign in with:</p><p>Email: <code>${esc(r.employee.email)}</code><br>Temporary password: <code>${esc(r.temp_password)}</code></p><p class="small muted">Shown once. They must change it on first sign-in.</p>`);
    else toast('Saved'); done();
  }, $('button', ev.target)); };
}
async function emp360(id, hr, done) {
  await run(async () => {
    const p = await api('/employees/' + id), e = p.employee, a = p.attendance_last_30_days;
    const m = modal(e.name, `<div class="grid g2"><div><p><b>${esc(e.code)}</b> ${badge(e.status)}<br>${esc(e.designation || 'No designation')}, ${esc(e.department)}<br>${esc(e.email)}${e.phone ? '<br>' + esc(e.phone) : ''}<br>Joined ${esc(e.join_date)}${e.exit_date ? ', left ' + esc(e.exit_date) : ''}</p>
      <p>Basic <b>${fmt(e.salary_basic)}</b> / Gross <b>${fmt(e.salary_basic * 1.5)}</b></p>${hr ? '<button class="btn sm" id="ed">Edit</button>' : ''}</div>
      <div><h3>Last 30 days</h3><p>Present ${a.present}, late ${a.late}, half day ${a.half_day}, absent ${a.absent}, on leave ${a.on_leave}<br>Attendance rate <b>${a.attendance_rate == null ? '-' : a.attendance_rate + '%'}</b></p></div></div>
      <h3>Leave balance</h3>${table([{ h: 'Type', f: r => esc(r.type) }, { h: 'Remaining', f: r => r.remaining == null ? 'Unlimited' : r.remaining }, { h: 'Used', f: r => r.used }], p.leave_balance)}
      <h3>Recent leave</h3>${table([{ h: 'Type', f: r => esc(r.type) }, { h: 'Dates', f: r => `${r.start_date} to ${r.end_date}` }, { h: 'Status', f: r => badge(r.status) }], p.recent_leaves, { empty: 'No leave requests.' })}
      <h3>Last payslip</h3>${p.last_payslip ? `<p>${esc(p.last_payslip.month)}: net <b>${fmt(p.last_payslip.net)}</b></p>` : '<p class="muted">None finalized yet.</p>'}`);
    if (hr) $('#ed', m.el).onclick = () => { m.close(); empForm(e, done); };
  });
}
function importCsvModal(done) {
  return () => {
    const m = modal('Import employees from CSV', `<p class="small muted">Columns: <code>name,email,department,join_date,salary_basic</code> (required) and <code>code,phone,designation,gender</code> (optional). Department must already exist.</p><input type="file" id="file" accept=".csv,text/csv"><textarea id="csv" rows="7" placeholder="name,email,department,join_date,salary_basic" style="margin-top:.5rem"></textarea><div class="row" style="margin-top:.5rem"><button class="btn sec" id="dry">Dry run (check only)</button><button class="btn" id="doit">Import valid rows</button></div><div id="res"></div>`);
    $('#file', m.el).onchange = e => { const r = new FileReader(); r.onload = () => { $('#csv', m.el).value = r.result; }; r.readAsText(e.target.files[0]); };
    const go = dry => ev => run(async () => {
      const r = await api('/employees/import?dryRun=' + (dry ? 1 : 0), { method: 'POST', body: { csv: $('#csv', m.el).value } });
      $('#res', m.el).innerHTML = `<p><b>${r.valid_count}</b> of ${r.total} rows valid, <b>${r.error_count}</b> with errors${dry ? ' (nothing saved)' : ''}.</p>${r.errors.length ? table([{ h: 'Row', f: x => x.row }, { h: 'Field', f: x => esc(x.field) }, { h: 'Reason', f: x => esc(x.reason) }], r.errors) : ''}${r.created.length ? `<h3>Created logins</h3>${table([{ h: 'Code', f: x => esc(x.code) }, { h: 'Email', f: x => esc(x.email) }, { h: 'Temporary password', f: x => `<code>${esc(x.temp_password)}</code>` }], r.created)}` : ''}`;
      if (!dry && r.created.length) done();
    }, ev.target);
    $('#dry', m.el).onclick = go(true); $('#doit', m.el).onclick = go(false);
  };
}

/* ---------- attendance ---------- */
PAGES.attendance = async el => (isStaff() ? attStaff(el) : attEmployee(el));
async function attStaff(el) {
  const hr = S.user.role === 'hr', date = S.attDate || todayStr();
  const [b, cor] = await Promise.all([api('/attendance/board?date=' + date), api('/attendance/corrections?status=pending')]);
  el.innerHTML = `<h1>Attendance</h1><div class="card"><div class="row"><div class="f"><label>Date</label><input type="date" id="d" value="${date}"></div></div>
  ${table([{ h: 'Code', f: r => esc(r.code) }, { h: 'Employee', f: r => esc(r.name) }, { h: 'Department', f: r => esc(r.department) }, { h: 'In', f: r => esc(r.check_in || '-') }, { h: 'Out', f: r => esc(r.check_out || '-') }, { h: 'Hours', f: r => r.hours ?? '-' }, { h: 'Source', f: r => esc(r.source || '-') }, { h: 'Status', f: r => badge(r.status) }], b.rows, { empty: 'No employees were employed on this date.' })}</div>
  <div class="card"><h2>Correction requests (pending)</h2>${table([{ h: 'Employee', f: r => esc(r.employee) }, { h: 'Date', f: r => esc(r.date) }, { h: 'In / Out', f: r => `${esc(r.check_in)} / ${esc(r.check_out || '-')}` }, { h: 'Reason', f: r => esc(r.reason) }, { h: '', cls: 'nowrap', f: r => hr ? `<button class="btn sm" data-ok="${r.id}">Approve</button> <button class="btn red sm" data-no="${r.id}">Reject</button>` : '' }], cor, { empty: 'No pending corrections.' })}</div>`;
  $('#d').onchange = e => { S.attDate = e.target.value; route(); };
  const dec = (id, approve) => { const m = modal(approve ? 'Approve correction' : 'Reject correction', `<form id="cf">${field('Comment (optional)', 'comment', { wide: true })}<button class="btn">${approve ? 'Approve' : 'Reject'}</button></form>`); $('#cf', m.el).onsubmit = e => { e.preventDefault(); run(async () => { await api(`/attendance/corrections/${id}/decide`, { method: 'POST', body: { approve, comment: formObj(e.target).comment } }); m.close(); toast('Done'); route(); }); }; };
  $$('[data-ok]', el).forEach(b => b.onclick = () => dec(b.dataset.ok, true)); $$('[data-no]', el).forEach(b => b.onclick = () => dec(b.dataset.no, false));
}
async function attEmployee(el) {
  const month = S.attMonth || todayStr().slice(0, 7);
  const [r, cor] = await Promise.all([api('/attendance/me?month=' + month), api('/attendance/corrections')]);
  const [y, mo] = month.split('-').map(Number), first = new Date(y, mo - 1, 1).getDay(), last = new Date(y, mo, 0).getDate();
  const by = {}; r.records.forEach(x => { by[x.date] = x; });
  const wk = S.settings.weekend; let cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="h">${d}</div>`).join('') + '<div style="border:0"></div>'.repeat(first);
  for (let d = 1; d <= last; d++) { const ds = `${month}-${String(d).padStart(2, '0')}`, x = by[ds], dow = new Date(y, mo - 1, d).getDay(); cells += `<div class="${x ? 's-' + x.status : wk.includes(dow) ? 's-off' : ''}">${d}${x ? `<small>${esc(x.check_in.slice(0, 5))}${x.check_out ? '-' + esc(x.check_out.slice(0, 5)) : ''}</small>` : ''}</div>`; }
  const s = r.summary;
  el.innerHTML = `<h1>My attendance</h1><div class="card"><div class="row"><div class="f"><label>Month</label><input type="month" id="m" value="${month}"></div><div class="f muted small">Present ${s.present}, late ${s.late}, half day ${s.half_day}, absent ${s.absent}, on leave ${s.on_leave}. Attendance rate ${s.attendance_rate == null ? '-' : s.attendance_rate + '%'}</div></div><div class="cal">${cells}</div></div>
  <div class="grid g2"><div class="card"><h2>Request a correction</h2><form id="cf" class="row">${field('Date', 'date', { type: 'date', required: true, attrs: ` max="${todayStr()}"` })}${field('Check-in', 'check_in', { type: 'time', required: true })}${field('Check-out', 'check_out', { type: 'time' })}${field('Reason', 'reason', { required: true, wide: true })}<button class="btn">Send request</button></form></div>
  <div class="card"><h2>My requests</h2>${table([{ h: 'Date', f: x => esc(x.date) }, { h: 'Status', f: x => badge(x.status) }, { h: 'Comment', f: x => esc(x.comment || '') }], cor, { empty: 'No correction requests.' })}</div></div>`;
  $('#m').onchange = e => { S.attMonth = e.target.value; route(); };
  $('#cf').onsubmit = e => { e.preventDefault(); run(async () => { await api('/attendance/corrections', { method: 'POST', body: formObj(e.target) }); toast('Request sent to HR'); route(); }, $('button', e.target)); };
}

/* ---------- leave ---------- */
PAGES.leave = async el => (isStaff() ? leaveStaff(el) : leaveEmployee(el));
async function leaveStaff(el) {
  const hr = S.user.role === 'hr', st = S.leaveSt ?? 'pending';
  const rows = await api('/leave?' + qs({ status: st }));
  el.innerHTML = `<h1>Leave requests</h1><div class="card"><div class="row"><div class="f"><label>Status</label><select id="st">${['pending', 'approved', 'rejected', 'cancelled', ''].map(x => `<option value="${x}" ${x === st ? 'selected' : ''}>${x || 'all'}</option>`).join('')}</select></div></div>
  ${table([{ h: 'Employee', f: r => `${esc(r.employee)}<br><span class="small muted">${esc(r.code)}</span>` }, { h: 'Type', f: r => esc(r.type) }, { h: 'Dates', f: r => `${r.start_date} to ${r.end_date}<br><span class="small muted">${r.days} working day(s)</span>` }, { h: 'Reason', f: r => esc(r.reason) }, { h: 'Status', f: r => badge(r.status) + (r.comment ? `<br><span class="small muted">${esc(r.comment)}</span>` : '') }, { h: '', cls: 'nowrap', f: r => hr && r.status === 'pending' ? `<button class="btn sm" data-ok="${r.id}">Approve</button> <button class="btn red sm" data-no="${r.id}">Reject</button>` : '' }], rows, { empty: 'No leave requests in this view.' })}</div>`;
  $('#st').onchange = e => { S.leaveSt = e.target.value; route(); };
  const dec = (id, approve) => { const m = modal(approve ? 'Approve leave' : 'Reject leave', `<form id="lf">${field(approve ? 'Comment (optional)' : 'Comment (required)', 'comment', { wide: true, required: !approve })}<button class="btn">${approve ? 'Approve' : 'Reject'}</button></form>`); $('#lf', m.el).onsubmit = e => { e.preventDefault(); run(async () => { await api(`/leave/${id}/decide`, { method: 'POST', body: { approve, comment: formObj(e.target).comment } }); m.close(); toast('Done'); route(); }); }; };
  $$('[data-ok]', el).forEach(b => b.onclick = () => dec(b.dataset.ok, true)); $$('[data-no]', el).forEach(b => b.onclick = () => dec(b.dataset.no, false));
}
async function leaveEmployee(el) {
  const [bal, list] = await Promise.all([api('/leave/balance'), api('/leave')]);
  el.innerHTML = `<h1>My leave</h1><div class="grid g4" style="margin-bottom:1rem">${bal.map(b => kpi(b.type + ' left', b.remaining == null ? 'Unlimited' : b.remaining, 't')).join('')}</div>
  <div class="card"><h2>Apply for leave</h2><div class="row" style="margin-bottom:.6rem"><div class="f" style="flex:3 1 260px"><label>Describe it in plain words (AI fills the form, you confirm)</label><input id="sl" placeholder="I need next Monday and Tuesday off for my sister's wedding" maxlength="300"></div><div class="f"><button class="btn vio" id="slb" type="button">Fill form with AI</button></div></div>
  <form id="lf" class="row">${field('Type', 'type_id', { options: bal.map(b => ({ v: b.type_id, t: b.type })), required: true, blank: false })}${field('From', 'start', { type: 'date', required: true })}${field('To', 'end', { type: 'date', required: true })}${field('Reason', 'reason', { required: true, wide: true })}<div class="f"><button class="btn">Submit request</button> <span id="ailabel" class="small muted"></span></div></form></div>
  <div class="card"><h2>History</h2>${table([{ h: 'Type', f: r => esc(r.type) }, { h: 'Dates', f: r => `${r.start_date} to ${r.end_date} (${r.days} d)` }, { h: 'Reason', f: r => esc(r.reason) }, { h: 'Status', f: r => badge(r.status) + (r.comment ? `<br><span class="small muted">${esc(r.comment)}</span>` : '') }, { h: '', f: r => ['pending', 'approved'].includes(r.status) && r.start_date >= todayStr() ? `<button class="btn sec sm" data-c="${r.id}">Cancel</button>` : '' }], list, { empty: 'You have not applied for leave yet.' })}</div>`;
  $('#slb').onclick = e => run(async () => {
    const r = await api('/ai/smart-leave', { method: 'POST', body: { text: $('#sl').value } }), f = $('#lf');
    f.type_id.value = r.type_id; f.start.value = r.start; f.end.value = r.end; f.reason.value = r.reason; $('#ailabel').textContent = 'AI-generated: please review before submitting.'; toast('Form pre-filled. Check the dates, then submit.');
  }, e.target);
  $('#lf').onsubmit = e => { e.preventDefault(); run(async () => { await api('/leave', { method: 'POST', body: formObj(e.target) }); toast('Leave request sent'); route(); }, $('button.btn', e.target)); };
  $$('[data-c]', el).forEach(b => b.onclick = () => confirm('Cancel this leave?') && run(async () => { await api(`/leave/${b.dataset.c}/cancel`, { method: 'POST' }); toast('Cancelled'); route(); }));
}

/* ---------- payroll ---------- */
PAGES.payroll = async el => {
  const hr = S.user.role === 'hr', adm = S.user.role === 'admin', runs = await api('/payroll/runs');
  el.innerHTML = `<h1>Payroll</h1>${hr ? `<form class="card row" id="nf">${field('Month', 'month', { type: 'month', value: todayStr().slice(0, 7), required: true })}<div class="f"><button class="btn">Create / refresh draft</button><span class="small muted"> Finalized months cannot be changed.</span></div></form>` : ''}
  <div class="card"><h2>Payroll runs</h2>${table([{ h: 'Month', f: r => `<b>${esc(r.month)}</b>` }, { h: 'Status', f: r => badge(r.status) }, { h: 'Employees', f: r => r.employees }, { h: 'Net total', f: r => fmt(r.net_total) }], runs, { click: true, empty: hr ? 'No payroll yet. Create a draft for a month above.' : 'HR has not created a payroll draft yet.' })}</div><div id="run"></div>`;
  const open = id => run(async () => {
    const r = await api('/payroll/runs/' + id);
    $('#run').innerHTML = `<div class="card"><div class="top"><h2>${esc(r.month)} ${badge(r.status)}</h2>${adm && r.status === 'draft' ? '<button class="btn" id="fin">Finalize and lock</button>' : ''}</div>
    <p class="small muted">Totals: gross ${fmt(r.totals.gross)}, deductions ${fmt(r.totals.deduction)}, tax ${fmt(r.totals.tax)}, net <b>${fmt(r.totals.net)}</b></p>
    ${table([{ h: 'Employee', f: p => `${esc(p.name)}<br><span class="small muted">${esc(p.code)}</span>` }, { h: 'Basic', f: p => fmt(p.basic) }, { h: 'Gross', f: p => fmt(p.gross) }, { h: 'Days', f: p => `${p.employed_days}/${p.working_days}` }, { h: 'Absent / unpaid / half', f: p => `${p.absent_days} / ${p.unpaid_days} / ${p.half_days}` }, { h: 'Deduction', f: p => fmt(p.deduction) }, { h: 'Tax', f: p => fmt(p.tax) }, { h: 'Net', f: p => `<b>${fmt(p.net)}</b>` }, { h: '', f: p => `<button class="btn sec sm" data-pdf="${p.id}" data-n="${esc(p.code)}-${esc(r.month)}">PDF</button>` }], r.slips)}</div>`;
    $$('[data-pdf]').forEach(b => b.onclick = () => download(`/payslips/${b.dataset.pdf}/pdf`, `payslip-${b.dataset.n}.pdf`));
    if ($('#fin')) $('#fin').onclick = e => confirm(`Finalize ${r.month}? This locks the month and cannot be undone.`) && run(async () => { await api(`/payroll/runs/${id}/finalize`, { method: 'POST' }); toast('Payroll finalized'); route(); setTimeout(() => open(id), 300); }, e.target);
  });
  $$('tr.click', el).forEach(tr => tr.onclick = () => open(runs[tr.dataset.i].id));
  if (hr) $('#nf').onsubmit = e => { e.preventDefault(); run(async () => { const r = await api('/payroll/runs', { method: 'POST', body: formObj(e.target) }); toast('Draft ready'); await route(); setTimeout(() => open(r.id), 300); }, $('button', e.target)); };
};
PAGES.payslips = async el => {
  const rows = await api('/payslips');
  el.innerHTML = `<h1>My payslips</h1><div class="card">${table([{ h: 'Month', f: r => `<b>${esc(r.month)}</b>` }, { h: 'Gross', f: r => fmt(r.gross) }, { h: 'Deductions', f: r => fmt(r.deduction) }, { h: 'Tax', f: r => fmt(r.tax) }, { h: 'Net pay', f: r => `<b>${fmt(r.net)}</b>` }, { h: '', f: r => `<button class="btn sm" data-pdf="${r.id}" data-m="${esc(r.month)}">Download PDF</button>` }], rows, { empty: 'No payslips yet. They appear after Admin finalizes the month.' })}</div>`;
  $$('[data-pdf]', el).forEach(b => b.onclick = () => download(`/payslips/${b.dataset.pdf}/pdf`, `payslip-${b.dataset.m}.pdf`));
};

/* ---------- profile, announcements, audit ---------- */
PAGES.profile = async el => {
  el.innerHTML = `<h1>Account</h1><div class="card"><p><b>${esc(S.user.name)}</b> <span class="pill ${S.user.role}">${S.user.role}</span><br>${esc(S.user.email)}</p><button class="btn sec" id="pw2">Change password</button></div><div id="emp"></div>`;
  $('#pw2').onclick = () => renderChangePw(false);
  if (S.user.role !== 'employee') return;
  const e = await api('/employees/me');
  $('#emp').innerHTML = `<div class="card"><h2>My details</h2><p>${esc(e.code)} · ${esc(e.designation || 'No designation')}, ${esc(e.department)} · joined ${esc(e.join_date)}<br>Basic salary ${fmt(e.salary_basic)}</p><form id="pf" class="row">${field('Phone', 'phone', { value: e.phone })}${field('Address', 'address', { value: e.address, wide: true })}<div class="f"><button class="btn">Save</button></div></form><p class="small muted">Only phone and address can be edited here. Ask HR for other changes.</p></div>`;
  $('#pf').onsubmit = ev => { ev.preventDefault(); run(async () => { await api('/employees/me', { method: 'PATCH', body: formObj(ev.target) }); toast('Saved'); }, $('button', ev.target)); };
};
PAGES.announcements = async el => {
  const list = await api('/announcements');
  el.innerHTML = `<h1>Announcements</h1>${isStaff() ? `<form class="card" id="af">${field('Title', 'title', { required: true, wide: true })}${field('Message', 'body', { area: true, required: true, wide: true })}<button class="btn">Post to everyone</button></form>` : ''}
  ${list.length ? list.map(a => `<div class="card"><h3>${esc(a.title)}</h3><p>${esc(a.body)}</p><span class="small muted">${esc(a.author || '')} · ${esc(a.created_at)} UTC</span></div>`).join('') : '<div class="card empty">No announcements yet.</div>'}`;
  if (isStaff()) $('#af').onsubmit = e => { e.preventDefault(); run(async () => { await api('/announcements', { method: 'POST', body: formObj(e.target) }); toast('Posted'); route(); }, $('button', e.target)); };
};
PAGES.audit = async el => {
  const a = S.auditF || (S.auditF = { entity: '', action: '' });
  const r = await api('/audit?' + qs(a));
  el.innerHTML = `<h1>Audit log</h1><form class="card row" id="af">${field('Entity (e.g. leave, employee)', 'entity', { value: a.entity })}${field('Action (e.g. approve)', 'action', { value: a.action })}<div class="f"><button class="btn">Filter</button></div></form>
  <div class="card">${table([{ h: 'When (UTC)', cls: 'nowrap', f: x => esc(x.created_at) }, { h: 'Actor', f: x => esc(x.actor) }, { h: 'Action', f: x => esc(x.action) }, { h: 'Entity', f: x => esc(x.entity + (x.entity_id ? ' #' + x.entity_id : '')) }, { h: 'Before → after', f: x => (x.before_json || x.after_json) ? `<details><summary>view</summary><pre class="small" style="white-space:pre-wrap;margin:.3rem 0">${esc(x.before_json || '-')}\n→\n${esc(x.after_json || '-')}</pre></details>` : '-' }], r.rows, { empty: 'No audit entries match.' })}</div>`;
  $('#af').onsubmit = e => { e.preventDefault(); Object.assign(a, formObj(e.target)); route(); };
};
