import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { TurnkeyClient, type TurnkeyApiTypes } from "@turnkey/http";
import { REAL_WALLET_ACCOUNT } from "../constants";
import type { RealServerConfig } from "./config";
import { COMPLETED_STATUS, TERMINAL_FAILURE_STATUSES, summarizeActivity, type TurnkeyActivitySummary, type TurnkeyStamp } from "./turnkey-signed-request";

/**
 * The server-only parent Turnkey client, holding the parent API key. This
 * key must never become a child API key, never become child root authority,
 * never sign a child wallet transaction, and never reach browser code — it
 * only ever calls parent-scoped, server-side activities (provisioning here;
 * read-only reads in turnkey-discovery.ts).
 */
export function createParentTurnkeyClient(config: RealServerConfig): TurnkeyClient {
  return new TurnkeyClient(
    { baseUrl: config.turnkeyApiBaseUrl },
    new ApiKeyStamper({ apiPublicKey: config.turnkeyApiPublicKey, apiPrivateKey: config.turnkeyApiPrivateKey }),
  );
}

/**
 * Provisioning Evidence Capture. CREATE_SUB_ORGANIZATION is no longer sent
 * through TurnkeyClient / createActivityPoller: that path serializes and
 * stamps the body inside the SDK (so the exact bytes are never visible to
 * us), keeps the activity id in a closure that an error discards, and polls
 * without any bound. Instead:
 *
 *   1. buildCreateSubOrganizationBody builds the ONE request string
 *      (pure, versioned).
 *   2. The caller durably persists that string + its digest
 *      (provisioning-dispatch.ts) BEFORE anything below runs.
 *   3. submitCreateSubOrganization stamps the PERSISTED string and POSTs
 *      exactly that string. The stamp is never stored or returned.
 *   4. readParentActivity / pollParentActivityUntilTerminal read that one
 *      activity by its exact id, under one absolute deadline.
 *
 * The wire format is the same one the SDK produced: JSON.stringify of the
 * same object, an X-Stamp header from the same ApiKeyStamper, POSTed to the
 * same path. Read-only live probe: rebuilding both existing accounts' bodies
 * with this shape reproduced, byte for byte, the body Turnkey recorded.
 *
 * Every request here has its own timeout, and nothing loops without a
 * deadline. A timeout, an abort, or any unreadable answer is "unknown" —
 * never proof that nothing was created.
 */
export const PROVISIONING_EVIDENCE_VERSION = 1;
export const CREATE_SUB_ORGANIZATION_ACTIVITY_TYPE = "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8";

const CREATE_SUB_ORGANIZATION_PATH = "/public/v1/submit/create_sub_organization";
const GET_ACTIVITY_PATH = "/public/v1/query/get_activity";
const LIST_WALLET_ACCOUNTS_PATH = "/public/v1/query/list_wallet_accounts";

/**
 * PROVISIONAL values (no deployment's platform limit has been verified). The
 * invariant is not any single number: it is that the poll has ONE absolute
 * deadline (pollBudgetMs from the submit response) and that every request is
 * individually bounded by min(its own cap, the time remaining).
 */
export const PROVISIONING_LIMITS = {
  submitTimeoutMs: 10_000,
  pollBudgetMs: 8_000,
  pollInitialIntervalMs: 500,
  pollMaxIntervalMs: 2_000,
  activityReadTimeoutMs: 3_000,
  walletReadTimeoutMs: 5_000,
} as const;
export type ProvisioningLimits = { [K in keyof typeof PROVISIONING_LIMITS]: number };

/** Injectable for deterministic tests; production uses global fetch, the parent ApiKeyStamper, real time, and PROVISIONING_LIMITS. */
export type ParentTurnkeyDeps = {
  fetchImpl?: typeof fetch;
  stamp?: (body: string) => Promise<TurnkeyStamp>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<ProvisioningLimits>;
};

export type ResolvedParentTurnkeyDeps = {
  fetchImpl: typeof fetch;
  stamp: (body: string) => Promise<TurnkeyStamp>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  limits: ProvisioningLimits;
};

