---
name: elyon-i18n
description: Use whenever adding, changing, or translating ANY user-facing text in Elyon CRM (labels, toasts, placeholders, table headers, page titles, statuses). The app is quadrilingual (English + Bulgarian + Albanian + Macedonian) with a per-user switcher in the top bar. New UI strings must NEVER be hardcoded — they go through i18next keys in src/i18n/locales/. Includes the owner's binding Macedonian terminology (01.10.2026): prediction = "предикција" (never "прогноза"), a leads team / queue = "лидови" (never "на чекање"), "На чекање" only for the order status pending, and the team + lane labels. Also read before touching dates, exports, or anything that LOOKS like display text but is actually data.
---

# Elyon i18n Skill — Quadrilingual UI Rules (EN + BG + SQ + MK)

Since 2026-06-12 the CRM is internationalized with **i18next + react-i18next**.
Every user-facing string lives in `src/i18n/locales/en.json` + `bg.json` + `sq.json`
+ `mk.json` (single namespace, dot-path keys, identical key trees — enforced by
`src/i18n/__tests__/parity.test.ts` in `npm test`). **2,744 keys** as of 2026-07-22.

**Adding a 5th language is now a one-line change in three places**: the
`LOCALES` map in `parity.test.ts`, the `TRANSLATED` map in `keys-used.test.ts`,
and `SUPPORTED_LANGUAGES` in `src/i18n/index.ts`. Nothing else iterates a
hardcoded language list — the switcher, Settings → Лично (`/settings/personal`,
was Settings → Appearance until 01.10) and the Call Scripts editor tabs all read
`SUPPORTED_LANGUAGES`. Keep it that way.

**Albanian (`sq`, Macedonia standard)** was added 2026-06-22 and is **LIVE**.
**Macedonian (`mk`, literary Skopje standard)** was added 2026-07-22 and is
**LIVE**. Both are in `SUPPORTED_LANGUAGES`, so the top-bar switcher and
Settings → Appearance show them. Professional wording review happens in-app
(operator workflow); keys stay stable, only values change.

Cross-device persistence needs the `profiles.language` CHECK constraint to allow
the code — migration `20260906000000_profiles_language_mk.sql` sets the full set
`('en','bg','sq','mk')` idempotently (it also repairs a DB where the earlier
`..._sq.sql` was never applied). Until applied, the write fails silently and the
choice sticks per-device via localStorage.

> **Trap, cost us Albanian silently for a month:** `AuthContext.fetchProfile`
> used to read `language: profile?.language === 'bg' ? 'bg' : 'en'`, a hardcoded
> two-language list. Any user whose stored preference was `sq` got coerced back
> to English on every fresh device, so the DB column looked broken when it
> wasn't. It now validates against `SUPPORTED_LANGUAGES`. **Never hardcode a
> language list anywhere outside `src/i18n/index.ts`.**

The top-bar switcher (`LanguageSwitcher.tsx`) is a **dropdown**: the trigger shows
only the active flag + chevron, and clicking lists all languages (flag + native
name, active one checked). Adding a language needs no switcher change beyond one
inline flag SVG in `FLAGS` — use **inline SVG, never an emoji flag**: Windows
renders 🇬🇧/🇧🇬 as plain letters and most agents are on Windows.

The **public TV board** (`/tv/leaderboard?key=…`) has no logged-in user to read a
preference from, so it takes an optional **`?lang=` query param** (validated
against `SUPPORTED_LANGUAGES`) and otherwise falls back to the localStorage
default. Office TV URL therefore looks like `/tv/leaderboard?key=…&lang=mk`.

## The Rules

1. **Never hardcode user-facing text** in JSX, toasts, placeholders, or labels.
   Add a key to ALL FOUR locale files (`en.json`, `bg.json`, `sq.json`,
   `mk.json`) in the same commit, then render with `t('domain.key')`. The parity
   test fails if any locale is missing the key.
