/**
 * PoC configuration read from public build-time env. Pure so it can be
 * unit-tested with an injected env object.
 *
 * Only NEXT_PUBLIC_* values are read: the CDP project ID is a public
 * identifier (it ships in the browser bundle by design), not a secret. No
 * API keys, wallet secrets, or paymaster URLs live here.
 */

export type CdpPocEnv = {
  NEXT_PUBLIC_CDP_POC_ENABLED?: string;
  NEXT_PUBLIC_CDP_PROJECT_ID?: string;
  NEXT_PUBLIC_CDP_POC_RPC_URL?: string;
};

export type CdpPocConfig = {
  enabled: boolean;
  projectId: string | null;
  /** Optional Base Sepolia JSON-RPC URL override; viem's chain default when null. */
  rpcUrl: string | null;
  /** Human-readable reasons the PoC cannot run yet (empty when it can). */
  problems: string[];
};

// CDP project IDs are UUIDs. Anything else is almost certainly a paste error
// (e.g. an API key name or secret), which we want to catch before it reaches
// the SDK.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readCdpPocConfig(env: CdpPocEnv): CdpPocConfig {
  const enabled = env.NEXT_PUBLIC_CDP_POC_ENABLED === "true";
  const rawProjectId = env.NEXT_PUBLIC_CDP_PROJECT_ID?.trim() ?? "";
  const rawRpc = env.NEXT_PUBLIC_CDP_POC_RPC_URL?.trim() ?? "";
  const problems: string[] = [];

  let projectId: string | null = null;
  if (rawProjectId === "") {
    problems.push("NEXT_PUBLIC_CDP_PROJECT_ID is not set. Copy the Project ID from the CDP Portal dashboard.");
  } else if (!UUID_PATTERN.test(rawProjectId)) {
    problems.push(
      "NEXT_PUBLIC_CDP_PROJECT_ID does not look like a CDP Project ID (expected a UUID). Do not put an API key here.",
    );
  } else {
    projectId = rawProjectId;
  }

  let rpcUrl: string | null = null;
  if (rawRpc !== "") {
    if (/^https:\/\//i.test(rawRpc)) {
      rpcUrl = rawRpc;
    } else {
      problems.push("NEXT_PUBLIC_CDP_POC_RPC_URL must be an https:// URL (or leave it unset to use the public Base Sepolia RPC).");
    }
  }

  return { enabled, projectId, rpcUrl, problems };
}

/** The config the running app uses. Reads process.env, which Next inlines at build time. */
export function getCdpPocConfig(): CdpPocConfig {
  return readCdpPocConfig({
    NEXT_PUBLIC_CDP_POC_ENABLED: process.env.NEXT_PUBLIC_CDP_POC_ENABLED,
    NEXT_PUBLIC_CDP_PROJECT_ID: process.env.NEXT_PUBLIC_CDP_PROJECT_ID,
    NEXT_PUBLIC_CDP_POC_RPC_URL: process.env.NEXT_PUBLIC_CDP_POC_RPC_URL,
  });
}
