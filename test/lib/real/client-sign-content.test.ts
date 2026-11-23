// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeFunctionData, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { entryPoint07Address } from "viem/account-abstraction";
import { WebauthnStamper } from "@turnkey/webauthn-stamper";
import { REAL_CASH_TOKEN, REAL_SAFE } from "@/lib/real/constants";
import { toSafeOpOperation, type PreparedUserOperationFields, type WirePreparedFields } from "@/lib/real/payments/prepared-operation";
import { splitSafeOpSignature, verifySafeOpSignature } from "@/lib/real/payments/safe-op-preflight";
import { rpcBlock } from "./fixtures/chain-block";

/**
 * L-1b — client Pay signing content binding.
 *
 * signPreparedPayment must sign a Pay UserOperation only if its callData is
 * EXACTLY the Safe execution of transfer(expected.recipient,
 * expected.amountBaseUnits) on REAL_CASH_TOKEN (value 0, CALL), rebuilt
 * locally, and must sign that locally rebuilt value. Anything else is refused
 * with one fixed message BEFORE account.signUserOperation — so before any
 * typed-data signing, Turnkey request, WebAuthn stamp or passkey prompt.
 *
 * Everything runs offline against the REAL code: the real client-sign.ts, the
 * real permissionless Safe account (encodeCalls and signUserOperation are only
 * wrapped to record order and arguments, then called through), the real
 * verified-owner account and raw-sign path, and — for the agreement tests —
 * the REAL server-side prepareCashTransferUserOperation (server/pimlico.ts).
 * Only the network is faked:
 *   - chain RPC: an in-process viem `custom` transport (every method recorded);
 *   - Pimlico: a stubbed global fetch answering only https://api.pimlico.io/;
 *   - Turnkey: TurnkeyClient is mocked. Like the real client, its
 *     signRawPayload first asks its WebauthnStamper to stamp the request body
 *     (WebauthnStamper.prototype.stamp is spied — the method that opens the
 *     browser's passkey prompt via navigator.credentials.get, itself stubbed
 *     to throw), then signs with a local test key standing in for the owner.
 */

const owner = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");

/** Ordered record of the signing-relevant steps, across all boundaries. */
const events: string[] = [];
const signUserOperationArgs: Array<Record<string, unknown>> = [];
/** How many chain RPC requests and fetches each client-side encodeCalls made (must be 0 each). */
const encodeCallsNetwork: Array<{ rpc: number; fetch: number }> = [];
const turnkeyClients: unknown[] = [];
const rpcLog: string[] = [];

const signRawPayloadMock = vi.fn(async (activity: unknown) => {
  const parameters = (activity as { parameters: { payload: Hex } }).parameters;
  const signature = await owner.sign({ hash: parameters.payload });
  return {
    activity: {
      id: "activity-1",
      result: { signRawPayloadResult: { r: signature.slice(2, 66), s: signature.slice(66, 130), v: Number.parseInt(signature.slice(130), 16) === 27 ? "0" : "1" } },
    },
  };
});

vi.mock("@turnkey/http", () => ({
  TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock(_config: unknown, stamper: { stamp: (body: string) => Promise<unknown> }) {
    turnkeyClients.push(stamper);
    return {
      signRawPayload: async (activity: unknown) => {
        events.push("stamp");
        await stamper.stamp(JSON.stringify(activity));
        events.push("signRawPayload");
        return signRawPayloadMock(activity);
      },
    };
  }),
}));

let deployed = false;
const GET_NONCE_SELECTOR = "0x35567e1a";
const DUMMY_BYTES_RETURN = encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3" as Hex]);

function offlineChainClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        rpcLog.push(method);
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_getBlockByNumber") return rpcBlock();
        if (method === "eth_getCode") return deployed ? "0x6080604052" : "0x";
        if (method === "eth_call") {
          const selector = ((params?.[0] ?? {}) as { data?: string }).data?.slice(0, 10);
          if (selector === GET_NONCE_SELECTOR) return encodeAbiParameters([{ type: "uint256" }], [BigInt(0)]);
          return DUMMY_BYTES_RETURN; // proxyCreationCode()
        }
        throw new Error(`Unexpected public RPC call in an offline test: ${method}`);
      },
    }),
  });
}
const chainClient = offlineChainClient();
const createRealPublicClientMock = vi.fn(() => chainClient);
vi.mock("@/lib/real/chain/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/real/chain/client")>();
  return { ...actual, createRealPublicClient: (...args: unknown[]) => createRealPublicClientMock(...(args as [])) };
});

