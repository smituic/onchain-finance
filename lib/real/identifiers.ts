const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!ADDRESS_PATTERN.test(trimmed)) return null;
  return `0x${trimmed.slice(2).toLowerCase()}`;
}

/**
 * Validates 0x + 40 hex chars WITHOUT changing case. Use this — never
 * normalizeAddress — for a Turnkey wallet/owner address. Turnkey's
 * signRawPayload resource lookup is exact-string / case-sensitive ("Could
 * not find any resource to sign with. Addresses are case sensitive."), so
 * lowercasing the address Turnkey returned makes Turnkey unable to find the
 * wallet account. normalizeAddress remains correct for plain EVM addresses
 * (recipients, tokens, the Safe address) where chain calls are
 * case-insensitive.
 */
export function validateAddressCasePreserving(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!ADDRESS_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function normalizeHash(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!HASH_PATTERN.test(trimmed)) return null;
  return `0x${trimmed.slice(2).toLowerCase()}`;
}

export function normalizeTurnkeyId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!UUID_PATTERN.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function assertNormalizedAddress(value: string, label: string): string {
  const normalized = normalizeAddress(value);
  if (!normalized) throw new Error(`${label} is not a valid Ethereum address.`);
  return normalized;
}

export function addressesEqual(a: string, b: string): boolean {
  const left = normalizeAddress(a);
  const right = normalizeAddress(b);
  return left !== null && left === right;
}
