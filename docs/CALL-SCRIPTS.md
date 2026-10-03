# Targeted call scripts: contract (owner, 02.10.2026)

The owner wants:
- scripts for **leads** and for **prediction**, written on `/call-scripts`;
- each script shown on `/calls` according to what the agent is working and who the client is.

The approved plan is `~/.claude/plans/revert-the-421-unproven-encapsulated-brook.md`. This file is the shared contract for the three workstreams (A, B, C). Change it first, then the code.

## Owner decisions
- **One script per LIST GROUP (recency band).** There is no split by value (≤26/26+), by order count, or by individual list.
- A script may **also** be attached to one or more **products**. The owner and the managers will write scripts for every product × group, starting from nothing.
- **Sections:** Отворање · Презентација · Приговори · Затворање, plus quick answers (`helpers`).
- **Who may do what:**
  - write and publish: admins + managers;
  - delete: admins only;
  - every change is versioned and can be restored.
- **Not live yet.** The switch `app_settings.call_scripts.mode` starts at `off`. While it is off, `/calls` shows today's panel unchanged.

## Groups
```
LEAD_GROUPS       = ['lead_new','lead_callback']        // order status pending|take → lead_new ; call_again → lead_callback
PREDICTION_GROUPS = ['newcomers','d21','d57','m4_6','m6_12','y1_2','y2plus','cancels','never_converted','trash']
ALL_GROUPS        = [...LEAD_GROUPS, ...PREDICTION_GROUPS]
```

`groupOfListName(name)` is pure and never renames a list. The prediction engine resolves lists by exact name.
- Exact pen names come first:
  - `Current Cancels` and `Cancelled Pendings` → `cancels`
  - `Never-Converted Recent` and `Never-Converted Old` → `never_converted`
  - `Trash List` → `trash`
  - `Current Returns`, `Due to Reorder` and `FULL MONAD LIST` → `null`
- Otherwise the first token decides: `NEWCOMERS|21d|57d|4-6m|6-12m|1-2yr|2yr+` → `newcomers|d21|d57|m4_6|m6_12|y1_2|y2plus`. These are the same ids as `RECENCY_ID` in `src/components/insights/lists/listModel.ts`, so the labels reuse `insights.lists.name.recency.*`.
- Anything else (uploaded campaign lists, unknown names) → `null`. A `null` group can only receive scripts whose `groups = {}` (all groups).
- The test fixture is all 59 live names: `src/components/insights/lists/__fixtures__/lists.sample.json`.

## Database: `supabase/migrations/20260947000100_call_scripts_targeting.sql` (workstream A)
Header with what the migration does and how to roll it back, a dependency check, and an md5 drift guard on `tg_app_settings_guard_owner_keys` (read the live md5 read-only first and accept the current live body). Use `SET LOCAL lock_timeout='5s'`.

New columns on `call_scripts` (`ADD COLUMN IF NOT EXISTS`):

| Column | Definition | Note |
|---|---|---|
| `status` | text NOT NULL DEFAULT `'published'` | The 13 live rows backfill as published. The new writer always passes a status. |
| `groups` | text[] NOT NULL DEFAULT `'{}'` | `{}` = every group |
| `product_ids` | uuid[] NOT NULL DEFAULT `'{}'` | `{}` = every product |
| `priority` | smallint NOT NULL DEFAULT 0 | between −100 and 100 |
| `sections` | jsonb NOT NULL DEFAULT `'[]'` | array, at most 12 entries |
| `version` | integer NOT NULL DEFAULT 1 | |
| `created_at` | timestamptz | |
| `created_by` | uuid | |
| `published_at` | timestamptz | |
| `published_by` | uuid | |
| `copied_from` | uuid | |

Constraints:
- `status IN ('draft','published','archived')`
- `context_type IN ('order','prediction_lead','product','targeted')`
- `groups <@ ALL_GROUPS`
- `cardinality(product_ids) <= 300`
- legacy rows never target: `context_type = 'targeted' OR (groups = '{}' AND product_ids = '{}')`

`sections` is an ordered array of `{id, key, title?, text}`:
- `key` is one of `opening | pitch | objections | closing | custom`. Each fixed key appears at most once.
- `id` is the key for fixed sections, or `custom-<6–12 [a-z0-9]>` for custom ones.
- A custom section needs a title (at most 80 characters).
- `text` is at most 8000 characters.

`helpers` stays as it is and becomes the quick answers ("Брзи одговори"). `translations` is `{sq:{title, description, sections:[…matched by id], helpers, script_text}}`. Scripts are written in **mk and sq only**.