/** Wraps (never replaces) the signing account's encodeCalls / signUserOperation. Server-side accounts (no `validity`) are returned untouched. */
vi.mock("@/lib/real/account/safe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/real/account/safe")>();
  return {
    ...actual,
    createRealSafeAccount: async (input: Parameters<typeof actual.createRealSafeAccount>[0]) => {
      const account = await actual.createRealSafeAccount(input);
      if (!input.validity) return account;
      events.push("account");
      const encodeCalls = account.encodeCalls.bind(account);
      const signUserOperation = account.signUserOperation.bind(account);
      account.encodeCalls = async (calls) => {
        events.push("encodeCalls");
        const rpcBefore = rpcLog.length;
        const fetchBefore = fakeFetch.mock.calls.length;
        const result = await encodeCalls(calls);
        encodeCallsNetwork.push({ rpc: rpcLog.length - rpcBefore, fetch: fakeFetch.mock.calls.length - fetchBefore });
        return result;
      };
      account.signUserOperation = async (parameters) => {
        events.push("signUserOperation");
        signUserOperationArgs.push(parameters as unknown as Record<string, unknown>);
        return signUserOperation(parameters);
      };
      return account;
    },
  };
});

// --- Offline Pimlico (honest provider), as in payments-prepare-calldata-binding.test.ts ---
const PAYMASTER = "0x7777777777777777777777777777777777777777";
const PAYMASTER_DATA = `0x${"ab".repeat(20)}`;
const hex = (n: number) => `0x${n.toString(16)}`;
function answerPimlico(method: string): unknown {
  switch (method) {
    case "pimlico_getUserOperationGasPrice": {
      const tier = { maxFeePerGas: hex(2_000_000), maxPriorityFeePerGas: hex(1_000_000) };
      return { slow: tier, standard: tier, fast: tier };
    }
    case "pm_getPaymasterStubData":
    case "pm_getPaymasterData":
      return { paymaster: PAYMASTER, paymasterData: PAYMASTER_DATA, paymasterVerificationGasLimit: hex(50_000), paymasterPostOpGasLimit: hex(10_000) };
    case "eth_estimateUserOperationGas":
      return { preVerificationGas: hex(60_000), verificationGasLimit: hex(150_000), callGasLimit: hex(80_000), paymasterVerificationGasLimit: hex(50_000), paymasterPostOpGasLimit: hex(10_000) };
    default:
      throw new Error(`Unexpected Pimlico method in an offline test: ${method}`);
  }
}
const fakeFetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
  const href = typeof url === "string" ? url : url instanceof URL ? url.href : String((url as { url?: string })?.url);
  if (!href.startsWith("https://api.pimlico.io/")) throw new Error(`Network access refused in an offline test: ${href}`);
  const body = JSON.parse(String(init?.body));
  const one = (req: { id: number; method: string }) => ({ jsonrpc: "2.0", id: req.id, result: answerPimlico(req.method) });
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
});

const { signPreparedPayment, PAYMENT_DETAILS_UNVERIFIED, PAYMENT_EXPIRED_BEFORE_APPROVAL } = await import("@/lib/real/payments/client-sign");
const { prepareCashTransferUserOperation } = await import("@/lib/real/server/pimlico");
const { createRealSafeAccount, createReadOnlyOwnerAccount } = await import("@/lib/real/account/safe");

const SAFE_ADDRESS = (await createRealSafeAccount({ owner: createReadOnlyOwnerAccount(owner.address), publicClient: chainClient })).address;

// --- The golden vector ------------------------------------------------------------------------

/** EIP-55 mixed-case address (the EIP's own test vector); the server stores and sends it lower-case. */
const RECIPIENT_CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const RECIPIENT = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const AMOUNT = "1000000"; // 1.00 Cash at 6 decimals = 0x0f4240

