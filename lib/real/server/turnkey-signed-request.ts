import { createHash } from "node:crypto";
import { base64UrlToBytes, bytesToBase64Url } from "../bytes";
import { credentialIdsEqual } from "../credential-id";
import type { RealServerConfig } from "./config";
import type { RealPasskeyRecord } from "./registry";
import { verifyLogin } from "./webauthn";

/**
 * "Model B" dispatch for child-authorized Turnkey mutations
 * (createAuthenticators / deleteAuthenticators). The browser only STAMPS the
 * exact request body with a fresh WebAuthn assertion from a specific child
 * credential (@turnkey/http's stamp* methods — never the dispatching
 * methods). This server then:
 *
 *   1. independently validates the exact body string against durable,
 *      authenticated state (callers do this per activity type),
 *   2. cryptographically verifies the stamp is a fresh WebAuthn assertion by
 *      the EXPECTED credential over exactly that body
 *      (verifyStampAuthorizedBy — @turnkey/webauthn-stamper's challenge is
 *      utf8(hex(sha256(body)))),
 *   3. durably records the request with an "unknown" outcome BEFORE any
 *      external call, and only then
 *   4. raw-forwards the byte-identical body with the ORIGINAL stamp header
 *      (forwardSignedRequest). Never TurnkeyClient.request / a generated
 *      mutation method: those re-stringify and re-stamp.
 *
 * The server never authorizes these activities and the parent API key is
 * never attached to them — the child WebAuthn assertion is the only
 * authority Turnkey sees.
 */

export const TURNKEY_WEBAUTHN_STAMP_HEADER = "X-Stamp-Webauthn";

export type TurnkeyMutationEndpoint = "create_authenticators" | "delete_authenticators";

const ENDPOINT_PATHS: Record<TurnkeyMutationEndpoint, string> = {
  create_authenticators: "/public/v1/submit/create_authenticators",
  delete_authenticators: "/public/v1/submit/delete_authenticators",
};

const MAX_BODY_LENGTH = 16_384;
const MAX_STAMP_LENGTH = 8_192;

/**
 * LOCAL, deliberately conservative policy — not Turnkey's documented
 * window (its exact timestampMs freshness rule is an unverified candidate
 * fact; see ARCHITECTURE.md). A signed request is accepted for first
 * submission, and replayed byte-for-byte after a lost response, only while
 * its own timestampMs is within this window. Being stricter than Turnkey is
 * safe: once the window closes we stop replaying and fall back to read-only
 * discovery — we never re-stamp or mint a new timestamp automatically.
 */
export const TURNKEY_STAMP_FRESHNESS_WINDOW_MS = 2 * 60 * 1000;
export const TURNKEY_STAMP_MAX_FUTURE_SKEW_MS = 60 * 1000;

export type TurnkeyStamp = { stampHeaderName: string; stampHeaderValue: string };
export type SignedTurnkeyRequest = { body: string; stamp: TurnkeyStamp; url: string };

export function parseSignedTurnkeyRequest(input: unknown): SignedTurnkeyRequest | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const stamp = record.stamp as Record<string, unknown> | null | undefined;
  if (typeof record.body !== "string" || typeof record.url !== "string" || !stamp || typeof stamp !== "object") return null;
  if (typeof stamp.stampHeaderName !== "string" || typeof stamp.stampHeaderValue !== "string") return null;
  if (record.body.length === 0 || record.body.length > MAX_BODY_LENGTH) return null;
  if (stamp.stampHeaderValue.length === 0 || stamp.stampHeaderValue.length > MAX_STAMP_LENGTH) return null;
  if (stamp.stampHeaderName.toLowerCase() !== TURNKEY_WEBAUTHN_STAMP_HEADER.toLowerCase()) return null;
  // Both are forwarded to Turnkey verbatim, so both must mean exactly one thing to any JSON parser.
  if (!isUnambiguousJson(record.body) || !isUnambiguousJson(stamp.stampHeaderValue)) return null;
  return { body: record.body, url: record.url, stamp: { stampHeaderName: TURNKEY_WEBAUTHN_STAMP_HEADER, stampHeaderValue: stamp.stampHeaderValue } };
}

const MAX_JSON_DEPTH = 32;
const SIMPLE_ESCAPES = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