`script_text` is derived by the SQL function `call_script_sections_text(sections, lang)`, which uses mk/sq headings. The TypeScript twin is `sectionsToText`. For legacy rows `script_text` is still edited directly.

**`call_script_versions`:**
- Columns: `id bigserial`, `script_id uuid` (no FK), `version`, `action` (one of `migrate`, `create`, `update`, `publish`, `unpublish`, `archive`, `restore`, `duplicate`, `bulk`, `delete`), `snapshot jsonb` (the row after the action; for `delete`, the row before), `actor_id`, `actor_name`, `note` (≤ 500), `created_at`.
- `UNIQUE (script_id, version)`.
- A trigger refuses UPDATE and DELETE.
- RLS deny-all; access only through the service role.

**RLS on `call_scripts`:**
- Drop the three old policies (keep their text in comments for rollback).
- Add one SELECT policy, `call_scripts_select`, using the InitPlan form: `(SELECT is_internal_staff((SELECT auth.uid()))) AND (status='published' OR (SELECT is_admin_or_manager((SELECT auth.uid()))))`. Check that the live helper function names exist and use the live ones.
- REVOKE INSERT/UPDATE/DELETE/TRUNCATE from PUBLIC, anon and authenticated.

**Writers.** All are SECURITY DEFINER with `search_path = public, pg_temp`, executable by service_role only. Each one:
- checks the actor's role itself;
- takes `pg_advisory_xact_lock(hashtext('call_scripts'))`;
- validates, writes, and adds a version row plus one `audit_log` row, all in one transaction.

| Function | Who | What it does |
|---|---|---|
| `call_script_save(p_actor uuid, p_id uuid, p_expected_version int, p_patch jsonb, p_note text) → jsonb` | admin or manager | **Create** when p_id is null: `context_type='targeted'`, status taken from the patch, default `draft`. **Update:** a version mismatch raises the SQLSTATE the api maps to 409 `stale`. Status moves: draft↔published, any→archived, archived→draft. Publishing a targeted script needs a title and at least one section with text. `product_ids` must exist. The legacy branch accepts only title, description, script_text, helpers and translations. Sets `published_*`, recomputes `script_text`, increments `version`. Audit actions: `call_script.create`, `update`, `publish`, `unpublish`, `archive`. |
| `call_script_duplicate(p_actor, p_id, p_targets jsonb, p_note)` | admin or manager | Up to 50 targets `[{title, groups, product_ids}]`. Creates drafts with `copied_from` set. |
| `call_scripts_bulk(p_actor, p_ids uuid[], p_op jsonb, p_note)` | admin or manager | Up to 200 ids. `p_op` = `{add_groups, remove_groups, add_products, remove_products, status?, priority?}`. One version row per script, one audit row overall. |
| `call_script_restore(p_actor, p_id, p_version, p_note)` | admin or manager; **admin only** if the row was deleted | Content and targeting come back from the snapshot as a new version, keeping the current status. A deleted row comes back as a draft with the same id. |
| `call_script_delete(p_actor, p_id, p_note)` | **admin only** | Writes a snapshot version, then deletes. Refuses the `order` and `prediction_lead` rows. |
| `call_script_demand() RETURNS TABLE(kind text, list_id uuid, lead_group text, product_id uuid, product_name text, waiting int, assigned int)` | service role | **Members:** not completed and the list is active, joined through `trigger_order_id → orders.product_id`. **Leads:** open lead orders (`is_lead_source`, status pending/take/call_again), grouped as `lead_new` / `lead_callback`. Both exclude test phones (`is_report_excluded_phone`). |

**Switch.** `app_settings('call_scripts', '{"mode":"off"}')` with modes `off | preview | on`. Re-emit `tg_app_settings_guard_owner_keys` from the live body, adding `'call_scripts'`. Only admins (who are owners) change it, through an audited api route.

**Data:**
- For each of the 11 legacy `product` rows, add a copy: `context_type='targeted'`, `status='draft'`, `copied_from=<id>`, `sections=[{id:'pitch', key:'pitch', text:script_text}]`, the same for `translations.sq`, empty targeting.
- Every row gets a v1 `migrate` snapshot.
- The legacy rows themselves are not touched.

## Pure modules (no imports; vitest; shared with the UI in the `src/lib/shiftsApi.ts` style)

### `supabase/functions/api/callScriptMatch.ts`
Exports: `ALL_GROUPS`, `LEAD_GROUPS`, `PREDICTION_GROUPS`, `groupOfListName`, `matchScripts`, `substitute`, `resolveTargetedScript(script, lang)` (sq falls back to mk per section id), `sectionsToText`, `lintScript`, `proposeProductsForTitle`, `whereItWins`.