2. **Key convention**: `domain.subarea.key`. Enum lookups use the raw enum
   value as the leaf key: `t('status.' + status)`. Domains: `common`, `nav`,
   `titles`, `status`, `leadStatus`, `cancelReason`, `roles`, `delivery`,
   `apiErrors`, plus one per page/modal (`orders`, `orderModal`, …).
3. **Components must subscribe**: any component rendering translated text calls
   `useTranslation()` — even when the text comes via a helper function
   (`statusLabel`, `cancelReasonLabel`, `friendlyRoleLabel`,
   `getCancelReasonOptions`). Outside React (module-level, plain functions):
   `i18n.t(...)` from `@/i18n`.
4. **NEVER remount on switch**: `key={language}` is forbidden — it would wipe
   an agent's half-filled order form mid-call.
5. **Plurals & interpolation**: `t('x.assigned', { count })` with
   `assigned_one` / `assigned_other` keys. No more ad-hoc `order${n !== 1 ? 's' : ''}`.
6. **Backend errors**: wrap with `apiErrorText(err)` from `src/i18n/apiErrors.ts`
   instead of showing `err.message` raw. Unknown messages fall through in English
   (deliberate). New common backend strings → add to the EXACT/PATTERNS maps.
7. **Dates**: user-visible word-bearing formats (`'MMM d'`, `'PPP'`,
   `formatDistanceToNow`) use `formatDate`/`formatDistanceToNow` from
   `src/i18n/dates.ts` (Bulgarian month names in BG, Albanian in SQ — both via
   `date-fns/locale`). Machine formats (`'yyyy-MM-dd'` payloads, fulfilment CSV
   timestamp) keep RAW `date-fns`.

## Macedonian (`mk`) — the close-language trap

Macedonian and Bulgarian are close enough that a careless translation reads to a
Skopje agent as *"Bulgarian with typos"*. `scripts/data/mk-glossary.md` is the
**binding term list** (Нарачка not Поръчка, Зачувај not Запази, Испорака not
Доставка, Магацин not Склад, Залиха not Наличност…). Read it before touching
`mk.json`; translate from the **English** source with Bulgarian as context only,
never by editing the Bulgarian.

Orthography is a hard, machine-checkable rule: **Macedonian has no `ъ`, `щ`,
`я`, `ю`, `ь`** (Bulgarian `щ` → Macedonian `шт`). `parity.test.ts` fails the
build if any of those letters appear in `mk.json`. Also mind `Недела` = *Sunday*
in Macedonian; *week* is `Седмица`.

### The owner's terminology (30.09 / 01.10.2026) — binding for every mk string

