import { randomUUID } from "node:crypto";
import { normalizeAddress } from "../identifiers";
import { getInMemoryRegistryInternals, type RealAccountRegistry } from "./registry";

/**
 * The durable Real Pay state machine (Batch 2d):
 *
 *   prepared -> awaiting_authorization -> signed -> submitting -> submitted -> confirmed
 *                                                                      \-> unknown
 *        \-> failed (definitive pre- or at-dispatch failure, retryable)
 *        \-> cancelled (the browser abandoned the flow before signing)
 *
 * Finite expiry: every attempt carries the SafeOp validUntil its owner must
 * sign (lib/real/payments/validity.ts). Submit refuses (signed -> failed,
 * nothing dispatched) a signature over any other window or one too close to
 * expiry; reconciliation may move submitting/submitted/unknown -> failed only
 * on on-chain PROOF the operation can never land (its nonce unconsumed at a
 * finalized block past validUntil — lib/real/chain/entry-point.ts).
 *
 * Only confirmed/failed/cancelled are terminal. `submitting` and `unknown`
 * are both sticky, non-resendable states: `submitting` is written durably
 * BEFORE eth_sendUserOperation is ever dispatched (closing the crash window
 * between "signature verified" and "dispatch result recorded"), and
 * `unknown` covers everything genuinely ambiguous after that. Neither state
 * may ever trigger a second dispatch for the same attempt; only
 * reconciliation (server/payments.ts's resolvePaymentStatus, via
 * expected_user_operation_hash) can resolve either of them.
 *
 * `reserve()` (an address payment) and `reserveHandlePayment()` (an @handle
 * payment, Handle Pay Slice B) are the only atomic entry points for creating a
 * new attempt — each enforces BOTH the per-account rate limit (10/hour,
 * 30/day) AND "at most one non-terminal attempt per account" in one
 * operation, so there is no separate count-then-create pair for a caller to
 * misuse non-atomically. They share one quota and one active-attempt rule;
 * the handle variant additionally resolves the recipient inside the same
 * operation and records the identity snapshot, while reserve() records none. The
 * Neon adapter (neon-store.ts) implements this as a single SQL statement
 * (advisory-lock + quota count + conditional insert) plus a partial unique
 * index as a database-level backstop; the in-memory adapter here enforces
 * the identical contract synchronously (no `await` between reading current
 * state and committing a new attempt, same technique registration-attempts.ts's
 * in-memory adapter uses), so it is fully race-safe.
 *
 * The Neon adapter is not symmetrically race-safe in every respect: per its
 * own "PRE-2F CORRECTED CLAIM" (neon-store.ts), the advisory lock does not
 * refresh its statement's read-committed snapshot, so the hourly/daily quota
 * counts there are only serially enforced and best-effort precise. What IS a
 * hard invariant on both adapters is "at most one active attempt per
 * account" — on Neon backed by the partial unique index (a database
 * constraint independent of any snapshot), and here by this store's
 * synchronous, single-threaded reserve().
 */
export type PaymentAttemptState = "prepared" | "awaiting_authorization" | "signed" | "submitting" | "submitted" | "confirmed" | "failed" | "cancelled" | "unknown";

const NON_TERMINAL_STATES: readonly PaymentAttemptState[] = ["prepared", "awaiting_authorization", "signed", "submitting", "submitted", "unknown"];

export function isTerminalState(state: PaymentAttemptState): boolean {
  return !NON_TERMINAL_STATES.includes(state);
}

