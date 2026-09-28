# Security model

> The defences that are in place, how they fit together, and the known gaps. The system handles real
> customer PII (Bulgarian names, phones, addresses) and money (COD totals), so the posture matters even at
> small scale.

---

## 1. Trust boundaries

```
Browser (untrusted)  ── anon key + user JWT ──►  PostgREST (RLS-bound)        : Auth + get_my_permissions only
Browser (untrusted)  ── user JWT ──►  Edge Function ── service role ──► DB    : everything else (function re-checks roles)
Internet (untrusted) ── HMAC ──►  Edge Function webhooks ── service role ──► DB: inbound leads/orders
Operator's machine   ── service role (.env) ──► DB                            : scripts (full admin)
```

The **service‑role key bypasses RLS** and is the trusted path. It lives only in: the Edge Function
environment (Supabase secret) and the operator's `.env` (for scripts). It is **never** in the browser
bundle or the repo.

---

## 2. Authentication & authorisation
- **Auth:** Supabase email/password → JWT. The function calls `getClaims(token)` itself (`verify_jwt=false`
  at the gateway), 401 on missing/invalid token.
- **Public signup is DISABLED** (`disable_signup=true`, set 2026-06-11). Accounts are admin-created only via
  `POST /users/create` (`auth.admin.createUser`); the app has no `signUp()` path. Password min length = 8.
  Leaked-password (HIBP) check and session idle/absolute timeouts are **Pro-plan features** — enable them
  (`password_hibp_enabled`, `sessions_inactivity_timeout=86400`, `sessions_timebox=604800`) if/when the
  project upgrades. MFA TOTP is enabled at the project level; enrol admin accounts.
- **AuthZ — three layers** ([USERS_ROLES_PERMISSIONS.md](USERS_ROLES_PERMISSIONS.md)): frontend gates (UX
  only), **Edge‑Function role checks (the real gate)**, Postgres RLS (backstop). Every privileged endpoint
  re‑checks `isAdminOrManager`/`isWarehouse` in code.
- **RLS** is enabled on every table. The recurring pattern uses `has_role()` / `is_admin_or_manager()`
  (SECURITY DEFINER, so no policy recursion). Permission config tables are locked to admin writes
  (`20260506180000_lock_down_permissions_tables.sql`).
- **Money = owners (Macedonia, 27–28.09.2026).** `public.is_business_owner()` gates every money figure,
  money tab, money route and money table (RLS): true for `public.business_owners` or any ACTIVE admin
  (`20260934000000`, `20260939000500`). Managers get operational payloads with money keys absent
  (`meta.money = false`, whitelist strip) or `403 owners_only` on owner-only surfaces. Owner-only
  `app_settings` keys (e.g. `no_parcel_rule`) are guarded by `trg_app_settings_guard_owner_keys`
  (`20260939000200`), so an admin/manager session cannot flip them through PostgREST. AlterCPA can never
  mark an order paid — MEX alone decides paid/returned (money guards, `20260934000200`). Details:
  [USERS_ROLES_PERMISSIONS.md §2a](USERS_ROLES_PERMISSIONS.md) and `.grok/skills/elyon-security/SKILL.md`.

## 3. Webhook integrity (inbound)
- **HMAC‑SHA256** over the raw body, header `x-webhook-signature`, **timing‑safe** compare. 401 on bad/missing.
- **Rate‑limited** 100/60 s per slug + per IP (in‑memory sliding window). Since 2026-06-11 the two PBX
  webhooks (`/webhook/missed-call`, `/webhook/missed-call-vm`) are also per‑IP limited.
- `WEBHOOK_SECRET` shared by landing pages + OpenCart + PBX; rotate via `supabase secrets set` and update
  senders in lockstep.
- **FAIL‑CLOSED (2026-06-11):** if `WEBHOOK_SECRET` is unset the function now **rejects** every webhook
  (was: accept unsigned with a warning). So a blank/misconfigured secret stops inbound leads rather than
  opening the pipeline — fix the secret to restore flow. Replay protection (signed timestamp/nonce) is a
  deliberate future item, not yet implemented.
- Details: [WEBSITES_WEBHOOKS.md](WEBSITES_WEBHOOKS.md).

## 4. CORS
- Strict allow‑list (`ALLOWED_ORIGINS`) + a Vercel‑preview regex; the `Access-Control-Allow-Origin` header
  is echoed only for matching origins. Server‑to‑server callers (no Origin) skip CORS and rely on HMAC.
- Adding a domain = edit the array **and redeploy**.

