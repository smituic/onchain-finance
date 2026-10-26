import { base64UrlToBytes, bytesToBase64Url } from "../bytes";
import { credentialIdsEqual } from "../credential-id";
import { createParentTurnkeyClient } from "./turnkey-provisioning";
import { summarizeActivity, type TurnkeyActivitySummary } from "./turnkey-signed-request";
import type { RealServerConfig } from "./config";

/**
 * SERVER-ONLY, parent-key-stamped, READ-ONLY Turnkey reads shared by S1
 * payment attribution, 2g backup enrollment / Proof B, S3 removal resolution,
 * and the authenticator-id backfill.
 *
 * S5 L2 (Option 3): there is deliberately NO sub-organization discovery or
 * adoption here. Finding a sub-org that contains a credential (getSubOrgIds +
 * current shape) proves membership, not that our own CREATE_SUB_ORGANIZATION
 * made it, nor that nobody else holds authority in it — so an uncertain
 * create is never resolved automatically (onboarding.ts). The exact
 * dispatch evidence a future operator-only resolver needs is captured by
 * provisioning-dispatch.ts; nothing here reads it.
 */
export type TurnkeyUserAuthenticator = { authenticatorId: string; credentialId: string; publicKey: string };

/** Controlled-development default for how long a caller waits on one read — not a provider SLA or a measured production threshold. */
const READ_DEADLINE_MS = 5_000;

/** A read that did not answer in time. Says nothing about whether Turnkey saw, or will finish, the request. */
class TurnkeyReadDeadlineError extends Error {
  constructor() {
    super("Turnkey did not answer the read in time.");
    this.name = "TurnkeyReadDeadlineError";
  }
}

/**
 * Bounds how long the CALLER waits for one SDK read — it does not abort the
 * SDK's socket, which may keep running after the caller has settled. The
 * timer starts immediately before the single call, is cleared as soon as the
 * call settles first, and nothing is retried or re-issued. A late result or a
 * late rejection is swallowed and can never reach the caller. A timeout is an
 * unavailable answer, never evidence the thing read is absent.
 */
function withReadDeadline<T>(read: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TurnkeyReadDeadlineError()), READ_DEADLINE_MS);
    let pending: Promise<T>;
    try {
      pending = read();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * SERVER-ONLY, parent-key-stamped, READ-ONLY: the current authenticators of
 * exactly one Turnkey user in one child sub-organization, or null if that
 * user isn't present in the response. A failed or timed-out read THROWS — it
 * is never null or [] (callers read those as absence). Parent-key authority here is the
 * same read access turnkey-discovery already had (getUsers) — it never
 * creates, deletes, or approves anything.
 */
export async function listTurnkeyUserAuthenticators(input: {
  config: RealServerConfig;
  subOrganizationId: string;
  turnkeyUserId: string;
}): Promise<TurnkeyUserAuthenticator[] | null> {
  const client = createParentTurnkeyClient(input.config);
  const { users } = await withReadDeadline(() => client.getUsers({ organizationId: input.subOrganizationId }));
  const user = (users ?? []).find((candidate) => candidate.userId === input.turnkeyUserId);
  if (!user) return null;
  return (user.authenticators ?? []).map((authenticator) => ({
    authenticatorId: authenticator.authenticatorId,
    credentialId: authenticator.credentialId,
    publicKey: authenticator.credential?.publicKey ?? "",
  }));
}

export type AuthenticatorMatch =
  | { outcome: "found"; authenticator: TurnkeyUserAuthenticator }
  | { outcome: "not_found" }
  | { outcome: "ambiguous"; authenticatorIds: string[] }
  | { outcome: "user_not_found" };

/**
 * Matches by DECODED CREDENTIAL-ID BYTES (credential-id.ts), never raw
 * string equality — Turnkey's and WebAuthn's encodings of the same id need
 * not be byte-identical strings. More than one match is reported, never
 * resolved silently. "not_found" is a single read with no read-after-write
 * guarantee: callers must never treat it as proof something was or wasn't
 * created/deleted on its own.
 */
export function matchAuthenticatorByCredentialId(authenticators: TurnkeyUserAuthenticator[] | null, credentialId: string): AuthenticatorMatch {
  if (!authenticators) return { outcome: "user_not_found" };
  const matches = authenticators.filter((authenticator) => credentialIdsEqual(authenticator.credentialId, credentialId));
  if (matches.length === 0) return { outcome: "not_found" };
  if (matches.length > 1) return { outcome: "ambiguous", authenticatorIds: matches.map((m) => m.authenticatorId) };
  return { outcome: "found", authenticator: matches[0]! };
}

/**
 * Turnkey reports a WebAuthn authenticator's credential.publicKey (and an
 * approving vote's publicKey) as canonical unpadded base64url of the raw
 * COSE_Key bytes — live-verified for a CREATE_SUB_ORGANIZATION primary and
 * CREATE_AUTHENTICATORS_V2 backups, byte-identical to our stored
 * credential_public_key. Base64url is case-sensitive, so the only accepted
 * spelling is exactly that one: a string, base64url alphabet only, no
 * padding, no whitespace, and decode -> re-encode must reproduce the input
 * (rejects non-zero spare bits, i.e. a second spelling of the same bytes).
 * Anything else is null — never trimmed, case-folded, or re-padded.
 */
export function strictCanonicalTurnkeyPublicKeyBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !CANONICAL_BASE64URL.test(value) || value.length % 4 === 1) return null;
  const bytes = base64UrlToBytes(value);
  if (bytes.length === 0 || bytesToBase64Url(bytes) !== value) return null;
  return bytes;
}

const CANONICAL_BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The one comparison for Turnkey/WebAuthn public keys: exact decoded-byte equality of two strictly canonical spellings. Either side undecodable is NO MATCH. Public data, so no constant-time compare. */
export function turnkeyPublicKeysEqual(a: unknown, b: unknown): boolean {
  const left = strictCanonicalTurnkeyPublicKeyBytes(a);
  const right = strictCanonicalTurnkeyPublicKeyBytes(b);
  return left !== null && right !== null && left.length === right.length && left.every((byte, i) => byte === right[i]);
}

/** SERVER-ONLY, parent-key-stamped, READ-ONLY poll of one child activity — never a resubmission of the mutation it describes. Returns null on any read failure, including a missed 5 s deadline (the caller stays pending): null means "unavailable", never "no such activity" — the SDK read has no not-found result distinct from a failure. */
export async function readTurnkeyActivity(input: { config: RealServerConfig; subOrganizationId: string; activityId: string }): Promise<TurnkeyActivitySummary | null> {
  try {
    const client = createParentTurnkeyClient(input.config);
    const response = await withReadDeadline(() => client.getActivity({ organizationId: input.subOrganizationId, activityId: input.activityId }));
    return summarizeActivity(response.activity);
  } catch {
    return null;
  }
}