/**
 * Strict RFC 8259 check of the RAW text that also rejects any object, at any
 * depth, that repeats a member name — compared after escape decoding, so
 * "foo" and "foo" collide. JSON.parse is last-key-wins and Turnkey's
 * parser may not be; a body two parsers could read differently is never
 * validated or forwarded. Read-only: the text is never re-serialized.
 * Malformed input (trailing commas, leading zeros, raw control characters,
 * a BOM, trailing garbage, excessive nesting) fails closed.
 */
export function isUnambiguousJson(text: string): boolean {
  let i = 0;

  const skipWhitespace = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i += 1;
  };

  /** Returns the DECODED string value, or null if malformed. */
  const readString = (): string | null => {
    if (text[i] !== '"') return null;
    i += 1;
    let decoded = "";
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '"') {
        i += 1;
        return decoded;
      }
      if (ch.charCodeAt(0) < 0x20) return null;
      if (ch !== "\\") {
        decoded += ch;
        i += 1;
        continue;
      }
      const escape = text[i + 1];
      const simple = escape === undefined ? undefined : SIMPLE_ESCAPES.get(escape);
      if (simple !== undefined) {
        decoded += simple;
        i += 2;
      } else if (escape === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        decoded += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
      } else {
        return null;
      }
    }
    return null;
  };

  const readNumber = (): boolean => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) return false;
    i += match[0].length;
    return true;
  };

  const readValue = (depth: number): boolean => {
    if (depth > MAX_JSON_DEPTH) return false;
    skipWhitespace();
    const ch = text[i];
    if (ch === "{") {
      i += 1;
      const names = new Set<string>();
      skipWhitespace();
      if (text[i] === "}") {
        i += 1;
        return true;
      }
      for (;;) {
        skipWhitespace();
        const name = readString();
        if (name === null || names.has(name)) return false;
        names.add(name);
        skipWhitespace();
        if (text[i] !== ":") return false;
        i += 1;
        if (!readValue(depth + 1)) return false;
        skipWhitespace();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return true;
        }
        return false;
      }
    }
    if (ch === "[") {
      i += 1;
      skipWhitespace();
      if (text[i] === "]") {
        i += 1;
        return true;
      }
      for (;;) {
        if (!readValue(depth + 1)) return false;
        skipWhitespace();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return true;
        }
        return false;
      }
    }
    if (ch === '"') return readString() !== null;
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return true;
      }
    }
    return readNumber();
  };

  if (!readValue(0)) return false;
  skipWhitespace();
  return i === text.length;
}

/** The ONLY destination this server will ever forward a child-signed request to — derived from server config, never from the browser. */
export function turnkeyEndpointUrl(config: RealServerConfig, endpoint: TurnkeyMutationEndpoint): string {
  return `${config.turnkeyApiBaseUrl}${ENDPOINT_PATHS[endpoint]}`;
}

/** The browser-reported url must name exactly the expected endpoint for this activity; it is validated, never used as the destination. */
export function isExpectedEndpointUrl(config: RealServerConfig, endpoint: TurnkeyMutationEndpoint, url: string): boolean {
  return url === turnkeyEndpointUrl(config, endpoint);
}

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function isFreshTimestamp(timestampMs: number, now: number = Date.now()): boolean {
  return now - timestampMs <= TURNKEY_STAMP_FRESHNESS_WINDOW_MS && timestampMs - now <= TURNKEY_STAMP_MAX_FUTURE_SKEW_MS;
}

