/**
 * collabbox-shops — the collabBox client. READ-ONLY by construction: every request passes
 * shops.ts isAllowed() (login, the five report forms, searchdoc / repbydocitm / infollc / lnp /
 * tkreport with the exact shapes of docs/SHOPS.md) before it is sent; anything else — an export,
 * submitCombo, a saved search, addcustom / deletecustom, labels, the basket, the notepad, ltd, mp,
 * plrwc — is refused. Twin of supabase/functions/collabbox-sync/client.ts (same transport, same
 * login, same session handling) with its own allow-list.
 *
 * Strictly sequential, ≥ 1,5 s between two requests, a hard request cap per run, one re-login when
 * the server answers with its login page. Credentials come from the caller (COLLABBOX_USER /
 * COLLABBOX_PASS — the same function secrets collabbox-sync uses) and are never logged; session ids
 * are redacted from every line. `fetch` is injected, so this file has no Deno dependency.
 */
import {
  PATHS, infollcBody, isAllowed, isLoginPage, itemsBody, lnpBody, parseDocHeaders, parseInfollc, parseLinesReport,
  parseLnp, parseShopSums, parseTkreport, redact, searchDocBody, tkreportBody,
} from "./shops.ts";
import type { DocHeadersPage, ItemsOptions, LinesPage, PeriodPage, StockPage, TkPage } from "./shops.ts";

export const COLLABBOX_BASE = "http://146.255.89.49:8081/naturatherapy/";
/** The politeness floor: never two requests closer than this (docs/SHOPS.md). */
export const MIN_PAUSE_MS = 1_500;

export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null; getSetCookie?: () => string[] };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: {
  method: string; body?: string; redirect: "manual"; headers: Record<string, string>; signal?: AbortSignal;
}) => Promise<ResponseLike>;

export class RequestCapError extends Error {}
export class CollabboxError extends Error {}

export interface ClientOptions {
  fetch: FetchLike;
  user: string;
  pass: string;
  base?: string;
  /** hard stop per run — a bug can never hammer their production ERP */
  maxRequests: number;
  /** politeness gap between two requests (raised to MIN_PAUSE_MS) */
  pauseMs: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

type FormKey = "items" | "infollc" | "lnp" | "tkreport";
const FORM_PATH: Record<FormKey, string> = {
  items: PATHS.itemsForm, infollc: PATHS.infollcForm, lnp: PATHS.lnpForm, tkreport: PATHS.tkreportForm,
};

export class ShopsClient {
  requests = 0;
  logins = 0;
  slowestMs = 0;
  readonly byKind: Record<string, number> = {};
  private readonly opts: ClientOptions;
  private readonly jar = new Map<string, string>();
  private readonly forms = new Map<FormKey, string>();
  private readonly base: string;
  private readonly pauseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private lastAt = 0;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.base = opts.base ?? COLLABBOX_BASE;
    this.pauseMs = Math.max(MIN_PAUSE_MS, opts.pauseMs);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
  }

  get remaining(): number { return Math.max(0, this.opts.maxRequests - this.requests); }

  private async http(method: string, path: string, body: string | null = null, kind = "other"): Promise<string> {
    if (!isAllowed(method, path, body)) throw new CollabboxError(`refusing a non-allow-listed request: ${method} ${redact(path.split("?")[0])}`);
    if (this.requests >= this.opts.maxRequests) throw new RequestCapError(`request cap ${this.opts.maxRequests} reached`);
    this.requests++;
    this.byKind[kind] = (this.byKind[kind] ?? 0) + 1;
    const wait = this.lastAt + this.pauseMs - this.now();
    if (this.requests > 1 && wait > 0) await this.sleep(wait);
    const t0 = this.now();
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (compatible) elyon-collabbox-shops/1 (read-only)",
      Accept: "text/html,application/xhtml+xml,*/*",
    };
    if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    let res: ResponseLike;
    try {
      const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
        ? AbortSignal.timeout(this.opts.timeoutMs ?? 120_000) : undefined;
      res = await this.opts.fetch(this.base + path, { method, body: body ?? undefined, redirect: "manual", headers, signal });
    } catch (e) {
      this.lastAt = this.now();
      throw new CollabboxError(`network error on ${method} ${redact(path.split("&")[0])}: ${redact((e as Error)?.message ?? e)}`);
    }
    const cookies = res.headers.getSetCookie?.() ?? splitSetCookie(res.headers.get("set-cookie"));
    for (const c of cookies) {
      const kv = c.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    const text = await res.text();
    this.lastAt = this.now();
    const ms = this.lastAt - t0;
    this.slowestMs = Math.max(this.slowestMs, ms);
    this.log(`#${this.requests} ${method} ${redact(path.split("&")[0])} [${kind}] → ${res.status} ${text.length} B ${ms} ms`);
    if (res.status !== 200) throw new CollabboxError(`HTTP ${res.status} for ${method} ${redact(path.split("&")[0])}`);
    return text;
  }

