import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch, unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { REAL_API_MAX_BODY_BYTES, checkRealApiRequest } from "@/lib/real/server/request-gate";
import { config as proxyConfig, proxy } from "@/proxy";
import nextConfig from "@/next.config";

const ORIGIN = "http://localhost:3000";
const ENV = { NEXT_PUBLIC_REAL_MODE_ENABLED: "true", NEXT_PUBLIC_REAL_ORIGIN: `${ORIGIN}, https://real.example` };

/**
 * A request as a browser would send it. A string body always travels with its
 * Content-Length, so the helper adds it (3B-2 requires it on body routes) unless
 * the test supplies one itself or sets `noLength` to model a request without it.
 */
function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string; noLength?: boolean } = {}) {
  const headers: Record<string, string> = { ...init.headers };
  const hasLength = Object.keys(headers).some((name) => name.toLowerCase() === "content-length");
  if (init.body !== undefined && !init.noLength && !hasLength) headers["content-length"] = String(new TextEncoder().encode(init.body).byteLength);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers, body: init.body });
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
    expect(proxy(new NextRequest(`${ORIGIN}${LOGIN_VERIFY}`, { method: "POST", headers: { ...JSON_HEADERS, origin: ORIGIN, "content-length": "2" }, body: "{}" }))).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Milestone 3B-2: the declared-length gate (411 / 400 / 413) and the shared
// ceiling. The ceiling was 10 MiB when 3B closed and is 256 KiB (262_144 bytes)
// since the separate post-3B global body-ceiling change.
// ---------------------------------------------------------------------------

const LIMIT = REAL_API_MAX_BODY_BYTES;
const root = path.resolve(__dirname, "../../..");

/** Every route file under app/api/real, as { file, url, methods } — the URL with `[x]` segments filled in. */
function discoverRoutes() {
  const found: { file: string; url: string; methods: string[] }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts") {
        const source = readFileSync(full, "utf8");
        const methods = [...source.matchAll(/export async function (GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)\(/g)].map((match) => match[1]!);
        const relative = path.relative(root, full).split(path.sep).join("/");
        const url = "/" + relative.replace(/^app\//, "").replace(/\/route\.ts$/, "").replace(/\[[^\]]+\]/g, "seg-1");
        found.push({ file: relative, url, methods });
      }
    }
  };
  walk(path.join(root, "app/api/real"));
  return found;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const unsafeRoutes = discoverRoutes().flatMap((route) => route.methods.filter((method) => UNSAFE.has(method)).map((method) => ({ ...route, method })));
/** The six route files that take no body (the gate's BODYLESS_ROUTES). */
const BODYLESS_FILES = [
  "app/api/real/account/register/options/route.ts",
  "app/api/real/account/login/options/route.ts",
  "app/api/real/account/passkeys/backup/step-up/options/route.ts",
  "app/api/real/account/passkeys/[credentialId]/revoke/options/route.ts",
  "app/api/real/payments/[id]/cancel/route.ts",
  "app/api/real/session/route.ts",
];
const bodyRoutes = unsafeRoutes.filter((route) => !BODYLESS_FILES.includes(route.file));
const bodylessRoutes = unsafeRoutes.filter((route) => BODYLESS_FILES.includes(route.file));

const gateAt = (url: string, method: string, headers: Record<string, string>) => checkRealApiRequest(new Request(`${ORIGIN}${url}`, { method, headers }), ENV);
const json = (extra: Record<string, string> = {}) => ({ ...JSON_HEADERS, origin: ORIGIN, ...extra });
const LENGTH_REQUIRED = { error: "Unsupported request.", code: "length_required" };
const TOO_LARGE = { error: "This request is too large.", code: "request_too_large" };
const NOT_ALLOWED = { error: "Request not allowed." };

