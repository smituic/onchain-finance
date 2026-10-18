import { isRealModeEnabled, readExpectedOrigins } from "./config";
import { requestTooLargeResponse } from "./http";

/**
 * S4 request gate for every /api/real/** call, run centrally by the root
 * proxy.ts before any route handler. Framework-agnostic (plain Request/
 * Response) so it stays inside lib/real's fence and is unit-testable.
 *
 * Safe methods (GET/HEAD/OPTIONS) pass untouched, EXCEPT the chain-read GETs
 * in PROTECTED_READS below (3A-1 Stage 1), which get a cross-site check of
 * their own (see checkProtectedRead). For every other method:
 *
 *  1. `Sec-Fetch-Site: cross-site` is refused outright.
 *  2. An `Origin` header, when present, must EXACTLY equal one of the
 *     configured Real origins (NEXT_PUBLIC_REAL_ORIGIN — the same list
 *     WebAuthn verifies against). Same-site-but-cross-origin callers and the
 *     opaque "null" origin fail this comparison.
 *  3. A request with NO Origin header is NOT refused for that reason alone:
 *     browsers attach Origin to every non-GET/HEAD fetch or form post, so a
 *     browser-borne cross-site request can't omit it — only non-browser
 *     callers (server-side tools, tests) do, and they carry no victim's
 *     cookie. They still face rules 1 and 4 and every route's own checks.
 *  4. `Content-Type` must be application/json, except on the explicit list
 *     of routes below that take no body. This is what stops the
 *     "simple request" shapes (text/plain, form posts) — the ones a
 *     cross-site page can send without a CORS preflight — from ever
 *     reaching a route that parses a JSON body. A new route is JSON-only by
 *     default; a body-less route must be added here.
 *
 *  5. (3B-2) A route that takes a body must DECLARE its length: `Content-Length`
 *     is required (411), must be plain decimal digits that form a safe integer
 *     (400), and may not exceed REAL_API_MAX_BODY_BYTES (413). This runs after
 *     rules 1-4, so a 403 or 415 still wins. It exists because Next.js copies a
 *     proxied request body only up to `experimental.proxyClientMaxBodySize`
 *     and, past it, keeps just the prefix while the request continues "normally":
 *     a route could otherwise see a truncated body that happens to parse. The
 *     framework limit is set to the same constant in next.config.ts, so no
 *     request that passes this gate can be truncated by the copy. A declared
 *     length is not proof of the body that follows — the server's HTTP framing
 *     enforces that — and a 411/413 here does not stop the framework from
 *     draining the upload; it only keeps the request from any route.
 *
 * No CSRF tokens: SameSite=Lax cookies plus this gate are the defense.
 */

/**
 * The ONE size ceiling for a body-carrying /api/real/** request: 256 KiB
 * (262 144 bytes), a controlled-development policy set after Milestone 3B
 * (which closed with the framework's 10 MiB default). next.config.ts sets
 * `experimental.proxyClientMaxBodySize` to this same constant and the gate
 * below refuses any larger declared length, so the two can never drift apart.
 * Never lower the framework limit without lowering this, and never raise this
 * above the framework limit. Route-specific limits (4 KiB control, 16 KiB
 * assertion, 64 KiB signed Turnkey and registration) are smaller and are
 * enforced inside the routes.
 */
export const REAL_API_MAX_BODY_BYTES = 262_144;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Unsafe routes that are defined to take no request body. Checked against the real client calls: none of these sends one. */
const BODYLESS_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/api\/real\/account\/register\/options$/ },
  { method: "POST", path: /^\/api\/real\/account\/login\/options$/ },
  { method: "POST", path: /^\/api\/real\/account\/passkeys\/backup\/step-up\/options$/ },
  { method: "POST", path: /^\/api\/real\/account\/passkeys\/[^/]+\/revoke\/options$/ },
  { method: "POST", path: /^\/api\/real\/payments\/[^/]+\/cancel$/ },
  { method: "DELETE", path: /^\/api\/real\/session$/ },
];

/**
 * Safe-method reads that spend provider work (chain RPC / bundler) on behalf
 * of the signed-in user, and that the per-account chain-read budget charges
 * (Slice 3A-1: the balance and payment-status resolvers consume it, after this
 * gate has run). A cross-site page must not be able to make a victim's browser
 * drive that spend, so these demand proof the request came from our own origin. Matched
 * exactly: payments/latest, payments/history and every other GET are NOT
 * listed, and so are unchanged.
 */
const PROTECTED_READS: ReadonlyArray<RegExp> = [
  /^\/api\/real\/account\/balance$/,
  /^\/api\/real\/payments\/[^/]+\/status$/,
];