**Matching.** The context is `{group: G|null, primary: productId|null, products: id[], twins: Record<id, id[]>}`. Twins are catalogue duplicates with the same normalised name and count as the same product.

```
candidates = targeted ∧ (published ∨ (includeDrafts ∧ draft))
gHit = groups=∅ ? 'all' : (G ∧ G∈groups ? 'group' : skip)
pHit = product_ids=∅ ? 'all' : (∩ family(primary) ? 'primary' : ∩ family(products) ? 'other' : skip)
tier = group&prod→1 · group&all→2 · all&prod→3 · all&all→4 (general)
sort: tier ↑ · pHit 'primary' before 'other' · priority ↓ · coalesce(published_at,updated_at) ↓ · id ↑
best = [0]; alternatives = next 4; tie_break = 'primary_product'|'priority'|'newest'|null
```

Each match carries reason codes: `group:<g>`, `product:<id>`, `twin`, `all_groups`, `all_products`.

Worked examples, which must be tests. Scripts: A=`[d21]`; B=`[d21,d57]`+Простатол; C=`[]`+Простатол; E=`[lead_new]`; F=`[lead_new,lead_callback]`+Неурофикс; D=`[y2plus]`; G=general.
1. A 21d client whose last purchase was Простатол (or its twin) → **B**. Alternatives: A, C, G.
2. A 2yr+ client with Нефрофикс from `last_sale_product` → **D**.
3. A fresh lead for Неурофикс (status `take`) → **F**; alternative E.
4. The same lead in `call_again` → **F**. If F were attached to `lead_new` only, G would win: there is no implicit fallback from callback to new.
5. A Trash List customer opened by hand → the script attached to `trash`.
6. An uploaded list or `Current Returns` (G null) → only C (if the product matches) or G.

**Variables.**
- New form: `{{customer_name}} {{first_name}} {{agent_name}} {{product}} {{price}} {{last_product}} {{last_purchase_date}} {{days_since_purchase}} {{since_purchase}} {{city}} {{order_id}}`.
- Legacy form: `[Customer Name] [Product] [Order ID] [Agent Name] [Your Name] [Price] [City]`.
- `substitute` returns **segments**, never HTML. A missing value becomes a "missing" segment, which the UI shows as an amber chip.

**Lint** (warnings only):
- `bg_content`: `/евро|€|\bлв\b|лева|Еконт|Спиди|Econt|Speedy|Бугарија|България/i`
- `terminology`: прогноз, пендинг, на чекање
- `unknown_var`
- `legacy_placeholder`
- `missing_sq` (information only)

### `supabase/functions/api/callScriptsAdmin.ts`
Request parsers (`parseScriptPatch`, `parseDuplicate`, `parseBulk`, `parseMode`), `buildCallContext(rows, flags)`, `redactVars(vars, piiFlags, showOrderHistory)`, `shapeCoverage(demandRows, lists, scripts, products, {families})` and `shapeLibrary`.

## Context: `GET /api/calls/scripts?phone&source=lead|prediction|manual&order_id&list_id&include_drafts`
Rate limit: 120 per minute.

**Lead.** The `order_id` must be an open lead on the same last-8 phone; otherwise the newest open lead on that phone is used.
- group = `call_again` → `lead_callback`, else `lead_new`
- products = `orders.product_id` plus the `order_items` ids
- primary = `orders.product_id`

**Prediction.**
- `list_id` must be a real list, and the caller's member row unless the caller is admin or manager.
- group = `groupOfListName(list.name)`
- product = the trigger order's product and items, else `last_sale_product(phone)`
- last purchase = the member's `last_paid_at`, else the `last_sale_product` date

**Manual.** In order: the `order_id` hint or the newest open lead on the phone; then the `list_id` hint; then `resolvePredictionAttribution(phone)`; else null.

**Twins and variables.**
- Twins: products with a case-insensitive exact name match.
- Name and city are dropped when the caller's privacy flags hide them. The `last_*` variables are dropped without `show_order_history`.
- The AlterCPA offer never leaves the server.

**Mode and caching.**
- Mode `off`, or `preview` for a non admin/manager → `{enabled:false}`.
- `include_drafts=1` works for admin and manager only.
- Published metadata is cached for 30 s per edge instance and cleared on any write. Bodies are loaded only for the best match and up to 4 alternatives.

## API routes (workstream A)
The new block goes **before** the legacy `GET /call-scripts/:contextType` handler (around `index.ts` line 12062). Otherwise that handler swallows `/call-scripts/<anything>`.