/**
 * The complete Safe4337 callData for "send 1.00 Cash to RECIPIENT", written out
 * by hand from the Solidity ABI specification — NOT produced by any encoder
 * under test. Provenance:
 *  - 0x541d63c8 = first 4 bytes of keccak256("executeUserOpWithErrorString(address,uint256,bytes,uint8)"),
 *    the Safe4337Module 0.3.0 entry point server/pimlico.ts uses (ARCHITECTURE.md L-1);
 *  - head (4 static words): to = REAL_CASH_TOKEN (Circle Base Sepolia USDC,
 *    0x036CbD53842c5426634e7929541eC2318f3dCF7e), value = 0, offset of `data`
 *    = 0x80 (4 head words × 32), operation = 0 (CALL);
 *  - tail: length of `data` = 0x44 (68 bytes), then data =
 *    0xa9059cbb (ERC-20 transfer(address,uint256)) ‖ recipient word ‖ amount word,
 *    right-padded with 28 zero bytes to a 32-byte boundary.
 * Total: 4 + 5×32 + 96 = 260 bytes. The two selectors are re-derived below
 * with viem's keccak (independently of permissionless).
 */
const GOLDEN_CALLDATA = (
  "0x" +
  "541d63c8" +
  "000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e" + // to: Cash token
  "0000000000000000000000000000000000000000000000000000000000000000" + // value: 0
  "0000000000000000000000000000000000000000000000000000000000000080" + // offset of data
  "0000000000000000000000000000000000000000000000000000000000000000" + // operation: 0 (CALL)
  "0000000000000000000000000000000000000000000000000000000000000044" + // data length: 68
  "a9059cbb" +
  "0000000000000000000000005aaeb6053f3e94c9b9a09f33669435e7ef1beaed" + // transfer to
  "00000000000000000000000000000000000000000000000000000000000f4240" + // transfer amount: 1000000
  "00000000000000000000000000000000000000000000000000000000" // 28 bytes of padding
) as Hex;

// --- Independently declared ABIs (test-side truth, used to build realistic mismatches) ----------
const SAFE_4337_EXECUTE_ABI = [
  { type: "function", name: "executeUserOpWithErrorString", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }], outputs: [] },
  { type: "function", name: "executeUserOp", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }], outputs: [] },
] as const;
const ERC20_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;
const transferData = (to: Address, amount: bigint) => encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] });
const safeExec = (input: { to: Address; value?: bigint; data: Hex; operation?: number; fn?: "executeUserOpWithErrorString" | "executeUserOp" }) =>
  encodeFunctionData({ abi: SAFE_4337_EXECUTE_ABI, functionName: input.fn ?? "executeUserOpWithErrorString", args: [input.to, input.value ?? BigInt(0), input.data, input.operation ?? 0] });

const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;
const OTHER_TOKEN = "0x4444444444444444444444444444444444444444" as Address;
const HANDLE_SAFE = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae"; // a handle payment's recipient: the resolved Safe, lower-case

// --- Helpers --------------------------------------------------------------------------------------

const NOW = Math.floor(Date.now() / 1000);
const VALID_UNTIL = NOW + 600;

/** What server/payments.ts persists and sends for a prepared operation (bigints as strings, absent fields null). */
function toWire(prepared: PreparedUserOperationFields): WirePreparedFields {
  return {
    sender: prepared.sender,
    nonce: prepared.nonce.toString(),
    factory: prepared.factory ?? null,
    factoryData: prepared.factoryData ?? null,
    callData: prepared.callData,
    callGasLimit: prepared.callGasLimit.toString(),
    verificationGasLimit: prepared.verificationGasLimit.toString(),
    preVerificationGas: prepared.preVerificationGas.toString(),
    maxFeePerGas: prepared.maxFeePerGas.toString(),
    maxPriorityFeePerGas: prepared.maxPriorityFeePerGas.toString(),
    paymaster: prepared.paymaster ?? null,
    paymasterData: prepared.paymasterData ?? null,
    paymasterVerificationGasLimit: prepared.paymasterVerificationGasLimit?.toString() ?? null,
    paymasterPostOpGasLimit: prepared.paymasterPostOpGasLimit?.toString() ?? null,
    validUntil: VALID_UNTIL,
  };
}

