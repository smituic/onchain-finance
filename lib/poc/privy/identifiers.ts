/**
 * Privy PoC — identifier normalisation. DISPOSABLE (see config.ts).
 *
 * The integration surfaces several distinct identifiers that must never be
 * conflated under "tx hash":
 *
 * - Privy user ID (`did:privy:...`) — the account, not a wallet.
 * - Privy wallet ID — Privy's server-side identifier for the embedded wallet.
 * - Account address — the embedded wallet's EOA address. Under Privy's native
 *   gas sponsorship this SAME address becomes the smart account via an
 *   EIP-7702 delegation, so "wallet address" and "smart-account address" are
 *   one value in this configuration (recorded explicitly, not assumed).
 * - User-operation hash — exists inside Privy/Alchemy for sponsored sends but
 *   is NOT surfaced by `useSendTransaction` in @privy-io/react-auth 3.44.0.
 * - Transaction hash — the on-chain identifier, once one exists.
 */

export type HexHash = `0x${string}`;

export type HashNormalisation =
  | { kind: "hash"; value: HexHash }
  /** The SDK returned a string but it is not a 32-byte hash (e.g. "" while a user operation is pending). */
  | { kind: "absent"; raw: string }
  | { kind: "invalid"; raw: string };

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Normalise a 32-byte hex hash to lowercase, distinguishing "no hash yet" from garbage. */
export function normaliseHash(raw: string | null | undefined): HashNormalisation {
  const value = (raw ?? "").trim();
  if (value.length === 0 || value === "0x") return { kind: "absent", raw: value };
  const lower = value.toLowerCase();
  if (HASH_PATTERN.test(lower)) return { kind: "hash", value: lower as HexHash };
  return { kind: "invalid", raw: value };
}

export function isAddress(value: string): value is `0x${string}` {
  return ADDRESS_PATTERN.test(value.trim());
}

export type AccountCodeStatus =
  | { kind: "none" }
  /** EIP-7702 delegation designator: 0xef0100 || 20-byte delegate address. */
  | { kind: "eip7702-delegation"; delegate: `0x${string}` }
  | { kind: "contract"; byteLength: number };

/**
 * Classify the result of `eth_getCode` for the account address. Under Privy's
 * native sponsorship the first sponsored operation is expected to move the
 * account from `none` to `eip7702-delegation`.
 */
export function classifyAccountCode(code: string | null | undefined): AccountCodeStatus {
  const value = (code ?? "").trim().toLowerCase();
  if (value.length === 0 || value === "0x") return { kind: "none" };
  if (value.startsWith("0xef0100") && value.length === 2 + 6 + 40) {
    return { kind: "eip7702-delegation", delegate: `0x${value.slice(8)}` };
  }
  return { kind: "contract", byteLength: (value.length - 2) / 2 };
}

/** Short display form for addresses/hashes in the diagnostic UI (public data only). */
export function shortenHex(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, head + 2)}…${value.slice(-tail)}`;
}
