---
name: elyon-phone-normalization
description: Use for any phone number handling, search, matching, import, or customer lookup in the Macedonia Elyon CRM. MACEDONIA stores E.164 with country code +389 (NOT the Bulgarian +359, NOT +383). Last-8-digits normalization for search is unchanged. Critical for search-prediction, customer intelligence, call queues, webhooks, and all order/lead lookups.
---

# Elyon Phone Normalization Skill

> **MACEDONIA OVERRIDE (CLAUDE.md wins):** store numbers as E.164 with **+389** (Macedonia), never the
> Bulgarian **+359** and never +383 (an older note of this fork said +383 — it was wrong). The
> last-8-digits search/matching rule below is country-agnostic and stays exactly as written. Use
> `normalizeMkPhone()` for MK intake — and remember it is a REWRITER, not a validator (it turns a
> foreign number into a +389 one; for multi-country data use `normalizePhoneForGeo`). Wherever this
> skill says "+359" below, read it as **+389**.

## The Golden Rule

Phones are **never** matched by exact string equality.

**Search rule**: Normalize by stripping all non-digits, then match on the **last 8 digits**.

This single rule makes `078319044`, `+38978319044`, `38978319044`, and `+35978319044` all resolve to the same customer record.

## Storage Format (Immutable)

- Always store as E.164 with Bulgarian country code: `+359XXXXXXXXX`
- 10 digits after +359 for Bulgarian mobile numbers.

## Normalization Logic (Use This Everywhere)

```js
function normalizePhoneForSearch(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-8) : digits;
}
```

The backend implements this in multiple places (search-prediction, search-quick, call matching, etc.). Never bypass it.

## Historical Pollution & Cleanup

The xlsx imports once created scientific notation disasters like `3.59886e+11`.

There are dedicated scripts for this:
- `scripts/cleanup-polluted-phones.mjs`
- `scripts/verify-cleanup.mjs`

If you ever see a phone containing `e+` or scientific notation in the database or imports, **stop** and run the cleanup logic. Do not proceed with bad data.

## Where This Skill Must Be Applied

- `GET /search-prediction?q=...`
- Customer intelligence lookups
- Call queue matching (pending orders + prediction leads)
- Webhook lead creation
- Manual order creation in CreateOrderModal
- Assigner / bulk operations
- Any CSV import or export involving phones

## Common Failure Modes to Prevent

1. Doing `WHERE customer_phone = ?` (exact match) — always wrong for search.
2. Storing numbers without the +359 prefix.
3. Treating `+389...` (Macedonian) differently from `+359...` for BG customers.
4. Letting frontend formatting (spaces, dashes) leak into the database.

## Decision Table

| Task                              | Correct Approach                              | Never Do This                     |
|-----------------------------------|-----------------------------------------------|-----------------------------------|
| Searching for a customer          | Last 8 digits after stripping non-digits     | Exact string match                |
| Storing a new phone               | Convert to +359... E.164                      | Store as typed by user            |
| Displaying a phone                | Pretty format for humans (`+359 78 319 044`)  | Show raw DB value if ugly         |
| Importing from XLSX/CSV           | Run normalization + pollution checks          | Trust the source file             |
| Matching across orders + leads    | Normalize both sides to last 8 digits         | Compare raw strings               |

## Sacred Reference Files

- Backend search logic: `supabase/functions/api/index.ts` (search-prediction and related endpoints)
- Frontend search: `SearchPredictionPage.tsx`, `GlobalSearch.tsx`
- Import scripts: `scripts/import-*.mjs` and the cleanup scripts mentioned above
- `src/lib/` phone utilities (if any centralized helpers exist)

**When the user pastes a phone in any format and asks to "find the customer" or "look up orders", the very first thing you must do is normalize it using the last-8-digits rule before querying.**

This rule has saved the project from massive data integrity disasters multiple times. It is not optional.