#!/usr/bin/env node
/**
 * Arbitrate the two insights engines against GROUND TRUTH (READ-ONLY).
 *
 *   MK_ADMIN_PASSWORD=... node scripts/check-insights-vs-truth.mjs
 *
 * When legacy and sql disagree, neither is presumed right. This computes the
 * figure a third way — one plain SQL statement with no pagination involved —
 * and reports which engine matches.
 *
 * It exists because of what it found on 2026-08-06. The legacy engine paged
 * with LIMIT/OFFSET and no ORDER BY, which Postgres does not guarantee to be
 * stable: three consecutive calls over the same range returned
 *
 *     €502,907.49 (22,564 orders)   +650 orders over truth
 *     €483,663.99 (22,220 orders)   +306 orders over truth
 *     €474,278.33 (21,914 orders)   exact
 *
 * i.e. the Insights page could silently overstate revenue by tens of thousands
 * of euro, differently on every refresh. The SQL engine returned the exact
 * figure three times out of three.
 */
import { readFileSync } from 'node:fs';
const REF='oufoazmnbwugtfldkwsn';
const env={}; for(const l of readFileSync('d:/Dev/archives/elyon-natura/.env','utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if(m) env[m[1]]=m[2];}
const U=env.VITE_SUPABASE_URL, A=env.VITE_SUPABASE_PUBLISHABLE_KEY;
const r=await fetch(`${U}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:A,'Content-Type':'application/json'},body:JSON.stringify({email:'mile@elyon.com',password:process.env.MK_ADMIN_PASSWORD})});
const JWT=(await r.json()).access_token;
const mg=async q=>{const x=await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query:q})}); return JSON.parse(await x.text());};

// GROUND TRUTH straight from Postgres — one statement, no pagination involved.
const [t] = await mg(`select
  coalesce(sum(price),0)::float8 as sold_revenue, count(*)::int as sold_count
  from orders
 where status in ('confirmed','shipped','delivered','paid')
   and (source_type is null or source_type <> 'monadon_legacy')
   and created_at >= '2025-05-01' and created_at <= '2026-05-08T23:59:59';`);
console.log(`GROUND TRUTH (single SQL statement)   revenue €${t.sold_revenue.toFixed(2)}   orders ${t.sold_count}\n`);

const go=async(eng)=>{const res=await fetch(`${U}/functions/v1/api/management-insights?from=2025-05-01&to=2026-05-08&engine=${eng}`,{headers:{Authorization:`Bearer ${JWT}`,apikey:A}}); const j=await res.json(); return j.overview;};
for (let i=1;i<=3;i++){ const o=await go('legacy'); const d=o.revenue-t.sold_revenue;
  console.log(`legacy  run ${i}   €${o.revenue.toFixed(2)}   ${o.sold_count} orders   ${d>0.01?`\x1b[31m+€${d.toFixed(2)} / +${o.sold_count-t.sold_count} orders OVER truth\x1b[0m`:'\x1b[32mmatches truth\x1b[0m'}`); }
for (let i=1;i<=3;i++){ const o=await go('sql'); const d=Math.abs(o.revenue-t.sold_revenue);
  console.log(`sql     run ${i}   €${o.revenue.toFixed(2)}   ${o.sold_count} orders   ${d<0.005?'\x1b[32mmatches truth\x1b[0m':`\x1b[31mΔ €${d.toFixed(2)}\x1b[0m`}`); }
import { readFileSync } from 'node:fs';
const REF='oufoazmnbwugtfldkwsn';
const env={}; for(const l of readFileSync('d:/Dev/archives/elyon-natura/.env','utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if(m) env[m[1]]=m[2];}
const U=env.VITE_SUPABASE_URL, A=env.VITE_SUPABASE_PUBLISHABLE_KEY;
const r=await fetch(`${U}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:A,'Content-Type':'application/json'},body:JSON.stringify({email:'mile@elyon.com',password:process.env.MK_ADMIN_PASSWORD})});
const JWT=(await r.json()).access_token;
const mg=async q=>{const x=await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query:q})}); return JSON.parse(await x.text());};

// GROUND TRUTH straight from Postgres — one statement, no pagination involved.
const [t] = await mg(`select
  coalesce(sum(price),0)::float8 as sold_revenue, count(*)::int as sold_count
  from orders
 where status in ('confirmed','shipped','delivered','paid')
   and (source_type is null or source_type <> 'monadon_legacy')
   and created_at >= '2025-05-01' and created_at <= '2026-05-08T23:59:59';`);
console.log(`GROUND TRUTH (single SQL statement)   revenue €${t.sold_revenue.toFixed(2)}   orders ${t.sold_count}\n`);

const go=async(eng)=>{const res=await fetch(`${U}/functions/v1/api/management-insights?from=2025-05-01&to=2026-05-08&engine=${eng}`,{headers:{Authorization:`Bearer ${JWT}`,apikey:A}}); const j=await res.json(); return j.overview;};
for (let i=1;i<=3;i++){ const o=await go('legacy'); const d=o.revenue-t.sold_revenue;
  console.log(`legacy  run ${i}   €${o.revenue.toFixed(2)}   ${o.sold_count} orders   ${d>0.01?`\x1b[31m+€${d.toFixed(2)} / +${o.sold_count-t.sold_count} orders OVER truth\x1b[0m`:'\x1b[32mmatches truth\x1b[0m'}`); }
for (let i=1;i<=3;i++){ const o=await go('sql'); const d=Math.abs(o.revenue-t.sold_revenue);
  console.log(`sql     run ${i}   €${o.revenue.toFixed(2)}   ${o.sold_count} orders   ${d<0.005?'\x1b[32mmatches truth\x1b[0m':`\x1b[31mΔ €${d.toFixed(2)}\x1b[0m`}`); }