export function resolveParentTurnkeyDeps(config: RealServerConfig, deps: ParentTurnkeyDeps | undefined): ResolvedParentTurnkeyDeps {
  return {
    fetchImpl: deps?.fetchImpl ?? fetch,
    stamp:
      deps?.stamp ??
      ((body: string) => new ApiKeyStamper({ apiPublicKey: config.turnkeyApiPublicKey, apiPrivateKey: config.turnkeyApiPrivateKey }).stamp(body)),
    now: deps?.now ?? Date.now,
    sleep: deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    limits: { ...PROVISIONING_LIMITS, ...deps?.limits },
  };
}

type TurnkeyAuthenticatorTransport =
  | "AUTHENTICATOR_TRANSPORT_BLE"
  | "AUTHENTICATOR_TRANSPORT_INTERNAL"
  | "AUTHENTICATOR_TRANSPORT_NFC"
  | "AUTHENTICATOR_TRANSPORT_USB"
  | "AUTHENTICATOR_TRANSPORT_HYBRID";

function toTurnkeyTransport(transport: string): TurnkeyAuthenticatorTransport {
  switch (transport) {
    case "ble":
      return "AUTHENTICATOR_TRANSPORT_BLE";
    case "nfc":
      return "AUTHENTICATOR_TRANSPORT_NFC";
    case "usb":
      return "AUTHENTICATOR_TRANSPORT_USB";
    case "hybrid":
      return "AUTHENTICATOR_TRANSPORT_HYBRID";
    default:
      return "AUTHENTICATOR_TRANSPORT_INTERNAL";
  }
}

/**
 * Evidence version 1: the exact CREATE_SUB_ORGANIZATION_V8 request body.
 * Pure — same input, same string. The KEY ORDER below is part of the
 * version: it is the order this app has always sent, and the string returned
 * here is what gets persisted, hashed, stamped, and sent. Changing a key, a
 * value, or the order is a new evidence version, never an edit to this one.
 *
 * ONE clock reading: `timestampMs` is both the request's timestampMs and the
 * millisecond suffix of the sub-organization name.
 *
 * It carries the SAME WebAuthn registration ceremony our own server already
 * verified independently (server/webauthn.ts's verifyRegistration) — never a
 * second, Turnkey-only passkey. Root model, unchanged: one root user (the
 * passkey), threshold 1, no API keys, no OAuth/email/SMS auth or recovery.
 */
export function buildCreateSubOrganizationBody(input: {
  organizationId: string;
  appUserId: string;
  timestampMs: number;
  challengeBase64Url: string;
  credentialId: string;
  clientDataJson: string;
  attestationObject: string;
  transports: string[] | null;
}): string {
  if (!Number.isSafeInteger(input.timestampMs) || input.timestampMs < 0) throw new Error("A provisioning request needs a valid millisecond timestamp.");
  const timestampMs = String(input.timestampMs);
  return JSON.stringify({
    type: CREATE_SUB_ORGANIZATION_ACTIVITY_TYPE,
    timestampMs,
    organizationId: input.organizationId,
    parameters: {
      subOrganizationName: `real-${input.appUserId}-${timestampMs}`,
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName: "end-user",
          apiKeys: [],
          authenticators: [
            {
              authenticatorName: "user-passkey",
              challenge: input.challengeBase64Url,
              attestation: {
                credentialId: input.credentialId,
                clientDataJson: input.clientDataJson,
                attestationObject: input.attestationObject,
                transports: (input.transports ?? ["internal"]).map(toTurnkeyTransport),
              },
            },
          ],
          oauthProviders: [],
        },
      ],
      wallet: {
        walletName: "owner",
        accounts: [REAL_WALLET_ACCOUNT],
      },
      disableEmailAuth: true,
      disableEmailRecovery: true,
      disableSmsAuth: true,
      disableOtpEmailAuth: true,
    },
  } satisfies TurnkeyApiTypes["v1CreateSubOrganizationRequest"]);
}

type ParentPostResult = { kind: "response"; ok: boolean; status: number; json: unknown } | { kind: "timeout" } | { kind: "transport" };

/**
 * The one parent-key transport: stamps `body` and POSTs that same string.
 * The timeout covers the stamp, the request, AND reading the response body.
 * The stamp never leaves this function. Module-private on purpose — callers
 * get the three purpose-built functions below, never a generic "post to
 * Turnkey".
 */
