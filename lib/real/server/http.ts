import { isRealModeEnabled, isRealServerConfig, readRealServerConfig } from "./config";

export function requireRealServerConfig() {
  const config = readRealServerConfig();
  if (!isRealServerConfig(config)) throw new Error(config.error);
  return config;
}

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export function disabledResponse(): Response {
  return jsonError("Not found", 404);
}

/**
 * Pre-2f hardening: every route's outer catch used to do
 * `jsonError(asErrorMessage(error), 500)`, forwarding whatever text an
 * uncaught exception happened to carry — including
 * requireRealServerConfig()'s "Missing server configuration: <ENV_VAR
 * NAMES>", raw Postgres errors (e.g. a malformed UUID's "invalid input
 * syntax for type uuid"), or a viem RPC error whose `.message` embeds the
 * request URL (and, for Pimlico, its API key query param). A generic 500
 * body is the fix for every unexpected-exception case at once; anything
 * that deserves a specific, safe message is handled by its own outcome
 * branch before this ever runs.
 */
export const GENERIC_SERVER_ERROR_MESSAGE = "Something went wrong. Please try again.";

export function jsonInternalError(): Response {
  return jsonError(GENERIC_SERVER_ERROR_MESSAGE, 500);
}

/**
 * Handle Pay Slice E: the ONE shape of a rate-limit denial — 429, a friendly
 * message, `code: "rate_limited"` (so a client can tell it from the payment
 * quota's 429, which keeps its own body), and a whole-second Retry-After.
 * Nothing else: no remaining count, reset time, bucket, account, or target.
 */
export const RECIPIENT_PROBE_RATE_LIMITED_MESSAGE = "Too many tries. Try again later.";
export const PAYMENT_PREPARE_RATE_LIMITED_MESSAGE = "You're going a bit fast. Try again later.";

export function rateLimitedResponse(message: string, retryAfterSeconds: number): Response {
  const seconds = Number.isFinite(retryAfterSeconds) ? Math.max(1, Math.ceil(retryAfterSeconds)) : 1;
  return Response.json({ error: message, code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(seconds) } });
}

/**
 * Payment-submit budget denial (Milestone 3, Slice 3A-2): the same shape as
 * rateLimitedResponse PLUS `retryable: true`. A client treats a non-retryable
 * submit error as a possibly-uncertain dispatch, but a budget denial is decided
 * before any provider work — nothing changed and nothing was sent — so it must
 * say so. Kept separate so rateLimitedResponse's body (used by the probe and
 * prepare routes) is untouched. The delay is validated upstream; a value that
 * is not a positive safe integer is a bug, so it throws (the route's generic
 * 500) rather than inventing a Retry-After.
 */
export function retryableRateLimitedResponse(message: string, retryAfterSeconds: number): Response {
  if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) throw new Error("Rate-limited response needs a positive whole-second delay.");
  return Response.json({ error: message, code: "rate_limited", retryable: true }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } });
}

/**
 * Parses a request body as JSON, returning null on any parse failure
 * instead of throwing — so a malformed body becomes a clean 400 at the
 * call site, never an uncaught exception that would otherwise fall through
 * to jsonInternalError()'s generic 500.
 */
export async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Milestone 3B, Slice 3B-1: the byte budget for a CONTROL request — a small
 * JSON body of ids, a short name, a handle, an address, an amount, a hex
 * signature, or a Turnkey activity id. The largest legitimate control body is
 * a few hundred bytes (a payment-submit signature is about 160 hex characters;
 * a display name is at most 40 characters), so 4 KiB leaves wide headroom while
 * keeping a hostile body from being buffered, decoded, or parsed. Requests that
 * carry WebAuthn attestations or assertions are NOT control requests and do not
 * use this limit.
 */
export const CONTROL_BODY_MAX_BYTES = 4096;

export const REQUEST_TOO_LARGE_MESSAGE = "This request is too large.";