export type PaymentAttempt = {
  id: string;
  appUserId: string;
  safeAddress: string;
  recipient: string;
  amountBaseUnits: string;
  chainId: number;
  tokenAddress: string;
  state: PaymentAttemptState;
  nonce: string | null;
  callData: string | null;
  factory: string | null;
  factoryData: string | null;
  callGasLimit: string | null;
  verificationGasLimit: string | null;
  preVerificationGas: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  paymaster: string | null;
  paymasterData: string | null;
  paymasterVerificationGasLimit: string | null;
  paymasterPostOpGasLimit: string | null;
  /** Computed and persisted BEFORE eth_sendUserOperation is ever dispatched — see lib/real/payments/hash.ts. */
  expectedUserOperationHash: string | null;
  /** Unix seconds — the SafeOp validUntil the owner must sign (lib/real/payments/validity.ts). Null only on pre-expiry legacy rows, which are never dispatched. */
  validUntil: number | null;
  /** Decimal string (uint64 block number) — lower bound of on-chain reconciliation's event search. */
  prepareBlockNumber: string | null;
  /**
   * Slice S1: the ONE passkey that may authorize this payment — the app
   * session credential at prepare, set by reserve() and never patched. Null
   * only on pre-attribution legacy rows, which are never signed or
   * dispatched and never back-filled.
   */
  authorizingCredentialId: string | null;
  /**
   * Handle Pay Slice B — the recipient identity SNAPSHOT, SERVER-ONLY. All
   * three are null for an address payment (every direct-address payment, and
   * every row before Slice B). For a handle payment the store writes them
   * together with `recipient` from ONE authoritative resolution (never from a
   * caller): the recipient's account, the canonical handle that was paid, and
   * the display name as it was at prepare. They are not a public shape — not
   * in the prepare response, history, or any browser state.
   */
  recipientAppUserId: string | null;
  recipientHandle: string | null;
  recipientDisplayName: string | null;
  /** The Turnkey signRawPayload activity proven (server-side read) to be this payment's approval by authorizingCredentialId. Write-once; unique across payments. */
  turnkeySignActivityId: string | null;
  /** ISO time that proof passed. Write-once. */
  authorizationVerifiedAt: string | null;
  transactionHash: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PaymentAttemptPatch = Partial<
  Pick<
    PaymentAttempt,
    | "nonce"
    | "callData"
    | "factory"
    | "factoryData"
    | "callGasLimit"
    | "verificationGasLimit"
    | "preVerificationGas"
    | "maxFeePerGas"
    | "maxPriorityFeePerGas"
    | "paymaster"
    | "paymasterData"
    | "paymasterVerificationGasLimit"
    | "paymasterPostOpGasLimit"
    | "expectedUserOperationHash"
    | "validUntil"
    | "prepareBlockNumber"
    | "turnkeySignActivityId"
    | "authorizationVerifiedAt"
    | "transactionHash"
    | "failureReason"
  >
>;

/** Thrown by transition() when a patch would record a Turnkey signing activity already recorded on ANOTHER attempt — one approval never authorizes two payments. The write is not applied. */
export class DuplicateSignActivityError extends Error {
  constructor() {
    super("This Turnkey signing activity is already recorded on another payment.");
    this.name = "DuplicateSignActivityError";
  }
}

export type ReserveResult = { ok: true; attempt: PaymentAttempt } | { ok: false; reason: "quota_exceeded" | "payment_in_progress" };

/**
 * What a handle payment's reservation may be told. There is deliberately NO
 * recipient address, recipient app_user_id, or display name here: the store
 * derives all three from the handle, in the one authoritative statement.
 */
export type ReserveHandlePaymentInput = {
  appUserId: string;
  safeAddress: string;
  /** Already canonical (lib/real/handle.ts) — the store does not canonicalize. */
  recipientHandle: string;
  amountBaseUnits: string;
  chainId: number;
  tokenAddress: string;
  authorizingCredentialId: string;
};

/** `recipient_not_found` covers a reserved handle, a nonexistent one, a missing account, and an invalid Safe — callers must not distinguish them. `self_payment`: the handle is the payer's own account. */
export type ReserveHandlePaymentResult =
  | { ok: true; attempt: PaymentAttempt }
  | { ok: false; reason: "recipient_not_found" | "self_payment" | "quota_exceeded" | "payment_in_progress" };

export const PAYMENT_RATE_LIMIT = { perHour: 10, perDay: 30 } as const;

/**
 * Server-only, vendor-neutral — mirrors registration-attempts.ts's shape.
 * Route handlers (via server/payments.ts) depend on this interface, never
 * on a specific backing store.
 */
export interface PaymentAttemptStore {
  /**
   * The single atomic entry point: reserves a new `prepared` row for
   * `input.appUserId`, or refuses without creating anything if the account
   * already has a non-terminal attempt, or has hit its hourly/daily quota.
   * Every call counts toward quota, whether or not the external Pimlico
   * `prepareUserOperation` that follows a successful reservation succeeds —
   * that call happens after reserve(), never before.
   */
  reserve(input: { appUserId: string; safeAddress: string; recipient: string; amountBaseUnits: string; chainId: number; tokenAddress: string; authorizingCredentialId: string }): Promise<ReserveResult>;

  /**
   * Handle Pay Slice B — the same single atomic entry point, for a payment
   * addressed to an @handle. Quota and the one-active-payment rule are
   * IDENTICAL to reserve(); the difference is that the recipient is resolved
   * INSIDE the reservation: the claimed handle, its account, and that
   * account's Safe come from the database in the same operation that creates
   * the row (the Neon adapter is one INSERT ... SELECT), and
   * `recipient`, `recipientAppUserId`, `recipientHandle`, and
   * `recipientDisplayName` are all written from those joined rows. Nothing
   * is created when the handle does not resolve to another account's valid
   * Safe. Whether the recipient has an active passkey is irrelevant.
   * reserve() stays address-only and never touches the handle directory.
   */
  reserveHandlePayment(input: ReserveHandlePaymentInput): Promise<ReserveHandlePaymentResult>;

  findById(id: string): Promise<PaymentAttempt | null>;

  findLatestByAppUserId(appUserId: string): Promise<PaymentAttempt | null>;

  /**
   * Batch 2e: bounded, newest-first read for the history view — never
   * signs, never mutates. `limit` is expected to already be validated/
   * clamped by the caller (see server/payment-history.ts's
   * clampHistoryLimit); adapters trust it as a plain positive integer.
   */
  findRecentByAppUserId(input: { appUserId: string; limit: number }): Promise<PaymentAttempt[]>;

  /**
   * Concurrency-safe compare-and-swap: applies only if the attempt is
   * currently in `from` state. Returns null (never throws) if another
   * concurrent caller already moved it — this is also the duplicate-submit
   * guard (a second concurrent /submit for the same attempt id finds the
   * row no longer in `awaiting_authorization`/`signed` and backs off).
   *
   * turnkeySignActivityId/authorizationVerifiedAt are write-once (an
   * existing value is never overwritten); recording an activity id already
   * on another attempt throws DuplicateSignActivityError and applies nothing.
   */
  transition(input: { id: string; from: PaymentAttemptState; to: PaymentAttemptState; patch?: PaymentAttemptPatch }): Promise<PaymentAttempt | null>;

  /**
   * Slice S1 — the ONE atomic claim of the right to dispatch: `signed ->
   * submitting` only if, in the same serialized step, the attempt's bound
   * credential is still an `active` passkey of the same account. Returns
   * null (never throws for a lost race) when the row isn't `signed` or the
   * passkey isn't active; the caller re-reads to tell which.
   *
   * Serialization (Neon): the account row is locked FOR UPDATE first — the
   * same first lock every Batch 2g passkey transaction (removal dispatch,
   * removal confirmation, enrollment activation) takes before touching
   * real_passkeys — so a removal that commits first is seen here, and one
   * that starts later waits for this claim to commit. Never held across any
   * network call: the caller dispatches only after this returns.
   */
  beginDispatch(input: { id: string }): Promise<PaymentAttempt | null>;
}

/**
 * `registry` must be the in-memory registry this adapter's attempts are
 * bound against — beginDispatch reads its passkey map synchronously (the
 * in-memory equivalent of the Neon account lock). Without one, beginDispatch
 * always refuses: dispatch is never claimed on unverifiable passkey state.
 */
export function createInMemoryPaymentAttemptStore(registry?: RealAccountRegistry): PaymentAttemptStore {
  const attempts = new Map<string, PaymentAttempt>();
  const passkeys = registry ? getInMemoryRegistryInternals(registry).passkeysByCredentialId : null;

  const accounts = registry ? getInMemoryRegistryInternals(registry).accountsByAppUserId : null;

  function forAccount(appUserId: string): PaymentAttempt[] {
    return [...attempts.values()].filter((attempt) => attempt.appUserId === appUserId);
  }

  /** The one place an in-memory attempt is created — address and handle payments share the exact same active-attempt and quota rules. */
  function reserveAttempt(
    input: { appUserId: string; safeAddress: string; amountBaseUnits: string; chainId: number; tokenAddress: string; authorizingCredentialId: string },
    destination: { recipient: string; recipientAppUserId: string | null; recipientHandle: string | null; recipientDisplayName: string | null },
  ): ReserveResult {
    // Everything below is synchronous (no `await`) until the write —
    // under Node's single-threaded event loop this makes reservation a
    // single atomic unit even under Promise.all([...]) concurrency,
    // exactly like registry.ts's/registration-attempts.ts's in-memory
    // adapters.
    const now = Date.now();
    const mine = forAccount(input.appUserId);

    if (mine.some((attempt) => !isTerminalState(attempt.state))) {
      return { ok: false, reason: "payment_in_progress" };
    }

    const hourly = mine.filter((attempt) => now - new Date(attempt.createdAt).getTime() < 60 * 60 * 1000).length;
    if (hourly >= PAYMENT_RATE_LIMIT.perHour) return { ok: false, reason: "quota_exceeded" };

    const daily = mine.filter((attempt) => now - new Date(attempt.createdAt).getTime() < 24 * 60 * 60 * 1000).length;
    if (daily >= PAYMENT_RATE_LIMIT.perDay) return { ok: false, reason: "quota_exceeded" };

    const nowIso = new Date(now).toISOString();
    const attempt: PaymentAttempt = {
      // Pre-2f hardening: a real UUID, matching Neon's gen_random_uuid()
      // shape — not a "payment-attempt-N" placeholder. The new
      // isValidUuid() guard (identifiers.ts) rejects non-UUID ids before
      // they ever reach a store lookup, so this store's ids must be
      // structurally realistic, not just unique.
      id: randomUUID(),
      appUserId: input.appUserId,
      safeAddress: input.safeAddress,
      recipient: destination.recipient,
      amountBaseUnits: input.amountBaseUnits,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      state: "prepared",
      nonce: null,
      callData: null,
      factory: null,
      factoryData: null,
      callGasLimit: null,
      verificationGasLimit: null,
      preVerificationGas: null,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      paymaster: null,
      paymasterData: null,
      paymasterVerificationGasLimit: null,
      paymasterPostOpGasLimit: null,
      expectedUserOperationHash: null,
      validUntil: null,
      prepareBlockNumber: null,
      authorizingCredentialId: input.authorizingCredentialId,
      recipientAppUserId: destination.recipientAppUserId,
      recipientHandle: destination.recipientHandle,
      recipientDisplayName: destination.recipientDisplayName,
      turnkeySignActivityId: null,
      authorizationVerifiedAt: null,
      transactionHash: null,
      failureReason: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    attempts.set(attempt.id, attempt);
    return { ok: true, attempt };
  }

  return {
    async reserve(input) {
      // Address payment: the identity snapshot is explicitly all-null (the
      // Neon twin names the three columns and writes NULL).
      return reserveAttempt(input, { recipient: input.recipient, recipientAppUserId: null, recipientHandle: null, recipientDisplayName: null });
    },

    async reserveHandlePayment(input) {
      // Synchronous from the handle lookup to the write (no `await` anywhere in
      // this path), so the resolution and the reservation are one atomic unit
      // under the event loop — the twin of the Neon statement's single
      // INSERT ... SELECT. Only the payer-supplied payment fields come from the
      // caller; the recipient is resolved here, from the directory.
      const directory = registry ? getInMemoryRegistryInternals(registry).handleDirectory : null;
      const row = directory?.byHandle.get(input.recipientHandle);
      if (!directory || !row || row.kind !== "claimed" || row.appUserId === null) return { ok: false, reason: "recipient_not_found" };
      const account = accounts?.get(row.appUserId);
      const recipient = account ? normalizeAddress(account.safeAddress) : null;
      if (!account || !recipient) return { ok: false, reason: "recipient_not_found" };
      if (account.appUserId === input.appUserId) return { ok: false, reason: "self_payment" };
      return reserveAttempt(input, {
        recipient,
        recipientAppUserId: account.appUserId,
        recipientHandle: row.handle,
        recipientDisplayName: directory.displayNames.get(account.appUserId) ?? null,
      });
    },

    async findById(id) {
      return attempts.get(id) ?? null;
    },

    async findLatestByAppUserId(appUserId) {
      const mine = forAccount(appUserId);
      if (mine.length === 0) return null;
      // >= (not >): millisecond-resolution timestamps can tie between two
      // attempts created in the same tick (routine in fast tests, possible
      // in production too); Map iteration order is insertion order, so
      // ties resolve to the most-recently-inserted attempt, which is what
      // "latest" should mean.
      return mine.reduce((latest, attempt) => (new Date(attempt.createdAt).getTime() >= new Date(latest.createdAt).getTime() ? attempt : latest));
    },

    async transition({ id, from, to, patch }) {
      const current = attempts.get(id);
      if (!current || current.state !== from) return null;
      const activityId = patch?.turnkeySignActivityId;
      if (activityId && [...attempts.values()].some((other) => other.id !== id && other.turnkeySignActivityId === activityId)) {
        throw new DuplicateSignActivityError();
      }
      const next: PaymentAttempt = {
        ...current,
        ...patch,
        turnkeySignActivityId: current.turnkeySignActivityId ?? patch?.turnkeySignActivityId ?? null,
        authorizationVerifiedAt: current.authorizationVerifiedAt ?? patch?.authorizationVerifiedAt ?? null,
        state: to,
        updatedAt: new Date().toISOString(),
      };
      attempts.set(id, next);
      return next;
    },

    async beginDispatch({ id }) {
      // Synchronous from read to write (no await) — atomic under the event
      // loop against any registry status change, like the 2g stores.
      const current = attempts.get(id);
      if (!current || current.state !== "signed" || !current.authorizingCredentialId || !passkeys) return null;
      const bound = passkeys.get(current.authorizingCredentialId);
      if (!bound || bound.appUserId !== current.appUserId || bound.status !== "active") return null;
      const next: PaymentAttempt = { ...current, state: "submitting", updatedAt: new Date().toISOString() };
      attempts.set(id, next);
      return next;
    },

    async findRecentByAppUserId({ appUserId, limit }) {
      // Reverse (Map iteration order is insertion order) BEFORE the stable
      // sort so that attempts tied on millisecond-resolution createdAt
      // resolve most-recently-inserted-first — same tie-break convention as
      // findLatestByAppUserId above. This is deliberately NOT the same
      // tie-break the Neon adapter uses (created_at DESC, id DESC): both
      // stores' ids are random UUIDs (reserve() above uses randomUUID(),
      // same as Neon's gen_random_uuid()), so an id-based tie-break would
      // only be a fixed, repeatable order here too, never a recency signal —
      // this store's actual recency signal is Map insertion order, which
      // Neon has no equivalent of. Both are deterministic — they just can't
      // agree value-for-value given the different tie-break mechanisms.
      return forAccount(appUserId)
        .slice()
        .reverse()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit);
    },
  };
}
