import { createInMemoryChallengeStore, type ChallengeStore } from "./challenge-store";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "./registry";
import { createInMemoryRegistrationAttemptStore, type RegistrationAttemptStore } from "./registration-attempts";
import { createInMemoryPaymentAttemptStore, type PaymentAttemptStore } from "./payment-attempts";
import { createInMemoryBackupPasskeyEnrollmentStore, type BackupPasskeyEnrollmentStore } from "./backup-passkey-enrollment";
import { createInMemoryPasskeyRevocationStore, type PasskeyRevocationStore } from "./passkey-revocation-attempts";
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
 * Live-verified against a real Neon database (Batch 2b registration/
 * restoration, Batch 2d Real Pay, Batch 2e payment history) — this is no
 * longer an unexercised path.
 *
 * Pre-2f hardening: production must never silently fall back to in-memory
 * storage — see the NODE_ENV check below.
 */
let registry: RealAccountRegistry | null = null;
let challengeStore: ChallengeStore | null = null;
let attemptStore: RegistrationAttemptStore | null = null;
let paymentAttemptStore: PaymentAttemptStore | null = null;
let backupEnrollmentStore: BackupPasskeyEnrollmentStore | null = null;
let revocationStore: PasskeyRevocationStore | null = null;

function ensureStoresInitialized(): void {
  if (registry && challengeStore && attemptStore && paymentAttemptStore && backupEnrollmentStore && revocationStore) return;

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    const durable = createNeonDurableStores(databaseUrl);
    registry = durable.registry;
    challengeStore = durable.challengeStore;
    attemptStore = durable.attempts;
    paymentAttemptStore = durable.payments;
    backupEnrollmentStore = durable.backupEnrollments;
    revocationStore = durable.revocations;
    return;
  }

  if (process.env.NODE_ENV === "production") {
    // Fail closed: a production deployment with no durable database would
    // otherwise silently run on ephemeral, single-process in-memory
    // stores — accounts, passkeys, and payment attempts all vanish on the
    // next restart/cold start, with no signal beyond a doc comment. This
    // throw surfaces as a clear server-side error (visible in the
    // platform's own function/request logs) instead.
    throw new Error("Real Mode is misconfigured: DATABASE_URL is required in production and none was provided.");
  }

  registry = createInMemoryRealAccountRegistry();
  challengeStore = createInMemoryChallengeStore();
  attemptStore = createInMemoryRegistrationAttemptStore();
  paymentAttemptStore = createInMemoryPaymentAttemptStore(registry);
  backupEnrollmentStore = createInMemoryBackupPasskeyEnrollmentStore(registry);
  revocationStore = createInMemoryPasskeyRevocationStore(registry);
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

export function getBackupPasskeyEnrollmentStore(): BackupPasskeyEnrollmentStore {
  ensureStoresInitialized();
  return backupEnrollmentStore!;
}

export function getPasskeyRevocationStore(): PasskeyRevocationStore {
  ensureStoresInitialized();
  return revocationStore!;
}
