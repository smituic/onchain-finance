import { recoverAddress, type Hex } from "viem";
import { credentialIdsEqual } from "../credential-id";
import { addressesEqual } from "../identifiers";
import { serializeTurnkeyRawSignature } from "../signing/raw-signature";
import type { RealServerConfig } from "./config";
import type { RealAccountRecord, RealPasskeyRecord } from "./registry";
import { listTurnkeyUserAuthenticators, matchAuthenticatorByCredentialId, normalizeTurnkeyPublicKey, readTurnkeyActivity, type TurnkeyUserAuthenticator } from "./turnkey-discovery";
import { COMPLETED_STATUS, TERMINAL_FAILURE_STATUSES } from "./turnkey-signed-request";

/** The exact activity raw-sign.ts creates for every payment signature. */
const SIGN_ACTIVITY_TYPE = "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2";

/** Turnkey activity ids are opaque; accept only a bounded, URL-safe token before ever using one as a lookup key. */
const ACTIVITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isWellFormedActivityId(value: unknown): value is string {
  return typeof value === "string" && ACTIVITY_ID_PATTERN.test(value);
}

/**
 * "unavailable": something the proof needs is ABSENT or unreadable (a read
 * failed, the activity isn't terminal, a field is missing, the authenticator
 * isn't visible) and nothing present contradicts the payment. It proves
 * nothing either way: the caller changes nothing and sends nothing, and the
 * same signature + activity id may be retried.
 *
 * "rejected": some field is PRESENT and contradicts this payment's approval
 * by the bound passkey. Definitive — even if other fields are also missing.
 */
export type PaymentAuthorizationResult = { outcome: "verified" } | { outcome: "unavailable" } | { outcome: "rejected"; reason: string };

/** A present, non-empty string — anything else (missing, null, another type, "") is absent. No real Turnkey id/key/hex value is empty. */
function presentString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function presentObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Slice S1 — proves, from Turnkey's own records, that the payment's bound
 * passkey approved signing exactly this payment's digest. The activity id is
 * only a locator the browser supplied; nothing about the activity is taken
 * from the client. Parent-key, read-only getActivity + getUsers (the same
 * authority Batch 2g's Proof B already uses — see backup-passkey-pipeline.ts's
 * confirmSigningProof, whose checks this mirrors). Verified only when ALL of:
 *
 *   1. the activity is the one asked for, in the account's own child org,
 *      of type ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2, and COMPLETED;
 *   2. its intent signs exactly `expectedDigest` (the server's own SafeOp
 *      digest for this row — payments/submit.ts's computeExpectedSafeOpDigest)
 *      with the canonical owner, hex-encoded, no re-hashing;
 *   3. exactly one APPROVED vote, for this activity, by the account's Turnkey
 *      user, whose publicKey equals the Turnkey authenticator that
 *      getUsers maps to the bound credential (matched by credential-id
 *      BYTES, and by authenticator id when the registry knows it) — and no
 *      OTHER authenticator of that user shares that public key, since then
 *      the vote couldn't say which credential approved;
 *   4. its signature result recovers to the owner over `expectedDigest` AND
 *      is byte-identical to the owner signature inside the Safe signature
 *      about to be dispatched.
 *
 * Every check runs; the verdict is "rejected" if any present field
 * contradicts, else "unavailable" if any needed field is absent, else
 * "verified". (Presence is read from the raw activity, not from
 * summarizeActivity's "" defaults, which can't tell missing from wrong.)
 *
 * Owner-address recovery alone can't attribute (every passkey authorizes
 * the same wallet key); (3) does. (2) + (4) tie that approval to THIS
 * payment: an approval of any other digest, or a signature from anywhere
 * else, is rejected.
 */