The owner's own vocabulary; "Прогнози" and a team called "На чекање" read wrong
to him and his staff (the Assigner board's badges prompted it).

- **Prediction = "предикција" / "предикциски"** — NEVER "прогноза", "прогнози",
  "прогнозни". "Предикциски листи" (was Прогнозни списоци), "Мотор за
  предикција", "Агент за предикција" (was Прогнозен агент).
- **The team or queue that works pending leads = "лидови"** — never "на чекање",
  never "пендинг / пендинзи". "Лидови" (was Пендинзи — the Assigner tab, the
  /calls queue entry), "Агент за лидови" (was Агент на чекање).
- **"На чекање" ONLY for the ORDER STATUS `pending`** (`status.pending` and its
  finance / warehouse uses). A web order the shop has not confirmed = "Чека
  потврда".
- **Team + lane labels** (`teamLines.label.*`, `src/lib/teamLines.ts`): Телешоп
  лидови · Телешоп предикција · Социјални мрежи · Affiliate лидови · Affiliate
  предикција · Менаџмент (`tvBoard.team.management`). Lanes: `teamLines.lane.in`
  / `.out` / `.social`.
- en / sq / bg keep their own words ("Pending", "Prediction" are fine in English).
- The sweep of 01.10 (`42318d3`, `82755b4`) was path-exact over 99 + the Calls
  values of `mk.json`. Re-check after any mk change:
  `grep -c рогноз src/i18n/locales/mk.json` → **0**, and no "на чекање" outside
  the order status.
- Keys stay stable — only values changed. Stored DATA (list names, product
  names) is never renamed for wording: a prediction list is translated for
  display only (`listLabel()`), because the engine resolves lists by exact name.

### Foreign literals — text that is DATA, not language

This bit off three real bugs during the MK rollout and the orthography test
carries an explicit allowlist for it. **If the ENGLISH value itself contains
Cyrillic, that text is external data and must be copied byte-identical:**

- `bigArenaStock.errUnrecognized` names the `Наименование / Информация /
  Количество` **columns of the BigArena export file**. MK "helpfully" wrote
  `Информација` — which would send an agent hunting for a column that does not
  exist in the file in front of them.
- `delivery.typeCityPlaceholder` shows `София` because the **address database
  holds Bulgarian city names**; the Macedonianised `Софија` matches nothing when
  typed.
- `languages.*` names every language **in its own language** (`English`,
  `Български`, `Shqip`, `Македонски`) in all four files. Do not "translate" them.

Quick audit for this whole class:
```
node -e "const en=require('./src/i18n/locales/en.json');/* any Cyrillic in an EN value = a literal token */"
```

## What is NEVER translated

- **Fulfilment CSV** (warehouse contract — see elyon-fulfilment-csv)
- **Currency** (`src/lib/currency.ts`): €/лв symbols, en-US number style, the
  1.95583 peg — identical in both languages (see elyon-currency)
- **Enum VALUES** in DB/payloads/URLs (`pending`, `not_satisfied`, …) — labels only
- Export FILE column headers (Pure Profit Excel/CSV stay English; dialogs translate)
- Brand/courier names (Speedy, Econt, BigArena, naturatherapy.bg, Elyon CRM)
- DB-stored data (product names, customer data, notes, segment names)

## Call scripts ARE translated — but in the DB, NOT in the locale JSON

Since 2026-06-23 the per-product **Call Scripts & Helpers** (talk tracks agents read
on calls) are locale-aware. They are long, operator-edited DB content, so they do NOT
live in `en/bg/sq.json`. Instead `call_scripts` has a `translations` JSONB column:
`{ "en": { title?, description?, script_text?, helpers? }, "sq": {...} }`. The base
columns (`title/description/script_text/helpers`) are the **Bulgarian source + per-field
fallback**. Resolve with `resolveScript(script, lang)` from `src/lib/callScripts.ts`
(never read the raw columns directly in the agent UI). Operators edit each language via
the `BG | EN | SQ` switch in Call Support Center; the AI drafts were seeded by
`scripts/translate-call-scripts.mjs` from `scripts/data/call-script-translations.json`.
Product TITLES stay as the brand name (fall back to base). So: still NO call-script
*content* in the locale JSON — only the editor's chrome keys (`callScripts.*`) go there.

## Language preference plumbing

- `localStorage('elyon.lang')` → instant load before auth (read in `src/i18n/index.ts`,
  side-effect imported FIRST in `src/main.tsx`)
- `profiles.language` column (migration `20260612100000_profiles_language.sql`) →
  cross-device; loaded in `AuthContext.fetchProfile` (with fallback if the column
  doesn't exist yet), synced by `src/contexts/LanguageContext.tsx`
- Switcher: `src/components/LanguageSwitcher.tsx` in the top bar (AppLayout) +
  a card in Settings → Appearance. Default for new users: **English** (operator decision)

## Rollout state

**ALL PHASES COMPLETE (2026-06-13).** The entire UI is bilingual:

- ✅ Phase 0+1 (2026-06-12): foundation, switcher, statuses, cancellation
  reasons, roles, sidebar nav, page titles, DeliveryMethodPicker, BreakButton
- ✅ Phase 2: agent calling surfaces (CallsPage, OrderModal, MissedCalls,
  components/calls/*, VoipContext toasts)
- ✅ Phase 3: Orders body, CreateOrderModal, GlobalSearch, NotificationsDropdown, BigArenaStatusSync
- ✅ Phase 4: Dashboard + ALL admin pages (Assigner, Warehouse, Settings all tabs,
  Insights + AgentsTab/Timeline, Webhooks/Ads, Shifts, Users, Products, Segments,
  Prediction*, CallHistory, CallScripts, LeadDistribution, Inbound, Login, NotFound)
- ✅ Phase 5: apiErrors.ts EXACT map (~55 backend strings) + interpolated PATTERNS
  (insufficient stock, personal-list claims, rate limits); all `err.message` toasts
  swept to `apiErrorText`; full i18n-scan clean

**Albanian (SQ) added 2026-06-22 — LIVE:** full `sq.json` (Macedonia standard, all
keys), date-fns `sq` locale wired, Albanian flag + dropdown switcher, `'sq'` in
`SUPPORTED_LANGUAGES`. Professional wording review still pending in-app (see intro).
Same change also swept the last hardcoded stragglers (AgentTimeline legend/tooltip,
CrossListBasketBar) into keys.

**Macedonian (MK) added 2026-07-22 — LIVE:** full `mk.json` (2,744 keys),
date-fns `mk` locale, Macedonian sun flag, `'mk'` in `SUPPORTED_LANGUAGES`,
migration `20260906000000_profiles_language_mk.sql`, glossary at
`scripts/data/mk-glossary.md`, per-product call scripts drafted into
`call_scripts.translations.mk`. The same pass also closed **drift that had made
three screens English in EVERY language** — they were built after the June sweep
and nobody re-ran the scan: `insights/PayoutTab.tsx`,
`settings/LeaderboardTab.tsx` and `pages/TvLeaderboardPage.tsx` (which had no
`useTranslation` at all). 79 keys added across `settings.lb*`, `payout.*`,
`tvBoard.*`. **Lesson: run `node scripts/i18n-scan.mjs` when you SHIP a new
screen, not only when you add a language.**

Deliberately NOT translated: RecordingsPage + Index.tsx (unrouted/dead),
SettingsPage DEV-only test-notification panel, `INV-001`-style format examples,
export FILE content (CSV/XLSX headers + AgentsTab CSV row).

## Tools

- `npm test` — locale parity + enum coverage (CI guard)
- `node scripts/i18n-scan.mjs [path]` — heuristic scan for missed hardcoded
  strings; run on each file/dir after translating it
- **After any codemod/hook work**: `npx tsc -p tsconfig.app.json --noEmit | grep "Cannot find name 't'"`
  — catches components calling t() without `useTranslation()` in scope. Vite build
  will NOT catch this (esbuild doesn't typecheck) and bare `npx tsc --noEmit`
  checks NOTHING (root tsconfig is solution-style). Burned us 2026-06-13: four
  components shipped with undefined `t` and crashed their pages. Also beware `t`
  SHADOWING in custom toast renderers (NotificationsDropdown: `t` = toast
  instance — use `i18n.t` there).
- Dev mode renders missing keys as `⟪key⟫` and warns in console — misses are loud

Bulgarian terminology is call-centre Bulgarian, terse (operator preference).
The operator reviews `bg.json` in-app; adjust wording when he objects, but keep
keys stable.

Macedonian (`mk.json`) is literary Skopje standard in the same terse register,
produced 2026-07-22 as a glossary-bound draft plus an independent
anti-Bulgarianism review pass, and is **pending operator review** — adjust
wording on feedback, keep keys stable, and keep it inside the glossary.

Albanian (`sq.json`) is Macedonia-standard, same terse register. It was produced as
a Claude first-draft (2026-06-22) and is **pending professional review** — adjust
wording on feedback, keep keys stable. Don't translate inside `{{…}}`, brand /
courier names (Speedy, Econt, BigArena, Pure Profit, Elyon CRM), enum values, or
the literal `Статус` / `[Customer Name]`-style tokens that map to external data.
