import { createHash } from "node:crypto";
import type { ParentTurnkeyDeps } from "@/lib/real/server/turnkey-provisioning";

/**
 * Stateful stand-in for the PARENT organization's side of Turnkey, as the
 * provisioning path talks to it: raw, parent-stamped POSTs to
 * create_sub_organization, get_activity and list_wallet_accounts. Nothing
 * leaves the process.
 *
 * It answers the way the live API was observed to (read-only probe): the
 * activity's intent is the request's `parameters` with the KEYS REORDERED,
 * `fingerprint` is "sha256:" + sha256(exact body), the single vote echoes
 * the exact body, `createdAt` is whole seconds (and so can precede the
 * request's millisecond timestamp), `failure` is null unless the activity
 * failed, and an unknown activity id is HTTP 404 / code 5.
 *
 * Every request is recorded byte-for-byte, in order, so a test can prove
 * what was sent, how often, and what had already happened when it was.
 */
export const CREATE_PATH = "/public/v1/submit/create_sub_organization";
export const GET_ACTIVITY_PATH = "/public/v1/query/get_activity";
export const LIST_WALLET_ACCOUNTS_PATH = "/public/v1/query/list_wallet_accounts";
export const FAKE_OWNER_ADDRESS = "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF";

export type FakeSubmitMode =
  | "completed"
  | "pending"
  | "failed"
  | "rejected"
  | "consensus_needed"
  | "network_error_before_apply"
  | "lose_response_after_apply"
  | "http_500"
  | "unparseable"
  | "hang";

type FakeActivity = Record<string, unknown> & { id: string; status: string; organizationId: string; type: string };
export type RecordedRequest = { path: string; url: string; body: string; headers: Record<string, string>; hasSignal: boolean; cache: string | undefined };

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** The same object with its keys in reverse order, recursively — what "Turnkey reorders keys" looks like to a naive string comparison. */
export function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, inner]) => [key, reorderKeys(inner)]));
  return value;
}