export async function verifyPaymentAuthorization(input: {
  config: RealServerConfig;
  account: RealAccountRecord;
  /** Registry row of the payment's bound authorizing credential. */
  passkey: RealPasskeyRecord;
  activityId: string;
  expectedDigest: Hex;
  /** The 65-byte owner signature from the submitted Safe4337 signature. */
  ownerSignature: Hex;
}): Promise<PaymentAuthorizationResult> {
  const { account, passkey } = input;
  // null = the read failed, or the response has no id/status at all.
  const activity = await readTurnkeyActivity({ config: input.config, subOrganizationId: account.subOrganizationId, activityId: input.activityId });
  if (!activity) return { outcome: "unavailable" };
  const raw = activity.raw;

  let rejection: string | null = null;
  let incomplete = false;
  const reject = (reason: string) => {
    rejection ??= reason;
  };
  /** Absent -> incomplete; present but failing `ok` -> rejected. Returns the present value. */
  const check = (value: unknown, ok: (present: string) => boolean, reason: string): string | undefined => {
    const present = presentString(value);
    if (present === undefined) incomplete = true;
    else if (!ok(present)) reject(reason);
    return present;
  };

  // 1. identity, org, type, status
  if (activity.id !== input.activityId) reject("not the requested activity");
  check(raw.organizationId, (org) => org === account.subOrganizationId, "not this account's organization");
  check(raw.type, (type) => type === SIGN_ACTIVITY_TYPE, "not a raw-payload signing activity");
  if (TERMINAL_FAILURE_STATUSES.has(activity.status)) reject("activity did not complete");
  else if (activity.status !== COMPLETED_STATUS) incomplete = true;

  // 2. the signed request
  const intent = presentObject(presentObject(raw.intent)?.signRawPayloadIntentV2);
  if (!intent) incomplete = true;
  else {
    check(intent.signWith, (signWith) => addressesEqual(signWith, account.ownerAddress), "signed with another key");
    check(intent.payload, (payload) => payload.toLowerCase() === input.expectedDigest.toLowerCase(), "signed something other than this payment");
    check(intent.hashFunction, (fn) => fn === "HASH_FUNCTION_NO_OP", "payload was re-hashed");
    check(intent.encoding, (encoding) => encoding === "PAYLOAD_ENCODING_HEXADECIMAL", "payload was not hex");
  }

  // 3a. the approval. An empty or unreadable vote record is absent proof —
  // a COMPLETED activity in a 1-of-1 org necessarily had an approval, so it
  // never proves authorization did NOT occur. Readable votes with no
  // approval, or more than one, contradict.
  let voteKey: string | undefined;
  if (!Array.isArray(raw.votes)) incomplete = true;
  else {
    const votes = (raw.votes as unknown[]).map(presentObject);
    const selections = votes.map((vote) => presentString(vote?.selection));
    const unreadable = selections.some((selection) => selection === undefined);
    if (unreadable) incomplete = true;
    const approvals = votes.filter((_, i) => selections[i] === "VOTE_SELECTION_APPROVED") as Array<Record<string, unknown>>;
    if (approvals.length > 1) reject("approval is ambiguous");
    else if (approvals.length === 0) {
      if (votes.length === 0) incomplete = true;
      else if (!unreadable) reject("activity was not approved");
    } else {
      const vote = approvals[0]!;
      check(vote.activityId, (id) => id === activity.id, "approval is for another activity");
      check(vote.userId, (userId) => userId === account.turnkeyUserId, "approval is not by this account's Turnkey user");
      voteKey = check(vote.publicKey, () => true, "");
    }
  }

  // 3b. which credential that key belongs to
  let authenticators: TurnkeyUserAuthenticator[] | null | undefined;
  try {
    authenticators = await listTurnkeyUserAuthenticators({ config: input.config, subOrganizationId: account.subOrganizationId, turnkeyUserId: account.turnkeyUserId });
  } catch {
    authenticators = undefined;
  }
  if (authenticators === undefined) incomplete = true;
  else {
    const match = matchAuthenticatorByCredentialId(authenticators, passkey.credentialId);
    // A miss is never read as proof of anything (no read-after-write guarantee).
    if (match.outcome === "ambiguous") reject("bound passkey maps to more than one Turnkey authenticator");
    else if (match.outcome !== "found") incomplete = true;
    else {
      if (passkey.turnkeyAuthenticatorId !== null && match.authenticator.authenticatorId !== passkey.turnkeyAuthenticatorId) reject("bound passkey's Turnkey authenticator mapping disagrees");
      // listTurnkeyUserAuthenticators reports an absent credential.publicKey as "".
      const expectedKey = normalizeTurnkeyPublicKey(match.authenticator.publicKey);
      if (expectedKey === "") incomplete = true;
      else {
        const shared = authenticators!.some((other) => !credentialIdsEqual(other.credentialId, passkey.credentialId) && normalizeTurnkeyPublicKey(other.publicKey) === expectedKey);
        if (shared) reject("bound passkey's public key is shared with another authenticator");
        if (voteKey !== undefined && normalizeTurnkeyPublicKey(voteKey) !== expectedKey) reject("approved by a different passkey");
      }
    }
  }

  // 4. the signature
  const result = presentObject(presentObject(raw.result)?.signRawPayloadResult);
  const r = presentString(result?.r);
  const s = presentString(result?.s);
  const v = presentString(result?.v);
  if (r === undefined || s === undefined || v === undefined) incomplete = true;
  else {
    let activitySignature: Hex | null = null;
    let recovered: string | null = null;
    try {
      activitySignature = serializeTurnkeyRawSignature({ r, s, v });
      recovered = await recoverAddress({ hash: input.expectedDigest, signature: activitySignature });
    } catch {
      reject("activity signature is malformed");
    }
    if (activitySignature && recovered) {
      if (!addressesEqual(recovered, account.ownerAddress)) reject("activity signature does not recover the owner");
      if (activitySignature.toLowerCase() !== input.ownerSignature.toLowerCase()) reject("submitted signature is not this activity's signature");
    }
  }

  if (rejection !== null) return { outcome: "rejected", reason: rejection };
  if (incomplete) return { outcome: "unavailable" };
  return { outcome: "verified" };
}
