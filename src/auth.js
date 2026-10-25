const jwt = require('jsonwebtoken');
const db = require('./db');
const { HttpError } = require('./util');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) console.warn('[warn] JWT_SECRET not set, using insecure dev secret');
const sign = u => jwt.sign({ uid: u.id }, SECRET, { expiresIn: '12h' });
function load(req, allowMustChange) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Login required');
  let p; try { p = jwt.verify(h.slice(7), SECRET); } catch { throw new HttpError(401, 'Session expired, login again'); }
  const u = db.prepare('select * from users where id=?').get(p.uid);
  if (!u || !u.active) throw new HttpError(401, 'Account inactive');
  if (u.must_change_password && !allowMustChange) throw new HttpError(403, 'Change your temporary password first', 'PASSWORD_CHANGE_REQUIRED');
  req.user = { id: u.id, email: u.email, name: u.name, role: u.role, employeeId: u.employee_id, mustChange: !!u.must_change_password };
}
const auth = (req, res, next) => { try { load(req, false); next(); } catch (e) { next(e); } };
const authAny = (req, res, next) => { try { load(req, true); next(); } catch (e) { next(e); } };
const role = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : next(new HttpError(403, 'You do not have access to this'));
module.exports = { sign, auth, authAny, role };