/** Strict JSON parse of the exact signed body — the caller validates the shape against durable state. Duplicate member names fail closed. */
export function parseSignedBody(body: string): Record<string, unknown> | null {
  if (!isUnambiguousJson(body)) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function hasExactlyKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

type ParsedWebauthnStamp = { authenticatorData: string; clientDataJson: string; credentialId: string; signature: string };

function parseWebauthnStamp(stamp: TurnkeyStamp): ParsedWebauthnStamp | null {
  try {
    const parsed = JSON.parse(stamp.stampHeaderValue) as Record<string, unknown>;
    const { authenticatorData, clientDataJson, credentialId, signature } = parsed;
    if (typeof authenticatorData !== "string" || typeof clientDataJson !== "string" || typeof credentialId !== "string" || typeof signature !== "string") return null;
    return { authenticatorData, clientDataJson, credentialId, signature };
  } catch {
    return null;
  }
}

export type StampVerification = { ok: true; newCounter: number } | { ok: false };

/**
 * Proves the stamp is a fresh, user-verified WebAuthn assertion by exactly
 * `credential` (its stored public key, our RP ID/origin) over exactly
 * `body`. This is what makes a stolen app cookie insufficient: without the
 * expected credential's private key there is no stamp that verifies here
 * (and none Turnkey would accept either).
 */
export async function verifyStampAuthorizedBy(input: { config: RealServerConfig; body: string; stamp: TurnkeyStamp; credential: RealPasskeyRecord }): Promise<StampVerification> {
  const parsed = parseWebauthnStamp(input.stamp);
  if (!parsed || !credentialIdsEqual(parsed.credentialId, input.credential.credentialId)) return { ok: false };
  const expectedChallenge = bytesToBase64Url(new TextEncoder().encode(sha256Hex(input.body)));
  try {
    const verified = await verifyLogin({
      config: input.config,
      expectedChallenge,
      response: {
        id: input.credential.credentialId,
        rawId: input.credential.credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: { authenticatorData: parsed.authenticatorData, clientDataJSON: parsed.clientDataJson, signature: parsed.signature },
      },
      credential: {
        id: input.credential.credentialId,
        publicKey: base64UrlToBytes(input.credential.credentialPublicKey),
        counter: input.credential.counter,
        transports: input.credential.transports ?? undefined,
      },
    });
    if (!verified.verified || !verified.authenticationInfo.userVerified) return { ok: false };
    return { ok: true, newCounter: verified.authenticationInfo.newCounter };
  } catch {
    return { ok: false };
  }
}

export type TurnkeyActivitySummary = { id: string; status: string; type: string; organizationId: string; raw: Record<string, unknown> };

export function summarizeActivity(value: unknown): TurnkeyActivitySummary | null {
  if (!value || typeof value !== "object") return null;
  const activity = value as Record<string, unknown>;
  if (typeof activity.id !== "string" || !activity.id || typeof activity.status !== "string") return null;
  return {
    id: activity.id,
    status: activity.status,
    type: typeof activity.type === "string" ? activity.type : "",
    organizationId: typeof activity.organizationId === "string" ? activity.organizationId : "",
    raw: activity,
  };
}

export type ForwardOutcome = { kind: "activity"; activity: TurnkeyActivitySummary } | { kind: "no_activity" };

/**
 * Raw-forwards the byte-identical signed body with its original stamp
 * header. Any failure to obtain an activity id — network error, timeout,
 * non-2xx, unparseable response — is "no_activity": NOT proof the request
 * didn't land (the caller keeps the outcome "unknown").
 */
export async function forwardSignedRequest(input: {
  config: RealServerConfig;
  endpoint: TurnkeyMutationEndpoint;
  body: string;
  stamp: TurnkeyStamp;
  fetchImpl?: typeof fetch;
}): Promise<ForwardOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(turnkeyEndpointUrl(input.config, input.endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json", [input.stamp.stampHeaderName]: input.stamp.stampHeaderValue },
      body: input.body,
      redirect: "error",
    });
    if (!response.ok) return { kind: "no_activity" };
    const json = (await response.json()) as { activity?: unknown };
    const activity = summarizeActivity(json.activity);
    return activity ? { kind: "activity", activity } : { kind: "no_activity" };
  } catch {
    return { kind: "no_activity" };
  }
}

export const TERMINAL_FAILURE_STATUSES = new Set(["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]);
export const COMPLETED_STATUS = "ACTIVITY_STATUS_COMPLETED";

/** Injectable for tests; production uses global fetch / real time / a short bounded poll. */
export type TurnkeyDispatchDeps = { fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; maxPolls?: number; pollIntervalMs?: number };

export function resolveDispatchDeps(deps: TurnkeyDispatchDeps | undefined) {
  return {
    fetchImpl: deps?.fetchImpl,
    now: deps?.now ?? Date.now,
    sleep: deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    maxPolls: deps?.maxPolls ?? 3,
    pollIntervalMs: deps?.pollIntervalMs ?? 700,
  };
}
