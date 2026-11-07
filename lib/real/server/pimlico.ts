import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { http, type Address, type Hash, type Hex } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { BASE_SEPOLIA_CHAIN_ID, REAL_CASH_TOKEN, REAL_SAFE } from "../constants";
import { createReadOnlyOwnerAccount, createRealSafeAccount } from "../account/safe";
import type { RealPublicClient } from "../chain/client";
import { encodeCashTransfer } from "../payments/transfer";
import type { PreparedUserOperationFields } from "../payments/prepared-operation";
import type { UserOperationReceiptLike } from "../payments/reconcile";

/**
 * SERVER-ONLY: the one place the Pimlico API key is ever used. There is no
 * generic proxy route exposing this URL/client to the browser — see
 * app/api/real/payments/** for the purpose-built routes that call the
 * functions below instead.
 */
function pimlicoRpcUrl(apiKey: string): string {
  return `https://api.pimlico.io/v2/${BASE_SEPOLIA_CHAIN_ID}/rpc?apikey=${apiKey}`;
}

function createServerPimlicoClient(apiKey: string) {
  return createPimlicoClient({
    transport: http(pimlicoRpcUrl(apiKey)),
    entryPoint: { address: entryPoint07Address, version: REAL_SAFE.entryPoint.version },
  });
}

/** The prepared callData is not the locally encoded Cash transfer. Carries no provider text. */
export class PreparedCallDataMismatchError extends Error {
  constructor() {
    super("Prepared callData does not match the expected Cash transfer.");
    this.name = "PreparedCallDataMismatchError";
  }
}

/**
 * Prepares a sponsored Cash transfer UserOperation for `ownerAddress`'s
 * Safe. Uses a READ-ONLY stand-in owner (account/safe.ts's
 * createReadOnlyOwnerAccount) — this never signs, so the server never needs
 * (and never holds) the owner's private key material. `to` is always
 * REAL_CASH_TOKEN.address, hardcoded here — there is no parameter through
 * which a caller could redirect this call to a different contract. The
 * returned callData is the locally encoded Safe execution of exactly this
 * transfer; a provider response that changed it is refused (throws).
 * Safe-deployment state (factory/factoryData) is decided by permissionless's
 * own toSafeSmartAccount from a live chain read, never assumed from a flag.
 */
export async function prepareCashTransferUserOperation(input: {
  publicClient: RealPublicClient;
  pimlicoApiKey: string;
  ownerAddress: Address;
  recipient: Address;
  amountBaseUnits: string;
}): Promise<PreparedUserOperationFields> {
  const owner = createReadOnlyOwnerAccount(input.ownerAddress);
  const account = await createRealSafeAccount({ owner, publicClient: input.publicClient });
  const pimlicoClient = createServerPimlicoClient(input.pimlicoApiKey);

  const smartAccountClient = createSmartAccountClient({
    account,
    chain: input.publicClient.chain,
    client: input.publicClient,
    bundlerTransport: http(pimlicoRpcUrl(input.pimlicoApiKey)),
    paymaster: pimlicoClient,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });

  const calls = [{ to: REAL_CASH_TOKEN.address, data: encodeCashTransfer(input.recipient, input.amountBaseUnits), value: BigInt(0) }];
  // The trusted encoding, built locally before any provider call by the same
  // Safe account encoder prepareUserOperation itself uses (no network).
  const expectedCallData = await account.encodeCalls(calls);
  const prepared = await smartAccountClient.prepareUserOperation({ calls });

  // viem spreads the raw paymaster stub/final responses over the request, so
  // a `callData` key in either one replaces the local encoding. Refuse any
  // returned callData that is not exactly the trusted one — never accept an
  // alternate action because it is well-formed.
  if (prepared.callData !== expectedCallData) throw new PreparedCallDataMismatchError();

  return {
    sender: account.address,
    nonce: prepared.nonce,
    factory: prepared.factory,
    factoryData: prepared.factoryData,
    callData: expectedCallData,
    callGasLimit: prepared.callGasLimit,
    verificationGasLimit: prepared.verificationGasLimit,
    preVerificationGas: prepared.preVerificationGas,
    maxFeePerGas: prepared.maxFeePerGas,
    maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
    paymaster: prepared.paymaster,
    paymasterData: prepared.paymasterData,
    paymasterVerificationGasLimit: prepared.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: prepared.paymasterPostOpGasLimit,
  };
}

/**
 * Dispatches an already-signed, already-independently-verified
 * UserOperation directly to the bundler — no account object, no
 * re-preparation, no re-signing. This is the fully-formed-fields call form
 * (see viem's SendUserOperationParameters), the same decomposed shape
 * poc/turnkey-real-account proved live.
 */
export async function sendPreparedUserOperation(input: { pimlicoApiKey: string; fields: PreparedUserOperationFields; signature: Hex }): Promise<Hash> {
  const client = createServerPimlicoClient(input.pimlicoApiKey);
  return client.sendUserOperation({
    ...input.fields,
    signature: input.signature,
    entryPointAddress: entryPoint07Address,
  });
}

export async function fetchUserOperationReceipt(input: { pimlicoApiKey: string; userOperationHash: Hash }): Promise<UserOperationReceiptLike | null> {
  const client = createServerPimlicoClient(input.pimlicoApiKey);
  const receipt = await client.getUserOperationReceipt({ hash: input.userOperationHash });
  if (!receipt) return null;
  return {
    userOpHash: receipt.userOpHash,
    sender: receipt.sender,
    success: receipt.success,
    receipt: { transactionHash: receipt.receipt.transactionHash, status: receipt.receipt.status },
  };
}
