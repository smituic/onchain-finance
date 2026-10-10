import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { base64UrlToBytes } from "../bytes";
import { credentialIdsEqual } from "../credential-id";
import { validateAccountDisplayName } from "../display/account-name";
import { canonicalizeHandle, isReservedHandle } from "../handle";
import type { AccountHandleStore, AccountProfile } from "./account-handles";
import type { ChallengeStore } from "./challenge-store";
import type { RealServerConfig } from "./config";
import { RECIPIENT_PROBE_POLICIES, type RateLimiter } from "./rate-limit";
import type { RealAccountRegistry } from "./registry";
import { buildLoginOptions, verifyLogin } from "./webauthn";

/**
 * Claiming a permanent @handle. A handle can never be changed or released,
 * so an app session alone is not enough: the claim needs a fresh,
 * user-verified assertion by the CURRENT SESSION CREDENTIAL, over a challenge
 * whose stored context names the account, that credential, AND the exact
 * handle. Whoever holds only a stolen cookie can therefore never brand an
 * account with a name, and an assertion obtained for one handle can never
 * claim another.
 *
 * APP AUTHENTICATION only — nothing here talks to Turnkey, and a handle never
 * grants or proves anything: it is a public label that resolves to the
 * account's Safe.
 */

const HANDLE_CLAIM_CHALLENGE_TTL_MS = 1000 * 60 * 5;

type HandleClaimContext = { appUserId: string; credentialId: string; handle: string };

/** One message for a reserved name and a name another account holds — the caller learns only "not available". */
const HANDLE_UNAVAILABLE = "That name isn't available. Try another.";
const HANDLE_ALREADY_CHOSEN = "This account already has a name, and it can't be changed.";
const CONFIRMATION_FAILED = "Couldn't confirm it's you. Try again.";
const SESSION_PASSKEY_NOT_ACTIVE = "The passkey you're signed in with isn't active.";

export type PrepareHandleClaimResult =
  | { outcome: "ready"; handle: string; optionsJSON: Awaited<ReturnType<typeof buildLoginOptions>> }
  | { outcome: "invalid"; reason: string }
  /** Slice E: the caller's recipient-probe budget is spent. Nothing was read and no challenge was created. */
  | { outcome: "rate_limited"; retryAfterSeconds: number }
  | { outcome: "unavailable"; reason: string }
  /** The account already holds a handle (`handle`); nothing is minted. */
  | { outcome: "already_has_handle"; reason: string; handle: string }
  | { outcome: "rejected"; reason: string };

/**
 * Step 1. Canonicalizes the requested handle and mints a sign-in challenge
 * for the session credential ONLY (allowCredentials = that one credential,
 * user verification required), bound to { appUserId, credentialId, handle }.
 * The availability check here is advisory — the insert in
 * completeHandleClaim is what decides.
 */
export async function prepareHandleClaim(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
  registry: RealAccountRegistry;
  handles: AccountHandleStore;
  /** Slice E: "is this name taken?" is the same question the recipient lookup answers, so it draws on the same per-account probe budget. */
  rateLimiter: RateLimiter;
  appUserId: string;
  sessionCredentialId: string;
  handle: unknown;
}): Promise<PrepareHandleClaimResult> {
  const canonical = canonicalizeHandle(input.handle);
  if (!canonical.ok) return { outcome: "invalid", reason: canonical.reason };
  const handle = canonical.handle;

  // Charged after the name is known to be well-formed and before anything is
  // read or minted: a denied request does no availability read and creates no
  // WebAuthn challenge. The limiter is told only the caller's own account.
  const admitted = await input.rateLimiter.consume({ subject: input.appUserId, policies: RECIPIENT_PROBE_POLICIES });
  if (!admitted.allowed) return { outcome: "rate_limited", retryAfterSeconds: admitted.retryAfterSeconds };

  const profile = await input.handles.findProfileByAppUserId(input.appUserId);
  if (!profile) return { outcome: "rejected", reason: "No account found for this session." };
  if (profile.handle !== null) return { outcome: "already_has_handle", reason: HANDLE_ALREADY_CHOSEN, handle: profile.handle };

  if (isReservedHandle(handle) || (await input.handles.findHandle(handle))) return { outcome: "unavailable", reason: HANDLE_UNAVAILABLE };

  const passkey = await input.registry.findPasskeyByCredentialId(input.sessionCredentialId);
  if (!passkey || passkey.appUserId !== input.appUserId || passkey.status !== "active") return { outcome: "rejected", reason: SESSION_PASSKEY_NOT_ACTIVE };

  const optionsJSON = await buildLoginOptions({ config: input.config, allowCredentialIds: [passkey.credentialId] });
  await input.challengeStore.create({
    challenge: optionsJSON.challenge,
    purpose: "handle_claim",
    ttlMs: HANDLE_CLAIM_CHALLENGE_TTL_MS,
    context: { appUserId: input.appUserId, credentialId: passkey.credentialId, handle } satisfies HandleClaimContext,
  });
  return { outcome: "ready", handle, optionsJSON };
}

function isHandleClaimContext(value: unknown): value is HandleClaimContext {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.appUserId === "string" &&
    record.appUserId !== "" &&
    typeof record.credentialId === "string" &&
    record.credentialId !== "" &&
    typeof record.handle === "string" &&
    record.handle !== ""
  );
}

export type CompleteHandleClaimResult =
  | { outcome: "claimed"; profile: AccountProfile }
  | { outcome: "unavailable"; reason: string }
  | { outcome: "already_has_handle"; reason: string; handle: string }
  | { outcome: "rejected"; reason: string };

