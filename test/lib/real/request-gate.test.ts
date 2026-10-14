import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch, unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { checkRealApiRequest } from "@/lib/real/server/request-gate";
import { config as proxyConfig, proxy } from "@/proxy";
import nextConfig from "@/next.config";

const ORIGIN = "http://localhost:3000";
const ENV = { NEXT_PUBLIC_REAL_MODE_ENABLED: "true", NEXT_PUBLIC_REAL_ORIGIN: `${ORIGIN}, https://real.example` };

function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers: init.headers, body: init.body });
}

const JSON_HEADERS = { "content-type": "application/json" };
const LOGIN_VERIFY = "/api/real/account/login/verify";
const REGISTER_VERIFY = "/api/real/account/register/verify";

describe("S4 request gate (F1): unsafe /api/real/** requests", () => {
  it("allowed Origin + JSON reaches both cookie-issuing endpoints", () => {
    for (const path of [LOGIN_VERIFY, REGISTER_VERIFY]) {
      expect(checkRealApiRequest(request(path, { headers: { ...JSON_HEADERS, origin: ORIGIN }, body: "{}" }), ENV)).toBeNull();
    }
    // Any configured origin, exactly as configured (list is comma-separated, trimmed).
    expect(checkRealApiRequest(request(LOGIN_VERIFY, { headers: { ...JSON_HEADERS, origin: "https://real.example" }, body: "{}" }), ENV)).toBeNull();
  });

  it("allows same-origin Fetch Metadata and JSON with a charset parameter", () => {
    const allowed = request("/api/real/payments/prepare", {
      headers: { "content-type": "application/json; charset=utf-8", origin: ORIGIN, "sec-fetch-site": "same-origin" },
      body: "{}",
    });
    expect(checkRealApiRequest(allowed, ENV)).toBeNull();
  });

  it("rejects a foreign Origin (403) on cookie-issuing and authenticated routes alike", async () => {
    for (const path of [LOGIN_VERIFY, REGISTER_VERIFY, "/api/real/payments/submit", "/api/real/account/passkeys/cred-1"]) {
      const response = checkRealApiRequest(request(path, { method: path.endsWith("cred-1") ? "PATCH" : "POST", headers: { ...JSON_HEADERS, origin: "https://evil.example" }, body: "{}" }), ENV);
      expect(response?.status).toBe(403);
      expect(await response?.json()).toEqual({ error: "Request not allowed." });
    }
  });

  it("same-site but cross-origin callers, look-alikes, and the opaque 'null' origin all fail the exact comparison", () => {
    for (const origin of ["http://localhost:3001", "https://localhost:3000", "http://sub.localhost:3000", "http://localhost:3000/", "HTTP://LOCALHOST:3000", "null", "https://real.example.evil.com"]) {
      const response = checkRealApiRequest(request(LOGIN_VERIFY, { headers: { ...JSON_HEADERS, origin, "sec-fetch-site": "same-site" }, body: "{}" }), ENV);
      expect(response?.status, origin).toBe(403);
    }
  });

  it("rejects Sec-Fetch-Site: cross-site — even with an allowed Origin, even with no Origin at all", () => {
    expect(checkRealApiRequest(request(LOGIN_VERIFY, { headers: { ...JSON_HEADERS, origin: ORIGIN, "sec-fetch-site": "cross-site" }, body: "{}" }), ENV)?.status).toBe(403);
    expect(checkRealApiRequest(request(LOGIN_VERIFY, { headers: { ...JSON_HEADERS, "sec-fetch-site": "cross-site" }, body: "{}" }), ENV)?.status).toBe(403);
    expect(checkRealApiRequest(request("/api/real/session", { method: "DELETE", headers: { "sec-fetch-site": "Cross-Site" } }), ENV)?.status).toBe(403);
  });

  it("the text/plain (and form) 'simple request' attack shapes can't reach a JSON endpoint — 415, even with an allowed or absent Origin", () => {
    const attackBody = JSON.stringify({ response: { id: "x" } });
    for (const contentType of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx", "application/json-patch+json"]) {
      for (const headers of [{ origin: ORIGIN }, {}] as Record<string, string>[]) {
        const response = checkRealApiRequest(request(LOGIN_VERIFY, { headers: { ...headers, "content-type": contentType }, body: attackBody }), ENV);
        expect(response?.status, contentType).toBe(415);
      }
    }
    // No Content-Type at all on a JSON route is refused too.
    expect(checkRealApiRequest(request("/api/real/payments/prepare", { headers: { origin: ORIGIN } }), ENV)?.status).toBe(415);
  });

  it("missing-Origin policy: a server-side/tool request with no Origin and no Fetch Metadata proceeds (its route still authenticates it)", () => {
    expect(checkRealApiRequest(request(LOGIN_VERIFY, { headers: JSON_HEADERS, body: "{}" }), ENV)).toBeNull();
    expect(checkRealApiRequest(request("/api/real/session", { method: "DELETE" }), ENV)).toBeNull();
  });

  it("body-less routes don't require a Content-Type — but still get the Origin and Fetch Metadata checks", () => {
    const bodyless: [string, string][] = [
      ["POST", "/api/real/account/register/options"],
      ["POST", "/api/real/account/login/options"],
      ["POST", "/api/real/account/passkeys/backup/step-up/options"],
      ["POST", "/api/real/account/passkeys/cred-abc_123/revoke/options"],
      ["POST", "/api/real/payments/0b7d1d3e-4f0e-4a4e-9a0e-3f7b2a1c9d8e/cancel"],
      ["DELETE", "/api/real/session"],
    ];
    for (const [method, path] of bodyless) {
      expect(checkRealApiRequest(request(path, { method, headers: { origin: ORIGIN } }), ENV), path).toBeNull();
      expect(checkRealApiRequest(request(path, { method, headers: { origin: "https://evil.example" } }), ENV)?.status, path).toBe(403);
    }
    // The exemption is exact: a body-consuming sibling isn't covered by it.
    expect(checkRealApiRequest(request("/api/real/account/passkeys/cred-1/revoke/submit", { headers: { origin: ORIGIN } }), ENV)?.status).toBe(415);
    expect(checkRealApiRequest(request("/api/real/session", { method: "POST", headers: { origin: ORIGIN } }), ENV)?.status).toBe(415);
  });

  it("safe methods pass untouched, whatever their Origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(checkRealApiRequest(request("/api/real/session", { method, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), ENV)).toBeNull();
    }
  });

  it("fails closed when no Real origin is configured: any Origin is foreign", () => {
    const env = { NEXT_PUBLIC_REAL_MODE_ENABLED: "true" };
    expect(checkRealApiRequest(request(LOGIN_VERIFY, { headers: { ...JSON_HEADERS, origin: ORIGIN }, body: "{}" }), env)?.status).toBe(403);
  });

  it("with Real Mode disabled the gate steps aside — every route already answers 404", () => {
    expect(checkRealApiRequest(request(LOGIN_VERIFY, { headers: { origin: "https://evil.example" } }), { NEXT_PUBLIC_REAL_ORIGIN: ORIGIN })).toBeNull();
  });
});