/** The REAL server preparation (offline), exactly as resolvePreparePayment calls it: the reserved, lower-case recipient and the reserved amount. */
async function serverPrepare(recipient: string, amountBaseUnits: string) {
  return prepareCashTransferUserOperation({ publicClient: chainClient, pimlicoApiKey: "pim_test_key", ownerAddress: owner.address, recipient: recipient as Address, amountBaseUnits });
}

/** A prepared operation for this owner's Safe that never touched the server: honest gas/paymaster fields, the given callData. */
function wireWith(callData: unknown): WirePreparedFields {
  return {
    sender: SAFE_ADDRESS,
    nonce: "0",
    factory: null,
    factoryData: null,
    callData: callData as string,
    callGasLimit: "80000",
    verificationGasLimit: "150000",
    preVerificationGas: "60000",
    maxFeePerGas: "2000000",
    maxPriorityFeePerGas: "1000000",
    paymaster: PAYMASTER,
    paymasterData: PAYMASTER_DATA,
    paymasterVerificationGasLimit: "50000",
    paymasterPostOpGasLimit: "10000",
    validUntil: VALID_UNTIL,
  };
}

function sign(fields: WirePreparedFields, expected: unknown) {
  return signPreparedPayment({
    fields,
    rpId: "localhost",
    subOrganizationId: "sub-org-1",
    ownerAddress: owner.address,
    rpcUrl: "http://unused.invalid",
    authorizingCredentialId: "Y3JlZGVudGlhbC0x",
    nowSeconds: NOW,
    expected: expected as { recipient: string; amountBaseUnits: string },
  });
}

let stampSpy: ReturnType<typeof vi.spyOn>;
const credentialsGet = vi.fn(() => {
  throw new Error("a real WebAuthn prompt was requested in an offline test");
});

beforeEach(() => {
  deployed = false;
  events.length = 0;
  signUserOperationArgs.length = 0;
  encodeCallsNetwork.length = 0;
  turnkeyClients.length = 0;
  rpcLog.length = 0;
  signRawPayloadMock.mockClear();
  createRealPublicClientMock.mockClear();
  credentialsGet.mockClear();
  fakeFetch.mockClear();
  vi.stubGlobal("fetch", fakeFetch);
  vi.stubGlobal("navigator", { credentials: { get: credentialsGet, create: credentialsGet } });
  stampSpy = vi.spyOn(WebauthnStamper.prototype, "stamp").mockResolvedValue({ stampHeaderName: "X-Stamp-Webauthn", stampHeaderValue: "{}" });
});

afterEach(() => {
  stampSpy.mockRestore();
  vi.unstubAllGlobals();
});

/** A refusal: the fixed message, and nothing on the signing path ran. */
async function expectRefusedBeforeSigning(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(PAYMENT_DETAILS_UNVERIFIED);
  expect(signUserOperationArgs).toEqual([]);
  expect(events).not.toContain("signUserOperation");
  expect(turnkeyClients).toEqual([]); // no TurnkeyClient / WebauthnStamper built for a request
  expect(stampSpy).not.toHaveBeenCalled(); // no WebAuthn stamp
  expect(credentialsGet).not.toHaveBeenCalled(); // no passkey prompt
  expect(signRawPayloadMock).not.toHaveBeenCalled(); // no Turnkey signing request, no signature
}

// --- Tests ----------------------------------------------------------------------------------------

describe("L-1b golden vector: the canonical single-Cash-transfer callData", () => {
  it("is exactly the hand-assembled ABI encoding (selectors re-derived, every field decoded)", () => {
    expect(toFunctionSelector("executeUserOpWithErrorString(address,uint256,bytes,uint8)")).toBe("0x541d63c8");
    expect(toFunctionSelector("transfer(address,uint256)")).toBe("0xa9059cbb");
    expect((GOLDEN_CALLDATA.length - 2) / 2).toBe(260);
    const outer = decodeFunctionData({ abi: SAFE_4337_EXECUTE_ABI, data: GOLDEN_CALLDATA });
    expect(outer.functionName).toBe("executeUserOpWithErrorString");
    const [to, value, data, operation] = outer.args;
    expect(to).toBe(REAL_CASH_TOKEN.address); // decoded checksummed: the shared constant itself
    expect(REAL_CASH_TOKEN.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(value).toBe(BigInt(0));
    expect(operation).toBe(0);
    const inner = decodeFunctionData({ abi: ERC20_ABI, data });
    expect(inner.functionName).toBe("transfer");
    expect(inner.args).toEqual([RECIPIENT_CHECKSUMMED, BigInt(AMOUNT)]);
    // The independent test-side encoder agrees byte for byte.
    expect(safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(RECIPIENT as Address, BigInt(AMOUNT)) })).toBe(GOLDEN_CALLDATA);
  });
});