Permissions:
- **write** = `isAdmin || (isManager && canEditModule('call_scripts'))`
- **delete** and switching the mode = admin only

| Route | Who | Returns |
|---|---|---|
| `GET /call-scripts/mode` | staff | `{mode, enabled_for_me, can_write, can_delete, can_switch}` |
| `PATCH /call-scripts/mode` `{mode, note?}` | admin | audited `call_scripts.mode` |
| `GET /call-scripts/library?status&group&product&q` | staff (agents see published only) | `{scripts: TargetedScript[] (with lint, updated_by_name), products: ProductIndexRow[]}` |
| `GET /call-scripts/published-index` | staff | `{scripts:[{id,title,groups,product_ids,version}]}` |
| `GET /call-scripts/item/:id` | staff (published only for agents) | `TargetedScript` |
| `POST /call-scripts/item` `{patch, note?}` | write | 201 `{script}` |
| `PATCH /call-scripts/item/:id` `{expected_version, patch, note?}` | write | `{script}`, or 409 `{code:'stale', current_version}` |
| `POST /call-scripts/item/:id/duplicate` `{groups, product_ids, split:'none'|'product'|'group'|'cell', note?}` | write | `{created:[{id,title}]}` (≤ 50) |
| `POST /call-scripts/bulk` `{ids, op, note?}` | write | `{updated:[{id,version}], skipped:[{id,reason}]}` |
| `GET /call-scripts/item/:id/versions` | write | `{versions:[…]}` (≤ 100) |
| `POST /call-scripts/item/:id/restore` `{version, note?}` | write (admin if the row was deleted) | `{script}` |
| `DELETE /call-scripts/item/:id` | admin | `{ok, version}` |
| `GET /call-scripts/deleted` | admin | the latest delete snapshots |
| `GET /call-scripts/coverage?families=1&assigned_only=0` | write | `CoverageResponse` |
| `GET /call-scripts/samples?group&product` | write | up to 10 waiting clients, privacy-filtered |
| `GET /calls/scripts…` | staff with calls access | `CallScriptsForCall` |

Hardening the legacy routes:
- `GET /call-scripts/:contextType` accepts only `order` and `prediction_lead`.
- Legacy PATCH goes through the writer's legacy branch.
- Legacy POST → 410 `use_new_editor`.
- Legacy DELETE → `call_script_delete`.

## Types: `src/lib/callScriptsTypes.ts`
Re-exports the pure modules.

```ts
export type ScriptGroup = 'lead_new'|'lead_callback'|'newcomers'|'d21'|'d57'|'m4_6'|'m6_12'|'y1_2'|'y2plus'|'cancels'|'never_converted'|'trash';
export type ScriptStatus = 'draft'|'published'|'archived';
export type ScriptsMode = 'off'|'preview'|'on';
export type SectionKey = 'opening'|'pitch'|'objections'|'closing'|'custom';
export interface ScriptSection { id: string; key: SectionKey; title?: string|null; text: string }
export interface ScriptTranslation { title?: string; description?: string|null; sections?: ScriptSection[]; helpers?: CallScriptHelper[] }
export interface TargetedScript {
  id: string; context_type: 'targeted'|'product'|'order'|'prediction_lead'; status: ScriptStatus;
  title: string; description: string|null; sections: ScriptSection[]; helpers: CallScriptHelper[];
  translations: { sq?: ScriptTranslation }; groups: ScriptGroup[]; product_ids: string[]; priority: number;
  version: number; created_at: string; created_by: string|null; updated_at: string; updated_by: string|null;
  published_at: string|null; published_by: string|null; copied_from: string|null;
  lint?: LintIssue[]; updated_by_name?: string|null;
}
export interface ScriptMatch { script_id: string; tier: 1|2|3|4; reasons: string[]; matched_product_id: string|null; tie_break: 'primary_product'|'priority'|'newest'|null }
export interface ScriptContext {
  source: 'lead'|'prediction'|'manual'; group: ScriptGroup|null; group_basis: 'order_status'|'list_name'|'attribution'|'none';
  list_name: string|null;   // raw — display only via listLabel()
  order: { id: string; display_id: string|null; status: 'pending'|'take'|'call_again'; created_at: string }|null;
  product: { id: string; name: string; price_eur: number|null }|null; products: { id: string; name: string }[];
  last_purchase: { at: string; product_name: string|null }|null; days_since_purchase: number|null; callback: boolean;
}
export interface ScriptVars { customer_name: string|null; first_name: string|null; agent_name: string|null; product: string|null; price_eur: number|null; last_product: string|null; last_purchase_at: string|null; days_since_purchase: number|null; city: string|null; order_id: string|null }
export interface CallScriptsForCall { enabled: boolean; mode: ScriptsMode; drafts_included: boolean; context: ScriptContext|null; vars: ScriptVars|null; best: (TargetedScript & { match: ScriptMatch })|null; alternatives: (TargetedScript & { match: ScriptMatch })[] }
export interface CoverageCell { waiting: number; assigned: number; winner: { script_id: string; title: string; tier: 1|2|3|4 }|null; draft_winner: { script_id: string; title: string; tier: 1|2|3|4 }|null; overlap: number }
export interface CoverageRow { key: string; product_ids: string[]; name: string; brand_line: string|null; kind: string|null; waiting: number; cells: Record<ScriptGroup, CoverageCell> }
export interface CoverageResponse { generated_at: string; groups: ScriptGroup[]; all_products: Record<ScriptGroup, CoverageCell>; rows: CoverageRow[]; totals: { waiting: number; covered: number; covered_pct: number; empty_cells_with_waiting: number; published: number; drafts: number } }
```