function refuse(status: number): Response {
  return Response.json({ error: status === 415 ? "Unsupported request." : "Request not allowed." }, { status });
}

/** 411: a body route was called without a Content-Length. Not retryable as-is, so no Retry-After and no `retryable`. */
function refuseLengthRequired(): Response {
  return Response.json({ error: "Unsupported request.", code: "length_required" }, { status: 411 });
}

/** A Content-Length field value is 1*DIGIT (RFC 9110); a list ("5, 5"), sign, space, fraction, or empty value is not. */
const CONTENT_LENGTH_SYNTAX = /^[0-9]+$/;

/**
 * Rule 5. Returns the refusal for a body route's declared length, or null when
 * the request may go on. Reads only the header; never the body.
 */
function checkDeclaredLength(request: Request): Response | null {
  const declared = request.headers.get("content-length");
  if (declared === null) return refuseLengthRequired();
  if (!CONTENT_LENGTH_SYNTAX.test(declared)) return refuse(400);
  const length = Number(declared);
  if (!Number.isSafeInteger(length)) return refuse(400);
  if (length > REAL_API_MAX_BODY_BYTES) return requestTooLargeResponse();
  return null;
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(";")[0]!.trim().toLowerCase() === "application/json";
}

function isBodylessRoute(method: string, pathname: string): boolean {
  return BODYLESS_ROUTES.some((route) => route.method === method && route.path.test(pathname));
}

/**
 * Route handlers answer HEAD with the GET handler, so HEAD is guarded the same
 * way. The path is matched raw and percent-decoded (with runs of "/"
 * collapsed), so an encoded spelling can't slip past the pattern.
 */
function isProtectedRead(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const candidates = [pathname];
  try {
    candidates.push(decodeURIComponent(pathname));
  } catch {
    // Not decodable: only the raw spelling is considered.
  }
  return candidates.some((candidate) => {
    const collapsed = candidate.replace(/\/{2,}/g, "/").replace(/(?<=.)\/$/, "");
    return PROTECTED_READS.some((pattern) => pattern.test(collapsed));
  });
}

/** The exact-origin check on a Referer: its URL must parse and its origin must be configured verbatim. */
function isTrustedReferer(referer: string, trusted: string[]): boolean {
  try {
    return trusted.includes(new URL(referer).origin);
  } catch {
    return false;
  }
}

/**
 * Cross-site protection for the protected reads. Each signal can only tighten
 * the verdict; none can rescue a request another signal denied.
 *
 *  - `Sec-Fetch-Site`, when present, must be exactly `same-origin`. cross-site,
 *    same-site (a sibling subdomain), none (typed/bookmarked/window.open from
 *    nowhere), the empty string and any unknown or oddly-cased value are
 *    refused. It is a forbidden header: page script cannot set it.
 *  - `Origin`, when present, must exactly equal a configured Real origin.
 *  - `Referer`, when present, must parse to a configured origin; when
 *    `Sec-Fetch-Site` is absent (older browsers, non-browser callers) it is
 *    REQUIRED, and its absence refuses the request.
 *
 * Trusted origins come only from readExpectedOrigins (NEXT_PUBLIC_REAL_ORIGIN);
 * never from Host, X-Forwarded-Host or the request URL. No configured origin
 * means nothing can be trusted, so a request without `Sec-Fetch-Site:
 * same-origin` is refused.
 */
function checkProtectedRead(request: Request, env: Record<string, string | undefined>): Response | null {
  const trusted = readExpectedOrigins(env);

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite.trim() !== "same-origin") return refuse(403);

  const origin = request.headers.get("origin");
  if (origin !== null && !trusted.includes(origin)) return refuse(403);

  const referer = request.headers.get("referer");
  if (referer !== null) {
    if (!isTrustedReferer(referer, trusted)) return refuse(403);
  } else if (fetchSite === null) {
    return refuse(403);
  }

  return null;
}

/** Returns a refusal Response, or null when the request may proceed to its route handler. */
export function checkRealApiRequest(request: Request, env: Record<string, string | undefined> = process.env): Response | null {
  // Disabled Real Mode: every route already answers 404 itself.
  if (!isRealModeEnabled(env)) return null;

  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) {
    return isProtectedRead(method, new URL(request.url).pathname) ? checkProtectedRead(request, env) : null;
  }

  if (request.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site") return refuse(403);

  const origin = request.headers.get("origin");
  if (origin !== null && !readExpectedOrigins(env).includes(origin)) return refuse(403);

  const { pathname } = new URL(request.url);
  if (isBodylessRoute(method, pathname)) return null;
  if (!isJsonContentType(request.headers.get("content-type"))) return refuse(415);

  return checkDeclaredLength(request);
}
