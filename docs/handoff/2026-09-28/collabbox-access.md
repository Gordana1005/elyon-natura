The collabBox fetch now runs headlessly and read-only, with no browser and no DWR. I ran it for 25.09–27.09.2026 across all order types and got **502 documents and 1,251 line items**. Every document matched its line items in both directions.

**Deliverables**
- Script: `D:\Dev\archives\elyon-natura\scripts\collabbox-fetch.mjs` (542 lines, untracked, not committed).
- Output: `D:\Dev\archives\elyon-natura\exports\collabbox\collabbox_25.09.2026_27.09.2026_2026-09-27T23-53-01-676Z.json` (1.44 MB). Raw `.html` and `.xls` responses are in `exports\collabbox\raw\`, which is gitignored.

## Why the old note in VAULT §7.1 was wrong
- **No DWR is involved.** Results come back inside the normal POST response. The `getFirstGrid()` script only handles keyboard navigation of the table.
- **The 09-10 crawl was plain searches, not "405 DWR pages".** It was 9 types × 45 months of document searches. I recovered that crawler from the old transcript `C:\Users\Mile\.claude\projects\d--naturatherapy\0796d74c-…jsonl`.
- **Why the 09-18 attempts always returned "Пребарувањето не врати резултати".** They sent `,,` for empty lists and `""` for unselected dropdowns. A browser sends `,` and the dropdown's first option. With that fixed, the emulated form matches the browser payload captured on 09-18 exactly (0 differing fields).
- **VAULT still says "headless not solved" and "LAN-hosted".** Both are now false. I did not edit VAULT; it should be corrected.

## Protocol
The full version is in the header comment of the script (lines 1–95).

- **Transport:** plain HTTP to `http://146.255.89.49:8081/naturatherapy/` (Tomcat), UTF-8 throughout.
  - No basic auth, no CSRF token, no Referer check.
  - The only state is the `JSESSIONID` cookie. An expired session answers with a 43-byte page containing `location.href='./Login?'`; the script detects this and logs in again (`isLoginPage`, line 198).
- **Login:** `GET Login?`, then `POST Login` with `company_code=` (empty), `username`, `password`, `browserIsIE=0`. Success is a 43-byte page redirecting to `./Index?`.
- **Document headers** (`fetchHeaders`, line 348; `parseHeaders`, line 317):
  - `POST Index?comp=searchdoc&action=search` with `searchMode=search`, `chkDocType=chk`, `selectedDocTypes=,ID,ID,` (comma-wrapped), `chkDatumOd=chk`, `datumod`, `chkDatumDo=chk`, `datumdo` (dd.mm.yyyy), `limitResults=0`.
  - All rows come back in one HTML page; there is no paging.
  - The page states "Вкупно пронајдени N документи." The script requires N to equal the number of parsed rows.
  - Fields per document: DocID, internal object id, DocNumber, type id and name, customer id and name, amount, currency, datetime (`25.09.2026 20:17:03`) and author.
  - Amounts look like `1,234.50 МКД` (comma for thousands, dot for decimals).
- **Line items** (`fetchItems`, line 437):
  - The whole 226-field form must be posted as a browser would (`readForm`, line 245; `fillCombos`, line 297). Every dual-list box posts both of its hidden fields, e.g. `doktipid=,10114,`, `holding=,2,`, `delid=,2,`, `selectedUserIds=,`. An empty box is exactly `,`. The body is about 62 KB.
  - **Default (xls):** post with `mode=doListOptions` and `searchMode=exportxls`. The page links `./FileDownload?path=reports/&file=DokumentiStavki_<session>.xls`. A GET on that link returns a real `.xls` attachment with 35 columns — the same file operators export by hand, so the existing `import-collabbox-teleshop.mjs` can read it. Parsed by `parseItemsXls` (line 395). This file only carries the date (`Датум`), no time.
  - **Fallback (html):** post with `mode=doSearch` and `searchMode=doSearch`. The response contains a 13-column table plus a totals row, or "Не се пронајдени резултати" when empty. Parsed by `parseItemsHtml` (line 417). This leaves no file on their server.
  - Both modes were tested live and give 48 lines, 104 units and 66,199.98 / 66,199.99 МКД for LEADS-OUT on 25.09.
- **Read-only guard:** `assertReadOnly` (line 154) allows only six request shapes.
  - It blocks everything else found on these pages: saving a search, the action form (which adds customer discounts), creating documents, e-mailing the export, and the hidden "special Excel" export.
  - It also caps the number of requests. The script runs one request at a time with a 2.5 s pause.
  - Credentials are read from VAULT §7 at runtime, and the session id is redacted from every log line.