`src/lib/callScriptsApi.ts`: a `scriptsFetch` that **keeps `status` and `code`** (`apiFetch` drops them; follow the `CallOutcomeError` pattern), one function per route, and `CALL_SCRIPTS_QUERY_KEYS`.

**Fixtures:** `src/components/callscripts/__fixtures__/{library,coverage,forCall.lead,forCall.prediction,forCall.empty}.sample.json`.

## UI
- **`/call-scripts` (workstream B):**
  - `src/pages/CallScriptsPage.tsx` becomes a shell. Tabs live in the URL: `?tab=library|coverage|tester|current|order|promo`. The editor opens with `?script=<id>` or `?new=1&group=…&product=…`.
  - Components: `src/components/callscripts/{library,editor,coverage,tester,legacy}/*`, `ModeSwitch`, `useCallScriptsAdmin.ts`, `scriptsModel.ts`.
  - Insights style, cards below md. The coverage grid has a sticky product column inside its own overflow container.
- **`/calls` (workstream C):**
  - Shared pieces: `src/components/callscripts/ScriptBody.tsx` (sections, anchors, substitution, missing-variable chips, sticky section chips) and `QuickAnswers.tsx`.
  - `src/components/calls/scripts/{useCallScripts,ScriptDock,ScriptDockMobile,WhyPopover,ScriptSearch}`.
  - `ClientProfileCard` gets a `scriptContext` prop and renders `ScriptDock` right after `{toolbar}` when the mode is enabled for the user (`CustomerHistoryTabs` then gets `showScripts={false}`). Otherwise today's `CallScriptsPanel` stays.
  - `OutcomeBar` gets an `accessory` prop, shown below md.
  - `CallsPage` builds `scriptCtx` and **fixes `openCallback`** (CallsPage ~1137), which currently loses the list and order.
- **Fixes:**
  - `OrderModal.tsx:687` → `apiUpdateCallScript(contextType, { script_text: editedScript })`; the edit link there is allowed for admin or manager.
  - Retire `scripts/import-scripts-from-bg.mjs` (it reads Bulgaria) and `scripts/import-call-scripts.mjs`: both exit with "retired — use /call-scripts".
- **i18n:** `callScripts.*` (groups, groupsDesc, families, sections, status, vars, library, editor, coverage, tester, history, mode, lint, errors, bulk, duplicate) and `scriptDock.*`, in mk/en/sq/bg. Use Лидови / Предикција / Нов лид / Повторен повик; never "на чекање", "пендинзи" or "прогноза".

## Workstreams
- **A:** contract (pure modules, types, api client, fixtures; committed first), migration, `callScriptsAdmin.ts`, api routes, `types.ts` (integrations), `scripts/verify-call-scripts.mjs` V1–V10, retiring the import scripts, docs/skill/CLAUDE.md/MACEDONIA-STATUS.
- **C:** `ScriptBody` and `QuickAnswers` (first commit), the /calls dock and context, OutcomeBar, CallsPage, `scriptDock.*`.
- **B:** /call-scripts, the OrderModal fix, `callScripts.*`.
- **Merge order:** A → C → B.
- **The lead** (not the agents) applies migrations, deploys and pushes.

