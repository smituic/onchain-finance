import {
  OPERATION_HISTORY_STORAGE_KEY,
  PENDING_OPERATION_STORAGE_KEY,
  PUBLIC_ACCOUNT_STORAGE_KEY,
  SAFE_POC,
} from "./constants";
import { normalizeAddress, normalizeHash, normalizeTurnkeyId, validateAddressCasePreserving } from "./identifiers";
import { isOperationStatus, type OperationStatus } from "./status";

export type PublicAuthenticator = {
  authenticatorId: string;
  authenticatorName: string;
  credentialId: string;
  transports: string[];
};

export type PublicAccountState = {
  appUserId: string;
  subOrganizationId: string;
  userId: string;
  walletId: string;
  ownerAddress: string;
  safeAddress: string | null;
  authenticators: PublicAuthenticator[];
  safe: {
    version: typeof SAFE_POC.version;
    threshold: number;
    saltNonce: string;
    entryPointAddress: string;
    entryPointVersion: typeof SAFE_POC.entryPoint.version;
    moduleAddress: string;
    moduleVersion: string;
    useMultiSendForSetup: boolean;
  };
};

export type PendingOperation = {
  id: string;
  status: OperationStatus;
  recipient: string;
  amountUsdc: string;
  userOperationHash: string | null;
  transactionHash: string | null;
  receiptStatus: "success" | "reverted" | null;
  submittedAt: string;
  lastError: string | null;
  autoResend: false;
  /** The id of the historical confirmed PendingOperation this record is a DEV-ONLY local recovery simulation of — see recovery-harness.ts. null for every real operation. */
  simulatedRecoveryOf: string | null;
};

export function createEmptyPendingOperation(partial: Partial<PendingOperation> & Pick<PendingOperation, "id" | "recipient" | "amountUsdc">): PendingOperation {
  return {
    status: "preparing",
    userOperationHash: null,
    transactionHash: null,
    receiptStatus: null,
    submittedAt: new Date(0).toISOString(),
    lastError: null,
    autoResend: false,
    simulatedRecoveryOf: null,
    ...partial,
  };
}

export function parsePublicAccountState(value: unknown): PublicAccountState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const appUserId = typeof record.appUserId === "string" ? record.appUserId : null;
  const subOrganizationId = normalizeTurnkeyId(asString(record.subOrganizationId));
  const userId = normalizeTurnkeyId(asString(record.userId));
  const walletId = normalizeTurnkeyId(asString(record.walletId));
  // Turnkey's wallet resource lookup is case-sensitive — preserve exact casing.
  const ownerAddress = validateAddressCasePreserving(asString(record.ownerAddress));
  if (!appUserId || !subOrganizationId || !userId || !walletId || !ownerAddress) return null;

  const authenticators = Array.isArray(record.authenticators)
    ? record.authenticators.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const auth = item as Record<string, unknown>;
        const authenticatorId = asString(auth.authenticatorId);
        const credentialId = asString(auth.credentialId);
        if (!authenticatorId || !credentialId) return [];
        return [
          {
            authenticatorId,
            authenticatorName: asString(auth.authenticatorName) ?? "Passkey",
            credentialId,
            transports: Array.isArray(auth.transports) ? auth.transports.filter((t): t is string => typeof t === "string") : [],
          },
        ];
      })
    : [];

  return {
    appUserId,
    subOrganizationId,
    userId,
    walletId,
    ownerAddress,
    safeAddress: normalizeAddress(asString(record.safeAddress)),
    authenticators,
    safe: {
      version: SAFE_POC.version,
      threshold: SAFE_POC.threshold,
      saltNonce: SAFE_POC.saltNonce,
      entryPointAddress: SAFE_POC.entryPoint.address,
      entryPointVersion: SAFE_POC.entryPoint.version,
      moduleAddress: SAFE_POC.module.address,
      moduleVersion: SAFE_POC.module.version,
      useMultiSendForSetup: SAFE_POC.useMultiSendForSetup,
    },
  };
}

export function parsePendingOperation(value: unknown): PendingOperation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const recipient = normalizeAddress(asString(record.recipient));
  const amountUsdc = asString(record.amountUsdc);
  const status = asString(record.status);
  if (!id || !recipient || !amountUsdc || !status || !isOperationStatus(status)) return null;
  if (record.autoResend === true) return null;

  return {
    id,
    status,
    recipient,
    amountUsdc,
    userOperationHash: normalizeHash(asString(record.userOperationHash)),
    transactionHash: normalizeHash(asString(record.transactionHash)),
    receiptStatus: record.receiptStatus === "success" || record.receiptStatus === "reverted" ? record.receiptStatus : null,
    submittedAt: asString(record.submittedAt) ?? new Date(0).toISOString(),
    lastError: asString(record.lastError),
    autoResend: false,
    simulatedRecoveryOf: asString(record.simulatedRecoveryOf),
  };
}

export function readJsonStorage<T>(key: string, parse: (value: unknown) => T | null): T | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return parse(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeJsonStorage(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function clearTurnkeyPocPublicStorage(): void {
  localStorage.removeItem(PUBLIC_ACCOUNT_STORAGE_KEY);
  localStorage.removeItem(PENDING_OPERATION_STORAGE_KEY);
  localStorage.removeItem(OPERATION_HISTORY_STORAGE_KEY);
}

export function loadPublicAccount(): PublicAccountState | null {
  return readJsonStorage(PUBLIC_ACCOUNT_STORAGE_KEY, parsePublicAccountState);
}

export function savePublicAccount(state: PublicAccountState): void {
  writeJsonStorage(PUBLIC_ACCOUNT_STORAGE_KEY, state);
}

export function loadPendingOperation(): PendingOperation | null {
  return readJsonStorage(PENDING_OPERATION_STORAGE_KEY, parsePendingOperation);
}

export function savePendingOperation(operation: PendingOperation): void {
  writeJsonStorage(PENDING_OPERATION_STORAGE_KEY, operation);
}

/**
 * Clears only the active pending-operation pointer, not the account or the
 * operation history — used to manually unstick the "one unresolved payment
 * at a time" guard after the user has checked USDC history or reconciled by
 * hash. The cleared operation stays visible in history; this never touches
 * the chain and is not a resend.
 */
export function clearPendingOperation(): void {
  localStorage.removeItem(PENDING_OPERATION_STORAGE_KEY);
}

export function loadOperationHistory(): PendingOperation[] {
  return readJsonStorage(OPERATION_HISTORY_STORAGE_KEY, (value) => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const parsed = parsePendingOperation(item);
      return parsed ? [parsed] : [];
    });
  }) ?? [];
}

export function rememberOperation(operation: PendingOperation): void {
  const history = loadOperationHistory().filter((item) => item.id !== operation.id);
  writeJsonStorage(OPERATION_HISTORY_STORAGE_KEY, [operation, ...history].slice(0, 20));
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