## Counts, 25–27.09.2026 (documents per day and total; line items; МКД)

| Type | 25.09 | 26.09 | 27.09 | Total | Lines | МКД |
|---|---|---|---|---|---|---|
| 10111 Нарачка LEADS | 55 | 60 | 60 | 175 | 233 | 544,960 |
| 10050 Нарачка out | 108 | 52 | 1 | 161 | 539 | 364,210 |
| 10036 Нарачка in | 47 | 26 | 24 | 97 | 247 | 217,150 |
| 10114 LEADS-OUT | 26 | 5 | 0 | 31 | 56 | 81,800 |
| 10106 Социјални Мрежи | 13 | 2 | 6 | 21 | 34 | 41,100 |
| 10107 Продавници | – | – | – | 4 | 12 | 10,200 |

- **Sales channels:** 485 documents, 1,249,220 МКД.
- **Store and replenishment orders:** 13 types with 1 document each, 2,495,760 МКД in total (e.g. Охрид 600,230, Лимак 433,940, Сити Мол 273,840). These are not retail sales and must be kept out of revenue.
- **Zero documents:** 10112 WEB, 10055, 10099, 10063, 10058, 10037 and 11 store types. 10063 and 10058 are not in this login's type list; they were queried by id anyway.
- **By day:** documents 254 / 156 / 92, line items 623 / 441 / 187.
- **Server load:** 12 requests in total; each search took 153–1,221 ms. Across the whole session I made 42 live requests, all read-only.

## Can it run as a Supabase Edge Function?
- **Code:** probably yes, though the logic is only tested in Node, never in Deno.
  - The code is plain `fetch` over HTTP to port 8081 with a hand-built cookie jar; Deno's `Headers.getSetCookie()` covers the cookies.
  - For the xls path it needs `npm:xlsx`; the html path needs nothing extra.
  - CPU per day is small: parsing a 623-line xls took about 202 ms, parsing the headers was negligible, and building the form took 16 ms.
  - I believe Supabase only blocks outbound ports 25 and 587; I have not verified that for this project.
- **Network:** untested. I could only test from this Windows machine.
  - This machine's public IP is 46.217.185.42 (local 192.168.1.153), a different network from 146.255.89.49. It connects in 13 ms, and the server applies no HTTP-level gate. So collabBox is on the public internet, not LAN-only.
  - A geo or IP firewall that blocks foreign addresses such as AWS Frankfurt cannot be ruled out.
  - Next step: deploy a probe function that does only `GET Login?`, under a new name, not the shared `api` function. That needs the tripwire and approval.
- **Fallback:** a scheduled task on this machine running the same Node script (proven reachable). Playwright is not needed.

## Risks
1. **Password in clear text.** Credentials and the session travel over plain HTTP; from Frankfurt that crosses the internet. Ask Accent for HTTPS or a VPN.
2. **The account can write.** `<collabBox user>` shows up as "Mile Stoev" inside collabBox and has full permissions; only my allow-list keeps the script read-only. Ask Accent for a dedicated read-only user.
3. **Files left on their server.** Each xls export writes `reports/DokumentiStavki_<session>.xls` on their server, exactly as the UI export does. The `--items html` mode avoids this.
4. **HTML scraping is brittle.** A layout change will break parsing. The script fails loudly on count mismatches and on documents missing their line items.
5. **Production load.** On 09-10, parallel full-history queries degraded their ERP (60–80 s per query, then connection refused). Keep the job sequential with one-day chunks. A full-year export also failed for the operator in the UI.
6. **Data drift.** Documents get edited, reversed (storno) or deleted after the fact.
   - A daily sync should re-fetch the last 7–14 days and upsert by DocNumber.
   - Deleted documents simply disappear from results, so they need a separate reconcile.
   - A collabBox "Нарачка" proves dispatch, not payment.
7. **No phone numbers.** Neither module has them. The customer id (`komitent`) has to be joined to `komitenti_full.csv` (a 09-10 snapshot) or to MEX. New customers are not covered yet.
8. **Untested lead on delivery status.** The line-items form has fields for "Delivered / In Delivery / Return to sender / платено / вратено" on documents, so collabBox may store MEX status per document. That could help the owner's paid / in-transit / returned breakdown, but I have not verified it.