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

/** Some other prepared field is unsafe or malformed (see verifyPreparedUserOperation). Fixed text — never provider text. */
export class PreparedUserOperationIntegrityError extends Error {
  constructor() {
    super("Prepared UserOperation failed structural integrity checks.");
    this.name = "PreparedUserOperationIntegrityError";
  }
}

// EntryPoint 0.7 packed widths: verificationGasLimit|callGasLimit and
// maxPriorityFeePerGas|maxFeePerGas are uint128 halves of one bytes32, as are
// the two paymaster gas limits inside paymasterAndData; nonce and
// preVerificationGas are uint256. Protocol widths only — not economic caps.
const UINT128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_SHAPE = /^0x0{40}$/;
const HEX_BYTES_SHAPE = /^0x(?:[0-9a-fA-F]{2})*$/;

function isUint(value: unknown, max: bigint): value is bigint {
  return typeof value === "bigint" && value >= BigInt(0) && value <= max;
}
const isAddressShape = (value: unknown): value is Address => typeof value === "string" && ADDRESS_SHAPE.test(value);
const isHexBytes = (value: unknown): value is Hex => typeof value === "string" && HEX_BYTES_SHAPE.test(value);

/** What the server derived locally, before any provider call, for this one preparation. */
export type LocalUserOperationExpectation = {
  sender: Address;
  nonce: bigint;
  /** Both undefined when the Safe is already deployed; both set (non-empty factoryData) when it is not. */
  factory: Address | undefined;
  factoryData: Hex | undefined;
  callData: Hex;
};

/**
 * Structural integrity of a prepared, sponsored EntryPoint 0.7 UserOperation.
 * `prepared` is read as unknown values on purpose: viem spreads raw paymaster
 * JSON over it, so a field typed bigint can arrive as a string, null or
 * anything else. Returns a fresh object of the validated fields only (no
 * provider-supplied extras); throws PreparedUserOperationIntegrityError on
 * any failure. callData is checked separately by the caller (it throws
 * PreparedCallDataMismatchError) and is taken here from the expectation.
 *
 * - sender and nonce: exactly the local values.
 * - factory/factoryData: exactly the local derivation — both absent for a
 *   deployed Safe, both identical for an undeployed one. No initCode or
 *   authorization field may be present.
 * - sponsored only: a well-formed non-zero paymaster with whole-byte
 *   paymasterData ("0x" allowed) and both paymaster gas limits. A non-zero
 *   paymaster makes EntryPoint 0.7 ask the Safe for missingAccountFunds = 0.
 *   It does NOT prove the paymaster is trustworthy or will pay.
 * - every numeric field: a bigint within its packed width. Zero is allowed;
 *   no gas or fee ceiling is applied here.
 */
export function verifyPreparedUserOperation(prepared: Readonly<Record<string, unknown>>, expected: LocalUserOperationExpectation): PreparedUserOperationFields {
  const fail = (): never => {
    throw new PreparedUserOperationIntegrityError();
  };

  // The local expectation must itself be coherent, or nothing can be compared.
  if (!isUint(expected.nonce, UINT256_MAX)) fail();
  const expectsFactory = expected.factory !== undefined || expected.factoryData !== undefined;
  if (expectsFactory && !(isAddressShape(expected.factory) && isHexBytes(expected.factoryData) && expected.factoryData !== "0x")) fail();

  if (prepared.sender !== expected.sender) fail();
  if (prepared.nonce !== expected.nonce) fail();

  if (expectsFactory) {
    if (prepared.factory !== expected.factory || prepared.factoryData !== expected.factoryData) fail();
  } else if (prepared.factory !== undefined || prepared.factoryData !== undefined) {
    fail();
  }
  if (prepared.initCode !== undefined || prepared.authorization !== undefined) fail();

  const { callGasLimit, verificationGasLimit, preVerificationGas, maxFeePerGas, maxPriorityFeePerGas } = prepared;
  if (!isUint(callGasLimit, UINT128_MAX)) return fail();
  if (!isUint(verificationGasLimit, UINT128_MAX)) return fail();
  if (!isUint(preVerificationGas, UINT256_MAX)) return fail();
  if (!isUint(maxFeePerGas, UINT128_MAX)) return fail();
  if (!isUint(maxPriorityFeePerGas, UINT128_MAX)) return fail();

  const { paymaster, paymasterData, paymasterVerificationGasLimit, paymasterPostOpGasLimit } = prepared;
  if (!isAddressShape(paymaster) || ZERO_ADDRESS_SHAPE.test(paymaster)) return fail();
  if (!isHexBytes(paymasterData)) return fail();
  if (!isUint(paymasterVerificationGasLimit, UINT128_MAX)) return fail();
  if (!isUint(paymasterPostOpGasLimit, UINT128_MAX)) return fail();

  return {
    sender: expected.sender,
    nonce: expected.nonce,
    factory: expected.factory,
    factoryData: expected.factoryData,
    callData: expected.callData,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymaster,
    paymasterData,
    paymasterVerificationGasLimit,
    paymasterPostOpGasLimit,
  };
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
 * The nonce and the Safe-deployment state (factory/factoryData) are read once
 * here, through the same account methods prepareUserOperation would call
 * itself (one EntryPoint getNonce, one eth_getCode — no extra request), passed
 * in explicitly, and then required back unchanged; every other field must be a
 * structurally valid sponsored operation (verifyPreparedUserOperation).
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
  // Exactly the reads prepareUserOperation would otherwise make: getNonce()
  // consumes ONE key from this account's own nonce-key manager (the same
  // default lane), and getFactoryArgs() reads deployment state once (a
  // deployed result is cached by the account, so viem's own later call makes
  // no request). Both are passed in, so viem does not derive them again.
  const [nonce, factoryArgs] = await Promise.all([account.getNonce(), account.getFactoryArgs()]);
  const prepared = await smartAccountClient.prepareUserOperation({
    calls,
    nonce,
    ...(factoryArgs.factory !== undefined ? { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData } : {}),
  });

  // viem spreads the raw paymaster stub/final responses over the request, so
  // a `callData` key in either one replaces the local encoding. Refuse any
  // returned callData that is not exactly the trusted one — never accept an
  // alternate action because it is well-formed.
  if (prepared.callData !== expectedCallData) throw new PreparedCallDataMismatchError();

  // The same spread can replace or delete every other field. A deployment
  // race (undeployed at the read, deployed before inclusion) is not treated
  // specially: the local factory fields are still required, and EntryPoint
  // then refuses the operation rather than anything being guessed here.
  return verifyPreparedUserOperation(prepared as unknown as Record<string, unknown>, {
    sender: account.address,
    nonce,
    factory: factoryArgs.factory,
    factoryData: factoryArgs.factoryData,
    callData: expectedCallData,
  });
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