describe("3A-1 Stage 1: cross-site protection for the chain-read GETs", () => {
  const BALANCE = "/api/real/account/balance";
  const STATUS = "/api/real/payments/0b7d1d3e-4f0e-4a4e-9a0e-3f7b2a1c9d8e/status";
  const PROTECTED = [BALANCE, STATUS];

  function get(path: string, headers: Record<string, string> = {}, method = "GET") {
    return checkRealApiRequest(request(path, { method, headers }), ENV);
  }

  it("A. a same-origin browser fetch is allowed (with and without Origin/Referer)", () => {
    for (const path of PROTECTED) {
      expect(get(path, { "sec-fetch-site": "same-origin" }), path).toBeNull();
      expect(get(path, { "sec-fetch-site": "same-origin", referer: `${ORIGIN}/pay` }), path).toBeNull();
      expect(get(path, { "sec-fetch-site": "same-origin", origin: ORIGIN, referer: `${ORIGIN}/` }), path).toBeNull();
      expect(get(path, { "sec-fetch-site": "same-origin", referer: "https://real.example/home" }), path).toBeNull();
    }
  });

  it("B/C. cross-site navigation and window.open are refused (403, existing response style)", async () => {
    for (const path of PROTECTED) {
      for (const headers of [
        { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
        { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", referer: "https://evil.example/" },
        { "sec-fetch-site": "cross-site", origin: ORIGIN, referer: `${ORIGIN}/pay` },
      ] as Record<string, string>[]) {
        const response = get(path, headers);
        expect(response?.status, path).toBe(403);
        expect(await response?.json()).toEqual({ error: "Request not allowed." });
      }
    }
  });

  it("D. a same-site sibling subdomain is refused", () => {
    for (const path of PROTECTED) {
      expect(get(path, { "sec-fetch-site": "same-site", origin: "http://sub.localhost:3000" })?.status).toBe(403);
      expect(get(path, { "sec-fetch-site": "same-site" })?.status).toBe(403);
      expect(get(path, { origin: "http://sub.localhost:3000", referer: "http://sub.localhost:3000/" })?.status).toBe(403);
    }
  });

  it("E/M. Sec-Fetch-Site none, empty, unknown, or non-exact values are refused", () => {
    for (const path of PROTECTED) {
      for (const value of ["none", "", "bogus", "same_origin", "same-origin, cross-site", "cross-site, same-origin", "Same-Origin", "SAME-ORIGIN"]) {
        expect(get(path, { "sec-fetch-site": value, referer: `${ORIGIN}/` })?.status, `${path} [${value}]`).toBe(403);
      }
    }
  });

  it("F/N. no Sec-Fetch-Site and no Referer (a non-browser client) is refused — even with a trusted Origin", () => {
    for (const path of PROTECTED) {
      expect(get(path)?.status).toBe(403);
      expect(get(path, { origin: ORIGIN })?.status).toBe(403);
      expect(get(path, { cookie: "session=abc" })?.status).toBe(403);
    }
  });

  it("G. no Sec-Fetch-Site with a trusted Referer is allowed", () => {
    for (const path of PROTECTED) {
      expect(get(path, { referer: `${ORIGIN}/pay` }), path).toBeNull();
      expect(get(path, { referer: ORIGIN }), path).toBeNull();
      expect(get(path, { referer: `${ORIGIN}/pay?x=1#y`, origin: ORIGIN }), path).toBeNull();
      expect(get(path, { referer: "https://real.example/" }), path).toBeNull();
    }
  });

  it("H/I/K. a foreign, malformed, or look-alike Referer is refused", () => {
    for (const path of PROTECTED) {
      for (const referer of [
        "https://evil.example/",
        "not a url",
        "/pay",
        "localhost:3000/pay",
        "",
        "http://localhost:3000.evil.example/",
        "http://localhost:3000@evil.example/",
        "http://evil.example/http://localhost:3000/",
        "http://localhostx:3000/",
        "http://localhost:30000/",
        "https://localhost:3000/",
        "https://real.example.evil.com/",
        "javascript:alert(1)",
        "data:text/html,http://localhost:3000",
      ]) {
        expect(get(path, { referer })?.status, `${path} [${referer}]`).toBe(403);
      }
    }
  });

  it("J/K. an Origin outside the trusted list is refused, whatever else is claimed", () => {
    for (const path of PROTECTED) {
      for (const origin of ["https://evil.example", "null", "http://localhost:3001", "http://localhost:3000/", "HTTP://LOCALHOST:3000", "https://real.example.evil.com", "http://localhost:3000.evil.example", ""]) {
        expect(get(path, { "sec-fetch-site": "same-origin", origin, referer: `${ORIGIN}/` })?.status, `${path} [${origin}]`).toBe(403);
        expect(get(path, { origin, referer: `${ORIGIN}/` })?.status, `${path} [${origin}]`).toBe(403);
      }
    }
  });

  it("L. Host / X-Forwarded-* are never trusted: a foreign Referer is refused even when Host or the request URL says otherwise", () => {
    for (const path of PROTECTED) {
      expect(get(path, { host: "evil.example", referer: "https://evil.example/" })?.status).toBe(403);
      expect(get(path, { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", referer: "https://evil.example/" })?.status).toBe(403);
      expect(get(path, { host: "localhost:3000", "x-forwarded-host": "localhost:3000", referer: "https://evil.example/" })?.status).toBe(403);
      // Host alone proves nothing: the request URL's own origin is not a credential.
      expect(get(path, { host: "localhost:3000" })?.status).toBe(403);
    }
    // A request whose URL is on a foreign host is judged only by the configured list.
    const foreign = checkRealApiRequest(new Request(`https://evil.example${BALANCE}`, { headers: { referer: "https://evil.example/" } }), ENV);
    expect(foreign?.status).toBe(403);
  });

  it("conflicting signals never turn a denial into an allow", () => {
    for (const path of PROTECTED) {
      // Fetch Metadata allows, a foreign Origin or Referer denies.
      expect(get(path, { "sec-fetch-site": "same-origin", origin: "https://evil.example" })?.status).toBe(403);
      expect(get(path, { "sec-fetch-site": "same-origin", referer: "https://evil.example/" })?.status).toBe(403);
      // Trusted Origin/Referer cannot override a hostile Fetch Metadata value.
      expect(get(path, { "sec-fetch-site": "cross-site", origin: ORIGIN, referer: `${ORIGIN}/` })?.status).toBe(403);
      expect(get(path, { "sec-fetch-site": "none", origin: ORIGIN, referer: `${ORIGIN}/` })?.status).toBe(403);
      // A trusted Origin does not excuse a foreign Referer.
      expect(get(path, { origin: ORIGIN, referer: "https://evil.example/" })?.status).toBe(403);
    }
  });

  it("header-name casing and surrounding whitespace do not change a verdict", () => {
    for (const path of PROTECTED) {
      expect(get(path, { "Sec-Fetch-Site": "  same-origin  " }), path).toBeNull();
      expect(get(path, { "SEC-FETCH-SITE": "\tsame-origin" }), path).toBeNull();
      expect(get(path, { Referer: `  ${ORIGIN}/pay  ` }), path).toBeNull();
      expect(get(path, { "Sec-Fetch-Site": "  cross-site  " })?.status).toBe(403);
      expect(get(path, { "sec-fetch-site": " same-origin ", ORIGIN: " https://evil.example " })?.status).toBe(403);
    }
  });

  it("fails closed when no Real origin is configured", () => {
    const env = { NEXT_PUBLIC_REAL_MODE_ENABLED: "true" };
    for (const path of PROTECTED) {
      expect(checkRealApiRequest(request(path, { method: "GET", headers: { referer: `${ORIGIN}/` } }), env)?.status).toBe(403);
      expect(checkRealApiRequest(request(path, { method: "GET", headers: { "sec-fetch-site": "same-origin", origin: ORIGIN } }), env)?.status).toBe(403);
    }
  });

  it("HEAD (answered by the GET handler) is guarded identically", () => {
    for (const path of PROTECTED) {
      expect(get(path, {}, "HEAD")?.status).toBe(403);
      expect(get(path, { "sec-fetch-site": "cross-site" }, "HEAD")?.status).toBe(403);
      expect(get(path, { "sec-fetch-site": "same-origin" }, "HEAD")).toBeNull();
    }
  });

  it("R. both route patterns are matched independently, including encoded, doubled-slash, and trailing-slash spellings", () => {
    // Balance only.
    expect(get(BALANCE)?.status).toBe(403);
    expect(get(STATUS)?.status).toBe(403);
    for (const path of [
      "/api/real/account/%62alance",
      "/api/real/account//balance",
      "/api/real/account/balance/",
      "/api/real/payments/abc%2Dxyz/%73tatus",
      "/api/real/payments//abc/status",
      "/api/real/payments/abc/status/",
      "/api/real/payments/latest/status",
    ]) {
      expect(get(path)?.status, path).toBe(403);
      expect(get(path, { "sec-fetch-site": "same-origin" }), path).toBeNull();
    }
  });

  it("O. unrelated Real GET endpoints are unchanged (still pass untouched, even cross-site)", () => {
    const hostile = { "sec-fetch-site": "cross-site", origin: "https://evil.example", referer: "https://evil.example/" };
    for (const path of [
      "/api/real/payments/latest",
      "/api/real/payments/history",
      "/api/real/session",
      "/api/real/account/passkeys",
      "/api/real/account/passkeys/backup/status",
      "/api/real/account/profile",
      "/api/real/account/handle",
      "/api/real/account/balance/extra",
      "/api/real/account/balances",
      "/api/real/payments/abc/status/extra",
      "/api/real/payments/abc/cancel",
      "/api/real/payments/status",
      "/api/real/recipients/lookup",
      "/api/real/x/api/real/account/balance",
    ]) {
      expect(get(path, hostile), path).toBeNull();
      expect(get(path), path).toBeNull();
    }
  });

  it("OPTIONS on a protected path is left alone (it runs no handler)", () => {
    for (const path of PROTECTED) expect(get(path, { "sec-fetch-site": "cross-site" }, "OPTIONS")).toBeNull();
  });

  it("P. POST/DELETE behavior on the same paths is unchanged: the unsafe-method rules apply, not the read rules", () => {
    for (const path of PROTECTED) {
      // Read rule would demand a Referer or Sec-Fetch-Site; the unsafe rules do not.
      expect(checkRealApiRequest(request(path, { method: "POST", headers: { ...JSON_HEADERS, origin: ORIGIN }, body: "{}" }), ENV)).toBeNull();
      expect(checkRealApiRequest(request(path, { method: "POST", headers: JSON_HEADERS, body: "{}" }), ENV)).toBeNull();
      expect(checkRealApiRequest(request(path, { method: "POST", headers: { origin: ORIGIN } }), ENV)?.status).toBe(415);
      expect(checkRealApiRequest(request(path, { method: "POST", headers: { ...JSON_HEADERS, origin: "https://evil.example" }, body: "{}" }), ENV)?.status).toBe(403);
      expect(checkRealApiRequest(request(path, { method: "DELETE", headers: { "sec-fetch-site": "cross-site" } }), ENV)?.status).toBe(403);
    }
  });

  it("Q. with Real Mode disabled the gate steps aside for the protected reads too", () => {
    for (const path of PROTECTED) {
      expect(checkRealApiRequest(request(path, { method: "GET", headers: { "sec-fetch-site": "cross-site" } }), { NEXT_PUBLIC_REAL_ORIGIN: ORIGIN })).toBeNull();
      expect(checkRealApiRequest(request(path, { method: "GET" }), {})).toBeNull();
      expect(checkRealApiRequest(request(path, { method: "GET", headers: { "sec-fetch-site": "cross-site" } }), { NEXT_PUBLIC_REAL_MODE_ENABLED: "false" })).toBeNull();
    }
  });

  it("is wired through proxy.ts: the same verdicts, refusal as a Response, allow as undefined", () => {
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", ORIGIN);
    try {
      for (const path of PROTECTED) {
        expect(proxy(new NextRequest(`${ORIGIN}${path}`, { headers: { "sec-fetch-site": "cross-site" } }))?.status).toBe(403);
        expect(proxy(new NextRequest(`${ORIGIN}${path}`))?.status).toBe(403);
        expect(proxy(new NextRequest(`${ORIGIN}${path}`, { headers: { "sec-fetch-site": "same-origin" } }))).toBeUndefined();
        expect(proxy(new NextRequest(`${ORIGIN}${path}`, { headers: { referer: `${ORIGIN}/pay` } }))).toBeUndefined();
      }
      expect(proxy(new NextRequest(`${ORIGIN}/api/real/payments/latest`, { headers: { "sec-fetch-site": "cross-site" } }))).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("3A-1 Stage 1 audit follow-ups: URL spelling variants of the protected reads", () => {
  const STATUS_ID = "0b7d1d3e-4f0e-4a4e-9a0e-3f7b2a1c9d8e";
  const get = (path: string, headers: Record<string, string> = {}) => checkRealApiRequest(request(path, { method: "GET", headers }), ENV);
  const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

  it(".rsc: the _rsc query param and RSC request headers never change the verdict for the protected paths", () => {
    const rscHeaders = { rsc: "1", "next-router-state-tree": "%5B%22%22%5D", "next-url": "/pay" };
    for (const path of ["/api/real/account/balance", `/api/real/payments/${STATUS_ID}/status`]) {
      for (const suffix of ["?_rsc=abc12", "?_rsc=", "?a=b&_rsc=x#frag"]) {
        expect(get(`${path}${suffix}`)?.status, `${path}${suffix}`).toBe(403);
        expect(get(`${path}${suffix}`, { ...rscHeaders, "sec-fetch-site": "cross-site" })?.status).toBe(403);
        expect(get(`${path}${suffix}`, { ...rscHeaders, ...SAME_ORIGIN }), `${path}${suffix}`).toBeNull();
      }
      // RSC headers alone grant nothing.
      expect(get(path, rscHeaders)?.status).toBe(403);
    }
  });

  it(".rsc / .json suffixed paths are different paths (route handlers are served only at their exact path); the gate pins that and they are not mistaken for the protected routes", () => {
    for (const path of [
      "/api/real/account/balance.rsc",
      "/api/real/account/balance.segments/_tree.segment.rsc",
      "/api/real/account/balance.json",
      `/api/real/payments/${STATUS_ID}/status.rsc`,
      `/api/real/payments/${STATUS_ID}/status.json`,
    ]) {
      expect(get(path, { "sec-fetch-site": "cross-site" }), path).toBeNull();
    }
  });

  it("undecodable percent-escapes never throw and never open a hole in a dynamic segment", () => {
    for (const id of ["%", "%E0%A4%A", "%ZZ", "%C0%AE", "abc%", "%00", "%E2%82"]) {
      const path = `/api/real/payments/${id}/status`;
      expect(() => get(path)).not.toThrow();
      expect(get(path)?.status, path).toBe(403); // raw spelling still matches [^/]+
      expect(get(path, SAME_ORIGIN), path).toBeNull();
    }
    // An undecodable STATIC segment can't be the protected route; it must simply not throw.
    for (const path of ["/api/real/account/bal%ance", "/api/real/account/%E0%A4%A", "/api/real/payments/%zz"]) {
      expect(() => get(path)).not.toThrow();
    }
  });

  it("encoded and double-encoded spellings: one decode only, matching what the router does", () => {
    // Each decodes once to a protected path.
    for (const path of ["/api/real/account/%62alance", `/api/real/payments/${STATUS_ID}/%73tatus`, "/api/real/payments/x%2Fstatus"]) {
      expect(get(path)?.status, path).toBe(403);
      expect(get(path, SAME_ORIGIN), path).toBeNull();
    }
    // The dynamic id is an opaque segment: double-encoding inside it changes nothing.
    expect(get("/api/real/payments/%2561bc/status")?.status).toBe(403);
    // Double-encoding a static part decodes (once) to a literal "%62alance" / "x%2Fstatus", which is not a protected route.
    expect(get("/api/real/account/%2562alance", { "sec-fetch-site": "cross-site" })).toBeNull();
    expect(get("/api/real/payments/x%252Fstatus", { "sec-fetch-site": "cross-site" })).toBeNull();
  });

  it("case variants are different paths (routes are case-sensitive) and stay untouched; the exact lowercase paths stay protected", () => {
    for (const path of [
      "/API/real/account/balance",
      "/api/REAL/account/balance",
      "/api/real/account/Balance",
      "/api/real/account/BALANCE",
      `/api/real/payments/${STATUS_ID}/Status`,
      `/api/real/payments/${STATUS_ID}/STATUS`,
    ]) {
      expect(get(path, { "sec-fetch-site": "cross-site" }), path).toBeNull();
    }
    expect(get("/api/real/account/balance", { "sec-fetch-site": "cross-site" })?.status).toBe(403);
  });
});

describe("S4 proxy.ts wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("matches every /api/real/** path and nothing else", () => {
    for (const url of ["/api/real", "/api/real/session", LOGIN_VERIFY, "/api/real/account/passkeys/abc/revoke/options"]) {
      expect(unstable_doesMiddlewareMatch({ config: proxyConfig, url }), url).toBe(true);
    }
    for (const url of ["/", "/pay", "/api/other", "/api/realx/session"]) {
      expect(unstable_doesMiddlewareMatch({ config: proxyConfig, url }), url).toBe(false);
    }
  });

  it("refuses a cross-origin unsafe request and lets an allowed one through (undefined = continue)", async () => {
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", ORIGIN);
    const refused = proxy(new NextRequest(`${ORIGIN}${LOGIN_VERIFY}`, { method: "POST", headers: { ...JSON_HEADERS, origin: "https://evil.example" }, body: "{}" }));
    expect(refused?.status).toBe(403);
    const plain = proxy(new NextRequest(`${ORIGIN}${REGISTER_VERIFY}`, { method: "POST", headers: { "content-type": "text/plain", origin: ORIGIN }, body: "{}" }));
    expect(plain?.status).toBe(415);
    expect(proxy(new NextRequest(`${ORIGIN}${LOGIN_VERIFY}`, { method: "POST", headers: { ...JSON_HEADERS, origin: ORIGIN }, body: "{}" }))).toBeUndefined();
  });
});

describe("S4 static security headers (F5) — next.config.ts as Next applies it", () => {
  it("every page and API response carries exactly the three intended headers — no HSTS, no script/style CSP", async () => {
    for (const url of [`${ORIGIN}/`, `${ORIGIN}/pay`, `${ORIGIN}/api/real/session`]) {
      const response = await unstable_getResponseFromNextConfig({ url, nextConfig });
      expect(response.headers.get("content-security-policy"), url).toBe("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options"), url).toBe("DENY");
      expect(response.headers.get("x-content-type-options"), url).toBe("nosniff");
      expect(response.headers.get("strict-transport-security"), url).toBeNull();
    }
  });
});
