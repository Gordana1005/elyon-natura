---
name: elyon-hr
description: HR — Човечки ресурси in the Macedonian Elyon CRM (owner 15.10.2026, Фаза 1) — the dossier for EVERY employee (call centre, the 22 shops, warehouse, office; a login is optional), absences and their stages (pending_team → pending_manager → approved | rejected | cancelled) and who decides each, the dossier wall (super_admin / owner / finance only), the labour-law defaults (20 days, 2/month in the first 6 months, carry until 30.06, a first part ≥ 12 days, sick days 1–30 employer / 31+ ФЗОМ, paid personal leave ≤ 7), holidays per calendar (state / orthodox / muslim / catholic / communities), the link to the shift roster (approval removes shifts, no shift on an absence, the login gate's on_leave), the /hr page, the api routes and the checker verify-hr. Read before touching hr_* tables or functions, GET/POST /api/hr/*, src/components/hr, src/pages/HrPage.tsx, or the shifts grid / save / runway / check-login.
---

# HR — Човечки ресурси (MACEDONIA)

> Owner, 15.10.2026: "во Тим е убаво да имаме и човечки ресурси… да знаеме кој кога има слободен ден, кој колку има
> користено одмор, кој кога бил слободен". Decisions the same day: **every employee** (shops and warehouse too);
> **the team lead approves first, then a manager**; **the dossier only super_admin + owner + finance**; next big module
> after HR = Viber / SMS. Plan: `C:\Users\Mile\.claude\plans\wondrous-tinkering-pearl.md` (Фаза 2 / 3 listed there).

## 1. Data (migration `20261016120000_hr_core.sql`)

| table | what |
|---|---|
| `hr_employees` | the dossier, one row per person. `user_id` optional + unique (shop staff have no login). Work: workplace (`call_centre / shop / warehouse / office / field`), `shop_name`, `team_key` (`teleshop / affiliate / management`), position, company, `approver_id`. Days: `work_days` (ISO weekdays, default Mon–Fri), `holiday_calendars`. Dossier: phone, email, birth date, address, emergency contact, hire date, contract type / end, probation end, prior service, `extra_leave_days` (+3 for age / disability…), notes. |
| `hr_leave_types` | `annual` О · `sick` Б · `personal_paid` П · `unpaid` Н · `maternity` М · `business_trip` С · `comp_day` К · `other` Д; `day_basis` working (work days minus holidays) or calendar (sick, maternity). |
| `hr_leave_requests` | from–to, `days` (counted at request), status, requester / team step / decision / cancel with notes, `doc_ref` (doctor's note), `removed_shifts` (what approval took off). |
| `hr_leave_entitlements` | a year's right set by HR (base / extra / carry). No row = `hr_default_entitlement()`. |
| `hr_holidays` | date, name, scope (`all` or a calendar), `moved_from` (a Sunday state day stored on its Monday), `verified` (false = computed / lunar date — HR confirms). 2026 + 2027 seeded. |

RLS on, **no policy**: everything goes through the api (service role). Seeded: one dossier row per active staff
login (53 on 15.10; affiliate-only logins and the "ТЕСТ…" profile excluded).

## 2. Who decides (SQL is the truth; the api and UI mirror it)

- **Team step** `hr_team_approvers(emp)`: the employee's `approver_id`, else the dept_admins (access level) whose
  departments are the employee's team (teleshop ↔ teleshop_out / teleshop_other / social = Тим Центар: Теодора,
  Мирјана; affiliate ↔ altercpa / elyon_crm = Тим Маџари: Мартина, Симона, Калина). Never the employee.
- **Manager step** `hr_can_decide_final(uid)`: access level administrator / owner / super_admin, or a uuid in
  `app_settings.hr.final_approvers`. Notified: `hr_final_approvers()` = that list, else every administrator
  (Mr Tony, Nina, Dragana, Dzenet), else owner + super admins.
- A request from someone with no team approver (shops, warehouse, office) or made by a final approver starts at
  `pending_manager`. A final approver may decide a `pending_team` request directly. **Nobody decides their own**
  (super admin excepted). A rejection needs a note ≥ 3 characters; a manager's cancel too.
- `record = true` (POST /hr/requests): a final approver enters an absence as already approved (a sick note, shop
  staff) — any date. A person asking for themselves can go at most 31 days back.
- Overlaps of open / approved requests of one person are refused (23505 → 409 `hr.conflict`).

## 3. The shift roster (it is the LOGIN GATE)

- Approval (or a record) calls `hr_clear_shifts`: the person's shift assignments on those days are deleted and kept in
  `removed_shifts`; a cancel calls `hr_restore_shifts` for days ≥ today (where still free and the shift row exists).
- `shifts_set_cells` skips a non-off cell on an approved-absence day and returns it in `skipped_absence` (the grid
  toasts "N days not saved"); trigger `trg_shift_assignments_zz_hr_absence` (sorts after `…_set_date`) silently skips
  any other insert / shift change (roll-forward, copy, the legacy POST /shifts).
- `shifts_grid` returns `absences` (user × day × type × letter); `ShiftGrid` / `ShiftDayList` show the letter (violet),
  never a brush.
- `shifts_runway` counts the last approved absence day like a shift.
- `GET /shifts/check-login`: when refused and `hr_absence_on(user, today)` → `code: 'on_leave'`, `leave: {type, until}`
  (blocked_login_attempts reason "On approved leave (…) until …"). Only the wording changes — the person had no shift.

## 4. The law (defaults — the accountant confirms; every number editable)

- Annual leave ≥ 20 working days; hired during the year: 2 days per full month worked by 31.12 until 6 months, then 20;
  + `extra_leave_days`. Seniority additions are HR's `extra_leave_days` / the year's entitlement row.
- Carry-over is usable until **30.06**; leave dated ≤ 30.06 spends it first (`carry_expiring` warns). The automatic
  carry starts from **2028** (or when HR set last year's right) — 2026 holds no leave from before HR existed, so HR types
  the 2027 carry or sets the 2026 right / records old absences.
- First part ≥ 12 working days in one request (`first_part_ok`; the UI warns from September).
- Sick leave: an uninterrupted spell (requests that touch day to day chain) — day 1–30 employer, day 31+ ФЗОМ refund
  (`sick_employer_days` / `sick_fzom_days`, computed, never typed).
- Paid personal leave > 7 days a year → warning.
- Holidays: a state holiday applies to everyone; religious / community days only to employees whose
  `holiday_calendars` hold that scope. Annual leave counts the person's work days minus their holidays.

## 5. api + UI

- `supabase/functions/api/hr.ts` (pure, `hr.test.ts`): vocabularies, body parsers, `stripEmployee` (dossier keys
  ABSENT for everyone but full; one's own row without `notes`), `teamsOfDepartments`, `inTeamScope`,
  `workingDays` / `requestDays` (the browser preview), `maxSameDay`, `decorateRequest` (can_decide / can_cancel),
  `rpcErrorStatus`.
- Routes (`index.ts`, module `hr`): `GET hr/me` · `GET hr/calendar` · `GET|POST hr/requests` ·
  `POST hr/requests/:id/decide|cancel` · `GET|POST hr/employees`, `PATCH hr/employees/:id` (full only) ·
  `GET hr/balances` · `PUT hr/entitlements` (full only) · `GET|POST hr/holidays`, `PATCH|DELETE hr/holidays/:id`
  (seeAll). Bell: type `hr_leave`, `meta.i18n = notif.hrLeave.<requested|teamApproved|approved|rejected|cancelled|recorded>`.
- `/hr` (`src/pages/HrPage.tsx`, `src/components/hr/*`): Мое (balance, requests, holidays) for anyone with a dossier;
  Преглед · Календар · Барања · Салда for team leads and managers; Вработени for the dossier viewers; Празници for all
  (edit: seeAll). Every screen 360–1920 px (cards below md; the month grid scrolls inside its own card).

## 6. Never

- Never give `authenticated` a read policy on hr_* (personal data) — the api strips per viewer.
- Never put personal values in `audit_log` (`hr_employee_save` logs the changed KEYS only).
- Never make "Слободен" in the shift grid an HR absence (weekends would flood it) — absences come from /hr.
- Never call the leave statuses "На чекање" (that is ONLY the order status pending) — "Чека тим / Чека менаџер".

Check: `node scripts/verify-hr.mjs` (H1 no shift on an absence · H2 no overlaps · H3 every login has a dossier ·
H4 holidays present, unverified listed · H5 stages whole · H6 balances compute).
