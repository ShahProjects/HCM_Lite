const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'hcm.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
create table if not exists settings(key text primary key, value text);
create table if not exists departments(id integer primary key, name text unique not null);
create table if not exists designations(id integer primary key, name text unique not null);
create table if not exists leave_types(id integer primary key, name text unique not null, quota integer, paid integer not null default 1);
create table if not exists holidays(id integer primary key, date text unique not null, name text not null);
create table if not exists employees(
  id integer primary key, code text unique not null, name text not null, email text unique not null,
  phone text, address text, gender text, department_id integer references departments(id),
  designation_id integer references designations(id), join_date text not null, exit_date text,
  status text not null default 'active', salary_basic real not null, created_at text default (datetime('now')));
create table if not exists users(
  id integer primary key, email text unique not null, name text not null, password_hash text not null,
  role text not null check(role in ('admin','hr','employee')), employee_id integer references employees(id),
  active integer not null default 1, must_change_password integer not null default 0, created_at text default (datetime('now')));
create table if not exists attendance(
  id integer primary key, employee_id integer not null references employees(id), date text not null,
  check_in text, check_out text, is_late integer not null default 0, source text default 'web',
  lat real, lng real, distance_m real, unique(employee_id, date));
create table if not exists corrections(
  id integer primary key, employee_id integer not null references employees(id), date text not null,
  check_in text, check_out text, reason text not null, status text not null default 'pending',
  decided_by integer, comment text, created_at text default (datetime('now')));
create table if not exists leave_requests(
  id integer primary key, employee_id integer not null references employees(id), type_id integer not null references leave_types(id),
  start_date text not null, end_date text not null, days integer not null, reason text,
  status text not null default 'pending', comment text, decided_by integer, created_at text default (datetime('now')));
create table if not exists payroll_runs(
  id integer primary key, month text unique not null, status text not null default 'draft',
  created_by integer, finalized_by integer, finalized_at text, created_at text default (datetime('now')));
create table if not exists payslips(
  id integer primary key, run_id integer not null references payroll_runs(id) on delete cascade,
  employee_id integer not null references employees(id), basic real, gross real, working_days integer,
  employed_days integer, absent_days real, unpaid_days real, half_days real, deduction real, tax real, net real, details text,
  unique(run_id, employee_id));
create table if not exists announcements(id integer primary key, title text not null, body text not null, author_id integer, created_at text default (datetime('now')));
create table if not exists notifications(id integer primary key, user_id integer not null, title text not null, body text, read integer not null default 0, created_at text default (datetime('now')));
create table if not exists audit_log(id integer primary key, actor_id integer, actor text, action text not null, entity text, entity_id text, before_json text, after_json text, created_at text default (datetime('now')));
create table if not exists ai_logs(id integer primary key, user_id integer, kind text, prompt text, response text, tools text, ok integer, ms integer, created_at text default (datetime('now')));
`);
module.exports = db;
