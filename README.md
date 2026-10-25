# HCM Lite

AI-assisted Human Capital Management for **Admin, HR and Employees** (Saylani Hackathon, 24 Oct 2026).
Node.js + Express + SQLite on the backend, a dependency-free JavaScript web app on the frontend (served by the same server).
The system starts **empty**: no dummy data. Every number on a dashboard comes from records created in the app.

## Run it (under 5 minutes)

```bash
npm install
cp .env.example .env     # then edit .env (see below)
npm start                # http://localhost:3000
npm test                 # 9 end-to-end tests (no AI key needed, the AI is mocked)
```
Requires Node 18+. The database is a single file at `data/hcm.db`, created automatically.

## Create the first Admin
Open the app on a fresh install: the **first-run screen** asks for the company name and Admin account.
Or set `ADMIN_EMAIL`, `ADMIN_PASSWORD` (and optionally `COMPANY_NAME`) in `.env` before the first start.

## Set the AI key
Any OpenAI-compatible API with tool calling works. The key stays in the backend only.
```
AI_API_KEY=your-key
AI_BASE_URL=https://api.groq.com/openai/v1            # Groq (free tier)
AI_MODEL=llama-3.3-70b-versatile
# Gemini free tier: AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai  AI_MODEL=gemini-2.0-flash
```
Without a key everything except the AI features works, and AI endpoints answer with a friendly 503 message.

## Demo flow (matches the brief)
1. Admin: set up company, office hours and location, a department, then **Logins → Create HR login** (note the temporary password).
2. HR signs in, changes the password, **Employees → Register employee** (shows the employee's temporary password once).
3. Employee signs in, changes the password, checks in, types a leave request in plain words (**Fill form with AI**), confirms.
4. HR approves leave, opens the dashboard, clicks **Summarize with AI**, asks the assistant "who is on leave today?", creates the payroll draft.
5. Admin finalizes payroll. Employee downloads the payslip PDF and asks the AI for a colleague's salary (refused). Admin opens the **Audit log**.

## Structure
```
src/app.js            routes (REST), role + scope guards, error handling
src/auth.js           JWT + bcrypt login, role middleware, forced password change
src/services/         business rules, one file per module
  core.js             settings, holidays, working days, attendance status rule, audit, notifications
  employees.js        register (creates login), search/paging, CSV dry run/import/export, Employee 360
  attendance.js       check-in/out (409 on second), corrections, camera + Haversine geofence
  leave.js            working-day count, overlap + balance (422), approval, cancel
  payroll.js          gross = 1.5 x basic, deductions, proration, tax slab, finalize lock, payslip PDF
  analytics.js        metrics from section 7 + dashboards (one source for UI and AI)
  ai.js               tool calling, dashboard summary, smart leave, policy Q&A, guardrails
public/               the web app (app.js = core/shell/AI panel, pages.js = screens)
test/                 end-to-end tests
```

## How the brief's rules are implemented
- **Server-side RBAC**: every route has a role guard; employees only read rows with their own `employee_id`. The AI tools apply the same scope (an Employee asking for a colleague's salary only ever gets their own record, and the prompt tells the model to refuse).
- **Attendance**: server stamps time; one record per employee/day (second check-in = 409); late after start + grace; half day under 5 h; absent when no record and no approved leave; missing checkout for past days without check-out. Settings are stored on records when created (applied to new records only).
- **Leave**: working days only, quotas 14/8/10, unpaid unlimited, overlap or over-balance = 422.
- **Payroll**: gross = 1.5 x basic; per day = gross / working days; deduct absent + unpaid + 0.5 x half days; joiners/leavers prorated; tax slab on gross x 12; only Admin can finalize; finalized months are locked (409).
- **AI guardrails**: key only in env; tools reuse the same services as the dashboard; AI never saves data (smart leave only pre-fills the form); JSON validated with one retry; 15 s timeout; 20 requests/user/hour; every call in `ai_logs`; answers labelled "AI-generated".
- **Audit log**: actor, action, entity, before/after JSON; no API to edit or delete entries.

## Done / not done
Done: all 25 functionalities of the checklist, 9 modules, tests.
Partly: camera check-in works on the server (face count, GPS accuracy <= 100 m, Haversine radius). The browser uses the native `FaceDetector` API when the browser has it (Chrome with experimental features); otherwise it tells the user to use normal check-in. No mobile app, no face matching/liveness.
Not done (bonus): attrition risk score, absence anomaly flags, late penalty rule, Roman Urdu is accepted by the AI prompt but not specially tested, dark mode follows the OS setting (no PWA).
Notes: dashboard numbers are computed on the server from SQL queries plus per-day status logic shared with the AI and payroll. Tax slab is illustrative as in the brief.

## Deploy (free)
Render / Railway: build `npm install`, start `npm start`. Set env vars `JWT_SECRET`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `TZ`. SQLite needs a persistent disk (on Render free tier data resets on redeploy, fine for judging because the app starts from first-run setup).
Never commit `.env`.