## Contract clarifications (workstream A, contract commit)
These are decisions taken while writing the pure module and the types; B and C build on them.
- **`matchScripts(scripts, ctx, opts)`** returns `{best, alternatives, ranked}` of `{script, match}` pairs. The server spreads them into `TargetedScript & {match}`. `opts.includeDrafts` lets drafts compete; archived rows never do. `opts.forceCandidateId` is for the editor's "where it wins".
- **`tie_break`** is set on every ranked match. It says what put that script ahead of the **next** one on the **same tier**: `primary_product`, then `priority`, then `newest`. It is `null` when the tier decided, when nothing follows, or when only the id decided (equal timestamps).
- **Twins:** `buildTwins(products)` uses `productFamilyKey(name)`, which is the name trimmed, with inner whitespace collapsed, lower-cased. Live on 02.10 there are **0** duplicate names (706 products), so twins are a safety net. In coverage, `families=1` folds twins into one row (`key` = the family key when more than one id, else the product id). `families=0` gives one row per product id.
- **`substitute(text, vars, lang)`** returns `ScriptSegment[]`, one of:
  - `{kind:'text', text}`
  - `{kind:'var', name, text, raw}`
  - `{kind:'missing', name, raw}`

  Formatting details:
  - `{{price}}` is formatted from `price_eur` with the frozen 61,5 (`1.599 ден`), the same output as `formatMoney`.
  - `{{last_purchase_date}}` is `dd.mm.yyyy` on the Skopje calendar.
  - `{{since_purchase}}` is `пред 3 месеци` / `para 3 muajsh`.
  - `{{first_name}}` falls back to the first word of `customer_name`.
  - An unknown `{{x}}` and unknown brackets (`[Company]`, which only the legacy order / prediction_lead rows use) stay literal.
  - `segmentsToText` joins the segments back together.
- **Lint:** the regex is the contract's, with one change: JavaScript's `\b` is ASCII-only, so `лв` is bounded by "not a Unicode letter". It lints mk **and** sq texts. `legacy_placeholder` also flags `[Company]`, `[Address]` and blanks `___` (the live product scripts use `______` for the names). For a legacy row, it lints `script_text` because the row has no sections. `missing_sq` has severity `info`; every other code is `warn`.
- **`resolveTargetedScript(script, lang)`** keeps the mk order. An sq section replaces the mk section with the same id when its text is not blank, and sq-only sections are appended. Title and description fall back per field. A non-empty sq helpers list replaces the mk list. It returns `fallback_section_ids` and `fallback_fields` so the UI can mark Macedonian text in an Albanian view.
- **`sectionsToText`** writes `Heading\ntext` blocks joined by a blank line and skips empty sections. It trims only space, tab, CR and LF. The SQL twin `call_script_sections_text` trims the same characters.
- **`validateSections`** applies the same rules the SQL writer enforces. The error codes are `not_array`, `too_many`, `not_object`, `bad_key`, `duplicate_key`, `bad_id`, `duplicate_id`, `title_required`, `title_too_long`, `text_not_string` and `text_too_long`.
- **`proposeProductsForTitle(title, products)`** uses the title's core, the part before ` – ` / ` - `. It drops units and numbers and transliterates Cyrillic to Latin, with `x` read as `ks`. A product is proposed when its name holds every significant token of the core. Results are sorted exact first, then products before bundles, then active first.
- **`whereItWins(target, others, {productIds, twins, includeDrafts})`** evaluates every cell the target is aimed at: its groups (all 12 when it has none) × its products (when it has none: "no product" plus `productIds`). The target competes whatever its status. It returns the winner of each cell and the win / lose counts.
- **`GET /call-scripts/library`** returns the targeted rows **and** the legacy `product` rows (`context_type` tells them apart). The `order` / `prediction_lead` rows stay on their own tabs through the legacy `GET /call-scripts/:contextType`.
- **`DELETE /call-scripts/item/:id`** takes the note as `?note=` (a JSON body is accepted too).
- **Client:** `src/lib/callScriptsApi.ts` throws `CallScriptsError {status, code, body}`, with `isStale` and `currentVersion` for the 409. `CALL_SCRIPTS_QUERY_KEYS.all = ['call-scripts']` invalidates everything.
- **Fixtures** (`src/components/callscripts/__fixtures__/`) are generated from the pure module, so their winners are real. `src/lib/callScriptsTypes.test.ts` keeps them consistent.

## Implementation (workstream A, 02.10.2026)
Built on `call-scripts-a`. Nothing is applied or deployed: the lead applies and deploys.

