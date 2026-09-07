import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));

const BASE = process.env.SMOKE_BASE || 'http://localhost:4173';
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const ROUTES = (process.env.SMOKE_ROUTES || '/,/orders').split(',');

// Log in over the API and plant the session, so the smoke test never depends on
// the shape of the login form.
const r = await fetch(env.VITE_SUPABASE_URL + '/auth/v1/token?grant_type=password', {
  method: 'POST',
  headers: { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const session = await r.json();
if (!session.access_token) { console.error('login failed', r.status); process.exit(1); }
const storageKey = 'sb-' + new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0] + '-auth-token';

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(([k, v]) => { localStorage.setItem(k, v); },
  [storageKey, JSON.stringify({ ...session, expires_at: Math.floor(Date.now() / 1000) + session.expires_in })]);

let failed = 0;
for (const route of ROUTES) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 45000 }).catch(e => errors.push('goto: ' + e.message));
  await page.waitForTimeout(2500);

  // A white screen is an empty #root. This is the check that would have caught
  // both of today's outages; a green build catches neither.
  const rootText = await page.evaluate(() => (document.getElementById('root')?.innerText || '').trim().length);
  // Only uncaught exceptions count. A blocked request or a CORS complaint is
  // noise (running against a local preview, the API's allowlist rejects the
  // origin) — but an uncaught throw is exactly what unmounts the tree and
  // paints the white screen, which is the whole point of this check.
  const fatal = errors.filter(e => !e.startsWith('console: '));

  if (rootText === 0 || fatal.length) {
    failed++;
    console.log(`FAIL ${route}  (rendered ${rootText} chars)`);
    fatal.slice(0, 4).forEach(e => console.log('   ' + e.split('\n')[0]));
  } else {
    console.log(`ok   ${route}  (rendered ${rootText} chars)`);
  }
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