describe("3B-2 classification — which routes the length rule covers", () => {
  it("the repository has exactly 22 body-reading unsafe routes and 6 bodyless ones, and the gate's classification agrees with the files", () => {
    expect(bodyRoutes).toHaveLength(22);
    expect(bodylessRoutes).toHaveLength(6);
    expect(unsafeRoutes).toHaveLength(28);
    // Every route file the test treats as body-reading really calls a JSON body reader; none of the bodyless ones does.
    for (const route of unsafeRoutes) {
      const reads = /readJsonBody|readBoundedJsonBody/.test(readFileSync(path.join(root, route.file), "utf8"));
      expect(reads, route.file).toBe(!BODYLESS_FILES.includes(route.file));
    }
  });

  it.each(bodyRoutes)("A. $method $url (a body route) is subject to the length rule", (route) => {
    const response = gateAt(route.url, route.method, json());
    expect(response?.status).toBe(411);
  });

  it.each(bodylessRoutes)("B. $method $url (bodyless) stays exempt: no Content-Type and no Content-Length needed", (route) => {
    expect(gateAt(route.url, route.method, { origin: ORIGIN })).toBeNull();
    expect(gateAt(route.url, route.method, {})).toBeNull();
    // ...but the Origin and Fetch Metadata checks still apply to them.
    expect(gateAt(route.url, route.method, { origin: "https://evil.example" })?.status).toBe(403);
  });

  it("B. DELETE /api/real/session works with no Content-Length and with an explicit zero", () => {
    expect(gateAt("/api/real/session", "DELETE", { origin: ORIGIN })).toBeNull();
    expect(gateAt("/api/real/session", "DELETE", { origin: ORIGIN, "content-length": "0" })).toBeNull();
  });

  it("C. GET, HEAD and OPTIONS are untouched by the length rule, with or without a length", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      for (const url of ["/api/real/session", "/api/real/payments/prepare", "/api/real/account/profile"]) {
        expect(gateAt(url, method, { origin: ORIGIN }), `${method} ${url}`).toBeNull();
        expect(gateAt(url, method, { origin: ORIGIN, "content-length": String(LIMIT + 1) }), `${method} ${url} oversized`).toBeNull();
        expect(gateAt(url, method, { origin: ORIGIN, "content-length": "garbage" }), `${method} ${url} garbage`).toBeNull();
      }
    }
  });

  it("a body route nobody has written yet is covered by default (any path not on the bodyless list)", () => {
    expect(gateAt("/api/real/future/new-thing", "POST", json())?.status).toBe(411);
    expect(gateAt("/api/real/future/new-thing", "PUT", json())?.status).toBe(411);
    expect(gateAt("/api/real/future/new-thing", "DELETE", json())?.status).toBe(411);
  });

  it("with Real Mode disabled the gate still steps aside completely (routes answer 404 themselves)", () => {
    expect(checkRealApiRequest(new Request(`${ORIGIN}/api/real/payments/prepare`, { method: "POST", headers: JSON_HEADERS }), {})).toBeNull();
  });
});

