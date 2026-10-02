#!/usr/bin/env node
/**
 * Real-browser smoke test for the deployed CRM.
 *
 * Why this exists: my HTTP-only smoke tests passed even when the deployed
 * JS threw at runtime and the page rendered as a blank white screen. This
 * script loads the production URL in a headless Chromium instance, captures
 * console errors and uncaught exceptions, then asserts that the React app
 * actually mounted (the #root element has children and the page contains
 * the brand text).
 *
 * Usage:
 *   node scripts/smoke-browser.mjs                     # default URL
 *   node scripts/smoke-browser.mjs https://other.app   # custom URL
 *
 * Optional env vars:
 *   SMOKE_EMAIL, SMOKE_PASSWORD — if set, also tests the login flow
 *
 * Exits 0 on pass, non-zero on any failure.
 */
import { chromium } from "@playwright/test";

// MK only — the old default was the Bulgarian project (owner audit 30.09.2026).
const TARGET = process.argv[2] || "https://elyon-natura.vercel.app";
const TIMEOUT_MS = 20_000;

const failures = [];
const note = (msg) => console.log(`  ${msg}`);
const fail = (msg) => {
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

async function main() {
  console.log(`Smoke test: ${TARGET}\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(`${err.name}: ${err.message}`);
  });
  page.on("requestfailed", (req) => {
    if (req.url().endsWith(".js") || req.url().endsWith(".css")) {
      pageErrors.push(`asset failed: ${req.url()} (${req.failure()?.errorText || "unknown"})`);
    }
  });

  // ── Test 1: load the home URL ──
  console.log("Test 1 — load and render");
  try {
    await page.goto(TARGET, { waitUntil: "networkidle", timeout: TIMEOUT_MS });
    pass(`navigated to ${TARGET}`);
  } catch (err) {
    fail(`navigation failed: ${err.message}`);
  }

  // ── Test 2: React mounted into #root ──
  try {
    await page.waitForFunction(
      () => {
        const root = document.querySelector("#root");
        return root && root.children.length > 0;
      },
      { timeout: TIMEOUT_MS },
    );
    pass("#root has children (React mounted)");
  } catch (err) {
    fail("#root never got children — React did not mount");
  }

  // ── Test 3: page contains brand text ──
  try {
    await page.waitForSelector('h1:has-text("Natura Therapy HUB")', { timeout: TIMEOUT_MS });
    pass('page contains "Natura Therapy HUB"');
  } catch (err) {
    fail('"Natura Therapy HUB" text never appeared');
  }

  // ── Test 4: no console errors during load ──
  if (consoleErrors.length === 0) {
    pass("no console errors");
  } else {
    fail(`${consoleErrors.length} console error(s):`);
    for (const e of consoleErrors) note(`  • ${e}`);
  }

  // ── Test 5: no uncaught page errors ──
  if (pageErrors.length === 0) {
    pass("no uncaught page errors");
  } else {
    fail(`${pageErrors.length} uncaught error(s):`);
    for (const e of pageErrors) note(`  • ${e}`);
  }

  // ── Test 6: optional login flow ──
  if (process.env.SMOKE_EMAIL && process.env.SMOKE_PASSWORD) {
    console.log("\nTest 6 — login flow");
    try {
      // Make sure we're on /login
      if (!page.url().endsWith("/login")) {
        await page.goto(`${TARGET}/login`, { waitUntil: "networkidle" });
      }
      await page.fill('input#username', process.env.SMOKE_EMAIL);
      await page.fill('input#password', process.env.SMOKE_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: TIMEOUT_MS });
      pass(`logged in, landed on ${new URL(page.url()).pathname}`);

      // Wait briefly for the dashboard to render and any lazy chunks to load
      await page.waitForTimeout(2000);

      const postLoginConsoleErrors = consoleErrors.length;
      if (postLoginConsoleErrors === 0) pass("no console errors after login");
      else note(`${postLoginConsoleErrors} console errors total (some may be from login)`);
    } catch (err) {
      fail(`login flow failed: ${err.message}`);
    }
  }

  await browser.close();

  console.log("");
  if (failures.length === 0) {
    console.log(`✅ all checks passed (${TARGET})`);
    process.exit(0);
  } else {
    console.log(`❌ ${failures.length} failure(s)`);
    for (const f of failures) console.log(`   ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