/**
 * Step 2. The challenge is consumed first (single-use even when everything
 * after it fails). The handle that is inserted is ALWAYS the one stored in
 * the challenge context — the request body's handle is only required to
 * equal it, never used.
 */
export async function completeHandleClaim(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
  registry: RealAccountRegistry;
  handles: AccountHandleStore;
  appUserId: string;
  sessionCredentialId: string;
  handle: unknown;
  response: unknown;
}): Promise<CompleteHandleClaimResult> {
  const rejected: CompleteHandleClaimResult = { outcome: "rejected", reason: CONFIRMATION_FAILED };

  const response = input.response as AuthenticationResponseJSON | null | undefined;
  if (!response || typeof response !== "object" || typeof response.id !== "string" || !response.response || typeof response.response.clientDataJSON !== "string") return rejected;
  let clientData: ReturnType<typeof decodeClientDataJSON>;
  try {
    clientData = decodeClientDataJSON(response.response.clientDataJSON);
  } catch {
    return rejected;
  }
  if (!clientData || typeof clientData.challenge !== "string") return rejected;

  const stored = await input.challengeStore.consume({ challenge: clientData.challenge, purpose: "handle_claim" });
  if (!stored) return rejected;
  const context = stored.context;
  if (!isHandleClaimContext(context)) return rejected;
  if (context.appUserId !== input.appUserId || context.credentialId !== input.sessionCredentialId) return rejected;

  // The body's handle must name the handle this challenge was minted for; from here on only context.handle is used.
  const requested = canonicalizeHandle(input.handle);
  if (!requested.ok || requested.handle !== context.handle) return rejected;
  // Re-validated, so a context can never smuggle a non-canonical or reserved value into the insert.
  const bound = canonicalizeHandle(context.handle);
  if (!bound.ok || bound.handle !== context.handle || isReservedHandle(context.handle)) return rejected;

  const passkey = await input.registry.findPasskeyByCredentialId(input.sessionCredentialId);
  if (!passkey || passkey.appUserId !== input.appUserId || passkey.status !== "active") return rejected;
  if (!credentialIdsEqual(response.id, passkey.credentialId)) return rejected;
  if (!response.response.userHandle || response.response.userHandle !== passkey.userHandle) return rejected;

  let verified;
  try {
    verified = await verifyLogin({
      config: input.config,
      response: { ...response, id: passkey.credentialId, rawId: passkey.credentialId },
      expectedChallenge: stored.challenge,
      credential: { id: passkey.credentialId, publicKey: base64UrlToBytes(passkey.credentialPublicKey), counter: passkey.counter, transports: passkey.transports ?? undefined },
    });
  } catch {
    // Never forward the library's own error.message (same convention as login.ts).
    return rejected;
  }
  if (!verified.verified || !verified.authenticationInfo.userVerified) return rejected;
  await input.registry.updateAuthenticatorCounter({ credentialId: passkey.credentialId, counter: verified.authenticationInfo.newCounter });

  const claim = await input.handles.claim({ handle: context.handle, appUserId: input.appUserId, credentialId: passkey.credentialId });
  if (claim.outcome === "handle_taken") return { outcome: "unavailable", reason: HANDLE_UNAVAILABLE };
  if (claim.outcome === "already_has_handle") return { outcome: "already_has_handle", reason: HANDLE_ALREADY_CHOSEN, handle: claim.handle };
  if (claim.outcome === "credential_not_active") return rejected;

  const profile = await input.handles.findProfileByAppUserId(input.appUserId);
  return { outcome: "claimed", profile: { handle: claim.handle, displayName: profile?.displayName ?? null } };
}

/** The account's human-readable identity, for the account response surface. Never part of the session cookie. */
export async function readAccountProfile(input: { handles: AccountHandleStore; appUserId: string }): Promise<AccountProfile> {
  return (await input.handles.findProfileByAppUserId(input.appUserId)) ?? { handle: null, displayName: null };
}

/**
 * RESPONSE ENRICHMENT ONLY, for callers that have ALREADY authenticated the
 * account (login/verify, GET /api/real/session). A handle and a display name
 * are presentation metadata: failing to read them — the store can't be built,
 * the registry table isn't there yet, a transient database error — must never
 * turn a successful sign-in or session check into a failure. Any such failure
 * yields an empty profile. `handles` is a thunk so that building the store is
 * covered too.
 *
 * Never use this where the profile DECIDES something (the claim routes read
 * the store directly and fail closed), and never to swallow an
 * authentication or account read.
 */
export async function readAccountProfileBestEffort(input: { handles: () => AccountHandleStore; appUserId: string }): Promise<AccountProfile> {
  try {
    return await readAccountProfile({ handles: input.handles(), appUserId: input.appUserId });
  } catch {
    return { handle: null, displayName: null };
  }
}

export type UpdateAccountDisplayNameResult = { outcome: "updated"; profile: AccountProfile } | { outcome: "invalid"; reason: string } | { outcome: "not_found" };

/** Presentation metadata only — an app session is sufficient (no passkey confirmation), like a passkey rename. */
export async function updateAccountDisplayName(input: { handles: AccountHandleStore; appUserId: string; displayName: unknown }): Promise<UpdateAccountDisplayNameResult> {
  const validation = validateAccountDisplayName(input.displayName);
  if (!validation.ok) return { outcome: "invalid", reason: validation.reason };
  if (!(await input.handles.setDisplayName({ appUserId: input.appUserId, displayName: validation.name }))) return { outcome: "not_found" };
  const profile = await input.handles.findProfileByAppUserId(input.appUserId);
  if (!profile) return { outcome: "not_found" };
  return { outcome: "updated", profile };
}
