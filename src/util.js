class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const pad = (n, l = 2) => String(n).padStart(l, '0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
};
const today = () => fmtDate(new Date());
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); };
const eachDay = (from, to) => { const out = []; let c = from; while (c <= to) { out.push(c); c = addDays(c, 1); } return out; };
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const toSec = t => { const [h, m, s = 0] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };
const hoursBetween = (a, b) => (toSec(b) - toSec(a)) / 3600;
const monthRange = m => {
  if (!/^\d{4}-\d{2}$/.test(m || '')) return null;
  const [y, mo] = m.split('-').map(Number);
  if (mo < 1 || mo > 12) return null;
  return { from: `${m}-01`, to: fmtDate(new Date(y, mo, 0)) };
};
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const round1 = n => Math.round((n + Number.EPSILON) * 10) / 10;
const haversine = (lat1, lon1, lat2, lon2) => {
  const R = 6371000, r = x => x * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
module.exports = { HttpError, pad, fmtDate, parseDate, today, addDays, eachDay, nowTime, hoursBetween, monthRange, round1, round2, haversine };
