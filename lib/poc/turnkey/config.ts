const TRUE = "true";

export function isTurnkeyPocEnabled(
  value: string | undefined = process.env.NEXT_PUBLIC_TURNKEY_POC_ENABLED,
): boolean {
  return value === TRUE;
}

export function readPublicTurnkeyPocConfig(env: Record<string, string | undefined> = process.env): {
  enabled: boolean;
  rpId: string;
  rpName: string;
  rpcUrl: string;
} {
  return {
    enabled: isTurnkeyPocEnabled(env.NEXT_PUBLIC_TURNKEY_POC_ENABLED),
    rpId: (env.NEXT_PUBLIC_TURNKEY_RP_ID ?? "localhost").trim() || "localhost",
    rpName: (env.NEXT_PUBLIC_TURNKEY_RP_NAME ?? "ON Chain Finance Turnkey PoC").trim(),
    rpcUrl: (env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org").trim(),
  };
}

export type ServerTurnkeyPocConfig = {
  enabled: boolean;
  apiBaseUrl: string;
  parentOrganizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  sessionSecret: string;
  pimlicoApiKey: string;
  rpcUrl: string;
  rpId: string;
};

export function readServerTurnkeyPocConfig(
  env: Record<string, string | undefined> = process.env,
): ServerTurnkeyPocConfig | { error: string } {
  if (!isTurnkeyPocEnabled(env.NEXT_PUBLIC_TURNKEY_POC_ENABLED)) {
    return { error: "Turnkey PoC is disabled." };
  }

  const parentOrganizationId = env.TURNKEY_PARENT_ORGANIZATION_ID?.trim();
  const apiPublicKey = env.TURNKEY_API_PUBLIC_KEY?.trim();
  const apiPrivateKey = env.TURNKEY_API_PRIVATE_KEY?.trim();
  const sessionSecret = env.TURNKEY_POC_SESSION_SECRET?.trim();
  const pimlicoApiKey = env.PIMLICO_API_KEY?.trim();

  const missing: string[] = [];
  if (!parentOrganizationId) missing.push("TURNKEY_PARENT_ORGANIZATION_ID");
  if (!apiPublicKey) missing.push("TURNKEY_API_PUBLIC_KEY");
  if (!apiPrivateKey) missing.push("TURNKEY_API_PRIVATE_KEY");
  if (!sessionSecret) missing.push("TURNKEY_POC_SESSION_SECRET");
  if (!pimlicoApiKey) missing.push("PIMLICO_API_KEY");
  if (missing.length > 0) {
    return { error: `Missing server configuration: ${missing.join(", ")}.` };
  }

  return {
    enabled: true,
    apiBaseUrl: env.TURNKEY_API_BASE_URL?.trim() || "https://api.turnkey.com",
    parentOrganizationId: parentOrganizationId!,
    apiPublicKey: apiPublicKey!,
    apiPrivateKey: apiPrivateKey!,
    sessionSecret: sessionSecret!,
    pimlicoApiKey: pimlicoApiKey!,
    rpcUrl: env.BASE_SEPOLIA_RPC_URL?.trim() || env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org",
    rpId: env.NEXT_PUBLIC_TURNKEY_RP_ID?.trim() || "localhost",
  };
}

export function isServerTurnkeyPocConfig(
  value: ServerTurnkeyPocConfig | { error: string },
): value is ServerTurnkeyPocConfig {
  return !("error" in value);
}
