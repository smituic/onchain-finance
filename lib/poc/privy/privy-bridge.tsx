"use client";

/**
 * Privy PoC — the vendor bridge. DISPOSABLE (see config.ts).
 *
 * This is the ONLY file in the PoC that imports `@privy-io/react-auth`. It
 * exists to answer an architectural question: can Privy's React-provider
 * integration be confined to one narrow bridge, with everything above it
 * consuming a plain, vendor-neutral facade (`PrivyPocAccount`)? The
 * diagnostic view imports from here and never from the SDK.
 *
 * Selected Privy configuration (current as of @privy-io/react-auth 3.44.0):
 * - Login: passkey first, email as the fallback (both need enabling in the
 *   Privy Dashboard).
 * - Embedded Ethereum wallet, created on login for users without one. TEE
 *   execution is Privy's default for new apps; `execution` below reports what
 *   the SDK actually says about the wallet (`recoveryMethod === "privy-v2"`
 *   is the SDK's own TEE/"unified stack" marker).
 * - Gas: Privy's NATIVE sponsorship (`sendTransaction(..., { sponsor: true })`),
 *   which upgrades the embedded EOA to a smart account via EIP-7702 on first
 *   use. No separate ERC-4337 contract account, no third-party bundler or
 *   paymaster URL on the client. The ERC-4337 `SmartWalletsProvider` path was
 *   evaluated and NOT chosen — it ships a paymaster URL to the browser.
 * - Sessions: we leave `cookieWriteBehavior` at its default (`"default"`) so
 *   the diagnostic can observe the JS-readable cookie mirror. `"never"` only
 *   skips that mirror; it does NOT stop localStorage token writes — nothing
 *   in the SDK's public config does; see sdk-static.ts and the storage audit.
 */
import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
  PrivyProvider,
  useCreateWallet,
  useLogin,
  useLoginWithPasskey,
  usePrivy,
  useSendTransaction,
  useSignupWithPasskey,
  type PasskeyFlowState,
  type User,
} from "@privy-io/react-auth";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC_ADDRESS, type PrivyPocConfig } from "./config";
import { encodeUsdcTransfer } from "./chain";

export function PrivyPocProvider({ config, children }: { config: PrivyPocConfig; children: ReactNode }) {
  return (
    <PrivyProvider
      appId={config.appId}
      clientId={config.clientId}
      config={{
        loginMethods: ["passkey", "email"],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          // Keep Privy's confirmation modal so "awaiting-user" is a real state.
          showWalletUIs: true,
        },
        supportedChains: [baseSepolia],
        defaultChain: baseSepolia,
        // Intentionally omit sessions.cookieWriteBehavior (default). Setting
        // "never" would hide JS-readable cookies without fixing localStorage.
      }}
    >
      {children}
    </PrivyProvider>
  );
}

export type EmbeddedWalletFacts = {
  /** Privy's server-side wallet id. Distinct from the address. */
  walletId: string | null;
  address: `0x${string}`;
  recoveryMethod: string | null;
  /** Derived from the SDK's own marker; "unknown" if the SDK gives no signal. */
  execution: "tee" | "on-device-or-legacy" | "unknown";
  walletIndex: number | null;
  delegated: boolean;
  imported: boolean;
};

export type LastLogin = {
  isNewUser: boolean;
  wasAlreadyAuthenticated: boolean;
  loginMethod: string | null;
  atMs: number;
};

export type PrivyPocAccount = {
  ready: boolean;
  authenticated: boolean;
  userId: string | null;
  createdAtMs: number | null;
  linkedAccountTypes: string[];
  passkeyCount: number;
  wallet: EmbeddedWalletFacts | null;
  lastLogin: LastLogin | null;
  passkeyFlow: PasskeyFlowState["status"];
  lastError: string | null;
  actions: {
    signupWithPasskey: () => Promise<void>;
    loginWithPasskey: () => Promise<void>;
    openLoginModal: () => void;
    createWallet: () => Promise<void>;
    /** Forces the SDK's refresh path and reports only whether a token came back. */
    restoreSession: () => Promise<boolean>;
    logout: () => Promise<void>;
    /** Sponsored USDC transfer from the embedded account. Returns the raw hash string the SDK gave us. */
    sendSponsoredUsdc: (to: `0x${string}`, amountBaseUnits: bigint) => Promise<string>;
  };
};