export class FakeParentTurnkey {
  requests: RecordedRequest[] = [];
  activities = new Map<string, FakeActivity>();
  /** The mode of the NEXT create(s): consumed in order, then `submitMode`. */
  submitQueue: FakeSubmitMode[] = [];
  submitMode: FakeSubmitMode = "completed";
  /** For a "pending" create: the activity turns COMPLETED on this many-th get_activity (Infinity: never). */
  completeAfterReads = 1;
  /** What a "pending" create eventually resolves to. */
  pendingResolvesTo: "ACTIVITY_STATUS_COMPLETED" | "ACTIVITY_STATUS_FAILED" | "ACTIVITY_STATUS_REJECTED" = "ACTIVITY_STATUS_COMPLETED";
  getActivityMode: "ok" | "error" | "not_found" | "hang" = "ok";
  walletMode: "ok" | "empty" | "error" | "hang" = "ok";
  /** Last-moment edit of the list_wallet_accounts answer's accounts — for crafting wrong bindings. */
  transformWalletAccounts: ((accounts: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) | null = null;
  ownerAddress = FAKE_OWNER_ADDRESS;
  /** Last-moment edit of an activity before it is served (create response and reads alike) — for crafting mismatches. */
  transformActivity: ((activity: FakeActivity) => FakeActivity) | null = null;
  /** Runs at the start of every request, before anything is applied or answered. */
  onRequest: ((request: RecordedRequest) => void | Promise<void>) | null = null;
  private seq = 0;
  private readsById = new Map<string, number>();

  get createRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.path === CREATE_PATH);
  }
  get activityReads(): RecordedRequest[] {
    return this.requests.filter((request) => request.path === GET_ACTIVITY_PATH);
  }
  get walletReads(): RecordedRequest[] {
    return this.requests.filter((request) => request.path === LIST_WALLET_ACCOUNTS_PATH);
  }

  /** A syntactically plausible stamp bound to the body; the real ApiKeyStamper is exercised in turnkey-provisioning.test.ts. */
  stamp = async (body: string) => ({ stampHeaderName: "X-Stamp", stampHeaderValue: `fake-parent-stamp.${sha256Hex(body)}` });

  /** A strictly increasing millisecond clock: two dispatches never share a timestamp (an identical body is refused — see the store's unique body digest). */
  private clock = 0;
  now = () => {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  };

  deps(extra: Partial<ParentTurnkeyDeps> = {}): ParentTurnkeyDeps {
    return { fetchImpl: this.fetchImpl, stamp: this.stamp, now: this.now, sleep: async () => {}, ...extra };
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private served(activity: FakeActivity): FakeActivity {
    return this.transformActivity ? this.transformActivity(structuredClone(activity)) : activity;
  }

  /** Never resolves; rejects like fetch does when its signal aborts. */
  private hang(signal: AbortSignal | undefined): Promise<Response> {
    return new Promise((_resolve, reject) => {
      if (!signal) return;
      const abort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }

  private applyCreate(body: string, status: string): FakeActivity {
    this.seq += 1;
    const parsed = JSON.parse(body) as { type: string; timestampMs: string; organizationId: string; parameters: Record<string, unknown> };
    const seconds = String(Math.floor(Number(parsed.timestampMs) / 1000));
    const stamp = { seconds, nanos: "0" };
    const completed = status === "ACTIVITY_STATUS_COMPLETED";
    const failed = status === "ACTIVITY_STATUS_FAILED" || status === "ACTIVITY_STATUS_REJECTED";
    const activity: FakeActivity = {
      id: `activity-${this.seq}`,
      organizationId: parsed.organizationId,
      status,
      type: parsed.type,
      intent: { createSubOrganizationIntentV8: reorderKeys(parsed.parameters) },
      result: completed
        ? { createSubOrganizationResultV8: { subOrganizationId: `sub-org-${this.seq}`, wallet: { walletId: `wallet-${this.seq}`, addresses: [this.ownerAddress] }, rootUserIds: [`turnkey-user-${this.seq}`] } }
        : null,
      votes: [{ id: `vote-${this.seq}`, userId: "parent-user", activityId: `activity-${this.seq}`, selection: "VOTE_SELECTION_APPROVED", message: body, publicKey: this.votePublicKey, scheme: "SIGNATURE_SCHEME_TK_API_P256", createdAt: stamp }],
      appProofs: [],
      fingerprint: `sha256:${sha256Hex(body)}`,
      canApprove: true,
      canReject: true,
      createdAt: stamp,
      updatedAt: stamp,
      failure: failed ? { code: 3, message: "invalid authenticator attestation: ChallengeMismatch", details: [] } : null,
    };
    this.activities.set(activity.id, activity);
    return activity;
  }

  /** The API public key the fake attributes votes to; tests set it to config.turnkeyApiPublicKey. */
  votePublicKey = "pub";

  fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const path = new URL(href).pathname;
    const body = String(init?.body ?? "");
    const signal = init?.signal ?? undefined;
    const request: RecordedRequest = { path, url: href, body, headers: { ...(init?.headers as Record<string, string>) }, hasSignal: Boolean(signal), cache: init?.cache };
    this.requests.push(request);
    await this.onRequest?.(request);

    if (path === CREATE_PATH) {
      const mode = this.submitQueue.shift() ?? this.submitMode;
      if (mode === "hang") return this.hang(signal);
      if (mode === "network_error_before_apply") throw new TypeError("fetch failed");
      if (mode === "http_500") return this.json({ code: 13, message: "internal error", details: [] }, 500);
      const status =
        mode === "pending"
          ? "ACTIVITY_STATUS_PENDING"
          : mode === "failed"
            ? "ACTIVITY_STATUS_FAILED"
            : mode === "rejected"
              ? "ACTIVITY_STATUS_REJECTED"
              : mode === "consensus_needed"
                ? "ACTIVITY_STATUS_CONSENSUS_NEEDED"
                : "ACTIVITY_STATUS_COMPLETED";
      const activity = this.applyCreate(body, status);
      if (mode === "lose_response_after_apply") throw new TypeError("fetch failed");
      if (mode === "unparseable") return new Response("<html>gateway</html>", { status: 200 });
      return this.json({ activity: this.served(activity) });
    }

    if (path === GET_ACTIVITY_PATH) {
      if (this.getActivityMode === "hang") return this.hang(signal);
      if (this.getActivityMode === "error") return this.json({ code: 14, message: "unavailable", details: [] }, 503);
      const { activityId } = JSON.parse(body) as { organizationId: string; activityId: string };
      const activity = this.activities.get(activityId);
      if (!activity || this.getActivityMode === "not_found") return this.json({ code: 5, message: `activity ID: "${activityId}" not found`, details: [], turnkeyErrorCode: "NOT_FOUND" }, 404);
      const reads = (this.readsById.get(activityId) ?? 0) + 1;
      this.readsById.set(activityId, reads);
      if (activity.status === "ACTIVITY_STATUS_PENDING" && reads >= this.completeAfterReads) {
        const resolved = this.pendingResolvesTo;
        activity.status = resolved;
        if (resolved === "ACTIVITY_STATUS_COMPLETED") {
          const n = activity.id.split("-").pop();
          activity.result = { createSubOrganizationResultV8: { subOrganizationId: `sub-org-${n}`, wallet: { walletId: `wallet-${n}`, addresses: [this.ownerAddress] }, rootUserIds: [`turnkey-user-${n}`] } };
        } else {
          activity.failure = { code: 3, message: "invalid authenticator attestation: ChallengeMismatch", details: [] };
        }
      }
      return this.json({ activity: this.served(activity) });
    }

    if (path === LIST_WALLET_ACCOUNTS_PATH) {
      if (this.walletMode === "hang") return this.hang(signal);
      if (this.walletMode === "error") return this.json({ code: 14, message: "unavailable", details: [] }, 503);
      const { organizationId, walletId } = JSON.parse(body) as { organizationId: string; walletId: string };
      // The live v1WalletAccount shape (@turnkey/http 6.5.0), for the one account REAL_WALLET_ACCOUNT describes.
      const accounts: Array<Record<string, unknown>> =
        this.walletMode === "empty"
          ? []
          : [
              {
                walletAccountId: walletId.replace("wallet-", "wallet-account-"),
                organizationId,
                walletId,
                curve: "CURVE_SECP256K1",
                pathFormat: "PATH_FORMAT_BIP32",
                path: "m/44'/60'/0'/0/0",
                addressFormat: "ADDRESS_FORMAT_ETHEREUM",
                address: this.ownerAddress,
                createdAt: { seconds: "1790204988", nanos: "0" },
                updatedAt: { seconds: "1790204988", nanos: "0" },
                publicKey: "02".padEnd(66, "a"),
              },
            ];
      return this.json({ accounts: this.transformWalletAccounts ? this.transformWalletAccounts(accounts) : accounts });
    }

    return this.json({ code: 12, message: "unimplemented", details: [] }, 404);
  }) as typeof fetch;
}
