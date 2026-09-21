import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import {
  concatHex,
  encodeFunctionData,
  erc20Abi,
  http,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import { createPocPublicClient, createPocSafeAccount } from "./account";
import { BASE_SEPOLIA_CHAIN_ID, CASH_USDC, GATE2_PAYMENT_USDC, SAFE_POC } from "./constants";
import { assertSafeOpPreflightOrThrow, packPaymasterAndData, verifySafeOpSignature, type SafeOpPreflightResult } from "./safe-op-preflight";
import { instrumentSignTypedData, type SignTypedDataDiagnostic } from "./signing-diagnostics";
import { parseUsdcToUnits } from "./usdc";

const PIMLICO_PROXY_URL = "/api/dev/turnkey-poc/pimlico";

export function encodeCashTransfer(recipient: Address, amountUsdc: string): Hex {
  const units = parseUsdcToUnits(amountUsdc);
  if (units === null) throw new Error("Invalid Cash amount.");
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, units],
  });
}

export async function createSponsoredSafeClient(owner: LocalAccount) {
  const publicClient = createPocPublicClient();
  const account = await createPocSafeAccount(owner);
  const pimlicoClient = createPimlicoClient({
    transport: http(PIMLICO_PROXY_URL),
    entryPoint: {
      address: entryPoint07Address,
      version: "0.7",
    },
  });

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: baseSepolia,
    client: publicClient,
    bundlerTransport: http(PIMLICO_PROXY_URL),
    paymaster: pimlicoClient,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });

  return { account, smartAccountClient, pimlicoClient };
}

type SponsoredSafeClient = Awaited<ReturnType<typeof createSponsoredSafeClient>>;
type SafeAccount = SponsoredSafeClient["account"];
type SponsoredSmartAccountClient = SponsoredSafeClient["smartAccountClient"];
type PreparedSafeUserOperation = Awaited<ReturnType<SponsoredSmartAccountClient["prepareUserOperation"]>>;

/**
 * The security-critical part of sendSponsoredCashTransfer, isolated behind
 * narrow (real, not hand-rolled) types so it can be exercised with fakes in
 * tests: sign -> verify locally -> only then submit. Proves, independent of
 * any real Turnkey/Pimlico wiring, that a throwing or non-recovering
 * signature never reaches smartAccountClient.sendUserOperation.
 */
export async function signVerifyAndSubmit(input: {
  account: Pick<SafeAccount, "address" | "signUserOperation">;
  smartAccountClient: Pick<SponsoredSmartAccountClient, "sendUserOperation">;
  prepared: PreparedSafeUserOperation;
  expectedOwner: Address;
  /** Mutable box so the caller can register instrumentSignTypedData's callback before account.signUserOperation runs and still read the captured diagnostic afterward. */
  signDiagnosticRef: { current: SignTypedDataDiagnostic | null };
}): Promise<{
  userOperationHash: Hex;
  preflight: SafeOpPreflightResult;
  signDiagnostic: SignTypedDataDiagnostic | null;
  digestsMatch: boolean | null;
}> {
  const signature = await input.account.signUserOperation(input.prepared);

  const preflight = await verifySafeOpSignature({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    safe4337ModuleAddress: SAFE_POC.module.address,
    expectedOwner: input.expectedOwner,
    safeSignature: signature,
    operation: {
      safe: input.account.address,
      nonce: input.prepared.nonce,
      initCode: input.prepared.factory && input.prepared.factoryData ? concatHex([input.prepared.factory, input.prepared.factoryData]) : "0x",
      callData: input.prepared.callData,
      verificationGasLimit: input.prepared.verificationGasLimit,
      callGasLimit: input.prepared.callGasLimit,
      preVerificationGas: input.prepared.preVerificationGas,
      maxPriorityFeePerGas: input.prepared.maxPriorityFeePerGas,
      maxFeePerGas: input.prepared.maxFeePerGas,
      paymasterAndData: packPaymasterAndData(input.prepared),
      entryPoint: entryPoint07Address,
    },
  });

  // digest A (signDiagnostic.preSignDigest): hashTypedData of the EXACT
  // object permissionless passed to owner.signTypedData, captured by the
  // instrumentation wrapper the caller registered.
  // digest B (preflight.reconstructedDigest): this module's own independent
  // reconstruction of that same {domain, types, message}, from `prepared`.
  // If these differ, the preflight's reconstruction — not Turnkey — is the
  // bug; if they match and recovery still fails, the problem is downstream
  // of construction (Turnkey's signing path or key selection).
  const signDiagnostic = input.signDiagnosticRef.current;
  const digestsMatch: boolean | null =
    signDiagnostic && preflight.reconstructedDigest
      ? signDiagnostic.preSignDigest.toLowerCase() === preflight.reconstructedDigest.toLowerCase()
      : null;

  // Never submit a signature that does not recover to the expected owner —
  // that is exactly what an AA24 rejection means the bundler will discover
  // anyway, except after spending a live submission (and having already
  // prompted for a passkey) to find out. Abort locally instead.
  assertSafeOpPreflightOrThrow(preflight, { signDiagnostic, digestsMatch });

  const userOperationHash = await input.smartAccountClient.sendUserOperation({
    ...input.prepared,
    signature,
  });

  return { userOperationHash, preflight, signDiagnostic, digestsMatch };
}

export async function sendSponsoredCashTransfer(input: {
  owner: LocalAccount;
  recipient: string;
  amountUsdc?: string;
}): Promise<{
  safeAddress: Address;
  userOperationHash: Hex;
  preflight: SafeOpPreflightResult;
  /** From instrumentSignTypedData — the exact object permissionless actually passed to owner.signTypedData, not a reconstruction. Compare .preSignDigest against preflight.reconstructedDigest. */
  signDiagnostic: SignTypedDataDiagnostic | null;
  digestsMatch: boolean | null;
}> {
  const signDiagnosticRef: { current: SignTypedDataDiagnostic | null } = { current: null };
  const instrumentedOwner = instrumentSignTypedData(input.owner, (diagnostic) => {
    signDiagnosticRef.current = diagnostic;
  });

  const { account, smartAccountClient } = await createSponsoredSafeClient(instrumentedOwner);
  const amountUsdc = input.amountUsdc ?? GATE2_PAYMENT_USDC;

  // Decomposed (prepare -> sign -> verify offline -> send) instead of the
  // atomic smartAccountClient.sendUserOperation({calls}) convenience call,
  // specifically so the exact signed fields can be verified locally before
  // ever reaching the bundler. prepareUserOperation's default "signature"
  // property fills a local, static stub (SafeSmartAccount.getStubSignature —
  // no network call, no Turnkey involvement — verified in this codebase's
  // audit trail) used only for gas estimation; it is discarded below in
  // favor of the one real, explicit passkey ceremony.
  const prepared = await smartAccountClient.prepareUserOperation({
    calls: [
      {
        to: CASH_USDC.address,
        data: encodeCashTransfer(input.recipient as Address, amountUsdc),
        value: BigInt(0),
      },
    ],
  });

  const result = await signVerifyAndSubmit({
    account,
    smartAccountClient,
    prepared,
    expectedOwner: input.owner.address as Address,
    signDiagnosticRef,
  });

  return { safeAddress: account.address, ...result };
}
