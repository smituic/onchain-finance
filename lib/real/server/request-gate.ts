import { isRealModeEnabled, readExpectedOrigins } from "./config";

/**
 * S4 request gate for every /api/real/** call, run centrally by the root
 * proxy.ts before any route handler. Framework-agnostic (plain Request/
 * Response) so it stays inside lib/real's fence and is unit-testable.
 *
 * Safe methods (GET/HEAD/OPTIONS) pass untouched. For every other method:
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
 * No CSRF tokens: SameSite=Lax cookies plus this gate are the defense.
 */

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

function refuse(status: number): Response {
  return Response.json({ error: status === 415 ? "Unsupported request." : "Request not allowed." }, { status });
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(";")[0]!.trim().toLowerCase() === "application/json";
}

function isBodylessRoute(method: string, pathname: string): boolean {
  return BODYLESS_ROUTES.some((route) => route.method === method && route.path.test(pathname));
}

/** Returns a refusal Response, or null when the request may proceed to its route handler. */
export function checkRealApiRequest(request: Request, env: Record<string, string | undefined> = process.env): Response | null {
  // Disabled Real Mode: every route already answers 404 itself.
  if (!isRealModeEnabled(env)) return null;

  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return null;

  if (request.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site") return refuse(403);

  const origin = request.headers.get("origin");
  if (origin !== null && !readExpectedOrigins(env).includes(origin)) return refuse(403);

  const { pathname } = new URL(request.url);
  if (!isBodylessRoute(method, pathname) && !isJsonContentType(request.headers.get("content-type"))) return refuse(415);

  return null;
}