describe("L-1b client/server agreement: the client signs exactly what the real server prepares", () => {
  it.each([
    ["an undeployed (counterfactual) Safe — factory fields present", false],
    ["a deployed Safe — no factory fields", true],
  ] as const)("%s, sponsored", async (_name, isDeployed) => {
    deployed = isDeployed;
    const prepared = await serverPrepare(RECIPIENT, AMOUNT);
    // The real server's own output (L-1's locally encoded value) is the golden vector.
    expect(prepared.callData).toBe(GOLDEN_CALLDATA);
    expect(prepared.sender).toBe(SAFE_ADDRESS);
    expect(prepared.paymaster).toBe(PAYMASTER);
    if (isDeployed) expect(prepared.factory).toBeUndefined();
    else expect(prepared.factory?.toLowerCase()).toBe(REAL_SAFE.proxyFactoryAddress.toLowerCase());
    const wire = JSON.parse(JSON.stringify(toWire(prepared))) as WirePreparedFields; // across the HTTP boundary
    events.length = 0;
    rpcLog.length = 0;
    const fetchesBefore = fakeFetch.mock.calls.length;

    const { signature, activityId } = await sign(wire, { recipient: RECIPIENT, amountBaseUnits: AMOUNT });

    // Verification ran first, then exactly one signing request.
    expect(events).toEqual(["account", "encodeCalls", "signUserOperation", "stamp", "signRawPayload"]);
    // The client's encoder made no RPC and no fetch; client signing made no fetch at all.
    expect(encodeCallsNetwork).toEqual([{ rpc: 0, fetch: 0 }]);
    expect(fakeFetch.mock.calls.length).toBe(fetchesBefore);
    expect(activityId).toBe("activity-1");
    expect(signRawPayloadMock).toHaveBeenCalledTimes(1);
    expect(stampSpy).toHaveBeenCalledTimes(1);
    expect(credentialsGet).not.toHaveBeenCalled();

    // The signed callData is the locally rebuilt golden value; every other field is the prepared one, unchanged.
    expect(signUserOperationArgs).toHaveLength(1);
    expect(signUserOperationArgs[0]).toEqual({
      sender: SAFE_ADDRESS,
      nonce: prepared.nonce,
      factory: prepared.factory,
      factoryData: prepared.factoryData,
      callData: GOLDEN_CALLDATA,
      callGasLimit: prepared.callGasLimit,
      verificationGasLimit: prepared.verificationGasLimit,
      preVerificationGas: prepared.preVerificationGas,
      maxFeePerGas: prepared.maxFeePerGas,
      maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
      paymaster: prepared.paymaster,
      paymasterData: prepared.paymasterData,
      paymasterVerificationGasLimit: prepared.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: prepared.paymasterPostOpGasLimit,
      signature: "0x",
    });

    // The owner's signature is over the SafeOp carrying exactly the golden callData, with the server's window.
    expect(splitSafeOpSignature(signature)).toMatchObject({ validAfter: 0, validUntil: VALID_UNTIL });
    const preflight = await verifySafeOpSignature({
      chainId: baseSepolia.id,
      safe4337ModuleAddress: REAL_SAFE.module.address,
      expectedOwner: owner.address,
      safeSignature: signature,
      operation: toSafeOpOperation({ ...prepared, callData: GOLDEN_CALLDATA }, { safe: SAFE_ADDRESS, entryPoint: entryPoint07Address }),
    });
    expect(preflight.ok).toBe(true);
    // ...and not over any other transfer.
    const other = await verifySafeOpSignature({
      chainId: baseSepolia.id,
      safe4337ModuleAddress: REAL_SAFE.module.address,
      expectedOwner: owner.address,
      safeSignature: signature,
      operation: toSafeOpOperation({ ...prepared, callData: safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(ATTACKER, BigInt(AMOUNT)) }) }, { safe: SAFE_ADDRESS, entryPoint: entryPoint07Address }),
    });
    expect(other.ok).toBe(false);
  });

  it.each([
    ["a direct address payment (lower-case, as stored)", RECIPIENT, RECIPIENT, "1000000"],
    ["a mixed-case (EIP-55) expected recipient", RECIPIENT, RECIPIENT_CHECKSUMMED, "1000000"],
    ["a mixed-case expected recipient that is NOT a valid checksum (case carries no meaning; encoded lower-case)", RECIPIENT, "0x5AAEB6053f3e94c9b9a09f33669435e7ef1beaed", "1000000"],
    ["a handle payment's resolved Safe address (at this boundary only an address)", HANDLE_SAFE, HANDLE_SAFE, "1000000"],
    ["the smallest amount (1 base unit)", RECIPIENT, RECIPIENT, "1"],
    ["a 50.00 Cash amount", RECIPIENT, RECIPIENT, "50000000"],
    ["a 1.5 Cash amount", RECIPIENT, RECIPIENT, "1500000"],
  ])("accepts %s", async (_name, serverRecipient, expectedRecipient, amount) => {
    const prepared = await serverPrepare(serverRecipient, amount);
    events.length = 0;
    const { signature } = await sign(toWire(prepared), { recipient: expectedRecipient, amountBaseUnits: amount });
    expect(signature).toMatch(/^0x[0-9a-f]+$/);
    expect(events).toEqual(["account", "encodeCalls", "signUserOperation", "stamp", "signRawPayload"]);
    expect(signUserOperationArgs[0]!.callData).toBe(prepared.callData);
    expect(signUserOperationArgs[0]!.callData).toBe(safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(serverRecipient as Address, BigInt(amount)) }));
  });
});

