/**
 * The durable Real Pay state machine (Batch 2d):
 *
 *   prepared -> awaiting_authorization -> signed -> submitting -> submitted -> confirmed
 *                                                                      \-> unknown
 *        \-> failed (definitive pre- or at-dispatch failure, retryable)
 *        \-> cancelled (the browser abandoned the flow before signing)
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
 * `reserve()` is the single atomic entry point for creating a new attempt —
 * it enforces BOTH the per-account rate limit (10/hour, 30/day) AND "at most
 * one non-terminal attempt per account" in one operation, so there is no
 * separate count-then-create pair for a caller to misuse non-atomically. The
 * Neon adapter (neon-store.ts) implements this as a single SQL statement
 * (advisory-lock + quota count + conditional insert) plus a partial unique
 * index as a database-level backstop; the in-memory adapter here enforces
 * the identical contract synchronously (no `await` between reading current
 * state and committing a new attempt), so both are race-safe for the same
 * reason registration-attempts.ts's in-memory adapter is.
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
    | "transactionHash"
    | "failureReason"
  >
>;

export type ReserveResult = { ok: true; attempt: PaymentAttempt } | { ok: false; reason: "quota_exceeded" | "payment_in_progress" };

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
  reserve(input: { appUserId: string; safeAddress: string; recipient: string; amountBaseUnits: string; chainId: number; tokenAddress: string }): Promise<ReserveResult>;

  findById(id: string): Promise<PaymentAttempt | null>;

  findLatestByAppUserId(appUserId: string): Promise<PaymentAttempt | null>;

  /**
   * Concurrency-safe compare-and-swap: applies only if the attempt is
   * currently in `from` state. Returns null (never throws) if another
   * concurrent caller already moved it — this is also the duplicate-submit
   * guard (a second concurrent /submit for the same attempt id finds the
   * row no longer in `awaiting_authorization`/`signed` and backs off).
   */
  transition(input: { id: string; from: PaymentAttemptState; to: PaymentAttemptState; patch?: PaymentAttemptPatch }): Promise<PaymentAttempt | null>;
}

export function createInMemoryPaymentAttemptStore(): PaymentAttemptStore {
  const attempts = new Map<string, PaymentAttempt>();
  let nextId = 0;

  function forAccount(appUserId: string): PaymentAttempt[] {
    return [...attempts.values()].filter((attempt) => attempt.appUserId === appUserId);
  }

  return {
    async reserve(input) {
      // Everything below is synchronous (no `await`) until the write —
      // under Node's single-threaded event loop this makes reserve() a
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
        id: `payment-attempt-${(nextId += 1)}`,
        appUserId: input.appUserId,
        safeAddress: input.safeAddress,
        recipient: input.recipient,
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
        transactionHash: null,
        failureReason: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      attempts.set(attempt.id, attempt);
      return { ok: true, attempt };
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
      const next: PaymentAttempt = { ...current, ...patch, state: to, updatedAt: new Date().toISOString() };
      attempts.set(id, next);
      return next;
    },
  };
}
