import {
  createEvmSmartAccount,
  getCurrentUser,
  getProjectConfig,
  getUserOperation,
  initialize,
  isSignedIn,
  onAuthStateChange,
  sendUserOperation,
  signInWithEmail,
  signOut,
  verifyEmailOTP,
  type User,
} from "@coinbase/cdp-core";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { CDP_NETWORK, USDC_ADDRESS } from "./constants";
import { normalizeUserOperation, type NormalizedUserOperation } from "./user-operation-status";

/**
 * Thin wrapper over `@coinbase/cdp-core@0.0.126` for the PoC. The point is to
 * keep the diagnostic page free of SDK imports and to surface exactly what
 * the SDK returns — no more, no less. Disposable.
 *
 * Nothing here handles key material: signing happens in CDP's TEE, the
 * per-session device key (`X-Wallet-Auth`) is a non-extractable WebCrypto
 * key the SDK holds in memory, and the access token is in memory too. The
 * refresh token is the SDK's business (HttpOnly cookie, plus a localStorage
 * "mirror" if the server puts it in a response body) — that behaviour is
 * exactly what the storage audit on the page observes.
 */

let initializedFor: string | null = null;

export async function initializeCdp(projectId: string): Promise<void> {
  if (initializedFor === projectId) return;
  await initialize({
    projectId,
    // New users get an EOA plus a smart account owned by it. Existing users
    // without a smart account are handled by ensureSmartAccount().
    ethereum: { createOnLogin: "smart" },
    disableAnalytics: true,
  });
  initializedFor = projectId;
}

export function isCdpInitialized(): boolean {
  return initializedFor !== null;
}

/** Public, non-secret account facts pulled off the SDK's User object. */
export type UserSummary = {
  userId: string;
  email: string | null;
  isNewUser: boolean | null;
  eoaAddresses: Address[];
  smartAccounts: Array<{ address: Address; ownerAddresses: string[]; createdAt: string }>;
  lastAuthenticatedAt: string | null;
};

export function summarizeUser(user: User, isNewUser: boolean | null = null): UserSummary {
  return {
    userId: user.userId,
    email: user.authenticationMethods.email?.email ?? null,
    isNewUser,
    eoaAddresses: (user.evmAccountObjects ?? []).map((a) => a.address as Address),
    smartAccounts: (user.evmSmartAccountObjects ?? []).map((a) => ({
      address: a.address as Address,
      ownerAddresses: a.ownerAddresses,
      createdAt: a.createdAt,
    })),
    lastAuthenticatedAt: user.lastAuthenticatedAt ?? null,
  };
}

export async function startEmailSignIn(email: string): Promise<{ flowId: string; message: string }> {
  const result = await signInWithEmail({ email });
  return { flowId: result.flowId, message: result.message };
}

export async function completeEmailSignIn(flowId: string, otp: string): Promise<UserSummary> {
  const result = await verifyEmailOTP({ flowId, otp });
  return summarizeUser(result.user, result.isNewUser);
}

/** What the SDK restored on its own (from the refresh credential) after initialize(). */
export async function getRestoredSession(): Promise<{ signedIn: boolean; user: UserSummary | null }> {
  const signedIn = await isSignedIn();
  const user = signedIn ? await getCurrentUser() : null;
  return { signedIn, user: user ? summarizeUser(user) : null };
}

export async function refreshUserSummary(): Promise<UserSummary | null> {
  const user = await getCurrentUser();
  return user ? summarizeUser(user) : null;
}

export async function signOutCdp(): Promise<void> {
  await signOut();
}

export function subscribeAuthState(callback: (user: UserSummary | null) => void): void {
  onAuthStateChange((user) => callback(user ? summarizeUser(user) : null));
}

/**
 * Makes sure the user has a smart account. With createOnLogin: "smart" a new
 * user already has one; this covers a user created under a different config.
 * Records whether we had to create it, which matters for the report.
 */
export async function ensureSmartAccount(): Promise<{ address: Address; created: boolean }> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in");
  const existing = user.evmSmartAccountObjects?.[0];
  if (existing) return { address: existing.address as Address, created: false };
  const address = await createEvmSmartAccount();
  return { address, created: true };
}

/** Public project configuration relevant to the cookie/first-party question. */
export type ProjectConfigSummary = {
  name: string | null;
  /** Set only when a verified first-party cookie domain is active for the project. */
  activeCookieDomain: string | null;
  raw: Record<string, unknown>;
};

export async function readProjectConfig(): Promise<ProjectConfigSummary> {
  const cfg = await getProjectConfig();
  const raw = cfg as unknown as Record<string, unknown>;
  return {
    name: typeof raw.name === "string" ? raw.name : null,
    activeCookieDomain: typeof raw.activeCookieDomain === "string" ? raw.activeCookieDomain : null,
    raw,
  };
}

export type SendUsdcParams = {
  smartAccount: Address;
  to: Address;
  amountBaseUnits: bigint;
  useCdpPaymaster: boolean;
};

export type SendUsdcResult = {
  /** The only identifier `sendUserOperation` returns. */
  userOperationHash: Hex;
  /** Exactly what was sent, for the evidence log. */
  request: { network: typeof CDP_NETWORK; to: Address; data: Hex; useCdpPaymaster: boolean };
};

/** ERC-20 transfer of test USDC as a single-call ERC-4337 user operation. */
export async function sendUsdcTransfer(params: SendUsdcParams): Promise<SendUsdcResult> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [params.to, params.amountBaseUnits],
  });
  const result = await sendUserOperation({
    evmSmartAccount: params.smartAccount,
    network: CDP_NETWORK,
    calls: [{ to: USDC_ADDRESS, value: BigInt(0), data }],
    useCdpPaymaster: params.useCdpPaymaster,
  });
  return {
    userOperationHash: result.userOperationHash,
    request: { network: CDP_NETWORK, to: USDC_ADDRESS, data, useCdpPaymaster: params.useCdpPaymaster },
  };
}

export async function fetchUserOperation(
  userOperationHash: Hex,
  smartAccount: Address,
): Promise<{ normalized: NormalizedUserOperation; raw: unknown }> {
  const op = await getUserOperation({ userOperationHash, evmSmartAccount: smartAccount, network: CDP_NETWORK });
  return { normalized: normalizeUserOperation(op), raw: op };
}