/**
 * HTTP 413 with a fixed body. Deliberately not `retryable` and without
 * Retry-After: resending the same body can never succeed. It carries nothing
 * from the request.
 */
export function requestTooLargeResponse(): Response {
  return Response.json({ error: REQUEST_TOO_LARGE_MESSAGE, code: "request_too_large" }, { status: 413 });
}

export type BoundedJsonResult = { kind: "ok"; value: unknown } | { kind: "too_large" } | { kind: "invalid" };

/** A Content-Length field value is 1*DIGIT (RFC 9110). A list ("5, 5"), sign, space, or empty value is not. */
const CONTENT_LENGTH_SYNTAX = /^[0-9]+$/;

/** Cancels without ever throwing or leaving a rejected promise behind. */
function cancelQuietly(target: { cancel(reason?: unknown): Promise<void> } | null | undefined): void {
  if (!target) return;
  try {
    target.cancel().catch(() => undefined);
  } catch {
    // A stream that cannot be cancelled (already locked or errored) has nothing left for us to release.
  }
}

/**
 * Reads a request body as JSON, counting the bytes actually received BEFORE
 * anything is decoded or parsed, and never buffering more than `maxBytes`.
 *
 *  - `too_large`: more than `maxBytes` bytes were declared (Content-Length) or
 *    actually arrived. The stream is cancelled; the chunk that crossed the line
 *    is never kept.
 *  - `invalid`: everything else that is not a JSON value — a malformed,
 *    duplicated, or unsafe Content-Length; a declared length that does not match
 *    the bytes received; a body that is empty, aborted, failed mid-read, not
 *    valid UTF-8, or not valid JSON.
 *  - `ok`: a complete, in-limit, valid UTF-8, valid JSON body. JSON `null` is a
 *    valid `ok` value; the caller keeps its own validation of it.
 *
 * A missing Content-Length is allowed (chunked uploads have none); only the
 * actual byte count then bounds the body. Decoding is strict UTF-8 (invalid
 * sequences are an error, never replaced); one leading BOM is dropped exactly as
 * `request.json()` would. No reviver, no normalization, no trimming.
 *
 * `maxBytes` must be given and must be a positive safe integer — there is no
 * unlimited default, and this never falls back to `request.json()`. It does not
 * and cannot stop an earlier layer (the framework's own body copy) from having
 * already drained the upload; it bounds what THIS route buffers and parses.
 * The body is never logged.
 */
export async function readBoundedJsonBody(request: Request, maxBytes: number): Promise<BoundedJsonResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("readBoundedJsonBody needs a positive safe-integer maxBytes.");

  const declaredHeader = request.headers.get("content-length");
  let declaredLength: number | null = null;
  if (declaredHeader !== null) {
    if (!CONTENT_LENGTH_SYNTAX.test(declaredHeader)) {
      cancelQuietly(request.body);
      return { kind: "invalid" };
    }
    declaredLength = Number(declaredHeader);
    if (!Number.isSafeInteger(declaredLength)) {
      cancelQuietly(request.body);
      return { kind: "invalid" };
    }
    if (declaredLength > maxBytes) {
      cancelQuietly(request.body);
      return { kind: "too_large" };
    }
  }

  if (request.body === null) return { kind: "invalid" };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    // Already read or locked: there is nothing left to parse.
    return { kind: "invalid" };
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ArrayBuffer.isView(value)) {
        cancelQuietly(reader);
        return { kind: "invalid" };
      }
      // Count BEFORE keeping: the chunk that crosses the limit is never appended.
      if (received + value.byteLength > maxBytes) {
        cancelQuietly(reader);
        return { kind: "too_large" };
      }
      received += value.byteLength;
      chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch {
    // An aborted or failed stream: a partial body is never parsed.
    cancelQuietly(reader);
    return { kind: "invalid" };
  }

  if (declaredLength !== null && received !== declaredLength) return { kind: "invalid" };

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

export { isRealModeEnabled };