### Migration `20260947000100_call_scripts_targeting.sql`
Beyond the contract tables above, it contains:
- **Drift guard:** `tg_app_settings_guard_owner_keys` was live at md5 `20972a5a1ac9b1d0d60c515b95bbbe28` on 02.10 (the shops body, CR-stripped `prosrc`). It is re-emitted with `'call_scripts'` added, which gives md5 `cebcf4fd23bc95d3ef2bb6b465ec71e8`. The guard accepts only these two values.
- **Helper functions** (owner only, not granted to anyone):
  - `call_script_groups()`: the 12 groups.
  - `call_script_sections_problem(jsonb)`: the CHECK on `sections`, with the same codes as `validateSections`.
  - `call_script_sections_normalize(jsonb)`: keeps `{id, key, text}`, plus a trimmed `title` on custom sections.
  - `call_script_sections_text(jsonb, text)`.
  - `call_script_blank(uuid)`, `call_script_apply_patch(call_scripts, jsonb)`, `call_script_publish_problem(call_scripts)` and `call_script_add_version(...)`.
- **`call_scripts_set_mode(p_actor, p_mode, p_note)`:** the switch's writer. Admins only; it writes the audit action `call_scripts.mode`.
- **`call_script_demand_json()`:** the same rows as `call_script_demand()`, returned as one jsonb array. PostgREST caps a set-returning rpc at 1000 rows and the demand is about 3.400 rows. The api reads this wrapper, cached for 60 s.
- **Test phones:** the demand query inlines the exclusion as an anti-join on `report_excluded_phones.phone8`. This is the same rule as `is_report_excluded_phone`, but that function is SECURITY DEFINER, cannot be inlined, and cost about 2 s across the 113k members. The query now takes about 0,8 s warm.
- **Error contract.** The machine code is in the error **HINT**, and `CSA.mapWriterError` maps it:

  | SQLSTATE | HTTP | Codes |
  |---|---|---|
  | `CS409` | 409 | `stale` (DETAIL = the current version) |
  | `CS404` | 404 | `not_found` |
  | `42501` | 403 | `forbidden`, `admin_only` |
  | `22023` | 400 | `unknown_field`, `bad_title`, `bad_description`, `bad_script_text`, `bad_group`, `unknown_product` (DETAIL = the ids), `too_many_products`, `bad_priority`, `bad_sections` (DETAIL = the problem), `bad_helpers`, `bad_translations`, `script_text_derived`, `legacy_field`, `bad_status`, `bad_transition`, `publish_needs_text` (DETAIL `title_required` / `text_required`), `legacy_fixed`, `bad_targets`, `bad_op`, `too_many`, `bad_mode`, `note_too_long`, `expected_version_required` |

- **Writer rules (as built):**
  - **Save, no-op:** a save that changes nothing returns `{action:'none', changed:false}`, with no version and no audit row.
  - **Save, publishing:** `published_at` / `published_by` are set on the move to published and kept while the script stays published, so an edit does not count as "newer". They are cleared on unpublish and archive. Archived → published is refused (`bad_transition`); the script goes back to draft first.
  - **Save, publish rule:** it applies to every save that leaves the script published, so a published script can never be emptied.
  - **Limits:** title ≤ 200, description ≤ 2000, helpers ≤ 50 (title ≤ 200, content ≤ 4000), translations `sq` only, legacy `script_text` ≤ 20000.
  - **Legacy rows:** the legacy branch never changes status.
  - **Duplicate:** a legacy source becomes `sections=[pitch: script_text]`, and the same for sq. Every copy is a draft with `copied_from` set.
  - **Bulk:** the skip reasons are `not_found`, `legacy`, `invalid`, `bad_transition`, `publish_needs_text` and `unchanged`.
  - **Delete:** the delete snapshot is stored as version `old + 1`, holding the row before the delete.
  - **Restore of a live row:** the snapshot's content and targeting come back. Products that no longer exist are dropped and reported (`dropped_products`). If the script is published and the restored version has no text, the restore is refused (`publish_needs_text`).
  - **Restore of a deleted row:** admins only. **A deviation from the contract:** a deleted *legacy product* row comes back as **published**, because legacy rows have no draft state in the old tabs. A targeted row comes back as a draft, as the contract says.

### api (`index.ts`, block "CALL SCRIPTS (targeted)" before the legacy handlers)
- The routes are as in the table above. POST `item` and `duplicate` answer **201**. PATCH `item` also returns `action` and `changed`. Restore also returns `was_deleted` and `dropped_products`. `GET /call-scripts/deleted` returns `{deleted:[{script_id, version, title, context_type, deleted_at, actor_name, note, snapshot}]}`.
- **`GET /calls/scripts`:**
  - Access: staff who are admins, managers, agents, or have `call_scripts` view. Rate limit: 120 per minute.
  - **source=prediction** needs `list_id`. An unknown list → 404 `list_not_found`. For an agent, a member row that is not assigned to them → 403 `not_your_member`.
  - **source=manual** silently ignores a `list_id` hint the caller may not use. It then falls through to `resolvePredictionAttribution`.
  - Only the best match and up to 4 alternatives load their bodies. A row unpublished between the cache read and the body read is dropped.