describe("3B-2 Content-Length — missing, malformed, unsafe, too large, and at the limit", () => {
  it("D/E. a missing Content-Length is HTTP 411 with the exact body, no Retry-After and nothing retryable", async () => {
    const response = gateAt("/api/real/payments/prepare", "POST", json())!;
    expect(response.status).toBe(411);
    expect(await response.json()).toEqual(LENGTH_REQUIRED);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("D. a chunked request (Transfer-Encoding, no length) to a body route is refused the same way", () => {
    expect(gateAt("/api/real/payments/submit", "POST", json({ "transfer-encoding": "chunked" }))?.status).toBe(411);
    // A request that carries a length is judged by that length, not by how the client framed it.
    expect(gateAt("/api/real/payments/submit", "POST", json({ "transfer-encoding": "chunked", "content-length": "10" }))).toBeNull();
  });

  it("F. a declared length of exactly 262,144 bytes (256 KiB) passes the gate on every body route", () => {
    expect(LIMIT).toBe(262_144);
    for (const route of bodyRoutes) expect(gateAt(route.url, route.method, json({ "content-length": String(LIMIT) })), route.url).toBeNull();
  });

  it("F. the boundary on every body route: 262,143 and 262,144 are admitted, 262,145 is the gate's 413", () => {
    for (const route of bodyRoutes) {
      expect(gateAt(route.url, route.method, json({ "content-length": "262143" })), `${route.url} 262143`).toBeNull();
      expect(gateAt(route.url, route.method, json({ "content-length": "262144" })), `${route.url} 262144`).toBeNull();
      expect(gateAt(route.url, route.method, json({ "content-length": "262145" }))?.status, `${route.url} 262145`).toBe(413);
    }
  });

  it("F. the previous 10 MiB ceiling is gone: a declared 10 MiB (and 10 MiB + 1) is now the gate's 413 on every body route", async () => {
    for (const route of bodyRoutes) {
      for (const declared of ["10485760", "10485761"]) {
        const response = gateAt(route.url, route.method, json({ "content-length": declared }))!;
        expect(response.status, `${route.url} ${declared}`).toBe(413);
        expect(await response.json(), `${route.url} ${declared}`).toEqual(TOO_LARGE);
      }
    }
  });

  it("F. Content-Length: 0 passes the gate; the route's own validation then rejects the empty body", () => {
    for (const route of bodyRoutes) expect(gateAt(route.url, route.method, json({ "content-length": "0" })), route.url).toBeNull();
  });

  it("F. leading zeros are plain decimal digits: they are read as the number they spell", () => {
    expect(gateAt("/api/real/payments/prepare", "POST", json({ "content-length": "000262144" }))).toBeNull();
    expect(gateAt("/api/real/payments/prepare", "POST", json({ "content-length": "000262145" }))?.status).toBe(413);
  });

  it("G/H. one byte above the ceiling is HTTP 413 with the exact body on every body route, and nothing is echoed or retryable", async () => {
    for (const route of bodyRoutes) {
      const response = gateAt(route.url, route.method, json({ "content-length": String(LIMIT + 1) }))!;
      expect(response.status, route.url).toBe(413);
      expect(await response.json(), route.url).toEqual(TOO_LARGE);
      expect(response.headers.get("retry-after"), route.url).toBeNull();
    }
    expect(gateAt("/api/real/payments/prepare", "POST", json({ "content-length": "9007199254740991" }))?.status).toBe(413);
  });

  it("I. anything but plain decimal digits is HTTP 400 in the gate's own convention", async () => {
    for (const bad of ["abc", "-1", "+5", "1e3", "5.0", "0x10", "", "5,5", "5, 5", "1_000", "\u00b2"]) {
      const response = gateAt("/api/real/payments/prepare", "POST", json({ "content-length": bad }));
      expect(response?.status, JSON.stringify(bad)).toBe(400);
      expect(await response?.json(), JSON.stringify(bad)).toEqual(NOT_ALLOWED);
    }
  });

  it("J. a value that is not a safe integer is HTTP 400, even though it is all digits", () => {
    for (const unsafe of ["9007199254740992", "9007199254740993", "99999999999999999999", "1".repeat(400)]) {
      expect(gateAt("/api/real/payments/prepare", "POST", json({ "content-length": unsafe }))?.status, unsafe.slice(0, 24)).toBe(400);
    }
  });

  it("K. a duplicated or combined Content-Length cannot slip through: two headers, even equal ones, are a list and are refused", () => {
    const duplicated = new Headers({ ...json() });
    duplicated.append("content-length", "5");
    duplicated.append("content-length", "5");
    expect(checkRealApiRequest(new Request(`${ORIGIN}/api/real/payments/prepare`, { method: "POST", headers: duplicated }), ENV)?.status).toBe(400);

    const mixed = new Headers({ ...json() });
    mixed.append("content-length", "5");
    mixed.append("content-length", String(LIMIT + 1));
    expect(checkRealApiRequest(new Request(`${ORIGIN}/api/real/payments/prepare`, { method: "POST", headers: mixed }), ENV)?.status).toBe(400);

    for (const combined of ["5, 5", "5,5", `5, ${LIMIT + 1}`, `${LIMIT + 1}, 5`, "5 5"]) {
      expect(gateAt("/api/real/payments/prepare", "POST", json({ "content-length": combined }))?.status, combined).toBe(400);
    }
  });

  it("Q. no refusal from the new rule is retryable: no Retry-After header and no `retryable` field", async () => {
    for (const headers of [json(), json({ "content-length": "x" }), json({ "content-length": String(LIMIT + 1) })]) {
      const response = gateAt("/api/real/payments/prepare", "POST", headers)!;
      expect(response.headers.get("retry-after")).toBeNull();
      expect(Object.keys((await response.json()) as object)).not.toContain("retryable");
    }
  });
});

describe("3B-2 ordering — the existing checks run first", () => {
  it("L. a foreign Origin or cross-site fetch is 403 whatever the length", () => {
    for (const length of [undefined, "0", "bad", String(LIMIT + 1)]) {
      const lengthHeader: Record<string, string> = length === undefined ? {} : { "content-length": length };
      expect(gateAt("/api/real/payments/prepare", "POST", { ...JSON_HEADERS, origin: "https://evil.example", ...lengthHeader })?.status, String(length)).toBe(403);
      expect(gateAt("/api/real/payments/prepare", "POST", { ...JSON_HEADERS, "sec-fetch-site": "cross-site", ...lengthHeader })?.status, String(length)).toBe(403);
    }
  });

  it("L. a non-JSON Content-Type is 415 whatever the length", () => {
    for (const length of [undefined, "0", "bad", String(LIMIT + 1)]) {
      const lengthHeader: Record<string, string> = length === undefined ? {} : { "content-length": length };
      expect(gateAt("/api/real/payments/prepare", "POST", { "content-type": "text/plain", origin: ORIGIN, ...lengthHeader })?.status, String(length)).toBe(415);
      expect(gateAt("/api/real/payments/prepare", "POST", { origin: ORIGIN, ...lengthHeader })?.status, String(length)).toBe(415);
    }
  });

  it("L. 403 beats 415 beats the length rule, in that order", () => {
    expect(gateAt("/api/real/payments/prepare", "POST", { "content-type": "text/plain", origin: "https://evil.example" })?.status).toBe(403);
    expect(gateAt("/api/real/payments/prepare", "POST", { "content-type": "text/plain", origin: ORIGIN, "content-length": String(LIMIT + 1) })?.status).toBe(415);
  });
});

describe("3B-2 paths — encoded and unusual spellings cannot reach a body route as if it were bodyless", () => {
  it("M. every spelling the URL parser resolves to a body route still needs a length", () => {
    const spellings = [
      "/api/real/payments/%70repare",
      "/api/real/payments/prepare/",
      "/api/real//payments//prepare",
      "/api/real/payments/./prepare",
      "/api/real/payments/x/../prepare",
      "/api/real/payments/%2e%2e/payments/prepare",
      "/api/real/payments/%2E%2E/payments/prepare",
      "/api/real/account/login/%76erify",
      "/api/real/account/passkeys/seg-1/revoke/%73ubmit",
      "/API/REAL/PAYMENTS/PREPARE",
      "/api/real/session/",
      "/api/real/session%2F",
      "/api/real/payments/seg-1/cancel/",
      "/api/real/payments/seg-1/cancel/extra",
      "/api/real/account/register/options/",
      "/api/real/account/register/options/more",
      "/api/real/account/login/options/..%2fverify",
    ];
    for (const spelling of spellings) {
      const resolved = new URL(`${ORIGIN}${spelling}`).pathname;
      const isExempt = unsafeRoutes.some((route) => BODYLESS_FILES.includes(route.file) && route.method === "POST" && route.url === resolved);
      if (isExempt) continue; // resolves to a genuinely bodyless route: nothing to bypass
      expect(gateAt(spelling, "POST", json())?.status, `${spelling} -> ${resolved}`).toBe(411);
    }
  });

  it("M. dot-segments that resolve onto a body route are judged on the resolved path", () => {
    expect(new URL(`${ORIGIN}/api/real/account/login/options/../verify`).pathname).toBe("/api/real/account/login/verify");
    expect(gateAt("/api/real/account/login/options/../verify", "POST", json())?.status).toBe(411);
    expect(new URL(`${ORIGIN}/api/real/payments/seg/../prepare`).pathname).toBe("/api/real/payments/prepare");
    expect(gateAt("/api/real/payments/seg/../prepare", "POST", json())?.status).toBe(411);
  });

  it("M. an encoded slash inside the id segment of a bodyless route keeps it bodyless-and-exact (it is that route's own id)", () => {
    expect(gateAt("/api/real/payments/a%2Fb/cancel", "POST", { origin: ORIGIN })).toBeNull();
  });

  it("M. the bodyless patterns are anchored: a longer or prefixed path is not exempt", () => {
    for (const url of ["/api/real/x/api/real/session", "/api/real/session/extra", "/api/real/payments/seg-1/cancel/x", "/api/real/payments//cancel", "/api/real/payments/seg-1/seg-2/cancel"]) {
      expect(gateAt(url, "DELETE", json())?.status, url).toBe(411);
    }
  });

  it("M. an exempt method is exempt only on its own route: POST to the DELETE-only session route and DELETE on a POST route are not", () => {
    expect(gateAt("/api/real/session", "POST", json())?.status).toBe(411);
    expect(gateAt("/api/real/payments/seg-1/cancel", "DELETE", json())?.status).toBe(411);
  });
});

describe("3B-2 shared ceiling and the framework's configuration", () => {
  it("N. next.config.ts sets the proxy body-copy limit to the very constant the gate enforces (256 KiB)", () => {
    expect(REAL_API_MAX_BODY_BYTES).toBe(256 * 1024);
    expect(REAL_API_MAX_BODY_BYTES).toBe(262_144);
    expect((nextConfig.experimental as { proxyClientMaxBodySize?: unknown }).proxyClientMaxBodySize).toBe(REAL_API_MAX_BODY_BYTES);
  });

  it("N. the framework limit equals the gate limit exactly (no accepted request can be truncated by the copy, and neither side can drift)", () => {
    const framework = (nextConfig.experimental as { proxyClientMaxBodySize: number }).proxyClientMaxBodySize;
    expect(framework).toBe(REAL_API_MAX_BODY_BYTES);
  });

  it("O. a request the gate admits can still be refused by a route's smaller limit (the 4 KiB policy is untouched)", () => {
    // The gate is a ceiling, not the control limit: 5 000 bytes passes here and is refused by the route (see request-body-limits.test.ts).
    expect(gateAt("/api/real/account/profile", "PATCH", json({ "content-length": "5000" }))).toBeNull();
    expect(gateAt("/api/real/payments/submit", "POST", json({ "content-length": String(LIMIT) }))).toBeNull();
  });

  it("P. the gate and next.config.ts stay inside Real Mode: neither imports Practice, stores, or components", () => {
    for (const file of ["lib/real/server/request-gate.ts", "next.config.ts"]) {
      const imports = [...readFileSync(path.join(root, file), "utf8").matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
      for (const specifier of imports) expect(specifier, file).not.toMatch(/simulation|stores|components|app\//);
    }
  });

  it("the gate imports only ./config and ./http, and neither imports next.config.ts back (no cycle)", () => {
    const gateImports = [...readFileSync(path.join(root, "lib/real/server/request-gate.ts"), "utf8").matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(gateImports.sort()).toEqual(["./config", "./http"]);
    for (const file of ["lib/real/server/http.ts", "lib/real/server/config.ts", "lib/real/server/session.ts"]) {
      const imports = [...readFileSync(path.join(root, file), "utf8").matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
      for (const specifier of imports) expect(specifier, file).not.toMatch(/next\.config|request-gate/);
    }
  });
});