describe("L-1b refusal: callData that is not exactly the held transfer is never signed", () => {
  const reservedTransfer = transferData(RECIPIENT as Address, BigInt(AMOUNT));
  const CASES: Array<[string, () => unknown]> = [
    ["a different encoded recipient", () => safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(ATTACKER, BigInt(AMOUNT)) })],
    ["a different encoded amount", () => safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(RECIPIENT as Address, BigInt(AMOUNT) * BigInt(1000)) })],
    ["a different Cash token target", () => safeExec({ to: OTHER_TOKEN, data: reservedTransfer })],
    ["a different outer execution target (the Safe calling itself)", () => safeExec({ to: SAFE_ADDRESS, data: reservedTransfer })],
    ["the alternate outer wrapper (executeUserOp)", () => safeExec({ to: REAL_CASH_TOKEN.address, data: reservedTransfer, fn: "executeUserOp" })],
    ["a non-zero execution value", () => safeExec({ to: REAL_CASH_TOKEN.address, data: reservedTransfer, value: BigInt(1) })],
    ["a DELEGATECALL operation", () => safeExec({ to: REAL_CASH_TOKEN.address, data: reservedTransfer, operation: 1 })],
    ["a different token function (approve)", () => safeExec({ to: REAL_CASH_TOKEN.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [ATTACKER, BigInt(2) ** BigInt(256) - BigInt(1)] }) })],
    ["the transfer with trailing bytes on the inner data", () => safeExec({ to: REAL_CASH_TOKEN.address, data: `${reservedTransfer}00` as Hex })],
    ["the exact expected encoding with trailing bytes appended", () => `${GOLDEN_CALLDATA}00`],
    ["a truncated prefix of the expected encoding", () => GOLDEN_CALLDATA.slice(0, -2)],
    ["only the inner transfer (no Safe wrapper)", () => reservedTransfer],
    ["empty callData", () => "0x"],
    ["the expected encoding in upper-case hex (non-canonical representation)", () => `0x${GOLDEN_CALLDATA.slice(2).toUpperCase()}`],
    ["a non-string callData", () => 12345],
  ];

  it.each(CASES)("refuses %s — before any signing request", async (_name, callData) => {
    await expectRefusedBeforeSigning(sign(wireWith(callData()), { recipient: RECIPIENT, amountBaseUnits: AMOUNT }));
    // It got past the sender check and every earlier guard: the refusal is L-1b's comparison.
    expect(events).toEqual(["account", "encodeCalls"]);
  });

  it("refuses MultiSend / additional calls (the real encoder's own two-call encoding)", async () => {
    const multi = await (await createRealSafeAccount({ owner: createReadOnlyOwnerAccount(owner.address), publicClient: chainClient })).encodeCalls([
      { to: REAL_CASH_TOKEN.address, data: reservedTransfer, value: BigInt(0) },
      { to: REAL_CASH_TOKEN.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [ATTACKER, BigInt(1)] }), value: BigInt(0) },
    ]);
    expect(multi.slice(0, 10)).toBe("0x541d63c8"); // same outer selector — only the full bytes tell them apart
    await expectRefusedBeforeSigning(sign(wireWith(multi), { recipient: RECIPIENT, amountBaseUnits: AMOUNT }));
    expect(events).toEqual(["account", "encodeCalls"]);
  });

  it("control: the same fixture with the honest callData signs (so every refusal above is the comparison)", async () => {
    const { signature } = await sign(wireWith(GOLDEN_CALLDATA), { recipient: RECIPIENT, amountBaseUnits: AMOUNT });
    expect(signature).toMatch(/^0x/);
    expect(signUserOperationArgs[0]!.callData).toBe(GOLDEN_CALLDATA);
  });

  it("callData for a different recipient is refused even when it would match a different held payment", async () => {
    const prepared = await serverPrepare(HANDLE_SAFE, AMOUNT);
    events.length = 0;
    await expectRefusedBeforeSigning(sign(toWire(prepared), { recipient: RECIPIENT, amountBaseUnits: AMOUNT }));
  });

  it("an explicit retry with the same inconsistent contents is refused again, every time", async () => {
    const fields = wireWith(safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(ATTACKER, BigInt(AMOUNT)) }));
    for (let i = 0; i < 3; i += 1) {
      await expectRefusedBeforeSigning(sign(fields, { recipient: RECIPIENT, amountBaseUnits: AMOUNT }));
    }
    expect(events).toEqual(["account", "encodeCalls", "account", "encodeCalls", "account", "encodeCalls"]);
  });
});