function toWalletFacts(user: User | null): EmbeddedWalletFacts | null {
  if (!user) return null;
  const account = user.linkedAccounts.find(
    (a) => a.type === "wallet" && a.chainType === "ethereum" && (a.walletClientType === "privy" || a.walletClientType === "privy-v2"),
  );
  if (!account || account.type !== "wallet") return null;
  const walletId = account.id ?? null;
  const recoveryMethod = account.recoveryMethod ?? null;
  const execution: EmbeddedWalletFacts["execution"] =
    walletId && recoveryMethod === "privy-v2" ? "tee" : recoveryMethod ? "on-device-or-legacy" : "unknown";
  return {
    walletId,
    address: account.address as `0x${string}`,
    recoveryMethod,
    execution,
    walletIndex: account.walletIndex ?? null,
    delegated: account.delegated,
    imported: account.imported,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Facade over the Privy hooks. Must be rendered inside `PrivyPocProvider`.
 * Nothing returned here is a credential: ids, addresses, flags, and statuses.
 */
export function usePrivyPocAccount(): PrivyPocAccount {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy();
  const [lastLogin, setLastLogin] = useState<LastLogin | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const loginCallbacks = useMemo(
    () => ({
      onComplete: ({
        isNewUser,
        wasAlreadyAuthenticated,
        loginMethod,
      }: {
        isNewUser: boolean;
        wasAlreadyAuthenticated: boolean;
        loginMethod: string | null;
      }) => {
        setLastLogin({ isNewUser, wasAlreadyAuthenticated, loginMethod, atMs: Date.now() });
        setLastError(null);
      },
      onError: (error: unknown) => setLastError(`login: ${errorMessage(error)}`),
    }),
    [],
  );
  const { signupWithPasskey, state: signupState } = useSignupWithPasskey(loginCallbacks);
  const { loginWithPasskey, state: loginState } = useLoginWithPasskey(loginCallbacks);
  const { login } = useLogin(loginCallbacks);
  const { createWallet } = useCreateWallet();
  const { sendTransaction } = useSendTransaction();

  // Whichever passkey flow was started most recently is the one to show.
  const [lastFlow, setLastFlow] = useState<"signup" | "login">("signup");
  const passkeyFlow = (lastFlow === "signup" ? signupState : loginState).status;

  const wallet = useMemo(() => toWalletFacts(user), [user]);

  const wrap = useCallback(
    <T,>(label: string, fn: () => Promise<T>): Promise<T> =>
      fn().catch((error: unknown) => {
        setLastError(`${label}: ${errorMessage(error)}`);
        throw error;
      }),
    [],
  );

  const actions = useMemo<PrivyPocAccount["actions"]>(
    () => ({
      signupWithPasskey: () => {
        setLastFlow("signup");
        return wrap("signupWithPasskey", () => signupWithPasskey());
      },
      loginWithPasskey: () => {
        setLastFlow("login");
        return wrap("loginWithPasskey", () => loginWithPasskey());
      },
      openLoginModal: () => login(),
      createWallet: () => wrap("createWallet", async () => void (await createWallet())),
      restoreSession: () =>
        wrap("restoreSession", async () => {
          const token = await getAccessToken();
          // Report presence only; the value is discarded immediately.
          return typeof token === "string" && token.length > 0;
        }),
      logout: () => wrap("logout", () => logout()),
      sendSponsoredUsdc: (to, amountBaseUnits) =>
        wrap("sendSponsoredUsdc", async () => {
          const { hash } = await sendTransaction(
            {
              to: BASE_SEPOLIA_USDC_ADDRESS,
              data: encodeUsdcTransfer(to, amountBaseUnits),
              value: 0,
              chainId: BASE_SEPOLIA_CHAIN_ID,
            },
            { sponsor: true },
          );
          return hash;
        }),
    }),
    [wrap, signupWithPasskey, loginWithPasskey, login, createWallet, getAccessToken, logout, sendTransaction],
  );

  return {
    ready,
    authenticated,
    userId: user?.id ?? null,
    createdAtMs: user?.createdAt ? new Date(user.createdAt).getTime() : null,
    linkedAccountTypes: user?.linkedAccounts.map((a) => a.type) ?? [],
    passkeyCount: user?.linkedAccounts.filter((a) => a.type === "passkey").length ?? 0,
    wallet,
    lastLogin,
    passkeyFlow,
    lastError,
    actions,
  };
}
