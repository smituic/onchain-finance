import { TurnkeyClient } from "@turnkey/http";
import { createAccount } from "@turnkey/viem";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPublicClient, http, type Address, type Hex, type LocalAccount } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import { TURNKEY_API_BASE_URL, SAFE_POC } from "./constants";
import { readPublicTurnkeyPocConfig } from "./config";
import { markWebauthnStamperConstructed } from "./executed-path";
import { createRequiredWebauthnStamper } from "./passkey";

export function createPasskeyTurnkeyClient(rpId: string): TurnkeyClient {
  markWebauthnStamperConstructed();
  return new TurnkeyClient({ baseUrl: TURNKEY_API_BASE_URL }, createRequiredWebauthnStamper(rpId));
}

export async function createTurnkeyOwnerAccount(input: {
  rpId: string;
  subOrganizationId: string;
  ownerAddress: string;
}): Promise<LocalAccount> {
  const client = createPasskeyTurnkeyClient(input.rpId);
  return createAccount({
    client,
    organizationId: input.subOrganizationId,
    signWith: input.ownerAddress,
    ethereumAddress: input.ownerAddress,
  });
}

export function createPocPublicClient() {
  const { rpcUrl } = readPublicTurnkeyPocConfig();
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
}

export async function createPocSafeAccount(owner: LocalAccount) {
  const publicClient = createPocPublicClient();
  return toSafeSmartAccount({
    client: publicClient,
    owners: [owner],
    version: SAFE_POC.version,
    entryPoint: {
      address: entryPoint07Address,
      version: SAFE_POC.entryPoint.version,
    },
    saltNonce: BigInt(SAFE_POC.saltNonce),
    threshold: BigInt(SAFE_POC.threshold),
    safe4337ModuleAddress: SAFE_POC.module.address,
    safeModuleSetupAddress: SAFE_POC.moduleSetupAddress,
    safeProxyFactoryAddress: SAFE_POC.proxyFactoryAddress,
    safeSingletonAddress: SAFE_POC.singletonAddress,
    useMultiSendForSetup: SAFE_POC.useMultiSendForSetup,
  });
}

export type SafeDiagnostic = {
  address: Address;
  ownerAddress: Address;
  threshold: number;
  version: string;
  moduleAddress: Address;
  moduleVersion: string;
  entryPointAddress: Address;
  entryPointVersion: string;
  saltNonce: string;
  deployed: boolean;
  bytecode: Hex | null;
};

export async function inspectSafe(address: Address, ownerAddress: string): Promise<SafeDiagnostic> {
  const publicClient = createPocPublicClient();
  const bytecode = await publicClient.getCode({ address });
  const deployed = Boolean(bytecode && bytecode !== "0x");
  return {
    address,
    ownerAddress: ownerAddress as Address,
    threshold: SAFE_POC.threshold,
    version: SAFE_POC.version,
    moduleAddress: SAFE_POC.module.address,
    moduleVersion: SAFE_POC.module.version,
    entryPointAddress: SAFE_POC.entryPoint.address,
    entryPointVersion: SAFE_POC.entryPoint.version,
    saltNonce: SAFE_POC.saltNonce,
    deployed,
    bytecode: deployed ? bytecode ?? null : null,
  };
}
