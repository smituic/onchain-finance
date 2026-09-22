/**
 * Server-only Real Mode configuration. Every secret-holding field here
 * (Turnkey parent API key, session HMAC secret) must never be imported by
 * client/browser code — enforced by the framework-agnostic + chain-SDK
 * ESLint fences on lib/real/**, and by this module only ever being reached
 * from app/api/real/** route handlers.
 */
export type RealServerConfig = {
  turnkeyApiBaseUrl: string;
  turnkeyParentOrganizationId: string;
  turnkeyApiPublicKey: string;
  turnkeyApiPrivateKey: string;
  sessionSecret: string;
  rpId: string;
  rpName: string;
  /** One or more allowed WebAuthn origins (exact scheme+host+port), e.g. "http://localhost:3000". */
  expectedOrigins: string[];
  rpcUrl: string;
  pimlicoApiKey: string;
};

export function readRealServerConfig(
  env: Record<string, string | undefined> = process.env,
): RealServerConfig | { error: string } {
  const turnkeyParentOrganizationId = env.TURNKEY_PARENT_ORGANIZATION_ID?.trim();
  const turnkeyApiPublicKey = env.TURNKEY_API_PUBLIC_KEY?.trim();
  const turnkeyApiPrivateKey = env.TURNKEY_API_PRIVATE_KEY?.trim();
  const sessionSecret = env.REAL_SESSION_SECRET?.trim();
  const rpId = env.NEXT_PUBLIC_REAL_RP_ID?.trim();
  const originsRaw = env.NEXT_PUBLIC_REAL_ORIGIN?.trim();
  const pimlicoApiKey = env.PIMLICO_API_KEY?.trim();

  const missing: string[] = [];
  if (!turnkeyParentOrganizationId) missing.push("TURNKEY_PARENT_ORGANIZATION_ID");
  if (!turnkeyApiPublicKey) missing.push("TURNKEY_API_PUBLIC_KEY");
  if (!turnkeyApiPrivateKey) missing.push("TURNKEY_API_PRIVATE_KEY");
  if (!sessionSecret) missing.push("REAL_SESSION_SECRET");
  if (!rpId) missing.push("NEXT_PUBLIC_REAL_RP_ID");
  if (!originsRaw) missing.push("NEXT_PUBLIC_REAL_ORIGIN");
  if (!pimlicoApiKey) missing.push("PIMLICO_API_KEY");
  if (missing.length > 0) {
    return { error: `Missing server configuration: ${missing.join(", ")}.` };
  }

  return {
    turnkeyApiBaseUrl: env.TURNKEY_API_BASE_URL?.trim() || "https://api.turnkey.com",
    turnkeyParentOrganizationId: turnkeyParentOrganizationId!,
    turnkeyApiPublicKey: turnkeyApiPublicKey!,
    turnkeyApiPrivateKey: turnkeyApiPrivateKey!,
    sessionSecret: sessionSecret!,
    rpId: rpId!,
    rpName: env.NEXT_PUBLIC_REAL_RP_NAME?.trim() || "onchain-finance",
    expectedOrigins: originsRaw!.split(",").map((origin) => origin.trim()).filter(Boolean),
    rpcUrl: env.BASE_SEPOLIA_RPC_URL?.trim() || env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org",
    pimlicoApiKey: pimlicoApiKey!,
  };
}

export function isRealServerConfig(value: RealServerConfig | { error: string }): value is RealServerConfig {
  return !("error" in value);
}

/**
 * Duplicated (not imported) from lib/stores/mode-store.ts's readRealModeFlag
 * on purpose: lib/real/** may not import anything under lib/stores/*
 * (ESLint fence — that store also pulls in zustand, which lib/real/** must
 * stay free of). Both read the same NEXT_PUBLIC_REAL_MODE_ENABLED env var
 * and must be kept in sync if its semantics ever change.
 */
export function isRealModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXT_PUBLIC_REAL_MODE_ENABLED === "true";
}

export function requireRealServerConfig(env?: Record<string, string | undefined>): RealServerConfig {
  const config = readRealServerConfig(env);
  if (!isRealServerConfig(config)) throw new Error(config.error);
  return config;
}
