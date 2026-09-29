/**
 * collabbox-sync — the collabBox client. READ-ONLY by construction: an allow-list of the only
 * request shapes the sync uses (isAllowed); everything else — saving a search, the discount action
 * form, creating documents, e-mailing an export, the Excel exports — is refused before it is sent.
 *
 * Plain HTTP to http://146.255.89.49:8081/naturatherapy/ (Tomcat), one JSESSIONID cookie, UTF-8.
 * Strictly sequential, a pause between requests, a hard request cap per run, one re-login when the
 * server answers with its login redirect. Credentials come from the caller (COLLABBOX_USER /
 * COLLABBOX_PASS function secrets) and are never logged; session ids are redacted from every line.
 *
 * `fetch` is injected (the platform fetch in the Edge Function, a fake in collabbox.test.ts), so
 * this file has no Deno dependency. Protocol: scripts/collabbox-fetch.mjs header §0–§4.
 */
import {
  KOMITENT_SEARCH_PATH, headersProblem, headersSearchBody, isLoginPage, itemsSearchBody,
  komitentSearchBody, parseHeaders, parseItemsHtml, parseKomitentSearch, redact,
} from "./collabbox.ts";
import type { HeadersPage, ItemRow, KomitentRow } from "./collabbox.ts";

export const COLLABBOX_BASE = "http://146.255.89.49:8081/naturatherapy/";

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
  /** politeness gap between two requests */
  pauseMs: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** The only request shapes the sync may send (method + path + the form's own mode). */
export function isAllowed(method: string, path: string, body: string | null | undefined): boolean {
  const p = path.split("#")[0];
  const form = body ? new URLSearchParams(body) : null;
  return (method === "GET" && p === "Login?")
    || (method === "POST" && p === "Login")
    || (method === "POST" && p === "Index?comp=searchdoc&action=search" && form?.get("searchMode") === "search")
    || (method === "GET" && p === "Index?comp=repbydocitm")
    || (method === "POST" && p === "Index?comp=repbydocitm" && form?.get("searchMode") === "doSearch" && form?.get("mode") === "doSearch")
    || (method === "POST" && p === KOMITENT_SEARCH_PATH && form?.get("searchMode") === "search" && /^\d{1,10}$/.test(form?.get("id") ?? ""));
}

export class CollabboxClient {
  requests = 0;
  logins = 0;
  slowestMs = 0;
  private readonly jar = new Map<string, string>();
  private itemsFormHtml: string | null = null;
  private readonly base: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ClientOptions) {
    this.base = opts.base ?? COLLABBOX_BASE;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
  }

  get remaining(): number { return Math.max(0, this.opts.maxRequests - this.requests); }

  private async http(method: string, path: string, body: string | null = null): Promise<string> {
    if (!isAllowed(method, path, body)) throw new CollabboxError(`refusing a non-allow-listed request: ${method} ${redact(path.split("?")[0])}`);
    if (this.requests >= this.opts.maxRequests) throw new RequestCapError(`request cap ${this.opts.maxRequests} reached`);
    this.requests++;
    if (this.requests > 1) await this.sleep(this.opts.pauseMs);
    const t0 = Date.now();
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (compatible) elyon-collabbox-sync/1 (read-only)",
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
      throw new CollabboxError(`network error on ${method} ${redact(path.split("&")[0])}: ${redact((e as Error)?.message ?? e)}`);
    }
    const cookies = res.headers.getSetCookie?.() ?? splitSetCookie(res.headers.get("set-cookie"));
    for (const c of cookies) {
      const kv = c.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    const text = await res.text();
    const ms = Date.now() - t0;
    this.slowestMs = Math.max(this.slowestMs, ms);
    this.log(`#${this.requests} ${method} ${redact(path.split("&")[0])} → ${res.status} ${text.length} B ${ms} ms`);
    if (res.status !== 200) throw new CollabboxError(`HTTP ${res.status} for ${method} ${redact(path.split("&")[0])}`);
    return text;
  }

  /** GET Login? (sets JSESSIONID) → POST Login; success = the redirect to ./Index? */
  async login(): Promise<void> {
    this.jar.clear();
    this.itemsFormHtml = null;
    await this.http("GET", "Login?");
    const body = new URLSearchParams({ company_code: "", username: this.opts.user, password: this.opts.pass, browserIsIE: "0" }).toString();
    const t = await this.http("POST", "Login", body);
    if (!t.includes("location.href='./Index?'")) throw new CollabboxError("collabBox login failed (COLLABBOX_USER / COLLABBOX_PASS rejected?)");
    this.logins++;
    this.log("logged in");
  }

  /** One retry with a fresh session when the server bounced the request to its login page. */
  private async authed(method: string, path: string, body: string | null, rebuild?: () => Promise<string>): Promise<string> {
    let t = await this.http(method, path, body);
    if (isLoginPage(t)) {
      this.log("session expired — logging in again");
      await this.login();
      t = await this.http(method, path, rebuild ? await rebuild() : body);
      if (isLoginPage(t)) throw new CollabboxError("still bounced to the login page after a fresh login");
    }
    return t;
  }

  /** §2 — every document of `types` dated [from, to] (dd.mm.yyyy), all rows in one page. */
  async searchHeaders(types: readonly string[], fromDmy: string, toDmy: string): Promise<HeadersPage> {
    const html = await this.authed("POST", "Index?comp=searchdoc&action=search", headersSearchBody(types, fromDmy, toDmy));
    const page = parseHeaders(html);
    const problem = headersProblem(page);
    if (problem) throw new CollabboxError(`searchdoc ${fromDmy}..${toDmy}: ${problem}`);
    return page;
  }

  private async itemsForm(): Promise<string> {
    if (!this.itemsFormHtml) this.itemsFormHtml = await this.authed("GET", "Index?comp=repbydocitm", null);
    return this.itemsFormHtml;
  }

  /** §3(a) — the line items of `types` dated [from, to], HTML table mode (leaves no file on their server). */
  async searchItems(types: readonly string[], fromDmy: string, toDmy: string): Promise<ItemRow[]> {
    const build = async () => itemsSearchBody(await this.itemsForm(), types, fromDmy, toDmy);
    const html = await this.authed("POST", "Index?comp=repbydocitm", await build(), async () => {
      this.itemsFormHtml = null;
      return build();
    });
    const page = parseItemsHtml(html);
    if (page.items.length) return page.items;
    if (page.noResults) return [];
    throw new CollabboxError(`repbydocitm ${fromDmy}..${toDmy}: no rows and no "no results" message (layout changed?)`);
  }

  /** The komitent card by Шифра (Коминтенти search). null = not found. */
  async readKomitent(komitentId: string): Promise<KomitentRow | null> {
    if (!/^\d{1,10}$/.test(komitentId)) return null;
    const html = await this.authed("POST", KOMITENT_SEARCH_PATH, komitentSearchBody(komitentId));
    const { rows, hasTable } = parseKomitentSearch(html);
    if (!hasTable && !/Не се пронајдени|не врати резултати/i.test(html)) {
      throw new CollabboxError(`infocc ${komitentId}: unrecognised answer (layout changed?)`);
    }
    return rows.find((r) => r.komitentId === komitentId) ?? null;
  }
}

/** A combined Set-Cookie header (runtimes without getSetCookie) → the individual cookies. */
export function splitSetCookie(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(/,(?=\s*[A-Za-z0-9_\-.]+=)/).map((s) => s.trim()).filter(Boolean);
}