describe("L-1b refusal: an unusable expected intent is refused before the account is even built", () => {
  const recipientCases: Array<[string, unknown]> = [
    ["a short address", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1bea"],
    ["a 41-byte address", `${RECIPIENT}00`],
    ["an address with surrounding spaces (never repaired)", `  ${RECIPIENT}  `],
    ["an upper-case 0X prefix", `0X${RECIPIENT.slice(2)}`],
    ["a non-hex address", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaeg"],
    ["a handle instead of an address", "@smit"],
    ["an empty string", ""],
    ["a non-string", 12345],
    ["null", null],
    ["undefined", undefined],
  ];
  it.each(recipientCases)("recipient: %s", async (_name, recipient) => {
    await expectRefusedBeforeSigning(sign(wireWith(GOLDEN_CALLDATA), { recipient, amountBaseUnits: AMOUNT }));
    expect(events).toEqual([]);
    expect(createRealPublicClientMock).not.toHaveBeenCalled();
  });

  /** Each of these would encode to EXACTLY the golden callData if passed through BigInt() unchecked (or is zero): the canonical check alone refuses them. */
  const amountCases: Array<[string, unknown, Hex]> = [
    ["a leading zero", "01000000", GOLDEN_CALLDATA],
    ["surrounding spaces", " 1000000 ", GOLDEN_CALLDATA],
    ["a hex amount", "0xf4240", GOLDEN_CALLDATA],
    ["a plus sign", "+1000000", GOLDEN_CALLDATA],
    ["zero (consistent zero-amount calldata)", "0", safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(RECIPIENT as Address, BigInt(0)) })],
    ["multiple zeros", "000", safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(RECIPIENT as Address, BigInt(0)) })],
    ["a decimal", "1.5", GOLDEN_CALLDATA],
    ["a negative amount", "-1000000", GOLDEN_CALLDATA],
    ["an exponent", "1e6", GOLDEN_CALLDATA],
    ["an empty string", "", GOLDEN_CALLDATA],
    ["a number instead of a string", 1000000, GOLDEN_CALLDATA],
    ["a bigint instead of a string", BigInt(1000000), GOLDEN_CALLDATA],
    ["null", null, GOLDEN_CALLDATA],
  ];
  it.each(amountCases)("amount: %s", async (_name, amountBaseUnits, callData) => {
    await expectRefusedBeforeSigning(sign(wireWith(callData), { recipient: RECIPIENT, amountBaseUnits }));
    expect(events).toEqual([]);
    expect(createRealPublicClientMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing entirely", undefined],
    ["null", null],
    ["an empty object", {}],
    ["a string", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"],
  ])("expected intent %s", async (_name, expected) => {
    await expectRefusedBeforeSigning(sign(wireWith(GOLDEN_CALLDATA), expected));
    expect(events).toEqual([]);
  });

  it("an amount too large to encode (above uint256) fails closed with the fixed message — no raw encoder text", async () => {
    const huge = `1${"0".repeat(80)}`;
    await expectRefusedBeforeSigning(sign(wireWith(GOLDEN_CALLDATA), { recipient: RECIPIENT, amountBaseUnits: huge }));
    // encodeCashTransfer throws while the call list is built — after the sender check, before encodeCalls runs.
    expect(events).toEqual(["account"]);
    expect(createRealPublicClientMock).toHaveBeenCalledTimes(1);
  });
});

