/**
 * Privy PoC — findings from the *installed* SDK source/types, not vendor prose.
 * DISPOSABLE (see config.ts).
 *
 * Nothing here talks to the network. Tests in `sdk-static.test.ts` re-read the
 * installed files so these claims fail closed if a later install disagrees.
 */

export const PRIVY_REACT_AUTH_VERSION = "3.44.0";
export const PRIVY_JS_SDK_CORE_VERSION = "0.76.1";

/**
 * Current smallest officially-supported path that can meet the product UX
 * (no extension, no seed phrase, Base Sepolia, sponsored gas) without a
 * third-party bundler/paymaster URL in the browser:
 *
 *   passkey/email login
 *   → Privy embedded Ethereum wallet (TEE by default for new apps)
 *   → native gas sponsorship (`sendTransaction(..., { sponsor: true })`)
 *   → EIP-7702 upgrade of that same address on first sponsored send
 *
 * Kernel / ERC-4337 `SmartWalletsProvider` is still exported, but current
 * Privy docs recommend native sponsorship instead, and the 4337 path needs a
 * bundler URL plus an optional paymaster URL. We did not install
 * `permissionless`.
 */
export const SELECTED_ARCHITECTURE = "privy-embedded-eoa + native-sponsorship + eip-7702" as const;

export type SdkStaticSecurityResult = "PASS" | "FAIL" | "BLOCKED";

export type SdkStaticFinding = {
  id: string;
  result: SdkStaticSecurityResult;
  claim: string;
};

/**
 * Security-relevant facts pinned to @privy-io/js-sdk-core 0.76.1 and
 * @privy-io/react-auth 3.44.0. Live cookies on a verified domain cannot
 * overturn the localStorage write path documented here unless the API stops
 * returning token values to the JS client entirely (unverified).
 */
export const SDK_STATIC_FINDINGS: SdkStaticFinding[] = [
  {
    id: "localstorage-adapter",
    result: "FAIL",
    claim:
      "The SDK's LocalStorage adapter is window.localStorage.getItem / setItem / removeItem with JSON.stringify. Session credentials are script-readable.",
  },
  {
    id: "access-token-always-stored",
    result: "FAIL",
    claim:
      "storeCustomerAccessTokenForUser always _storage.put's the access token to privy:token (or privy:<userId>:token). There is no public config that skips this write.",
  },
  {
    id: "refresh-token-always-stored",
    result: "FAIL",
    claim:
      "storeRefreshTokenForUser always _storage.put's the refresh token to privy:refresh_token when the API returns a string. cookieWriteBehavior and useServerCookies only gate the JS cookie mirror, not this put.",
  },
  {
    id: "cookie-write-behavior",
    result: "FAIL",
    claim:
      "CookieWriteBehavior is only 'default' | 'never' (experimental). 'never' makes shouldWriteCookies() false. So does useServerCookies (set when app config has custom_api_url). Neither disables localStorage.",
  },
  {
    id: "no-httponly-in-client",
    result: "FAIL",
    claim:
      "js-sdk-core's cookie helper writes document cookies from JS (sameSite Strict, secure true). HttpOnly cannot be set from document.cookie. Production HttpOnly cookies are server-set on a verified domain, which localhost cannot exercise.",
  },
  {
    id: "deprecated-refresh-placeholder",
    result: "BLOCKED",
    claim:
      "The React SDK exports DEPRECATED_REFRESH_TOKEN = \"deprecated\". Cookie-mode may write that placeholder instead of a real refresh token. This audit never reads values — a privy:refresh_token key is still classified sensitive. Confirm in DevTools whether the value is a JWT or the placeholder.",
  },
];

/** Overall static security verdict: a sensitive credential MUST land in localStorage. */
export const SDK_STATIC_SECURITY_RESULT: SdkStaticSecurityResult = "FAIL";

export type OwnershipFact = {
  question: string;
  answer: string;
};

export const OWNERSHIP_FACTS: OwnershipFact[] = [
  {
    question: "Who controls the embedded wallet?",
    answer:
      "The Privy user. The wallet is a linked account on the Privy user object (walletClientType privy / privy-v2). Our app never receives a private key or seed.",
  },
  {
    question: "Where does signing material exist?",
    answer:
      "TEE (default for new Privy apps, SDK marker recoveryMethod === \"privy-v2\"): key shares are reconstructed inside Privy's enclave, not in this page's JS. On-device/legacy: a device share lives in the Privy iframe origin's storage (auth.privy.io or a privy. subdomain), not on this origin. This app origin should not hold key material.",
  },
  {
    question: "Can Privy sign without user authorization?",
    answer:
      "This PoC keeps showWalletUIs: true, so sendTransaction opens Privy's confirmation UI (awaiting-user). Privy also supports server-side wallet API signing with the app secret — we do not ship an app secret and do not call that API. Dashboard 'client-initiated sponsorship' must be enabled for sponsor: true from the browser.",
  },
  {
    question: "Can our app/server sign?",
    answer:
      "No, not in this PoC. There is no app secret, no server wallet RPC, and no session signer / delegated-actions setup. The browser can only request a signature through Privy's SDK, which requires an authenticated Privy session.",
  },
  {
    question: "Smart account owner structure?",
    answer:
      "Native sponsorship upgrades the embedded EOA in place via EIP-7702. Wallet address and smart-account address are the same value. The EOA remains the authority; code at the address becomes a delegation designator (0xef0100 || delegate). This is not a separate Kernel/Safe/Light Account contract.",
  },
  {
    question: "Is this user-owned / non-custodial?",
    answer:
      "User-owned under Privy's model: the user authenticates (passkey/email), Privy holds key shares such that our app cannot extract a key, and we cannot sign without going through Privy. It is not 'the user holds a seed on disk'. Recovery for TEE wallets is Privy-managed (recoveryMethod privy-v2). Do not treat marketing 'non-custodial' as 'user has an exportable key'.",
  },
];
