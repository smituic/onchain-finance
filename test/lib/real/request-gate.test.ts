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