async function postStampedParentRequest(input: { config: RealServerConfig; path: string; body: string; timeoutMs: number; deps: ResolvedParentTurnkeyDeps }): Promise<ParentPostResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(0, input.timeoutMs));
  try {
    const stamp = await input.deps.stamp(input.body);
    if (timedOut) return { kind: "timeout" };
    const response = await input.deps.fetchImpl(`${input.config.turnkeyApiBaseUrl}${input.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [stamp.stampHeaderName]: stamp.stampHeaderValue },
      body: input.body,
      redirect: "error",
      // A create or an exact-id read must never be answered from any cache.
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { kind: "response", ok: response.ok, status: response.status, json };
  } catch {
    return timedOut ? { kind: "timeout" } : { kind: "transport" };
  } finally {
    clearTimeout(timer);
  }
}

function readActivityField(json: unknown): TurnkeyActivitySummary | null {
  if (!json || typeof json !== "object") return null;
  return summarizeActivity((json as { activity?: unknown }).activity);
}

/**
 * `httpOk: false` means an activity id was readable from a NON-2xx answer:
 * the id is still recorded (never lost), but its embedded status is not
 * trusted — the caller reads the activity back by its exact id.
 */
export type SubmitCreateOutcome =
  | { kind: "activity"; activity: TurnkeyActivitySummary; httpOk: boolean }
  | { kind: "no_activity"; reason: "timeout" | "transport" | "http_error" | "unparseable" };

/**
 * Stamps and sends EXACTLY `body` — the string the caller already persisted.
 * It is never rebuilt, re-serialized, or re-read here. "no_activity" is NOT
 * proof the request didn't land (the caller keeps the outcome "unknown").
 */
export async function submitCreateSubOrganization(input: { config: RealServerConfig; body: string; deps: ResolvedParentTurnkeyDeps }): Promise<SubmitCreateOutcome> {
  const result = await postStampedParentRequest({ config: input.config, path: CREATE_SUB_ORGANIZATION_PATH, body: input.body, timeoutMs: input.deps.limits.submitTimeoutMs, deps: input.deps });
  if (result.kind !== "response") return { kind: "no_activity", reason: result.kind };
  const activity = readActivityField(result.json);
  if (activity) return { kind: "activity", activity, httpOk: result.ok };
  return { kind: "no_activity", reason: result.ok ? "unparseable" : "http_error" };
}

/** not_found: Turnkey answered that this id does not exist (HTTP 404 / code 5). Never proof of absence — a single read has no read-after-write guarantee. */
export type ParentActivityRead = { kind: "activity"; activity: TurnkeyActivitySummary } | { kind: "not_found" } | { kind: "error" };

/** SERVER-ONLY, parent-key-stamped, READ-ONLY: one activity by its exact organization id + activity id. Never a list, a search, or a resubmission. */
export async function readParentActivity(input: {
  config: RealServerConfig;
  organizationId: string;
  activityId: string;
  timeoutMs: number;
  deps: ResolvedParentTurnkeyDeps;
}): Promise<ParentActivityRead> {
  const body = JSON.stringify({ organizationId: input.organizationId, activityId: input.activityId });
  const result = await postStampedParentRequest({ config: input.config, path: GET_ACTIVITY_PATH, body, timeoutMs: input.timeoutMs, deps: input.deps });
  if (result.kind !== "response") return { kind: "error" };
  if (!result.ok) {
    const code = result.json && typeof result.json === "object" ? (result.json as { code?: unknown }).code : undefined;
    return result.status === 404 || code === 5 ? { kind: "not_found" } : { kind: "error" };
  }
  const activity = readActivityField(result.json);
  return activity ? { kind: "activity", activity } : { kind: "error" };
}

export function isTerminalActivityStatus(status: string): boolean {
  return status === COMPLETED_STATUS || TERMINAL_FAILURE_STATUSES.has(status);
}

export type PollOutcome = { activity: TurnkeyActivitySummary | null; terminal: boolean; reads: number };

/**
 * Bounded polling for ONE in-process dispatch. One absolute deadline
 * (now + pollBudgetMs) governs everything: it never sleeps past the
 * deadline, each read gets min(activityReadTimeoutMs, time remaining), and
 * the number of reads has a hard ceiling that holds even if the clock does
 * not advance. Returns the last activity read for `activityId` (a read
 * naming another id is ignored) and whether it is terminal.
 */
export async function pollParentActivityUntilTerminal(input: {
  activityId: string;
  read: (timeoutMs: number) => Promise<ParentActivityRead>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  limits: Pick<ProvisioningLimits, "pollBudgetMs" | "pollInitialIntervalMs" | "pollMaxIntervalMs" | "activityReadTimeoutMs">;
}): Promise<PollOutcome> {
  const { limits } = input;
  const deadline = input.now() + limits.pollBudgetMs;
  const interval0 = Math.max(1, limits.pollInitialIntervalMs);
  const maxReads = Math.ceil(limits.pollBudgetMs / interval0) + 1;
  let interval = interval0;
  let last: TurnkeyActivitySummary | null = null;
  let reads = 0;
  while (reads < maxReads) {
    const beforeSleep = deadline - input.now();
    if (beforeSleep <= 0) break;
    await input.sleep(Math.min(interval, beforeSleep));
    const remaining = deadline - input.now();
    if (remaining <= 0) break;
    reads += 1;
    const read = await input.read(Math.min(limits.activityReadTimeoutMs, remaining));
    if (read.kind === "activity" && read.activity.id === input.activityId) {
      last = read.activity;
      if (isTerminalActivityStatus(last.status)) return { activity: last, terminal: true, reads };
    }
    interval = Math.min(interval * 2, Math.max(interval0, limits.pollMaxIntervalMs));
  }
  return { activity: last, terminal: false, reads };
}

export type ProvisionedTurnkeyAccount = {
  subOrganizationId: string;
  turnkeyUserId: string;
  walletId: string;
  walletAccountId: string;
  ownerAddress: string;
};

/**
 * createSubOrganization's own result only returns the derived address, not
 * the walletAccountId — one follow-up read against the just-created sub-org
 * (parent-key-stamped, read-only, bounded).
 *
 * The answer must describe EXACTLY the account the validated create result
 * names, and nothing else. Checked, using fields @turnkey/http 6.5.0's
 * v1WalletAccount actually has:
 *   - exactly one account in the response for this wallet (no extras, no
 *     "first match wins");
 *   - organizationId = the created sub-organization; walletId = the
 *     created wallet;
 *   - address = the created owner address (same 20 bytes; hex case is not
 *     identity — see the report/docs);
 *   - curve, pathFormat, path, addressFormat = REAL_WALLET_ACCOUNT;
 *   - a non-empty walletAccountId.
 * NOT verifiable from this response: whether other wallets or private keys
 * exist in the sub-organization (the lookup is per wallet), and the
 * account's key material (`publicKey` is optional and not compared).
 *
 * null on any failure, timeout, or disagreement: the caller stops in review.
 */
export async function findWalletAccountId(input: {
  config: RealServerConfig;
  subOrganizationId: string;
  walletId: string;
  ownerAddress: string;
  deps: ResolvedParentTurnkeyDeps;
}): Promise<string | null> {
  const body = JSON.stringify({ organizationId: input.subOrganizationId, walletId: input.walletId });
  const result = await postStampedParentRequest({ config: input.config, path: LIST_WALLET_ACCOUNTS_PATH, body, timeoutMs: input.deps.limits.walletReadTimeoutMs, deps: input.deps });
  if (result.kind !== "response" || !result.ok || !result.json || typeof result.json !== "object") return null;
  const accounts = (result.json as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) return null;
  const account = accounts[0] as Record<string, unknown> | null;
  if (!account || typeof account !== "object") return null;
  const { walletAccountId, organizationId, walletId, address, curve, pathFormat, path, addressFormat } = account;
  if (typeof walletAccountId !== "string" || !walletAccountId) return null;
  if (organizationId !== input.subOrganizationId || walletId !== input.walletId) return null;
  if (typeof address !== "string" || !EVM_ADDRESS.test(address) || !EVM_ADDRESS.test(input.ownerAddress) || address.toLowerCase() !== input.ownerAddress.toLowerCase()) return null;
  if (curve !== REAL_WALLET_ACCOUNT.curve || pathFormat !== REAL_WALLET_ACCOUNT.pathFormat || path !== REAL_WALLET_ACCOUNT.path || addressFormat !== REAL_WALLET_ACCOUNT.addressFormat) return null;
  return walletAccountId;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