- **Caches** (per edge isolate, cleared on every write in that isolate): mode, script metadata and products for 30 s; demand for 60 s.
- **`GET /call-scripts/samples`:**
  - `group` is required; `product` is optional and twins count.
  - Lead groups → open lead orders. Prediction groups → open members of the active lists in that group.
  - Test phones are excluded. Each sample also carries `group` and `vars` (redacted the same way as the dock), so the tester can render it with `substitute` and match it locally, even when the caller's privacy flags mask the phone.
- **`GET /call-scripts/coverage`:**
  - Also returns `outside: {waiting, lists[]}`: the clients on lists with no group (Current Returns, uploaded lists).
  - `totals.waiting` counts the clients in the grid only.
  - A product that a script names gets a row even when nobody is waiting for it.
- **Legacy hardening:**
  - `GET /call-scripts` lists legacy rows only.
  - `POST /call-scripts` → 410 `use_new_editor`.
  - `GET /call-scripts/:contextType` serves `order` / `prediction_lead` only.
  - `PATCH /call-scripts/:id|:contextType` goes through `call_script_save` with the row's current version. Old clients send no version, so the last write wins, but every write is now a restorable version. A targeted row → 409 `use_new_editor`.
  - `DELETE /call-scripts/:id` → `call_script_delete`, admins only.
- `scripts/translate-call-scripts.mjs` is retired too (**a deviation: it was not on the contract's list**). It wrote `translations` straight through the service role, which would bypass the versions.

### Dry-run evidence (02.10, rolled back)
- **Backfill:** 13 live rows published and untouched; 11 draft copies; 24 `migrate` versions; mode `off`. The guard refuses a browser write of `call_scripts`, even from an admin (42501). An agent sees 13 rows; a manager sees 24.
- **Writers:** every rule in the table above behaved as written, and every refusal returned its code. `verify-call-scripts` passed V1–V9 after the full exercise. A bypassing UPDATE made V4 fail.
- **Demand:**

  | | Waiting | Lists |
  |---|---|---|
  | Members, all | 113.547 | — |
  | Open leads, all | 170 | — |
  | y2plus | 20.595 | 8 |
  | m6_12 | 18.567 | 8 |
  | y1_2 | 16.961 | 8 |
  | trash | 13.257 | 1 |
  | never_converted | 10.674 | 2 |
  | d57 | 10.118 | 8 |
  | m4_6 | 7.630 | 8 |
  | d21 | 6.072 | 8 |
  | newcomers | 3.340 | 4 |
  | cancels | 2.951 | 1 |
  | lead_callback | 166 | — |
  | lead_new | 2 | — |
  | Current Returns (null group) | 3.383 | — |

  The top products by waiting clients are MAGNESIUM CITRAT 325mg (8.882), СНАИЛ КОМПЛЕКС cps 30 (7.309), ПРОСТАТОЛ КОМПЛЕКС cps 30 (5.973), no product (5.229), АЛОЕ ВЕРА ГЕЛ СО АРОНИЈА 1Л (4.777) and Колаген Пептид со ВАНИЛА 200 гр (4.304). In total, 213 distinct products are waiting.

  **Note:** the catalogue holds the same product under two scripts, for example "ПРОСТАТОЛ КОМПЛЕКС cps 30" and "Prostatol Complex (2+2)…". Twins (exact name) do not fold these. `proposeProductsForTitle` does: Cyrillic is transliterated, then c/q→k, x→ks, w→v, y→i and doubled letters are collapsed. The editor should offer those proposals.

### Apply / deploy order (the lead)
1. `node scripts/assert-mk-target.mjs`
2. `node scripts/apply-migration-mk.mjs supabase/migrations/20260947000100_call_scripts_targeting.sql`
3. `node scripts/verify-call-scripts.mjs`. Expect V1–V9 PASS and **V10 WARN (20 rows: the 10 BG-worded legacy scripts and their 10 draft copies)**. Then run `node scripts/engine-fixture-mk.mjs`: the migration does not touch lists, but run it per the bundle rule.
4. Deploy the api: `npx supabase functions deploy api --project-ref oufoazmnbwugtfldkwsn` (add `--use-api` if the CLI hangs).
   - **The api must come after the migration.** Its legacy PATCH / DELETE call the new writers.
   - Between steps 2 and 4, the old api still writes legacy rows directly through the service role. V4 would list any row edited in that window; re-save it through the editor to heal it.
5. Push the frontend (A → C → B merged).
6. Mode stays `off`. The owner decides `preview` (admins / managers see the dock) and later `on`.
