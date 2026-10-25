/* HCM Lite frontend core: helpers, auth, shell, notifications, AI chat */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { token: sessionStorage.getItem('hcm_token'), user: null, settings: null, depts: [], chat: [] };
const fmt = n => (n == null ? '-' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const badge = s => `<span class="badge b-${esc(s)}">${esc(String(s).replace(/_/g, ' '))}</span>`;

function toast(msg, err) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), err ? 6500 : 3500);
}
async function api(path, o = {}) {
  const headers = { Authorization: 'Bearer ' + (S.token || '') };
  if (o.body !== undefined && typeof o.body !== 'string') headers['Content-Type'] = 'application/json';
  if (typeof o.body === 'string') headers['Content-Type'] = 'text/csv';
  let r;
  try { r = await fetch('/api' + path, { method: o.method || 'GET', headers, body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body) }); }
  catch { throw new Error('Cannot reach the server. Check your connection.'); }
  if (o.blob) { if (!r.ok) throw new Error('Download failed'); return r.blob(); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && S.user) { logout(true); }
    const e = new Error(data.error || 'Request failed'); e.status = r.status; e.details = data.details;
    if (Array.isArray(data.details)) e.message += ': ' + data.details.map(d => (d.row ? `row ${d.row} ` : '') + (d.field ? d.field + ' ' : '') + d.reason).join('; ');
    throw e;
  }
  return data;
}
const run = async (fn, btn) => { if (btn) btn.disabled = true; try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; } };
function modal(title, html) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><header><h2>${esc(title)}</h2><button class="btn sec sm" data-x aria-label="Close">Close</button></header><div data-body>${html}</div></div>`;
  bg.addEventListener('click', e => { if (e.target === bg || e.target.dataset.x !== undefined) bg.remove(); });
  document.body.append(bg); return { el: $('[data-body]', bg), close: () => bg.remove() };
}
const field = (label, name, o = {}) => {
  const v = o.value ?? '', req = o.required ? ' required' : '', cls = 'f' + (o.wide ? ' w' : '');
  if (o.options) return `<div class="${cls}"><label>${esc(label)}</label><select name="${name}"${req}>${o.blank === false ? '' : '<option value="">-</option>'}${o.options.map(x => `<option value="${esc(x.v)}"${String(x.v) === String(v) ? ' selected' : ''}>${esc(x.t)}</option>`).join('')}</select></div>`;
  if (o.area) return `<div class="${cls}"><label>${esc(label)}</label><textarea name="${name}" rows="${o.rows || 3}"${req}>${esc(v)}</textarea></div>`;
  return `<div class="${cls}"><label>${esc(label)}</label><input name="${name}" type="${o.type || 'text'}" value="${esc(v)}"${req}${o.attrs || ''}></div>`;
};
const formObj = f => { const o = {}; new FormData(f).forEach((v, k) => { o[k] = v; }); return o; };
const table = (cols, rows, o = {}) => rows.length
  ? `<div class="tw"><table><thead><tr>${cols.map(c => `<th>${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) => `<tr class="${o.click ? 'click' : ''}" data-i="${i}">${cols.map(c => `<td class="${c.cls || ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : `<div class="empty">${esc(o.empty || 'Nothing here yet.')}</div>`;
const bars = (items, o = {}) => { const max = Math.max(1, ...items.map(i => i.value || 0)); return items.length ? items.map(i => `<div class="bar"><span title="${esc(i.label)}">${esc(i.label)}</span><i style="width:${Math.max(2, (i.value || 0) / max * 55)}%"></i><span>${fmt(i.value)}${o.suffix || ''}</span></div>`).join('') : '<div class="empty">No data yet.</div>'; };
function spark(points) {
  const p = points.filter(x => x.rate != null); if (p.length < 2) return '<div class="empty">Not enough days of data yet.</div>';
  const W = 300, H = 90, xs = i => 8 + i * (W - 16) / (p.length - 1), ys = v => H - 8 - (v / 100) * (H - 16);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Attendance rate trend"><polyline fill="none" stroke="var(--orange)" stroke-width="2" points="${p.map((x, i) => `${xs(i)},${ys(x.rate)}`).join(' ')}"/>${p.map((x, i) => `<circle cx="${xs(i)}" cy="${ys(x.rate)}" r="2.5" fill="var(--orange)"><title>${x.date}: ${x.rate}%</title></circle>`).join('')}</svg><div class="small muted">${p[0].date} to ${p[p.length - 1].date} (attendance rate %)</div>`;
}
const kpi = (label, val, cls = '') => `<div class="kpi ${cls}"><b>${esc(val)}</b><span>${esc(label)}</span></div>`;

/* ---------- boot / auth ---------- */
function logout() { sessionStorage.clear(); location.hash = ''; location.reload(); }
async function boot() {
  try {
    const st = await (await fetch('/api/setup/status')).json();
    if (!st.initialized) return renderSetup();
    if (!S.token) return renderLogin(st.company_name);
    const me = await api('/auth/me'); S.user = me.user; S.settings = me.settings;
    if (S.user.mustChange) return renderChangePw(true);
    renderShell();
  } catch (e) { if (!S.token) renderLogin(); else { $('#app').innerHTML = `<div class="center"><div class="auth"><h2>Could not load</h2><p>${esc(e.message)}</p><button class="btn" onclick="logout()">Back to login</button></div></div>`; } }
}
function authCard(inner) { $('#app').innerHTML = `<div class="center"><div class="auth">${inner}</div></div>`; }
function renderSetup() {
  authCard(`<h1>Set up HCM Lite</h1><p class="muted">First run: create your company and the Admin account.</p><form id="f">${field('Company name', 'company_name', { required: true, wide: true })}${field('Your name', 'name', { value: 'Admin', wide: true })}${field('Admin email', 'email', { type: 'email', required: true, wide: true })}${field('Password (8+ characters)', 'password', { type: 'password', required: true, wide: true, attrs: ' minlength="8"' })}<button class="btn">Create company</button></form>`);
  $('#f').onsubmit = e => { e.preventDefault(); run(async () => { const d = formObj(e.target); await api('/setup', { method: 'POST', body: d }); const l = await api('/auth/login', { method: 'POST', body: { email: d.email, password: d.password } }); S.token = l.token; sessionStorage.setItem('hcm_token', l.token); toast('Company created'); boot(); }, $('button', e.target)); };
}
function renderLogin(company) {
  authCard(`<h1>${esc(company || 'HCM Lite')}</h1><p class="muted">Sign in to continue</p><form id="f">${field('Email', 'email', { type: 'email', required: true, wide: true })}${field('Password', 'password', { type: 'password', required: true, wide: true })}<button class="btn">Sign in</button></form>`);
  $('#f').onsubmit = e => { e.preventDefault(); run(async () => { const l = await api('/auth/login', { method: 'POST', body: formObj(e.target) }); S.token = l.token; sessionStorage.setItem('hcm_token', l.token); boot(); }, $('button', e.target)); };
}
function renderChangePw(forced) {
  const f = `<form id="f">${field('Current password', 'current_password', { type: 'password', required: true, wide: true })}${field('New password (8+ characters)', 'new_password', { type: 'password', required: true, wide: true, attrs: ' minlength="8"' })}<button class="btn">Change password</button></form>`;
  if (!forced) { const m = modal('Change password', f); bindPw($('#f', m.el), m.close); return; }
  authCard(`<h1>Set a new password</h1><p class="muted">You signed in with a temporary password. Choose your own to continue.</p>${f}<p><a href="#" onclick="logout();return false">Sign out</a></p>`);
  bindPw($('#f'), () => boot());
}
function bindPw(form, done) { form.onsubmit = e => { e.preventDefault(); run(async () => { await api('/auth/change-password', { method: 'POST', body: formObj(form) }); toast('Password changed'); done(); }, $('button', form)); }; }

/* ---------- shell ---------- */
const MENUS = {
  admin: [['dashboard', 'Dashboard'], ['settings', 'Company settings'], ['org', 'Organization'], ['users', 'Logins'], ['employees', 'Employees'], ['attendance', 'Attendance'], ['leave', 'Leave'], ['payroll', 'Payroll'], ['announcements', 'Announcements'], ['audit', 'Audit log']],
  hr: [['dashboard', 'Dashboard'], ['employees', 'Employees'], ['attendance', 'Attendance'], ['leave', 'Leave approvals'], ['payroll', 'Payroll'], ['announcements', 'Announcements'], ['profile', 'Account']],
  employee: [['dashboard', 'My dashboard'], ['attendance', 'My attendance'], ['leave', 'My leave'], ['payslips', 'Payslips'], ['profile', 'My profile'], ['announcements', 'Announcements']],
};
function renderShell() {
  const menu = MENUS[S.user.role];
  $('#app').innerHTML = `<div class="shell"><nav class="side" id="side"><div class="brand">${esc(S.settings.company_name || 'HCM Lite')}<small>HCM Lite</small></div>${menu.map(([k, t]) => `<a href="#/${k}" data-k="${k}">${esc(t)}</a>`).join('')}</nav>
  <div class="main"><div class="top"><div><button class="btn sec sm burger" id="burger">Menu</button> <span class="muted small">${new Date().toDateString()}</span></div>
  <div class="who"><button class="btn sec sm" id="bell" aria-label="Notifications">Notifications <b id="unread"></b></button><span>${esc(S.user.name)} <span class="pill ${S.user.role}">${S.user.role}</span></span><button class="btn sec sm" id="pw">Password</button><button class="btn sec sm" id="out">Sign out</button></div></div>
  <div id="page"></div></div></div>
  <button class="ai-fab" id="aifab">Ask AI</button>
  <div class="ai-panel" id="aipanel"><header><b>HCM assistant</b><button class="btn sec sm" id="aix">Close</button></header><div class="ai-msgs" id="aimsgs"></div><form id="aiform"><input id="aiin" placeholder="Ask about attendance, leave, policy…" maxlength="500" autocomplete="off"><button class="btn vio">Send</button></form></div>`;
  $('#out').onclick = () => logout(); $('#pw').onclick = () => renderChangePw(false);
  $('#burger').onclick = () => $('#side').classList.toggle('open');
  $('#bell').onclick = showNotifications; initChat(); refreshUnread();
  window.onhashchange = route; route();
}
async function refreshUnread() { try { const n = await api('/notifications'); $('#unread').textContent = n.unread ? `(${n.unread})` : ''; } catch { /* ignore */ } }
async function showNotifications() {
  await run(async () => {
    const n = await api('/notifications');
    const m = modal('Notifications', n.rows.length ? n.rows.map(x => `<div class="card" style="padding:.6rem .8rem"><b>${esc(x.title)}</b>${x.read ? '' : ' <span class="badge b-pending">new</span>'}<div class="small muted">${esc(x.created_at)} UTC</div><div>${esc(x.body)}</div></div>`).join('') : '<div class="empty">No notifications yet.</div>');
    await api('/notifications/read', { method: 'POST' }); $('#unread').textContent = ''; return m;
  });
}
function route() {
  const k = (location.hash.replace(/^#\//, '') || 'dashboard').split('?')[0];
  const menu = MENUS[S.user.role]; const key = menu.some(m => m[0] === k) ? k : 'dashboard';
  $$('#side a').forEach(a => a.classList.toggle('on', a.dataset.k === key)); $('#side').classList.remove('open');
  const el = $('#page'); el.innerHTML = '<p class="muted">Loading…</p>';
  const fn = PAGES[key];
  Promise.resolve(fn(el)).catch(e => { el.innerHTML = `<div class="card"><h2>Could not load this page</h2><p>${esc(e.message)}</p><button class="btn" onclick="route()">Try again</button></div>`; });
  refreshUnread();
}

/* ---------- AI chat ---------- */
function initChat() {
  const panel = $('#aipanel'), msgs = $('#aimsgs');
  const draw = () => { msgs.innerHTML = S.chat.length ? S.chat.map(m => `<div class="msg ${m.role === 'user' ? 'u' : 'a'}">${esc(m.content)}${m.role === 'assistant' ? '<small>AI-generated</small>' : ''}</div>`).join('') : `<div class="msg a">Hi ${esc(S.user.name.split(' ')[0])}! Ask me things like "who came late most this month?" or "what is the leave policy?". I only see data you are allowed to see.</div>`; msgs.scrollTop = msgs.scrollHeight; };
  $('#aifab').onclick = () => { panel.classList.toggle('open'); draw(); $('#aiin').focus(); }; $('#aix').onclick = () => panel.classList.remove('open');
  $('#aiform').onsubmit = async e => {
    e.preventDefault(); const q = $('#aiin').value.trim(); if (!q) return; $('#aiin').value = '';
    const hist = S.chat.slice(-6); S.chat.push({ role: 'user', content: q }); draw();
    msgs.insertAdjacentHTML('beforeend', '<div class="msg a" id="thinking">Thinking…</div>'); msgs.scrollTop = msgs.scrollHeight;
    try { const r = await api('/ai/chat', { method: 'POST', body: { message: q, history: hist } }); S.chat.push({ role: 'assistant', content: r.answer }); }
    catch (err) { S.chat.push({ role: 'assistant', content: err.message }); }
    draw();
  };
}
