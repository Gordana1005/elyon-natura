// collabbox-sync — PROBE ONLY (2026-09-28). Answers one question before the
// real sync is built: can a Supabase Edge Function (eu-central-1) reach the
// collabBox server at all? It sends ONE read-only GET to the login page and
// reports status/timing. No credentials, no login, nothing written anywhere.
// Replaced by the real daily sync in the same folder.
const TARGET = "http://146.255.89.49:8081/naturatherapy/Login?";

Deno.serve(async (req) => {
  // The gateway verifies the JWT signature (verify_jwt on); only the
  // service role may call the probe.
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  let role = "";
  try { role = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role ?? ""; } catch { /* no role */ }
  if (role !== "service_role") return new Response("forbidden", { status: 403 });
  const t0 = Date.now();
  try {
    const r = await fetch(TARGET, { signal: AbortSignal.timeout(15000) });
    const body = await r.text();
    return Response.json({
      ok: true, status: r.status, ms: Date.now() - t0, bytes: body.length,
      login_form: /name=["']?password/i.test(body),
      cookie: (r.headers.get("set-cookie") ?? "").includes("JSESSIONID"),
    });
  } catch (e) {
    return Response.json({ ok: false, ms: Date.now() - t0, error: String(e) });
  }
});
