import { createInMemoryChallengeStore, type ChallengeStore } from "./challenge-store";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "./registry";
import { createInMemoryRegistrationAttemptStore, type RegistrationAttemptStore } from "./registration-attempts";
import { createInMemoryPaymentAttemptStore, type PaymentAttemptStore } from "./payment-attempts";
import { createNeonDurableStores } from "./neon-store";

/**
 * Process-local store selection: Neon Postgres (server/neon-store.ts) when
 * DATABASE_URL is configured, in-memory otherwise. In-memory resets on
 * every server restart/cold start — the durable onboarding pipeline
 * (server/onboarding.ts) is designed to recover from a crash mid-onboarding,
 * but only once a real database is configured; without one, a restart
 * during onboarding is unrecoverable by design (there is nothing to
 * recover from), which is fine for local development, not production.
 *
 * This file has never connected to a live Neon database in this session —
 * no DATABASE_URL/credentials were available. See the Batch 2b report's
 * "env setup" section for what's needed before this path is exercised.
 */
let registry: RealAccountRegistry | null = null;
let challengeStore: ChallengeStore | null = null;
let attemptStore: RegistrationAttemptStore | null = null;
let paymentAttemptStore: PaymentAttemptStore | null = null;

function ensureStoresInitialized(): void {
  if (registry && challengeStore && attemptStore && paymentAttemptStore) return;

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    const durable = createNeonDurableStores(databaseUrl);
    registry = durable.registry;
    challengeStore = durable.challengeStore;
    attemptStore = durable.attempts;
    paymentAttemptStore = durable.payments;
    return;
  }

  registry = createInMemoryRealAccountRegistry();
  challengeStore = createInMemoryChallengeStore();
  attemptStore = createInMemoryRegistrationAttemptStore();
  paymentAttemptStore = createInMemoryPaymentAttemptStore();
}

export function getRealAccountRegistry(): RealAccountRegistry {
  ensureStoresInitialized();
  return registry!;
}

export function getChallengeStore(): ChallengeStore {
  ensureStoresInitialized();
  return challengeStore!;
}

export function getRegistrationAttemptStore(): RegistrationAttemptStore {
  ensureStoresInitialized();
  return attemptStore!;
}

export function getPaymentAttemptStore(): PaymentAttemptStore {
  ensureStoresInitialized();
  return paymentAttemptStore!;
}
