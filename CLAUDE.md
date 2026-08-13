# Elyon CRM — MACEDONIA edition (Natura Therapy MK)

This repository is the **Macedonian** instance of the Elyon CRM — a hard fork of the Bulgarian
system, run as a completely separate operation. It has its OWN infrastructure and shares
**nothing at runtime** with Bulgaria.

> **Naming note:** the deployment was stood up for Macedonia on 2026-06-30 and re-aimed at
> **Macedonia** on 2026-07-31. The Vercel project was renamed `elyon-macedonia` → `elyon-natura`
> on 2026-08-01, so the live URL is **https://elyon-natura.vercel.app**
> (`elyon-macedonia.vercel.app` still resolves to the same deployment and is kept as a legacy
> alias — both are in the edge function's CORS allowlist).
> The GitHub repo **was** renamed too and is now **`Gordana1005/elyon-natura`**
> (verified against `git remote -v`, 2026-08-13 — the old `elyon-macedonia` URL 404s, so a push
> to it fails with "Repository not found"). Only the **Supabase ref** (`bmfxhgznttcnnlqloqzp`)
> keeps its original name, on purpose: renaming the ref means rebuilding the project. Wherever
> you see "macedonia" in that one identifier, read it as "this project".
> **The market is Macedonia.**

## 🛑 GOLDEN RULE — never touch the Bulgarian system
This is the #1 rule. A mistake here already caused a live Bulgarian outage once (2026-06-30).
**Bulgaria is OFF LIMITS.** Never run any command against, deploy to, or edit:
- Supabase project `sxymaloycddnoxudxaqp`
- Domains `elyoncall.com` / `www.elyoncall.com`
- The Bulgarian repo folder `C:\Users\Mile\Desktop\elyoncrm`
- The Bulgarian Vercel project `elyoncrm` (`prj_965V2iBg793RmiJJw9m6Tl3djllX`)

Everything here targets **Macedonia only** (see Infra below). If you ever see
`sxymaloycddnoxudxaqp` or `elyoncall.com` in a command you're about to run → **STOP.**
That is the live BG system.

**The token in `.env` can write to BOTH projects.** Nothing but the command line protects
Bulgaria. Before ANY state-changing command (db push, functions deploy, secrets set, vercel
deploy), run the tripwire:

```
node scripts/assert-mk-target.mjs
```

It checks `supabase/config.toml`, `.env`, `.vercel/project.json` and the remote row counts, and
exits non-zero if anything points at Bulgaria.

## ⚠️ CLI safety (this is how the BG incident happened — read it)
The shell's working directory **silently resets between tool calls**. NEVER rely on the current
directory to choose which project a command acts on. For ANY state-changing command, pass the
target **explicitly** and verify it before running:
- **Vercel:** `vercel <cmd> --cwd "D:\Dev\archives\elyon-macedonia" --scope gordanas-projects-a53c0208`
- **Supabase:** confirm `supabase/config.toml` `project_id = "bmfxhgznttcnnlqloqzp"` before any link/push/deploy
- **Git:** `git -C "D:\Dev\archives\elyon-macedonia" …`
- Read the tool's echoed target (e.g. "to Project X"); if it's ever `elyoncrm`/BG → abort immediately.
- **Never pass a `--project-ref` copied out of `docs/`** — those pages were inherited from Bulgaria.
- **Vercel env vars:** prefer the Vercel REST API (JSON body) over `vercel env add` stdin — PowerShell
  piping injects a UTF-8 BOM ("non ISO-8859-1 code point" login error) and bash `printf` w/o newline
  sets empty. Always verify with `vercel env pull`.

## Infra (Macedonia only)
- **Supabase:** ref `bmfxhgznttcnnlqloqzp` → https://bmfxhgznttcnnlqloqzp.supabase.co
- **Vercel:** project `elyon-natura`, scope `gordanas-projects-a53c0208` → https://elyon-natura.vercel.app (GitHub-connected → auto-deploys on push to `main`)
- **GitHub:** `Gordana1005/elyon-natura` (renamed from `elyon-macedonia`; the old name 404s)
- **Secrets:** `docs/VAULT.md` (gitignored) — keys, webhook secret, admin logins
- **Status / done / TODO:** `MACEDONIA-STATUS.md` (repo root)
- **Migrations:** the DB password was never recorded, so `supabase db push` cannot open a direct
  Postgres connection. Use `node scripts/apply-migration-mk.mjs <file.sql>` (Management API, same
  `postgres` role). Record the DB password in VAULT §1 to restore the normal `db push` path.

## Per-market rules (Macedonia ≠ Bulgaria) — these OVERRIDE the copied BG docs/skills
`.grok/skills/` and `docs/` were copied from Bulgaria and still describe BG specifics in places.
**Where they conflict with the list below, THIS LIST WINS** (and update the skill/doc):
- **Currency: MKD in the UI.** Prices are STORED in EUR; the denar is derived at display
  time from a **frozen** `MKD_PER_EUR` constant. The denar is a managed NBRM peg, not a legally
  fixed rate like the lev — **never "update" the constant**, because that silently re-prices every
  historical order, closed payout and already-collected COD. If the market moves, re-price the
  catalogue in EUR instead. No lev, no 1.95583, no dual display.
  **One documented exception (operator, 2026-08-10): affiliate/CPA payout renders in EUR**
  (`formatEurExact`) on both the partner portal and `/affiliates-admin` — `payout_eur_snapshot`
  is a euro debt to a foreign webmaster who invoices in euro, not a Macedonian retail price.
  The staff "Avg order value (confirmed)" tile stays денари. Do not "fix" this back — see
  `.grok/skills/elyon-currency` and `elyon-affiliates`.
- **Timezone:** `Europe/Skopje` (CET/CEST) — not Europe/Sofia (EET, one hour ahead).
- **Phone:** country code **+389** — not +359. Last-8 matching is unchanged.
- **Language:** default UI is Macedonian (`mk`); en/sq/bg also shipped.
- **VAT:** 18% standard. ⚠️ Confirm with the accountant whether supplements fall under the
  preferential 5%/10% band — `VAT_RATE` feeds every profit report.
- **Login email domain:** `elyon-mk.local` (placeholder — see TODO).
- **Couriers/cities:** still BG (Speedy/Econt + `bg_settlements`) — **TODO:** replace with
  Macedonian carriers. ⚠️ **The fulfilment CSV must not be used for real shipments until a
  Macedonian carrier confirms the column contract** (it is BigArena's Bulgarian 3PL format).
- **Telephony:** deferred (Phase 2). `VITE_USE_REAL_VOIP=false`; PBX/DID values are BG placeholders.
  The VOIP minutes bundle is seeded at 0 — there is no MK carrier contract.
- **Trash is STICKY here (engine v3.7-mk, 2026-08-06)** and differs from Bulgaria in two ways on
  purpose: (1) a **paid order after the trash releases** the customer — BG deletes them forever,
  we keep them, because 2.391 Macedonian customers had already paid us *after* being trashed;
  (2) **`duplicate_order` is housekeeping**, so it never removes anyone from a calling band and
  never enters the Trash List. Do not "align with BG" on either.
- Search the code for `TODO(mk)` to find every unfinished real-value spot.

## Grok Skills System

**This project has a first-class skills system** located in `.grok/skills/`. Check `/skills`
before non-trivial work on money, phones, warehouse, stock, webhooks, or fulfilment.
**But apply the Macedonian per-market overrides above** — several skills still teach BG rules
(lev peg, +359, Sofia). When a skill conflicts with the overrides, the overrides win; fix the skill.

- `elyon-currency` — ⚠️ inherited BG/Macedonia rules. The currency override above wins.
- `elyon-phone-normalization` — Last-8-digits search + E.164 storage + pollution protection.
- `elyon-fulfilment-csv` — ⚠️ describes a Bulgarian warehouse serving a Skopje call centre; for MK that relationship inverts. Rewrite before relying on it.
- `elyon-warehouse-incoming` — The full daily warehouse workflow and stock safety.
- `elyon-webhook-and-lead-ingestion` — Inbound pipeline, HMAC, per-product slugs.
- `elyon-stock-and-bigarena` — Stock movements, import rules, and historical operator decisions.
- `elyon-agent-commissions` — Per-package agent bonuses on every PAID order (only gate is paid; source irrelevant), tiered 1/2/3€ by unit price, no minimum, credited to the confirmer. Read before touching any payout/commission math.
- `elyon-notifications` — The bell, the 6 notification types, the English-in-DB + `meta.i18n` translation contract, owner = confirmer, and the unpaid-delivery chase job.
- `elyon-segments-and-prediction` — The name-construction engine (**v3.7-mk, sticky trash**), the exclusivity rule, holding pens (Current Cancels 14d, NEWCOMERS 21d, Trash List), carry-over, and the nightly recompute. Law for anything touching prediction lists.
- `elyon-assigner` — Distribution + the Unassign tab, agent workload truth, and the live agent status tile.
- `elyon-voip-and-pbx` — The A1 trunk, Asterisk/FreePBX, the WebRTC softphone and recordings. BG-specific; MK telephony is deferred.
- `elyon-i18n` — EN/BG/SQ/MK: every user-visible string goes through i18n in all four locales, no exceptions.
- `elyon-security` — RLS, HMAC, permissions, audit and secrets. Never write an `authenticated`-wide read policy.
- `elyon-affiliates` — The CPA/partner system and the hard wall that keeps external logins out of staff surfaces.
- `elyon-altercpa-bridge` — The AlterCPA lead mirror: ledger-first, callable geos, offer mapping, and why foreign leads must never reach `orders`. Read before touching `altercpa_*` or multi-country intake.
- `elyon-logistics-costs` — Courier rate card, return round-trip loss, and Pure Profit actuals.

New skills should be added to `.grok/skills/` whenever you find yourself re-explaining the same
complicated rule or workflow. Use `/skillify` right after completing a complex piece of work;
prefer **project scope** so the skill is committed to the repo.

## Engine regression check
The segment engine resolves its target list by **exact name match**, and it deletes existing
memberships *before* resolving. A drifted list name therefore wipes members silently, with no
error. After any migration bundle, run:

```
node scripts/engine-fixture-mk.mjs
```

## Memory
This Macedonian workspace has its OWN memory store, separate from Bulgaria. `MEMORY.md` is loaded
each session. Keep only Macedonian facts there; never write BG facts into this project's memory,
and never let a recalled BG fact send you to touch the BG system.

---

*Fork stood up 2026-06-30 from `deploy-kit/`; re-aimed from Macedonia to Macedonia and brought to
Bulgarian code parity on 2026-07-31 (28 migrations + ~33 new files). This file is the Macedonian
constitution (Claude.md + Skills + Memory = the Elyon Agent OS, Macedonian instance).*