describe("L-1b: the held intent is read once, before any await — never re-read", () => {
  it("changing the caller's expected object after the call started changes nothing that is verified or signed", async () => {
    const expected = { recipient: RECIPIENT, amountBaseUnits: AMOUNT };
    const pending = sign(wireWith(GOLDEN_CALLDATA), expected);
    expected.recipient = ATTACKER;
    expected.amountBaseUnits = "999";
    await pending;
    expect(signUserOperationArgs[0]!.callData).toBe(GOLDEN_CALLDATA);
  });

  it("an expected object whose values change on every read is captured from its first read only", async () => {
    let reads = 0;
    const expected = {
      get recipient() {
        reads += 1;
        return reads === 1 ? RECIPIENT : ATTACKER;
      },
      amountBaseUnits: AMOUNT,
    };
    await sign(wireWith(GOLDEN_CALLDATA), expected);
    expect(reads).toBe(1);
    expect(signUserOperationArgs[0]!.callData).toBe(GOLDEN_CALLDATA);
  });

  it("changing the caller's prepared fields after the call started changes nothing that is verified or signed", async () => {
    const fields = wireWith(GOLDEN_CALLDATA);
    const pending = sign(fields, { recipient: RECIPIENT, amountBaseUnits: AMOUNT });
    fields.callData = safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(ATTACKER, BigInt(AMOUNT)) });
    await pending;
    expect(signUserOperationArgs[0]!.callData).toBe(GOLDEN_CALLDATA);
  });
});

describe("L-1b leaves the existing guards and their messages exactly as they were", () => {
  const honestIntent = { recipient: RECIPIENT, amountBaseUnits: AMOUNT };

  it("no bound passkey: the existing refusal, first", async () => {
    await expect(signPreparedPayment({ fields: wireWith(GOLDEN_CALLDATA), rpId: "localhost", subOrganizationId: "sub-org-1", ownerAddress: owner.address, rpcUrl: "x", authorizingCredentialId: "", nowSeconds: NOW, expected: honestIntent })).rejects.toThrow(/no approving passkey/);
    expect(events).toEqual([]);
  });

  it("an expired window: the existing refusal, before L-1b (even with an unusable intent)", async () => {
    await expect(signPreparedPayment({ fields: { ...wireWith("0x"), validUntil: NOW + 30 }, rpId: "localhost", subOrganizationId: "sub-org-1", ownerAddress: owner.address, rpcUrl: "x", authorizingCredentialId: "Y3JlZA", nowSeconds: NOW, expected: { recipient: "bad", amountBaseUnits: "0" } })).rejects.toThrow(PAYMENT_EXPIRED_BEFORE_APPROVAL);
    expect(events).toEqual([]);
  });

  it("a foreign sender: the existing sender refusal, before the content check", async () => {
    await expect(sign({ ...wireWith("0x"), sender: "0x9999999999999999999999999999999999999999" }, honestIntent)).rejects.toThrow(/does not match the prepared payment's sender/);
    expect(events).toEqual(["account"]);
    expect(signRawPayloadMock).not.toHaveBeenCalled();
  });
});
