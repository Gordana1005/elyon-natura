# Elyon CRM — Grok Skills System

This directory contains **project-specific skills** for Grok (and compatible agents).

These skills encode the hard-won operational wisdom of running this **Macedonian** call-centre CRM (a hard fork of the
Bulgarian system). Where an inherited skill still teaches a Bulgarian rule, CLAUDE.md's per-market overrides win. They are the single best way to stop repeating the same complex explanations every session.

## How Skills Work Here

- Skills live in this folder (repo-scoped, version controlled).
- Each skill is a directory with a `SKILL.md` file.
- Grok automatically discovers them with high priority when working inside this repository.
- Use `/skills` in the TUI to list or inject a specific skill.
- Good skills are **automatically invoked** when your prompt matches their `description`.

## Current Skills (as of 28.09.2026)

| Skill | When to Use | Sacred Area |
|-------|-------------|-------------|
| `elyon-currency` | Any price, money, totals, stock value, revenue, MEX COD | Stored EUR, shown денари via the FROZEN 61.5 peg (`formatMoney`); amounts already in денари use `formatDenari`; affiliate payout stays EUR |
| `elyon-phone-normalization` | Any phone search, lookup, import, or matching | Last-8-digits rule + E.164 (+389) |
| `elyon-fulfilment-csv` | The /orders "MEX Import CSV" (MEX Poshta portal template) | The 8-column MEX contract in `src/lib/mexImportCsv.ts` (Latin, integer денари, no quoted fields) |
| `elyon-warehouse-incoming` | Warehouse tabs, bulk actions, ship_after_date logic | The daily operational heartbeat |
| `elyon-webhook-and-lead-ingestion` | New websites, landing pages, debugging missing leads | HMAC + per-product webhooks |
| `elyon-stock-and-bigarena` | Stock movements, BigArena imports, reconciliation | Historical operator decisions on SKUs/barcodes |
| `elyon-voip-and-pbx` | Telephony, SIP trunk, Asterisk, FreePBX, softphone swap, recordings, **A1 trunk connection** | Bulgarian infrastructure — MK telephony is deferred (Phase 2) |
| `elyon-segments-and-prediction` | Prediction lists, segments, recompute, bulk assign, Assigner | The intelligent lead distribution engine |
| `elyon-security` | Authentication, RLS, webhook HMAC, permissions, audit, CORS, secrets | Protecting data and operational integrity |
| `elyon-assigner` | Assigner page, bulk assignment, the Unassign tab / full detach, unassign rules, workload management | Lead distribution and agent workload fairness |
| `elyon-agent-commissions` | Agent bonus/commission/payout math, attribution, who gets credited | Per-package pay; one first-confirming agent; super-admins earn nothing |
| `elyon-logistics-costs` | Shipping/return/courier cost, Pure Profit actuals, courier rate card | Per-courier+service rates; full round-trip return loss; cash-basis profit |
| `elyon-altercpa-bridge` | `altercpa_*` tables, the `altercpa-sync` function (rolling / status / nightly / weekly sweeps), multi-country intake, the push to AlterCPA, the 7-day no-parcel rule and its reopen | Ledger-first; foreign leads never reach `orders`; AlterCPA decides only confirmed-or-dead, MEX decides money |
| `elyon-affiliates` | `/cpa/*` endpoints, affiliate tables, webmaster API keys, offers/payouts, lead stages, postback queue, affiliate portal/admin pages | External CPA identities + payout math; partners must never see internal data |
| `elyon-i18n` | Any user-facing text: labels, toasts, placeholders, table headers, page titles, statuses; also dates/exports that only look like display text | Quadrilingual EN/BG/SQ/MK parity — never hardcode a string |
| `elyon-notifications` | The bell dropdown, any DB trigger or pg_cron job writing to `notifications`, notification text, unpaid-delivery chase alerts | English-in-DB + `meta.i18n` translation contract; owner = confirmer; REVOKE FROM PUBLIC on every new table/RPC |
| `elyon-presence-and-leaderboard` | Presence / time on the CRM, 30-min idle alerts, the TV leaderboard, sales people / identities / teams, `orders.sold_*`, Settings → Teams | Source wins, the team is a badge; managers are shown and never earn; only the deciding agent is credited; `sold_*` is write-once |
| `elyon-web-shop-bridge` | The naturatherapy.mk mirror: `web_orders`, the `web-sync` function + crons, the shop's `crm_export`, web ↔ MEX parcel links, web money | The live shop gets NO changes; web orders are a read-only mirror, never CRM orders |
| `elyon-customer360-and-integrations` | Customer 360 timeline, Settings → Integrations health, feed freshness, the 7-day no-parcel rule's Report ↔ Apply switch | Owner-only money keys absent for everyone else; freshness thresholds in step with `insights_overview` |

## Best Practice for Future Work

**At the beginning of any significant task, especially if it touches one of the areas above:**

1. Run `/skills` to see what is available.
2. If a relevant skill exists, inject it (e.g. `/skills elyon-voip-and-pbx`).
3. Follow the skill's instructions strictly.

The goal of this system is to make future work dramatically faster, safer, and more consistent — especially on the complex, high-stakes parts of the CRM.

## Adding New Skills

When you find yourself explaining the same domain rule or workflow multiple times, capture it as a new skill using `/skillify` (or `/create-skill`).

Prefer project scope (`<repo_root>/.grok/skills/`) so the whole team benefits.

## Memory Connection

Many of these skills are also excellent candidates for long-term memory entries (via `/flush` and `/dream`).

Together, skills + memory + this `Claude.md` form the "Elyon Agent Operating System".

---

**This setup was created in May 2026, extended in July 2026 (affiliates, i18n, notifications) and on 28.09.2026 (presence + leaderboard, the web-shop bridge, Customer 360 + integrations; the security, notifications and currency skills brought up to the code), to make the partnership between the human operator and Grok as powerful and low-friction as possible for the long term.**