## 5. Input validation & error hygiene
- **zod schemas** validate every write body (`parseBody`). Max lengths cap payload sizes.
- **`sanitizeSearch`** strips PostgREST `.or()`/LIKE metacharacters from search input (defence‑in‑depth on
  top of the SDK's escaping) so a stray `%` can't match every row.
- **`sanitizeDbError`** maps PG error codes to generic messages and logs only the code — DB schema details
  (table/column/constraint names) never leak to clients.
- Queries use the supabase‑js builder (parameterised) — no string‑built SQL in the app path.

## 6. Audit trail (tamper‑evident)
- `audit_log` records sensitive admin actions (user create, bulk assign/unassign, bulk status update,
  segment assign/auto‑assign/unassign/edit) with actor id/email, action, target, and JSON payload.
- **`assigner.unassign_all`** is the one to check after a mass detach: its payload carries `agent_id`,
  `list_ids`, `include_done`, the total freed, and the **pre‑wipe per‑agent breakdown** (snapshotted from
  `assignment_matrix()` *before* the UPDATE). Since a full detach clears the denormalised
  `assigned_agent_name` stamp from member rows, that audit row — together with `call_logs` — is the
  record of who had been working which list.
- **Append‑only by trigger:** `audit_log_block_update` / `_block_delete` raise on any mutation — even the
  service role cannot edit or delete rows. `order_history` is the equivalent immutable trail for orders.

## 7. Rate limiting & abuse
- Webhooks: 100/60 s per slug+IP (now incl. both PBX missed-call webhooks).
- Sensitive authed endpoints: per‑user limiter (`checkUserRateLimit`) — create/delete user (10/min), bulk
  ops (20/min), bigarena-sync (8/min), and (2026-06-11) `search-prediction` (60/min) + `segments/recompute`
  (6/min).
- Login brute‑force/spam: public signup disabled + Supabase Auth's built‑in per‑IP limits on the token
  endpoint. CAPTCHA deliberately not used (operator decision — agent‑login friction).
- `blocked_login_attempts` ledgers failed logins.
- Note: limiters are **in‑memory per warm instance** — they reset on cold start and don't coordinate across
  instances. Fine for the current threat model (runaway scripts, casual abuse), not a DDoS control. A truly
  global cap would need a shared store (Postgres/Upstash).

## 8. Secrets handling
- App build‑time vars (`VITE_*`, anon key) are **public by design** (shipped to the browser).
- **Server‑only secrets** (service‑role key, `WEBHOOK_SECRET`, `SUPABASE_ACCESS_TOKEN`, DB password,
  A1 SIP creds) live in: Supabase Edge‑Function secrets, the operator's gitignored `.env`/`.secrets/`, and
  [VAULT.md](VAULT.md) (gitignored). `.gitignore` already excludes `.env*`, `.secrets/`, and the vault.
- PBX/SSH: key‑only SSH (`C:\Users\Mile\.ssh\elyon_vps`), fail2ban, firewalld — see [../PBX-SETUP.md](../PBX-SETUP.md).

## 9. Transport & hosting
- TLS everywhere: Vercel (app), Let's Encrypt (PBX, incl. the WSS endpoint). HSTS on the PBX vhost.
- Supabase project is single‑tenant to this business; RLS keeps agents scoped to their own rows even if a
  token leaks.

---

## 10. Known gaps (prioritised — full list in the Audit)

| Severity | Gap | Note |
|---|---|---|
| ~~Medium~~ ✅ | ~~`WEBHOOK_SECRET` fail‑open~~ | **Fixed 2026-06-11 — now fails closed.** |
| ~~Medium~~ | ~~Public signup open~~ | **Fixed 2026-06-11 — `disable_signup=true`.** |
| Medium | **In‑memory rate limits** don't survive cold starts / scale | Move to a DB/Redis counter if abuse appears. |
| Medium | **Webhook replay** (no timestamp/nonce in HMAC) | Captured signed `/leads` or `/:slug` call can be replayed → dup leads. Add a signed timestamp (deferred per operator). |
| Low | **HIBP + session timeouts** are Pro‑plan only | Enable on upgrade (`password_hibp_enabled`, `sessions_*`). |
| Low | Founding accounts seeded with weak bootstrap password (`12345678`) | **Rotate now** (min length is 8); enrol admin MFA. |
| Low | **CI doesn't run lint**; lint errors (mostly `any`) | Not a vuln, but `any` hides type bugs. |
| Info | VOIP SIP secret reaches the browser (required for WebRTC) | Contained: per‑extension secret, fail2ban, the trunk's concurrent‑channel cap. Rotate periodically. |

The historical RESUME.md "to‑harden" list is now **largely done**: HMAC on webhooks ✅, CORS locked ✅,
route code‑splitting ✅, React Query defaults ✅. Re‑verify the `notifications` INSERT policy and the
config‑table read locks during the next security pass.

---

## 11. Incident quick‑actions
- **Suspected secret leak:** rotate the service‑role key + anon key (Supabase dashboard), `WEBHOOK_SECRET`
  (`supabase secrets set` + update senders), and the `SUPABASE_ACCESS_TOKEN`; redeploy the function; update
  [VAULT.md](VAULT.md). Re‑issue the PBX SSH key if that's involved.
- **Webhook abuse:** disable the offending webhook (`status=disabled`) or rotate the secret.
- **Bad actor account:** `POST /users/:id/toggle-active` to disable login immediately.