  /** GET Login? (sets JSESSIONID) → POST Login; success = the redirect to ./Index? */
  async login(): Promise<void> {
    this.jar.clear();
    this.forms.clear();
    await this.http("GET", PATHS.loginForm, null, "login");
    const body = new URLSearchParams({ company_code: "", username: this.opts.user, password: this.opts.pass, browserIsIE: "0" }).toString();
    const t = await this.http("POST", PATHS.login, body, "login");
    if (!t.includes("location.href='./Index?'")) throw new CollabboxError("collabBox login failed (COLLABBOX_USER / COLLABBOX_PASS rejected?)");
    this.logins++;
    this.log("logged in");
  }

  /** One retry with a fresh session when the server bounced the request to its login page. */
  private async authed(method: string, path: string, body: () => Promise<string | null>, kind: string): Promise<string> {
    let t = await this.http(method, path, await body(), kind);
    if (isLoginPage(t)) {
      this.log("session expired — logging in again");
      await this.login();
      t = await this.http(method, path, await body(), kind);
      if (isLoginPage(t)) throw new CollabboxError("still bounced to the login page after a fresh login");
    }
    return t;
  }

  /** A report form as the browser receives it (display only; cached for the session). */
  private async form(key: FormKey): Promise<string> {
    let html = this.forms.get(key);
    if (!html) {
      html = await this.authed("GET", FORM_PATH[key], async () => null, `form:${key}`);
      if (!/<form[^>]*name\s*=\s*"?searchform"?/i.test(html)) throw new CollabboxError(`the ${key} form did not load (layout changed?)`);
      this.forms.set(key, html);
    }
    return html;
  }

  /** Document lines (repbydocitm, HTML table). */
  async lines(o: ItemsOptions): Promise<LinesPage> {
    const html = await this.authed("POST", PATHS.items, async () => itemsBody(await this.form("items"), o), "lines");
    const page = parseLinesReport(html);
    if (page.problem) throw new CollabboxError(`repbydocitm ${o.fromDmy}..${o.toDmy}: ${page.problem}`);
    if (!page.lines.length && !page.noResults && !page.hasTable) throw new CollabboxError(`repbydocitm ${o.fromDmy}..${o.toDmy}: no rows and no "no results" message (layout changed?)`);
    return page;
  }

  /** Per-shop sums of the same report (one row per out-warehouse). */
  async shopSums(o: Omit<ItemsOptions, "sumsByShop">) {
    const html = await this.authed("POST", PATHS.items, async () => itemsBody(await this.form("items"), { ...o, sumsByShop: true }), "sums");
    return parseShopSums(html);
  }

  /** Document headers (searchdoc), all rows in one page; the count is checked. */
  async headers(types: readonly string[], fromDmy: string, toDmy: string, withNatura = false): Promise<DocHeadersPage> {
    const html = await this.authed("POST", PATHS.searchdoc, async () => searchDocBody(types, fromDmy, toDmy, withNatura), "headers");
    const page = parseDocHeaders(html);
    if (page.problem) throw new CollabboxError(`searchdoc ${fromDmy}..${toDmy}: ${page.problem}`);
    return page;
  }

  /** Stock of one shop as of a day (infollc). */
  async stock(magid: number, asOfDmy: string): Promise<StockPage> {
    const html = await this.authed("POST", PATHS.infollc, async () => infollcBody(await this.form("infollc"), magid, asOfDmy), "stock");
    const page = parseInfollc(html);
    if (page.problem) throw new CollabboxError(`infollc ${magid} ${asOfDmy}: ${page.problem}`);
    return page;
  }

  /** Opening / in / out / closing of one shop over a period (lnp, ~30 s on their side). */
  async period(magid: number, fromDmy: string, toDmy: string): Promise<PeriodPage> {
    const html = await this.authed("POST", PATHS.lnp, async () => lnpBody(await this.form("lnp"), magid, fromDmy, toDmy), "lnp");
    const page = parseLnp(html);
    if (page.problem) throw new CollabboxError(`lnp ${magid} ${fromDmy}..${toDmy}: ${page.problem}`);
    return page;
  }

  /** The trade book per shop: all payments, or cash only. */
  async tradeBook(fromDmy: string, toDmy: string, payments: "all" | "cash"): Promise<TkPage> {
    const html = await this.authed("POST", PATHS.tkreport, async () => tkreportBody(await this.form("tkreport"), fromDmy, toDmy, payments), `tk:${payments}`);
    const page = parseTkreport(html);
    if (page.problem) throw new CollabboxError(`tkreport ${fromDmy}..${toDmy}: ${page.problem}`);
    return page;
  }
}

/** A combined Set-Cookie header (runtimes without getSetCookie) → the individual cookies. */
export function splitSetCookie(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(/,(?=\s*[A-Za-z0-9_\-.]+=)/).map((s) => s.trim()).filter(Boolean);
}
