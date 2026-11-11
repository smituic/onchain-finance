// @vitest-environment node
import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, http, toFunctionSelector, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import * as pimlico from "@/lib/real/server/pimlico";
import * as safeModule from "@/lib/real/account/safe";
import * as constants from "@/lib/real/constants";
import {
  ALLOWED_METHODS,
  CompatRefusal,
  GATE_ENV,
  GATE_VALUE,
  GuardDeniedError,
  INCONCLUSIVE_TRIPS,
  INPUT_ENV,
  LIVE_TEST_OPTIONS,
  MAX_RESPONSE_BYTES,
  NODE_EVIDENCE_FS,
  PINNED,
  PLATFORM_FETCH,
  REQUEST_CEILINGS,
  REQUEST_PLAN,
  RUNNER_FILE,
  SAFETY_TRIPS,
  WALL_CLOCK_MS,
  automaticRerunProblem,
  classifyVerdict,
  createAttemptLatch,
  createNetworkGuard,
  describeHex,
  describeShape,
  encodeExpectedCallData,
  expectedConfirmation,
  expectedUsage,
  findsLeak,
  guardIsLocked,
  inputsProblem,
  installGuard,
  liveRunResult,
  networkEnvironmentNames,
  observationPairingProblem,
  observeCompatibility,
  preflightEvidence,
  printableReport,
  prohibitedEnvNames,
  readBoundedBody,
  requireLiveAuthorization,
  selectionProblem,
  writeEvidence,
  type CompatInputs,
  type CompatReport,
  type EvidenceFs,
  type EvidencePlan,
  type FetchLike,
  type ProductionDeps,
  type VerdictInput,
} from "../../admin/observe-pimlico-prepare-compatibility.admin.test";

/**
 * OFFLINE self-test of the L-1a honest-Pimlico compatibility harness
 * (test/admin/observe-pimlico-prepare-compatibility.admin.test.ts).
 *
 * EVERYTHING HERE IS SIMULATED. No request leaves the process: the guard's
 * "underlying" transport is a scripted fake, the real global fetch is
 * replaced by a refusing sentinel for the whole file, and no case ever sets
 * the runner's exact gate phrase in a process environment. A simulated PASS
 * here says the harness and the production preparation agree on fake
 * answers; it is NOT evidence about Pimlico.
 *
 * Importing the runner registers its live suite here too; with the gate
 * absent it is reported as one skipped test.
 */

const FETCH_AT_LOAD = globalThis.fetch;
const WEBSOCKET_AT_LOAD = (globalThis as Record<string, unknown>).WebSocket;
const EGRESS_AT_LOAD = new Map(["WebSocket", "EventSource", "XMLHttpRequest"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
/** After an observation is refused post-install, its sealed guard stays on the globals (as in a live run); put the test's own back. */
function restoreTestGlobals() {
  Object.defineProperty(globalThis, "fetch", { value: sentinel, configurable: true, writable: true });
  for (const [name, descriptor] of EGRESS_AT_LOAD) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
}

const OWNER = getAddress("0xf6c3fe6de636f0d8f421d5485d1a64ff3628cfaf");
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const AMOUNT = "10000";
const CHAIN_URL = "https://base-sepolia.rpc.selftest.invalid/v1/SELFTESTCHAINPATHSECRET0001";
const CHAIN_HREF = new URL(CHAIN_URL).href;
const PIMLICO_KEY = "pim_SELFTESTsecretKEY0001";
const PIMLICO_HREF = new URL(`https://api.pimlico.io/v2/84532/rpc?apikey=${PIMLICO_KEY}`).href;
const PROVIDER_SECRET_TEXT = "PROVIDER-SECRET-TEXT-never-printed";

const DUMMY_CREATION_CODE = "0x600a600c600039600a6000f3" as Hex;
const SAFE_CODE = "0x6080604052348015600f57600080fd5b50" as Hex;
const ENTRY_POINT_CODE = "0x6080604052" as Hex;
const PAYMASTER = "0x7777777777777777777777777777777777777777";
const STUB_DATA = `0x${"ab".repeat(20)}`;
const FINAL_DATA = `0x${"cd".repeat(24)}`;
const hexOf = (value: bigint | number) => `0x${value.toString(16)}`;

const SEL = {
  proxyCreationCode: toFunctionSelector("function proxyCreationCode()"),
  getOwners: toFunctionSelector("function getOwners()"),
  getThreshold: toFunctionSelector("function getThreshold()"),
  balanceOf: toFunctionSelector("function balanceOf(address)"),
  getNonce: toFunctionSelector("function getNonce(address,uint192)"),
};
const GET_NONCE_ABI = [{ type: "function", name: "getNonce", stateMutability: "view", inputs: [{ name: "sender", type: "address" }, { name: "key", type: "uint192" }], outputs: [{ type: "uint256" }] }] as const;

const DEPS: ProductionDeps = { pimlico, safe: safeModule, constants };
let SAFE: Address;
const inputs = (over: Partial<CompatInputs> = {}): CompatInputs => ({ safe: SAFE, owner: OWNER, recipient: RECIPIENT, amountBaseUnits: AMOUNT, chainRpcUrl: CHAIN_URL, pimlicoApiKey: PIMLICO_KEY, ...over });

const sentinel = vi.fn(async () => {
  throw new Error("offline self-test: the real network is refused");
});

beforeAll(async () => {
  // The Safe the production derivation yields for OWNER with the fake proxy creation code (in-process transport only).
  const local = createPublicClient({
    chain: baseSepolia,
    transport: custom({ request: async ({ method }: { method: string }) => (method === "eth_call" ? encodeAbiParameters([{ type: "bytes" }], [DUMMY_CREATION_CODE]) : `0x${baseSepolia.id.toString(16)}`) }),
  });
  SAFE = (await safeModule.createRealSafeAccount({ owner: safeModule.createReadOnlyOwnerAccount(OWNER), publicClient: local })).address;
  Object.defineProperty(globalThis, "fetch", { value: sentinel, configurable: true, writable: true });
});

afterAll(() => {
  expect(sentinel).not.toHaveBeenCalled();
  Object.defineProperty(globalThis, "fetch", { value: FETCH_AT_LOAD, configurable: true, writable: true });
});

// ---------------------------------------------------------------------------
// Scripted fake backend (chain + Pimlico), reached only through the guard
// ---------------------------------------------------------------------------

type Answer = { status?: number; headers?: Record<string, string>; result?: unknown; error?: { code: number; message: string }; hang?: boolean; raw?: Response };
type ChainState = {
  chainId: number;
  entryPointCode: Hex;
  safeCode: Hex;
  postSafeCode?: Hex;
  owners: Address[];
  threshold: bigint;
  balance: bigint;
  postBalance?: bigint;
  nonceSeq: bigint;
  postNonceSeq?: bigint;
};
type Script = {
  chain?: Partial<ChainState>;
  stubIsFinal?: boolean;
  stubExtra?: Record<string, unknown>;
  stubOmit?: string[];
  finalExtra?: Record<string, unknown>;
  finalOmit?: string[];
  override?: Partial<Record<string, (n: number) => Answer | undefined>>;
  /** Called with the init of every paymaster-stub request that reaches the fake (its abort signal fires the moment the guard trips). */
  onStubRequest?: (init: RequestInit | undefined) => void;
};

function shaped(base: Record<string, unknown>, extra?: Record<string, unknown>, omit?: string[]) {
  const out: Record<string, unknown> = { ...base, ...extra };
  for (const key of omit ?? []) delete out[key];
  return out;
}

function backend(script: Script = {}) {
  const state: ChainState = { chainId: 84532, entryPointCode: ENTRY_POINT_CODE, safeCode: SAFE_CODE, owners: [OWNER], threshold: BigInt(1), balance: BigInt(5_000_000), nonceSeq: BigInt(7), ...script.chain };
  const calls: Array<{ endpoint: "chain" | "pimlico"; method: string; params: unknown[]; init: RequestInit | undefined }> = [];
  const seen = { safeCode: 0, balance: 0, nonce: 0 };
  const perMethod: Record<string, number> = {};

  function chainAnswer(method: string, params: unknown[]): Answer {
    if (method === "eth_chainId") return { result: hexOf(state.chainId) };
    if (method === "eth_getCode") {
      const target = String(params[0]).toLowerCase();
      if (target === PINNED.entryPoint.toLowerCase()) return { result: state.entryPointCode };
      if (target === SAFE.toLowerCase()) {
        seen.safeCode += 1;
        return { result: seen.safeCode >= 3 ? (state.postSafeCode ?? state.safeCode) : state.safeCode };
      }
      return { result: "0x" };
    }
    if (method === "eth_call") {
      const data = (params[0] as { data: Hex }).data;
      const selector = data.slice(0, 10);
      if (selector === SEL.proxyCreationCode) return { result: encodeAbiParameters([{ type: "bytes" }], [DUMMY_CREATION_CODE]) };
      if (selector === SEL.getOwners) return { result: encodeAbiParameters([{ type: "address[]" }], [state.owners]) };
      if (selector === SEL.getThreshold) return { result: encodeAbiParameters([{ type: "uint256" }], [state.threshold]) };
      if (selector === SEL.balanceOf) {
        seen.balance += 1;
        return { result: encodeAbiParameters([{ type: "uint256" }], [seen.balance >= 2 ? (state.postBalance ?? state.balance) : state.balance]) };
      }
      if (selector === SEL.getNonce) {
        seen.nonce += 1;
        const { args } = decodeFunctionData({ abi: GET_NONCE_ABI, data });
        const seq = seen.nonce >= 2 ? (state.postNonceSeq ?? state.nonceSeq) : state.nonceSeq;
        return { result: encodeAbiParameters([{ type: "uint256" }], [(args[1] << BigInt(64)) | seq]) };
      }
    }
    return { error: { code: -32601, message: "fake chain: method not scripted" } };
  }

  function pimlicoAnswer(method: string): Answer {
    switch (method) {
      case "pimlico_getUserOperationGasPrice": {
        const tier = { maxFeePerGas: hexOf(BigInt(2_000_000)), maxPriorityFeePerGas: hexOf(BigInt(1_000_000)) };
        return { result: { slow: tier, standard: tier, fast: tier } };
      }
      case "pm_getPaymasterStubData":
        return {
          result: shaped(
            { paymaster: PAYMASTER, paymasterData: STUB_DATA, paymasterVerificationGasLimit: hexOf(50_000), paymasterPostOpGasLimit: hexOf(10_000), ...(script.stubIsFinal ? { isFinal: true } : { isFinal: false }) },
            script.stubExtra,
            script.stubOmit,
          ),
        };
      case "eth_estimateUserOperationGas":
        return { result: { preVerificationGas: hexOf(60_000), verificationGasLimit: hexOf(150_000), callGasLimit: hexOf(80_000), paymasterVerificationGasLimit: hexOf(50_000), paymasterPostOpGasLimit: hexOf(10_000) } };
      case "pm_getPaymasterData":
        return { result: shaped({ paymaster: PAYMASTER, paymasterData: FINAL_DATA, paymasterVerificationGasLimit: hexOf(50_000), paymasterPostOpGasLimit: hexOf(10_000) }, script.finalExtra, script.finalOmit) };
      default:
        return { error: { code: -32601, message: "fake pimlico: method not scripted" } };
    }
  }

  const fetchFn: FetchLike = async (input, init) => {
    const url = String(input);
    const endpoint = url === CHAIN_HREF ? "chain" : url === PIMLICO_HREF ? "pimlico" : null;
    if (!endpoint) throw new Error("fake backend: unknown URL");
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    const params = request.params ?? [];
    calls.push({ endpoint, method: request.method, params, init });
    if (request.method === "pm_getPaymasterStubData") script.onStubRequest?.(init);
    perMethod[request.method] = (perMethod[request.method] ?? 0) + 1;
    const answer = script.override?.[request.method]?.(perMethod[request.method]!) ?? (endpoint === "chain" ? chainAnswer(request.method, params) : pimlicoAnswer(request.method));
    if (answer.raw) return answer.raw;
    if (answer.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("fake backend: aborted")));
      });
    }
    const body = answer.error ? { jsonrpc: "2.0", id: request.id, error: answer.error } : { jsonrpc: "2.0", id: request.id, result: answer.result };
    return new Response(JSON.stringify(body), { status: answer.status ?? 200, headers: { "content-type": "application/json", ...answer.headers } });
  };
  return { fetch: fetchFn, calls, methods: () => calls.map((c) => `${c.endpoint}:${c.method}`), count: (method: string) => calls.filter((c) => c.method === method).length };
}

async function simulate(script: Script = {}, over: { deps?: ProductionDeps | ((fake: ReturnType<typeof backend>) => ProductionDeps); wallClockMs?: number; inputs?: CompatInputs; evidencePlan?: EvidencePlan } = {}) {
  const fake = backend(script);
  const deps = typeof over.deps === "function" ? over.deps(fake) : (over.deps ?? DEPS);
  const observation = await observeCompatibility({ mode: "simulated", inputs: over.inputs ?? inputs(), underlyingFetch: fake.fetch, loadDeps: async () => deps, wallClockMs: over.wallClockMs ?? 10_000, evidencePlan: over.evidencePlan });
  // Late library retries settle against the (sealed) guard, never against the sentinel.
  await observation.settled;
  observation.uninstall();
  return { report: observation.report, fake };
}

const probesFor = () => [
  PIMLICO_KEY,
  "apikey",
  CHAIN_URL,
  new URL(CHAIN_URL).host,
  "SELFTESTCHAINPATHSECRET0001",
  PROVIDER_SECRET_TEXT,
  STUB_DATA,
  FINAL_DATA,
  encodeExpectedCallData(RECIPIENT, BigInt(AMOUNT)),
  ...[SAFE, OWNER, RECIPIENT].flatMap((a) => [a, a.toLowerCase(), a.slice(2).toLowerCase()]),
];
function expectNoLeak(text: string) {
  for (const probe of probesFor()) expect(text.toLowerCase().includes(probe.toLowerCase()), `leaked a probe of length ${probe.length}`).toBe(false);
}

// ---------------------------------------------------------------------------
// 1-2. Disabled by default; ordinary runs make no network calls
// ---------------------------------------------------------------------------

const RUNNER = RUNNER_FILE;
const CHILD_TIMEOUT_MS = 120_000;
const STRIPPED = /^(VITEST|REAL_SMOKE_|REAL_ADMIN_|NEON_|TURNKEY_|PIMLICO_|REAL_SESSION_|NEXT_PUBLIC_REAL_|PG|POSTGRES)|DATABASE_URL|PRIVATE_KEY|MNEMONIC|SEED_PHRASE/;

function runChild(args: string[], extra: Record<string, string>): Promise<{ code: number; output: string }> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !STRIPPED.test(name)) env[name] = value;
  return new Promise((resolve) => {
    execFile(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...args], { env: { ...env, ...extra } as NodeJS.ProcessEnv, timeout: CHILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: `${stdout}\n${stderr}` });
    });
  });
}
const summary = (output: string) => /Tests\s+([^\n]*)/.exec(output)?.[1] ?? "";
const REACHED_NETWORK = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo|GuardDeniedError|GuardDispatchFailure|api\.pimlico\.io|SIMULATED|LIVE (PASS|FAIL|INCONCLUSIVE)/;
const ourEvidenceFiles = () => (existsSync("evidence") ? readdirSync("evidence").filter((name) => name.startsWith("pimlico-prepare-compat-")).length : 0);

describe("disabled by default: an ordinary Vitest run never reaches the live observation", () => {
  it("importing the runner changed no global (fetch and WebSocket are the platform's)", () => {
    expect(FETCH_AT_LOAD).toBe(PLATFORM_FETCH);
    expect(WEBSOCKET_AT_LOAD).toBe((globalThis as Record<string, unknown>).WebSocket);
  });

  it.concurrent(
    "child run of the runner file with NO gate: the suite is skipped, exit 0, nothing refused, no network, no evidence file",
    async () => {
      const before = ourEvidenceFiles();
      const result = await runChild([RUNNER], {});
      expect(result.code, summary(result.output)).toBe(0);
      expect(summary(result.output)).toMatch(/^1 skipped \(1\)/);
      expect(result.output).not.toMatch(/refused|failed/);
      expect(result.output).not.toMatch(REACHED_NETWORK);
      expect(ourEvidenceFiles()).toBe(before);
    },
    CHILD_TIMEOUT_MS,
  );

  it.concurrent.each(["1", "true", "yes", "observe"])(
    "child run with a generic gate value %j: FAILS (never skipped green) before any network, no evidence file",
    async (value) => {
      const before = ourEvidenceFiles();
      const result = await runChild([RUNNER], { [GATE_ENV]: value });
      expect(result.code, summary(result.output)).not.toBe(0);
      expect(result.output).toContain("observe-pimlico-prepare-compatibility refused: ");
      expect(result.output).toContain("is not the exact authorization phrase");
      expect(result.output).not.toMatch(REACHED_NETWORK);
      expect(ourEvidenceFiles()).toBe(before);
    },
    CHILD_TIMEOUT_MS,
  );

  it.concurrent(
    "child run with a wrong gate plus synthetic database, Turnkey and Pimlico credentials: refused, and no value is echoed",
    async () => {
      const result = await runChild([RUNNER], {
        [GATE_ENV]: "1",
        DATABASE_URL: "postgresql://u:SYNTHETICDBSECRET@ep-x.invalid/db",
        TURNKEY_API_PRIVATE_KEY: "SYNTHETICTURNKEYSECRET",
        PIMLICO_API_KEY: "SYNTHETICPIMLICOSECRET",
        [INPUT_ENV.pimlicoApiKey]: "SYNTHETICHARNESSKEY0001",
        [INPUT_ENV.chainRpcUrl]: "https://rpc.selftest.invalid/SYNTHETICCHAINSECRET",
      });
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("refused: ");
      expect(result.output).not.toMatch(/SYNTHETIC/);
      expect(result.output).not.toMatch(REACHED_NETWORK);
    },
    CHILD_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Gate (pure function over synthetic env objects; no process env is set)
// ---------------------------------------------------------------------------

describe("manual gate: exact phrase, no inherited credentials, one-file command line, complete bound inputs", () => {
  const CLI = ["run", RUNNER_FILE];
  const complete = () => {
    const base: Record<string, string> = {
      [GATE_ENV]: GATE_VALUE,
      [INPUT_ENV.safe]: SAFE,
      [INPUT_ENV.owner]: OWNER,
      [INPUT_ENV.recipient]: RECIPIENT,
      [INPUT_ENV.amount]: AMOUNT,
      [INPUT_ENV.chainRpcUrl]: CHAIN_URL,
      [INPUT_ENV.pimlicoApiKey]: PIMLICO_KEY,
    };
    base[INPUT_ENV.confirmation] = expectedConfirmation({ safe: SAFE, recipient: RECIPIENT, amountBaseUnits: AMOUNT });
    return base;
  };
  const refusal = (env: Record<string, string | undefined>, cliArgs: unknown = CLI) => {
    try {
      requireLiveAuthorization({ env, cliArgs });
    } catch (error) {
      expect(error).toBeInstanceOf(CompatRefusal);
      return (error as Error).message;
    }
    throw new Error("expected a refusal");
  };
  const expectNoValues = (message: string) => {
    for (const value of [PIMLICO_KEY, CHAIN_URL, "SELFTESTCHAINPATHSECRET0001", SAFE.toLowerCase(), OWNER.toLowerCase(), RECIPIENT.toLowerCase(), "SYNTHETIC"]) expect(message.toLowerCase()).not.toContain(value.toLowerCase());
  };

  it("the complete authorization is accepted, frozen and normalized — and only the exact phrase opens it", () => {
    const authorization = requireLiveAuthorization({ env: complete(), cliArgs: CLI });
    expect(authorization.kind).toBe("live-authorization");
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(Object.isFrozen(authorization.inputs)).toBe(true);
    expect(authorization.inputs).toEqual(inputs());
    expect(requireLiveAuthorization({ env: complete(), cliArgs: ["run", `./${RUNNER_FILE}`] }).kind).toBe("live-authorization");
  });

  it.each([undefined, "", "1", "true", "TRUE", "yes", `${GATE_VALUE} `, GATE_VALUE.toUpperCase(), GATE_VALUE.slice(0, -1)])("gate value %j is refused", (value) => {
    const env = { ...complete(), [GATE_ENV]: value };
    expect(refusal(env)).toMatch(value === undefined ? /is not set/ : /is not the exact authorization phrase/);
  });

  it.each([
    ["DATABASE_URL", "postgresql://u:SYNTHETIC@h/db"],
    ["DIRECT_DATABASE_URL", "SYNTHETIC"],
    ["DATABASE_URL_UNPOOLED", "SYNTHETIC"],
    ["PGPASSWORD", "SYNTHETIC"],
    ["PGHOST", "SYNTHETIC"],
    ["POSTGRES_URL", "SYNTHETIC"],
    ["NEON_BRANCH_ID", "SYNTHETIC"],
    ["TURNKEY_API_PRIVATE_KEY", "SYNTHETIC"],
    ["TURNKEY_PARENT_ORGANIZATION_ID", "SYNTHETIC"],
    ["REAL_SESSION_SECRET", "SYNTHETIC"],
    ["PIMLICO_API_KEY", "SYNTHETIC"],
    ["REAL_SMOKE_ANYTHING", "1"],
    ["REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION", "1"],
    ["REAL_ADMIN_PIMLICO_COMPAT_EXTRA", "1"],
    ["OWNER_PRIVATE_KEY", "SYNTHETIC"],
    ["WALLET_MNEMONIC", "SYNTHETIC"],
    ["EMPTY_BUT_PRESENT_PRIVATE_KEY", ""],
  ])("an inherited %s is refused by NAME before anything else runs, its value never echoed", (name, value) => {
    const message = refusal({ ...complete(), [name]: value });
    expect(message).toContain(name);
    expectNoValues(message);
    expect(prohibitedEnvNames({ [name]: value })).toEqual([name]);
  });

  it.each([
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "Https_Proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "FTP_PROXY",
    "WS_PROXY",
    "WSS_PROXY",
    "NODE_USE_ENV_PROXY",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "node_tls_reject_unauthorized",
    "NODE_EXTRA_CA_CERTS",
    "NODE_USE_SYSTEM_CA",
    "NODE_OPTIONS",
    "node_options",
    "NODE_DEBUG",
    "NODE_DEBUG_NATIVE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SSLKEYLOGFILE",
  ])("an inherited %s (proxy / TLS / Node option / Node debug) is refused by NAME with fixed text; its value is never echoed and the env is never changed", (name) => {
    const env = { ...complete(), [name]: "http://user:SYNTHETIC@proxy.selftest.invalid:8080" };
    const before = JSON.stringify(env);
    const message = refusal(env);
    expect(message).toBe(`observe-pimlico-prepare-compatibility refused: inherited proxy, TLS, Node-option or Node-debug variables must be absent; unset them first: ${name}`);
    expectNoValues(message);
    expect(message).not.toMatch(/proxy\.selftest|8080|user:/);
    expect(JSON.stringify(env)).toBe(before);
    expect(networkEnvironmentNames({ [name]: "1" })).toEqual([name]);
    // An empty value is still present.
    expect(networkEnvironmentNames({ [name]: "" })).toEqual([name]);
  });

  it("network-setting names: several are listed sorted; undefined is absent; look-alikes are ignored; the credential prohibitions are checked first", () => {
    expect(networkEnvironmentNames({ https_proxy: "x", HTTP_PROXY: "x", NODE_OPTIONS: "x", NO_PROXY: undefined })).toEqual(["HTTP_PROXY", "NODE_OPTIONS", "https_proxy"]);
    expect(networkEnvironmentNames({ NODE_ENV: "test", NODE_PATH: "/x", PROXY: "1", HTTP_PROXY_DOCS: "1", MY_NODE_OPTIONS: "1", NODE_OPTIONS_X: "1", SSL_CERT: "1", NODE_TLS: "1" })).toEqual([]);
    const both = refusal({ ...complete(), DATABASE_URL: "SYNTHETIC", HTTPS_PROXY: "SYNTHETIC" });
    expect(both).toContain("DATABASE_URL");
    expect(both).not.toContain("HTTPS_PROXY");
  });

  it("presence alone is checked: an undefined entry is not 'present', unrelated variables are ignored", () => {
    expect(prohibitedEnvNames({ DATABASE_URL: undefined, HOME: "/x", PATH: "/bin", NODE_ENV: "test", PIMLICO_DOCS: "1" })).toEqual([]);
  });

  it.each([
    [null, /not available/],
    [["watch", RUNNER_FILE], /vitest run/],
    [["run"], /ONE argument/],
    [["run", RUNNER_FILE, "--reporter=verbose"], /ONE argument/],
    [["run", RUNNER_FILE, "-t", "x"], /ONE argument/],
    [["run", RUNNER_FILE, "test/lib/real/other.test.ts"], /ONE argument/],
    [["run", "test/admin"], /ONE argument/],
    [["run", "observe-pimlico"], /ONE argument/],
  ])("command line %j is refused", (cliArgs, reason) => {
    expect(selectionProblem(cliArgs)).toMatch(reason);
    expect(refusal(complete(), cliArgs)).toMatch(reason);
  });

  it.each([
    [INPUT_ENV.safe, undefined],
    [INPUT_ENV.safe, "0x123"],
    [INPUT_ENV.safe, "<SAFE with 0X prefix>"],
    [INPUT_ENV.owner, "0xF6C3FE6DE636F0D8F421D5485D1A64FF3628CFAf"],
    [INPUT_ENV.recipient, undefined],
    [INPUT_ENV.recipient, OWNER],
    [INPUT_ENV.recipient, "<SAFE>"],
    [INPUT_ENV.recipient, PINNED.cashToken],
    [INPUT_ENV.recipient, PINNED.entryPoint],
    [INPUT_ENV.recipient, "0x0000000000000000000000000000000000000000"],
    [INPUT_ENV.amount, "0"],
    [INPUT_ENV.amount, "01"],
    [INPUT_ENV.amount, "1.5"],
    [INPUT_ENV.amount, "1000001"],
    [INPUT_ENV.amount, "-1"],
    [INPUT_ENV.amount, undefined],
    [INPUT_ENV.chainRpcUrl, "http://base-sepolia.rpc.selftest.invalid/SELFTESTCHAINPATHSECRET0001"],
    [INPUT_ENV.chainRpcUrl, "https://user:SYNTHETIC@rpc.selftest.invalid/"],
    [INPUT_ENV.chainRpcUrl, "https://api.pimlico.io/v2/84532/rpc"],
    [INPUT_ENV.chainRpcUrl, "https://rpc.selftest.invalid/#SYNTHETIC"],
    [INPUT_ENV.chainRpcUrl, "not a url"],
    [INPUT_ENV.chainRpcUrl, undefined],
    [INPUT_ENV.pimlicoApiKey, "short"],
    [INPUT_ENV.pimlicoApiKey, "pim key with spaces SYNTHETIC"],
    [INPUT_ENV.pimlicoApiKey, undefined],
  ])("input %s = %j is refused without echoing a value", (name, raw) => {
    const value = raw === "<SAFE>" ? SAFE : raw === "<SAFE with 0X prefix>" ? SAFE.toLowerCase().replace("0x", "0X") : raw;
    const env = { ...complete(), [name]: value };
    // Keep the confirmation consistent with whatever parses, so the input rule (not the confirmation) is what refuses.
    const message = refusal(env);
    expect(message).not.toMatch(/CONFIRMATION/);
    expectNoValues(message);
  });

  it.each<[string, () => string | undefined]>([
    ["missing", () => undefined],
    ["empty", () => ""],
    ["generic", () => "yes"],
    ["for another amount", () => expectedConfirmation({ safe: SAFE, recipient: RECIPIENT, amountBaseUnits: "10001" })],
    ["for another recipient", () => expectedConfirmation({ safe: SAFE, recipient: getAddress("0x3333333333333333333333333333333333333333"), amountBaseUnits: AMOUNT })],
    ["in upper case", () => expectedConfirmation({ safe: SAFE, recipient: RECIPIENT, amountBaseUnits: AMOUNT }).toUpperCase()],
  ])(
    "a confirmation that is %s is refused",
    (_label, make) => {
      const message = refusal({ ...complete(), [INPUT_ENV.confirmation]: make() });
      expect(message).toContain(INPUT_ENV.confirmation);
      expectNoValues(message);
    },
  );
});

// ---------------------------------------------------------------------------
// 3-9. The network guard, driven directly with a fake underlying transport
// ---------------------------------------------------------------------------

describe("network guard: refuses before dispatch, budgets, trips, and stays tripped", () => {
  const expectedCallData = () => encodeExpectedCallData(RECIPIENT, BigInt(AMOUNT));
  function makeGuard(options: { answer?: (method: string, n: number) => Response | Promise<Response>; wallClockMs?: number; now?: () => number; maxResponseBytes?: number } = {}) {
    const counts: Record<string, number> = {};
    const underlying = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      counts[request.method] = (counts[request.method] ?? 0) + 1;
      if (options.answer) return options.answer(request.method, counts[request.method]!);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "eth_chainId" ? "0x14a34" : "0x" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const guard = createNetworkGuard({ underlying, chainRpcUrl: CHAIN_URL, pimlicoApiKey: PIMLICO_KEY, safe: SAFE, expectedCallData: expectedCallData(), wallClockMs: options.wallClockMs ?? 10_000, now: options.now, maxResponseBytes: options.maxResponseBytes });
    return { guard, underlying };
  }
  const post = (method: string, params?: unknown[]) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) });
  const userOp = (over: Record<string, unknown> = {}) => ({ sender: SAFE, nonce: hexOf((BigInt(5) << BigInt(64)) | BigInt(7)), callData: expectedCallData(), signature: "0x", ...over });
  const lastRecord = (guard: ReturnType<typeof makeGuard>["guard"]) => guard.snapshot().records.at(-1)!;
  const toPrepareWithNonce = async (guard: ReturnType<typeof makeGuard>["guard"]) => {
    guard.setPhase("pre");
    guard.setPhase("prepare");
    // The prepare-phase nonce read the Pimlico intent check binds to.
    await guard.fetch(CHAIN_HREF, post("eth_call", [{ to: PINNED.entryPoint, data: encodeFunctionData({ abi: GET_NONCE_ABI, functionName: "getNonce", args: [SAFE, BigInt(5)] }) }, "latest"]));
  };

  it("the plan is exactly 17 single-use requests: chain 13 (eth_chainId 1, eth_getCode 4, eth_call 8), Pimlico 4", () => {
    expect(REQUEST_PLAN).toHaveLength(17);
    expect(REQUEST_PLAN.every((p) => p.max === 1)).toBe(true);
    expect(REQUEST_CEILINGS).toEqual({ chain: 13, pimlico: 4 });
    const byMethod = (endpoint: string) => REQUEST_PLAN.filter((p) => p.endpoint === endpoint).reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.method]: (acc[p.method] ?? 0) + 1 }), {});
    expect(byMethod("chain")).toEqual({ eth_chainId: 1, eth_getCode: 4, eth_call: 8 });
    expect(byMethod("pimlico")).toEqual({ pimlico_getUserOperationGasPrice: 1, pm_getPaymasterStubData: 1, eth_estimateUserOperationGas: 1, pm_getPaymasterData: 1 });
    expect([...ALLOWED_METHODS.chain].sort()).toEqual(["eth_call", "eth_chainId", "eth_getCode"]);
    expect([...ALLOWED_METHODS.pimlico].sort()).toEqual(["eth_estimateUserOperationGas", "pimlico_getUserOperationGasPrice", "pm_getPaymasterData", "pm_getPaymasterStubData"]);
    expect(expectedUsage(true)["prepare.pimlico.paymasterData"]).toBe(0);
    expect(expectedUsage(false)["prepare.pimlico.paymasterData"]).toBe(1);
    expect(WALL_CLOCK_MS).toBe(60_000);
  });

  it.each([
    ["pimlico", "eth_sendUserOperation"],
    ["pimlico", "pm_sponsorUserOperation"],
    ["pimlico", "eth_sendRawTransaction"],
    ["pimlico", "pimlico_sendUserOperationNow"],
    ["pimlico", "eth_getUserOperationReceipt"],
    ["pimlico", "eth_supportedEntryPoints"],
    ["pimlico", "eth_chainId"],
    ["chain", "eth_sendTransaction"],
    ["chain", "eth_sendRawTransaction"],
    ["chain", "eth_sendUserOperation"],
    ["chain", "eth_sign"],
    ["chain", "personal_sign"],
    ["chain", "eth_signTypedData_v4"],
    ["chain", "eth_signTransaction"],
    ["chain", "wallet_sendCalls"],
    ["chain", "eth_getBalance"],
    ["chain", "eth_estimateGas"],
    ["chain", "eth_blockNumber"],
    ["chain", "pm_getPaymasterStubData"],
    ["chain", "debug_traceCall"],
  ])("%s method %s is refused BEFORE dispatch, trips the guard, and every later request is denied", async (endpoint, method) => {
    const { guard, underlying } = makeGuard();
    guard.setPhase("pre");
    await expect(guard.fetch(endpoint === "chain" ? CHAIN_HREF : PIMLICO_HREF, post(method, []))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying).not.toHaveBeenCalled();
    expect(guard.snapshot().trips).toEqual(["forbidden_method"]);
    await expect(guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(lastRecord(guard)).toMatchObject({ outcome: "denied", reason: "already_tripped" });
    expect(underlying).not.toHaveBeenCalled();
    guard.seal();
  });

  it.each([
    "https://evil.example/rpc",
    "http://api.pimlico.io/v2/84532/rpc?apikey=" + PIMLICO_KEY,
    "https://api.pimlico.io/v1/84532/rpc?apikey=" + PIMLICO_KEY,
    "https://api.pimlico.io/v2/8453/rpc?apikey=" + PIMLICO_KEY,
    "https://api.pimlico.io/v2/84532/rpc?apikey=pim_SOMEONEELSE0001",
    "https://api.pimlico.io/v2/84532/rpc?apikey=" + PIMLICO_KEY + "&extra=1",
    "https://api.pimlico.io:8443/v2/84532/rpc?apikey=" + PIMLICO_KEY,
    "https://user:pw@api.pimlico.io/v2/84532/rpc?apikey=" + PIMLICO_KEY,
    "https://api.pimlico.io.evil.example/v2/84532/rpc?apikey=" + PIMLICO_KEY,
    CHAIN_URL.replace("SECRET0001", "SECRET0002"),
    CHAIN_URL + "?x=1",
    CHAIN_URL.replace("https:", "http:"),
    "https://ccip.offchain.example/{sender}/{data}",
  ])("host/URL %# is refused before dispatch", async (url) => {
    const { guard, underlying } = makeGuard();
    guard.setPhase("pre");
    await expect(guard.fetch(url, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying).not.toHaveBeenCalled();
    expect(guard.snapshot().trips).toEqual(["forbidden_host"]);
    guard.seal();
  });

  it.each([
    ["a Request object", () => [new Request(CHAIN_HREF, { method: "POST", body: "{}" }), undefined]],
    ["a GET", () => [CHAIN_HREF, { method: "GET" }]],
    ["no init", () => [CHAIN_HREF, undefined]],
    ["a non-string body", () => [CHAIN_HREF, { method: "POST", body: new Uint8Array([1]) }]],
    ["a batch (array) body", () => [CHAIN_HREF, { method: "POST", body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_chainId" }]) }]],
    ["a non-JSON body", () => [CHAIN_HREF, { method: "POST", body: "not json" }]],
    ["a body without jsonrpc 2.0", () => [CHAIN_HREF, { method: "POST", body: JSON.stringify({ id: 1, method: "eth_chainId" }) }]],
    ["params that are not an array", () => [CHAIN_HREF, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: {} }) }]],
    ["a non-URL input", () => [{ href: CHAIN_HREF }, post("eth_chainId")]],
  ])("%s is refused before dispatch", async (_label, make) => {
    const { guard, underlying } = makeGuard();
    guard.setPhase("pre");
    const [input, init] = make() as [unknown, unknown];
    await expect((guard.fetch as unknown as (a: unknown, b: unknown) => Promise<Response>)(input, init)).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying).not.toHaveBeenCalled();
    expect(guard.snapshot().trips).toEqual(["forbidden_request_form"]);
    guard.seal();
  });

  it("dispatches with redirect: manual and refuses a redirect answer (never followed), tripping the guard", async () => {
    const { guard, underlying } = makeGuard({ answer: () => new Response(null, { status: 307, headers: { location: "https://evil.example/rpc" } }) });
    guard.setPhase("pre");
    await expect(guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying).toHaveBeenCalledTimes(1);
    expect((underlying.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
    expect(guard.snapshot().trips).toEqual(["redirect_refused"]);
    guard.seal();
  });

  it("passes on exactly method/body/content-type and a guard-owned abort signal — no other init field from the caller", async () => {
    const { guard, underlying } = makeGuard();
    guard.setPhase("pre");
    await guard.fetch(CHAIN_HREF, { ...post("eth_chainId"), headers: { authorization: "Bearer SYNTHETIC", "content-type": "application/json" }, credentials: "include", keepalive: true } as RequestInit);
    const init = underlying.mock.calls[0]![1] as RequestInit;
    expect(Object.keys(init).sort()).toEqual(["body", "headers", "method", "redirect", "signal"]);
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    guard.seal();
  });

  it("a request that is planned for another phase is refused (Pimlico before preparation; anything while idle)", async () => {
    const idle = makeGuard();
    await expect(idle.guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(idle.guard.snapshot().trips).toEqual(["phase_violation"]);
    idle.guard.seal();
    const early = makeGuard();
    early.guard.setPhase("pre");
    await expect(early.guard.fetch(PIMLICO_HREF, post("pimlico_getUserOperationGasPrice", []))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(early.underlying).not.toHaveBeenCalled();
    expect(early.guard.snapshot().trips).toEqual(["phase_violation"]);
    early.guard.seal();
    expect(() => early.guard.setPhase("pre")).toThrow(/forward/);
  });

  it.each<[string, string, () => unknown[]]>([
    ["eth_call to an unplanned contract", "eth_call", () => [{ to: RECIPIENT, data: SEL.balanceOf }, "latest"]],
    ["eth_call with an unplanned selector on the Safe", "eth_call", () => [{ to: SAFE, data: "0x12345678" }, "latest"]],
    ["balanceOf of someone else", "eth_call", () => [{ to: PINNED.cashToken, data: encodeFunctionData({ abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [RECIPIENT] }) }, "latest"]],
    ["eth_call carrying a from field", "eth_call", () => [{ to: SAFE, data: SEL.getOwners, from: OWNER }, "latest"]],
    ["eth_call at a non-latest block", "eth_call", () => [{ to: SAFE, data: SEL.getOwners }, "0x1"]],
    ["eth_call with a state override", "eth_call", () => [{ to: SAFE, data: SEL.getOwners }, "latest", {}]],
    ["eth_getCode of an unplanned address", "eth_getCode", () => [RECIPIENT, "latest"]],
  ])("%s is refused before dispatch", async (_label, method, params) => {
    const { guard, underlying } = makeGuard();
    guard.setPhase("pre");
    await expect(guard.fetch(CHAIN_HREF, post(method, params()))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying).not.toHaveBeenCalled();
    expect(guard.snapshot().trips).toEqual(["forbidden_target"]);
    guard.seal();
  });

  it("authorized duplicate reads across phases are recognized (Safe code pre/prepare/post, balance pre/post) — a second one inside a phase is a budget breach", async () => {
    const { guard, underlying } = makeGuard();
    guard.setPhase("pre");
    await guard.fetch(CHAIN_HREF, post("eth_getCode", [SAFE, "latest"]));
    guard.setPhase("prepare");
    await guard.fetch(CHAIN_HREF, post("eth_getCode", [SAFE, "latest"]));
    guard.setPhase("post");
    await guard.fetch(CHAIN_HREF, post("eth_getCode", [SAFE, "latest"]));
    expect(guard.snapshot().usage).toMatchObject({ "pre.code.safe": 1, "prepare.code.safe": 1, "post.code.safe": 1 });
    await expect(guard.fetch(CHAIN_HREF, post("eth_getCode", [SAFE, "latest"]))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying).toHaveBeenCalledTimes(3);
    expect(guard.snapshot().trips).toEqual(["budget_exceeded"]);
    guard.seal();
  });

  it("the post-phase nonce read is allowed only at the prepared nonce's key", async () => {
    const { guard, underlying } = makeGuard();
    guard.setPhase("pre");
    guard.setPhase("prepare");
    guard.setPostNonceKey(BigInt(5));
    guard.setPhase("post");
    const read = (key: bigint) => post("eth_call", [{ to: PINNED.entryPoint, data: encodeFunctionData({ abi: GET_NONCE_ABI, functionName: "getNonce", args: [SAFE, key] }) }, "latest"]);
    await expect(guard.fetch(CHAIN_HREF, read(BigInt(6)))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying).not.toHaveBeenCalled();
    expect(guard.snapshot().trips).toEqual(["forbidden_target"]);
    guard.seal();
  });

  it("an unexpected repeat of a Pimlico request after a successful answer is blocked (FAIL-SAFETY reason), dispatched once", async () => {
    const { guard, underlying } = makeGuard();
    await toPrepareWithNonce(guard);
    await guard.fetch(PIMLICO_HREF, post("pimlico_getUserOperationGasPrice", []));
    await expect(guard.fetch(PIMLICO_HREF, post("pimlico_getUserOperationGasPrice", []))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying.mock.calls.filter((c) => String(c[1]?.body).includes("pimlico_getUserOperationGasPrice"))).toHaveLength(1);
    expect(guard.snapshot().trips).toEqual(["unexpected_repeat"]);
    guard.seal();
  });

  it.each([
    ["HTTP 503", () => new Response("{}", { status: 503 })],
    ["HTTP 429", () => new Response("{}", { status: 429, headers: { "retry-after": "30" } })],
    ["a JSON-RPC error", () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: PROVIDER_SECRET_TEXT } }), { status: 200, headers: { "content-type": "application/json" } })],
    ["a malformed body", () => new Response("<html>" + PROVIDER_SECRET_TEXT, { status: 200 })],
  ])("a library retry after %s is blocked before dispatch (INCONCLUSIVE reason), dispatched once", async (_label, answer) => {
    const { guard, underlying } = makeGuard({ answer: (method) => (method === "eth_call" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"0".repeat(64)}` }), { status: 200 }) : answer()) });
    await toPrepareWithNonce(guard);
    const first = await guard.fetch(PIMLICO_HREF, post("pimlico_getUserOperationGasPrice", []));
    expect(first.headers.get("retry-after")).toBeNull(); // Retry-After is never handed back to viem
    await expect(guard.fetch(PIMLICO_HREF, post("pimlico_getUserOperationGasPrice", []))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying.mock.calls.filter((c) => String(c[1]?.body).includes("pimlico_getUserOperationGasPrice"))).toHaveLength(1);
    expect(guard.snapshot().trips).toEqual(["library_retry_blocked"]);
    expect(JSON.stringify(guard.snapshot().records)).not.toContain(PROVIDER_SECRET_TEXT);
    expect(JSON.stringify(guard.snapshot().shapes)).not.toContain(PROVIDER_SECRET_TEXT);
    guard.seal();
  });

  it.each([
    ["the wrong sender", { sender: RECIPIENT }],
    ["different callData", { callData: encodeExpectedCallData(RECIPIENT, BigInt(AMOUNT) + BigInt(1)) }],
    ["a factory field", { factory: PINNED.proxyFactory, factoryData: "0x1234" }],
    ["an initCode field", { initCode: "0x1234" }],
    ["an authorization field", { authorization: {} }],
    ["a nonce other than the one read from chain", { nonce: hexOf(BigInt(1)) }],
  ])("a Pimlico stub request with %s is refused before dispatch", async (_label, over) => {
    const { guard, underlying } = makeGuard({ answer: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeAbiParameters([{ type: "uint256" }], [(BigInt(5) << BigInt(64)) | BigInt(7)]) }), { status: 200 }) });
    await toPrepareWithNonce(guard);
    const calls = underlying.mock.calls.length;
    await expect(guard.fetch(PIMLICO_HREF, post("pm_getPaymasterStubData", [userOp(over), PINNED.entryPoint, "0x14a34", null]))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying.mock.calls.length).toBe(calls);
    expect(guard.snapshot().trips).toEqual(["request_intent_mismatch"]);
    guard.seal();
  });

  it.each([
    ["a sponsorship context", [PINNED.entryPoint, "0x14a34", { sponsorshipPolicyId: "x" }]],
    ["another chain id", [PINNED.entryPoint, "0x2105", null]],
    ["another EntryPoint", ["0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", "0x14a34", null]],
  ])("a Pimlico stub request naming %s is refused before dispatch", async (_label, rest) => {
    const { guard } = makeGuard({ answer: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodeAbiParameters([{ type: "uint256" }], [(BigInt(5) << BigInt(64)) | BigInt(7)]) }), { status: 200 }) });
    await toPrepareWithNonce(guard);
    await expect(guard.fetch(PIMLICO_HREF, post("pm_getPaymasterStubData", [userOp(), ...rest]))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(guard.snapshot().trips).toEqual(["request_intent_mismatch"]);
    guard.seal();
  });

  it("the wall clock trips on the next request (injected clock) and on its own timer, aborting what is in flight", async () => {
    let t = 1_000;
    const clocked = makeGuard({ now: () => t, wallClockMs: 500 });
    clocked.guard.setPhase("pre");
    t = 1_600;
    await expect(clocked.guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(clocked.underlying).not.toHaveBeenCalled();
    expect(clocked.guard.snapshot().trips).toEqual(["wall_clock_exceeded"]);
    clocked.guard.seal();

    const timed = makeGuard({ wallClockMs: 50, answer: () => new Promise<Response>(() => undefined) });
    timed.guard.setPhase("pre");
    await expect(timed.guard.tripped).resolves.toBe("wall_clock_exceeded");
    expect(timed.guard.signal.aborted).toBe(true);
    timed.guard.seal();
  });

  it("an oversized answer trips response_too_large", async () => {
    const { guard } = makeGuard({ maxResponseBytes: 16, answer: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "00".repeat(64) }), { status: 200 }) });
    guard.setPhase("pre");
    await expect(guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(guard.snapshot().trips).toEqual(["response_too_large"]);
    expect(lastRecord(guard)).toMatchObject({ outcome: "dispatched", response: "too_large" });
    guard.seal();
  });

  it("the default response ceiling is 1 MiB in bytes, and a malformed ceiling is refused", () => {
    expect(MAX_RESPONSE_BYTES).toBe(1_048_576);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createNetworkGuard({ underlying: vi.fn(), chainRpcUrl: CHAIN_URL, pimlicoApiKey: PIMLICO_KEY, safe: SAFE, expectedCallData: expectedCallData(), wallClockMs: 10, maxResponseBytes: bad })).toThrow(/byte ceiling/);
    }
  });

  it("a declared Content-Length above the ceiling is refused WITHOUT reading the body: response_too_large, never retried", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls += 1;
        c.enqueue(new Uint8Array(8));
      },
    });
    const { guard, underlying } = makeGuard({ maxResponseBytes: 64, answer: () => new Response(body, { status: 200, headers: { "content-length": "65" } }) });
    guard.setPhase("pre");
    await expect(guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying).toHaveBeenCalledTimes(1);
    expect(guard.snapshot().trips).toEqual(["response_too_large"]);
    expect(pulls).toBeLessThanOrEqual(1); // at most the stream's own initial pull; nothing was consumed
    expect(guard.signal.aborted).toBe(true);
    guard.seal();
  });

  it("a streamed answer that passes the ceiling under an understated Content-Length is cut off as it streams, then trips", async () => {
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls += 1;
        c.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { guard } = makeGuard({ maxResponseBytes: 64, answer: () => new Response(endless, { status: 200, headers: { "content-length": "2" } }) });
    guard.setPhase("pre");
    await expect(guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(guard.snapshot().trips).toEqual(["response_too_large"]);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(12);
    guard.seal();
  });

  it("a body that errors while streaming is a transport failure (fixed text), and the library's retry is then blocked", async () => {
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"jsonrpc"'));
            c.error(new Error(PROVIDER_SECRET_TEXT));
          },
        }),
        { status: 200 },
      );
    const { guard, underlying } = makeGuard({ answer: () => broken() });
    guard.setPhase("pre");
    const failure = await guard.fetch(CHAIN_HREF, post("eth_chainId")).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("GuardDispatchFailure");
    expect((failure as Error).message).not.toContain(PROVIDER_SECRET_TEXT);
    expect(lastRecord(guard)).toMatchObject({ outcome: "dispatched", response: "network_failure" });
    await expect(guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying).toHaveBeenCalledTimes(1);
    expect(guard.snapshot().trips).toEqual(["library_retry_blocked"]);
    guard.seal();
  });

  it("an allowed answer keeps its status and content type, drops every other header, and its body arrives intact", async () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x14a34", note: "é".repeat(8) });
    const { guard } = makeGuard({ answer: () => new Response(payload, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "retry-after": "5", "x-provider": "p" } }) });
    guard.setPhase("pre");
    const response = await guard.fetch(CHAIN_HREF, post("eth_chainId"));
    expect(response.status).toBe(200);
    expect([...response.headers.keys()]).toEqual(["content-type"]);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe(payload);
    guard.seal();
  });

  it("a body that is not valid UTF-8 or JSON is recorded as malformed (no provider text kept)", async () => {
    const { guard } = makeGuard({ answer: () => new Response(new Uint8Array([0xff, 0xfe, 0x7b, 0x80]), { status: 200 }) });
    guard.setPhase("pre");
    await guard.fetch(CHAIN_HREF, post("eth_chainId"));
    expect(lastRecord(guard)).toMatchObject({ outcome: "dispatched", response: "malformed" });
    expect(guard.snapshot().trips).toEqual([]);
    guard.seal();
  });

  it("a stalled body is released by the wall clock: the read stops, the guard trips, nothing more is dispatched", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode("{")) }); // never closes
    const { guard, underlying } = makeGuard({ wallClockMs: 60, answer: () => new Response(stalled, { status: 200 }) });
    guard.setPhase("pre");
    await expect(guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toHaveProperty("name", "GuardDispatchFailure");
    expect(guard.snapshot().trips).toEqual(["wall_clock_exceeded"]);
    expect(underlying).toHaveBeenCalledTimes(1);
    guard.seal();
  });

  it.each([
    ["carrying a string paymaster", { paymaster: PAYMASTER }, true],
    ["without a paymaster", {}, false],
  ] as const)("a VALID repeat of the paymaster stub after a successful answer %s is refused before dispatch with its own non-safety reason", async (_label, extra, hadPaymaster) => {
    const nonce = encodeAbiParameters([{ type: "uint256" }], [(BigInt(5) << BigInt(64)) | BigInt(7)]);
    const { guard, underlying } = makeGuard({ answer: (method) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_call" ? nonce : { paymasterData: "0x", ...extra } }), { status: 200 }) });
    await toPrepareWithNonce(guard);
    const stub = () => post("pm_getPaymasterStubData", [userOp(), PINNED.entryPoint, "0x14a34", null]);
    await guard.fetch(PIMLICO_HREF, stub());
    await expect(guard.fetch(PIMLICO_HREF, stub())).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying.mock.calls.filter((c) => String(c[1]?.body).includes("pm_getPaymasterStubData"))).toHaveLength(1);
    expect(guard.snapshot().trips).toEqual(["stub_repeat_blocked"]);
    expect(guard.snapshot().stubHadStringPaymaster).toBe(hadPaymaster);
    expect(lastRecord(guard)).toMatchObject({ outcome: "denied", slot: "prepare.pimlico.stub", reason: "stub_repeat_blocked" });
    expect(SAFETY_TRIPS as readonly string[]).not.toContain("stub_repeat_blocked");
    expect(INCONCLUSIVE_TRIPS as readonly string[]).toContain("stub_repeat_blocked");
    // Still a trip: every later request is denied.
    await expect(guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(lastRecord(guard)).toMatchObject({ reason: "already_tripped" });
    guard.seal();
  });

  it("a stub repeat with MODIFIED intent is a safety trip (request_intent_mismatch), never the repeat reason", async () => {
    const nonce = encodeAbiParameters([{ type: "uint256" }], [(BigInt(5) << BigInt(64)) | BigInt(7)]);
    const { guard, underlying } = makeGuard({ answer: (method) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_call" ? nonce : { paymasterData: "0x" } }), { status: 200 }) });
    await toPrepareWithNonce(guard);
    await guard.fetch(PIMLICO_HREF, post("pm_getPaymasterStubData", [userOp(), PINNED.entryPoint, "0x14a34", null]));
    const calls = underlying.mock.calls.length;
    await expect(guard.fetch(PIMLICO_HREF, post("pm_getPaymasterStubData", [userOp({ callData: encodeExpectedCallData(RECIPIENT, BigInt(2)) }), PINNED.entryPoint, "0x14a34", null]))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying.mock.calls.length).toBe(calls);
    expect(guard.snapshot().trips).toEqual(["request_intent_mismatch"]);
    guard.seal();
  });

  // ---- Low-1: the interrupted-stub-reentry diagnostic needs EXACTLY ONE denial, and it must be the expected one ----
  const nonceResult = () => encodeAbiParameters([{ type: "uint256" }], [(BigInt(5) << BigInt(64)) | BigInt(7)]);
  const stubBody = (over: Record<string, unknown> = {}) => post("pm_getPaymasterStubData", [userOp(over), PINNED.entryPoint, "0x14a34", null]);
  /** A guard in the prepare phase whose stub answer lacks a string paymaster; the first stub request has been made. */
  async function guardAfterPaymasterlessStub() {
    const made = makeGuard({ answer: (method) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_call" ? nonceResult() : { paymasterData: "0x" } }), { status: 200 }) });
    await toPrepareWithNonce(made.guard);
    await made.guard.fetch(PIMLICO_HREF, stubBody());
    return made;
  }
  /** The verdict the runner would reach from this guard's own records, as an aborted preparation with no post-run reads. */
  function verdictFrom(guard: ReturnType<typeof makeGuard>["guard"], over: Partial<VerdictInput> = {}) {
    const { records, trips, stubHadStringPaymaster } = guard.snapshot();
    return classifyVerdict({
      trips,
      preconditionFailures: [],
      stageFailures: [],
      preparation: "aborted_by_guard",
      prepareResponsesAllSuccessful: false,
      prepareDispatchedAllSuccessful: true,
      stubHadStringPaymaster,
      deniedRequests: records.flatMap((r) => (r.outcome === "denied" ? [{ slot: r.slot, reason: r.reason }] : [])),
      independentCheckFailures: [],
      postStateChanges: [],
      evidenceComplete: false,
      ...over,
    });
  }
  const EXPECTED_DENIAL = [{ slot: "prepare.pimlico.stub", reason: "stub_repeat_blocked" }];

  it("EXACTLY ONE expected stub denial: INCONCLUSIVE with the fixed diagnostic reasons — never FAIL-COMPAT, never PASS", async () => {
    const { guard, underlying } = await guardAfterPaymasterlessStub();
    await expect(guard.fetch(PIMLICO_HREF, stubBody())).rejects.toBeInstanceOf(GuardDeniedError);
    expect(guard.snapshot().records.filter((r) => r.outcome === "denied").map((r) => ({ slot: r.slot, reason: (r as { reason: string }).reason }))).toEqual(EXPECTED_DENIAL);
    expect(underlying.mock.calls.filter((c) => String(c[1]?.body).includes("pm_getPaymasterStubData"))).toHaveLength(1);
    expect(verdictFrom(guard)).toEqual({
      verdict: "INCONCLUSIVE",
      reasons: ["guard:stub_repeat_blocked", "stub_response_lacked_paymaster", "initial_stub_response_observed", "l1a_validation_not_reached", "post_state_not_observed", "preparation_aborted_by_guard", "evidence_incomplete"],
    });
    guard.seal();
  });

  it("an ADDITIONAL already_tripped denial after the expected one: the diagnostic is withheld — INCONCLUSIVE with additional_denied_requests", async () => {
    const { guard, underlying } = await guardAfterPaymasterlessStub();
    await expect(guard.fetch(PIMLICO_HREF, stubBody())).rejects.toBeInstanceOf(GuardDeniedError);
    const calls = underlying.mock.calls.length;
    await expect(guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    await expect(guard.fetch(PIMLICO_HREF, stubBody())).rejects.toBeInstanceOf(GuardDeniedError); // a third stub attempt
    expect(underlying.mock.calls.length).toBe(calls); // nothing more is ever dispatched
    expect(guard.snapshot().trips).toEqual(["stub_repeat_blocked"]); // already_tripped adds no trip: the trip list alone cannot see these
    const verdict = verdictFrom(guard);
    expect(verdict.verdict).toBe("INCONCLUSIVE");
    expect(verdict.reasons).toEqual(expect.arrayContaining(["guard:stub_repeat_blocked", "stub_repeat_unexplained", "additional_denied_requests"]));
    for (const withheld of ["stub_response_lacked_paymaster", "initial_stub_response_observed", "l1a_validation_not_reached"]) expect(verdict.reasons).not.toContain(withheld);
    guard.seal();
  });

  it("a LATER forbidden-method attempt after the expected denial is FAIL-SAFETY (reason names it, not the stub repeat)", async () => {
    const { guard, underlying } = await guardAfterPaymasterlessStub();
    await expect(guard.fetch(PIMLICO_HREF, stubBody())).rejects.toBeInstanceOf(GuardDeniedError);
    const calls = underlying.mock.calls.length;
    // The guard has tripped, so this is denied as already_tripped (no new trip) ...
    await expect(guard.fetch(PIMLICO_HREF, post("eth_sendUserOperation", []))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying.mock.calls.length).toBe(calls);
    expect(guard.snapshot().trips).toEqual(["stub_repeat_blocked"]);
    // ... so it is INCONCLUSIVE here, never the diagnostic.
    expect(verdictFrom(guard).verdict).toBe("INCONCLUSIVE");
    expect(verdictFrom(guard).reasons).toContain("additional_denied_requests");
    expect(verdictFrom(guard).reasons).not.toContain("l1a_validation_not_reached");
    guard.seal();
    // The same forbidden method attempted BEFORE the stub repeat trips the safety check on its own.
    const early = await guardAfterPaymasterlessStub();
    await expect(early.guard.fetch(PIMLICO_HREF, post("eth_sendUserOperation", []))).rejects.toBeInstanceOf(GuardDeniedError);
    await expect(early.guard.fetch(PIMLICO_HREF, stubBody())).rejects.toBeInstanceOf(GuardDeniedError);
    expect(early.guard.snapshot().trips).toEqual(["forbidden_method"]);
    expect(verdictFrom(early.guard)).toEqual({ verdict: "FAIL-SAFETY", reasons: ["guard:forbidden_method"] });
    early.guard.seal();
  });

  it("a safety breach that trips alongside the stub repeat (an egress constructor) is FAIL-SAFETY: the diagnostic never overwrites it", async () => {
    const { guard } = await guardAfterPaymasterlessStub();
    await expect(guard.fetch(PIMLICO_HREF, stubBody())).rejects.toBeInstanceOf(GuardDeniedError);
    expect(() => guard.blockedConstructor("WebSocket")()).toThrow(GuardDeniedError);
    expect(guard.snapshot().trips).toEqual(["stub_repeat_blocked", "egress_api_blocked"]);
    expect(guard.snapshot().stubHadStringPaymaster).toBe(false);
    expect(verdictFrom(guard)).toEqual({ verdict: "FAIL-SAFETY", reasons: ["guard:egress_api_blocked"] });
    guard.seal();
  });

  it("a CHANGED-INTENT stub repeat is FAIL-SAFETY (request_intent_mismatch) and never the diagnostic", async () => {
    const { guard } = await guardAfterPaymasterlessStub();
    await expect(guard.fetch(PIMLICO_HREF, stubBody({ callData: encodeExpectedCallData(RECIPIENT, BigInt(2)) }))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(guard.snapshot().trips).toEqual(["request_intent_mismatch"]);
    expect(verdictFrom(guard)).toEqual({ verdict: "FAIL-SAFETY", reasons: ["guard:request_intent_mismatch"] });
    guard.seal();
  });

  it("a FAILED initial stub response gets no diagnostic: its repeat is a blocked library retry — INCONCLUSIVE, no stub-reentry reasons", async () => {
    const { guard } = makeGuard({ answer: (method) => (method === "eth_call" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: nonceResult() }), { status: 200 }) : new Response("{}", { status: 503 })) });
    await toPrepareWithNonce(guard);
    await guard.fetch(PIMLICO_HREF, stubBody());
    await expect(guard.fetch(PIMLICO_HREF, stubBody())).rejects.toBeInstanceOf(GuardDeniedError);
    expect(guard.snapshot().stubHadStringPaymaster).toBeNull();
    const verdict = verdictFrom(guard, { prepareDispatchedAllSuccessful: false });
    expect(verdict.verdict).toBe("INCONCLUSIVE");
    expect(verdict.reasons).toContain("guard:library_retry_blocked");
    for (const withheld of ["stub_response_lacked_paymaster", "l1a_validation_not_reached", "stub_repeat_unexplained"]) expect(verdict.reasons).not.toContain(withheld);
    guard.seal();
  });

  it("an UNRELATED repeated request is its own safety trip, before or after the stub: FAIL-SAFETY before; withheld-diagnostic INCONCLUSIVE after", async () => {
    // Before the stub repeat: a second gas-price request (an unplanned Pimlico repeat) is a safety trip.
    const first = makeGuard();
    await toPrepareWithNonce(first.guard);
    await first.guard.fetch(PIMLICO_HREF, post("pimlico_getUserOperationGasPrice", []));
    await expect(first.guard.fetch(PIMLICO_HREF, post("pimlico_getUserOperationGasPrice", []))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(verdictFrom(first.guard, { stubHadStringPaymaster: false })).toEqual({ verdict: "FAIL-SAFETY", reasons: ["guard:unexpected_repeat"] });
    first.guard.seal();
    // After the stub repeat has tripped the guard: the unrelated repeat is just another denial.
    const second = await guardAfterPaymasterlessStub();
    await expect(second.guard.fetch(PIMLICO_HREF, stubBody())).rejects.toBeInstanceOf(GuardDeniedError);
    await expect(second.guard.fetch(PIMLICO_HREF, post("pimlico_getUserOperationGasPrice", []))).rejects.toBeInstanceOf(GuardDeniedError);
    const verdict = verdictFrom(second.guard);
    expect(verdict.verdict).toBe("INCONCLUSIVE");
    expect(verdict.reasons).toContain("additional_denied_requests");
    expect(verdict.reasons).not.toContain("l1a_validation_not_reached");
    second.guard.seal();
  });

  it("a stub repeat after a FAILED stub answer stays a blocked library retry", async () => {
    const nonce = encodeAbiParameters([{ type: "uint256" }], [(BigInt(5) << BigInt(64)) | BigInt(7)]);
    const { guard } = makeGuard({ answer: (method) => (method === "eth_call" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: nonce }), { status: 200 }) : new Response("{}", { status: 503 })) });
    await toPrepareWithNonce(guard);
    const stub = () => post("pm_getPaymasterStubData", [userOp(), PINNED.entryPoint, "0x14a34", null]);
    await guard.fetch(PIMLICO_HREF, stub());
    await expect(guard.fetch(PIMLICO_HREF, stub())).rejects.toBeInstanceOf(GuardDeniedError);
    expect(guard.snapshot().trips).toEqual(["library_retry_blocked"]);
    guard.seal();
  });

  it("after seal every request is denied as 'sealed' (not a new trip) and nothing is dispatched", async () => {
    const { guard, underlying } = makeGuard();
    guard.setPhase("pre");
    guard.seal();
    await expect(guard.fetch(CHAIN_HREF, post("eth_chainId"))).rejects.toBeInstanceOf(GuardDeniedError);
    expect(underlying).not.toHaveBeenCalled();
    expect(guard.snapshot().trips).toEqual([]);
    expect(lastRecord(guard)).toMatchObject({ reason: "sealed" });
  });

  it("installGuard routes globalThis.fetch through the guard and blocks WebSocket/EventSource/XMLHttpRequest; restore puts everything back", async () => {
    const { guard } = makeGuard();
    const restore = installGuard(guard);
    try {
      expect(globalThis.fetch).toBe(guard.fetch);
      const Ws = (globalThis as Record<string, unknown>).WebSocket as new (url: string) => unknown;
      expect(() => new Ws("wss://evil.example")).toThrow(GuardDeniedError);
      expect(guard.snapshot().trips).toEqual(["egress_api_blocked"]);
    } finally {
      restore();
      guard.seal();
    }
    expect(globalThis.fetch).toBe(sentinel);
    expect((globalThis as Record<string, unknown>).WebSocket).toBe(WEBSOCKET_AT_LOAD);
  });

  it("a LOCKED install (every live run) leaves fetch and the egress constructors impossible to assign, redefine or delete, and refuses to uninstall", async () => {
    const { guard, underlying } = makeGuard();
    const target: Record<string, unknown> = { fetch: sentinel };
    const restore = installGuard(guard, { lock: true, target });
    expect(guardIsLocked(guard, target)).toBe(true);
    for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) {
      const original = target[name];
      expect(Object.getOwnPropertyDescriptor(target, name)).toMatchObject({ writable: false, configurable: false });
      expect(() => {
        target[name] = vi.fn();
      }).toThrow(TypeError);
      expect(() => Object.defineProperty(target, name, { value: vi.fn() })).toThrow(TypeError);
      expect(() => delete target[name]).toThrow(TypeError);
      expect(Reflect.set(target, name, vi.fn())).toBe(false);
      expect(target[name]).toBe(original);
    }
    expect(target.fetch).toBe(guard.fetch);
    // Reading the locked property still reaches the guard, which is all viem does (`options.fetchFn ?? fetch` at request time).
    guard.setPhase("pre");
    await (target.fetch as typeof fetch)(CHAIN_HREF, post("eth_chainId"));
    expect(underlying).toHaveBeenCalledTimes(1);
    expect(() => restore()).toThrow(/never uninstalled/);
    expect(target.fetch).toBe(guard.fetch);
    // The test process's own globals were never touched.
    expect(globalThis.fetch).toBe(sentinel);
    guard.seal();
  });

  it("guardIsLocked is false for an unlocked install, a substituted fetch, or a missing constructor", () => {
    const { guard } = makeGuard();
    const unlocked: Record<string, unknown> = {};
    installGuard(guard, { target: unlocked });
    expect(guardIsLocked(guard, unlocked)).toBe(false);
    const other = makeGuard().guard;
    const foreign: Record<string, unknown> = {};
    installGuard(other, { lock: true, target: foreign });
    expect(guardIsLocked(guard, foreign)).toBe(false);
    const partial: Record<string, unknown> = {};
    Object.defineProperty(partial, "fetch", { value: guard.fetch, writable: false, configurable: false });
    expect(guardIsLocked(guard, partial)).toBe(false);
    guard.seal();
    other.seal();
  });

  it("the Node and Vitest facts the lock relies on (pinned; a change needs a new review): fetch is an own configurable data property, and Vitest's node environment never touches it", () => {
    expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toMatchObject({ configurable: true, writable: true });
    const environments = readdirSync("node_modules/vitest/dist/chunks").find((name) => /^index\.[A-Za-z0-9_-]+\.js$/.test(name) && readFileSync(path.join("node_modules/vitest/dist/chunks", name), "utf8").includes('name: "node"'));
    expect(environments).toBeDefined();
    const source = readFileSync(path.join("node_modules/vitest/dist/chunks", environments!), "utf8");
    const nodeEnvironment = source.slice(source.indexOf("var node = {"), source.indexOf("const environments = {"));
    const setup = nodeEnvironment.slice(nodeEnvironment.indexOf("async setup(global)"));
    expect(setup).toContain("global.console.Console = Console");
    expect(setup).not.toMatch(/fetch/);
  });

  it("viem's http transport resolves fetch per request: a client built BEFORE the guard was installed still goes through it", async () => {
    const early = createPublicClient({ chain: baseSepolia, transport: http(CHAIN_URL, { retryCount: 0 }) });
    const { guard, underlying } = makeGuard();
    const restore = installGuard(guard);
    try {
      guard.setPhase("pre");
      expect(await early.getChainId()).toBe(84532);
      expect(underlying).toHaveBeenCalledTimes(1);
      expect(String(underlying.mock.calls[0]![0])).toBe(CHAIN_HREF);
    } finally {
      restore();
      guard.seal();
    }
    // And the installed viem source still reads `fetch` at call time (pinned: a change here needs a new review).
    expect(readFileSync("node_modules/viem/_esm/utils/rpc/http.js", "utf8")).toContain("fetchFn = options.fetchFn ?? fetch");
  });
});

// ---------------------------------------------------------------------------
// Bounded response reads (bytes, enforced while streaming)
// ---------------------------------------------------------------------------

describe("readBoundedBody: a byte ceiling enforced as the body streams", () => {
  const live = () => new AbortController().signal;
  const streamOf = (chunks: unknown[], opts: { error?: boolean; hang?: boolean } = {}) =>
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        if (opts.error) c.error(new Error(PROVIDER_SECRET_TEXT));
        else if (!opts.hang) c.close();
      },
    });
  const bytes = (n: number) => new Uint8Array(n).fill(0x61);

  it.each<[string, () => Response, number, { ok: true; text: string } | { ok: false; failure: string }]>([
    ["below the limit", () => new Response("abc"), 4, { ok: true, text: "abc" }],
    ["exactly at the limit", () => new Response("abcd"), 4, { ok: true, text: "abcd" }],
    ["one byte above the limit", () => new Response("abcde"), 4, { ok: false, failure: "too_large" }],
    ["exactly at the limit in BYTES with multi-byte characters (2 chars, 4 bytes)", () => new Response("éé"), 4, { ok: true, text: "éé" }],
    ["above the limit in BYTES though under it in string length (2 chars, 4 bytes, limit 3)", () => new Response("éé"), 3, { ok: false, failure: "too_large" }],
    ["an empty body", () => new Response(null, { status: 204 }), 0, { ok: true, text: "" }],
    ["no Content-Length, within the limit", () => new Response(streamOf([bytes(3), bytes(1)])), 4, { ok: true, text: "aaaa" }],
    ["no Content-Length, streaming past the limit", () => new Response(streamOf([bytes(3), bytes(2)])), 4, { ok: false, failure: "too_large" }],
    ["a false (understated) Content-Length", () => new Response("0123456789", { headers: { "content-length": "2" } }), 4, { ok: false, failure: "too_large" }],
    ["a false (overstated) Content-Length within the limit", () => new Response("ab", { headers: { "content-length": "4" } }), 4, { ok: true, text: "ab" }],
    ["a declared Content-Length above the limit", () => new Response("ab", { headers: { "content-length": "5" } }), 4, { ok: false, failure: "too_large" }],
    ["a malformed Content-Length (ignored; bytes still counted)", () => new Response("abcde", { headers: { "content-length": "4x" } }), 4, { ok: false, failure: "too_large" }],
    ["a body that is not UTF-8 (decoded like Response.text())", () => new Response(new Uint8Array([0xff, 0x61])), 4, { ok: true, text: "\ufffda" }],
    ["a leading BOM is stripped like Response.text()", () => new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 4, { ok: true, text: "a" }],
    ["a stream that errors part-way", () => new Response(streamOf([bytes(1)], { error: true })), 4, { ok: false, failure: "read_failed" }],
    ["a non-byte chunk", () => new Response(streamOf(["a"])), 4, { ok: false, failure: "read_failed" }],
  ])("%s", async (_label, make, max, expected) => {
    const result = await readBoundedBody(make(), max, live());
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(PROVIDER_SECRET_TEXT);
  });

  it("matches Response.text() on every allowed body above", async () => {
    for (const make of [() => new Response("abc"), () => new Response("éé"), () => new Response(new Uint8Array([0xff, 0x61])), () => new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))]) {
      expect(await readBoundedBody(make(), 16, live())).toEqual({ ok: true, text: await make().text() });
    }
  });

  it("an oversize stream is cancelled immediately: no further chunk is pulled after the limit is passed", async () => {
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls += 1;
        c.enqueue(bytes(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readBoundedBody(new Response(endless), 25, live())).toEqual({ ok: false, failure: "too_large" });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(4);
  });

  it("a declared oversize is refused without consuming the body", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls += 1;
        c.enqueue(bytes(1));
      },
    });
    expect(await readBoundedBody(new Response(body, { headers: { "content-length": "1048577" } }), MAX_RESPONSE_BYTES, live())).toEqual({ ok: false, failure: "too_large" });
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("an aborted read (already aborted, or aborted while the stream stalls) stops with read_failed", async () => {
    const already = new AbortController();
    already.abort();
    expect(await readBoundedBody(new Response(streamOf([bytes(1)], { hang: true })), 4, already.signal)).toEqual({ ok: false, failure: "read_failed" });
    const later = new AbortController();
    const reading = readBoundedBody(new Response(streamOf([bytes(1)], { hang: true })), 4, later.signal);
    setTimeout(() => later.abort(), 20);
    expect(await reading).toEqual({ ok: false, failure: "read_failed" });
  });

  it("exactly MAX_RESPONSE_BYTES passes and one byte more is refused", async () => {
    expect(await readBoundedBody(new Response(bytes(MAX_RESPONSE_BYTES)), MAX_RESPONSE_BYTES, live())).toMatchObject({ ok: true });
    expect(await readBoundedBody(new Response(bytes(MAX_RESPONSE_BYTES + 1)), MAX_RESPONSE_BYTES, live())).toEqual({ ok: false, failure: "too_large" });
  });
});

// ---------------------------------------------------------------------------
// 16-17. The real production preparation through the guard (simulated)
// ---------------------------------------------------------------------------

describe("observation through the real prepareCashTransferUserOperation (SIMULATED — fake answers, not provider evidence)", () => {
  it("honest fake answers: a SIMULATED PASS, every planned request used exactly once, both transports intercepted", async () => {
    const { report, fake } = await simulate();
    expect(report.verdict).toBe("PASS");
    expect(report.simulated).toBe(true);
    expect(report.evidenceKind).toBe("simulated-offline-self-test");
    expect(printableReport(report)).toContain("SIMULATED PASS (offline fakes; NOT provider evidence)");
    expect(report.reasons).toEqual([]);
    expect(report.preparation).toEqual({ outcome: "ok", errorName: null });
    expect(report.network.usage).toEqual(report.network.expectedUsage);
    expect(report.network.totals).toEqual({ chain: 13, pimlico: 4 });
    expect(report.network.trips).toEqual([]);
    expect(report.network.deniedAttempts).toBe(0);
    expect(fake.calls).toHaveLength(17);
    expect(fake.calls.filter((c) => c.endpoint === "pimlico").map((c) => c.method)).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "eth_estimateUserOperationGas", "pm_getPaymasterData"]);
    expect(fake.calls.every((c) => c.init?.redirect === "manual")).toBe(true);
    expect(Object.values(report.preconditions).every(Boolean)).toBe(true);
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(Object.keys(report.checks)).toHaveLength(14);
    expect(report.postState).toEqual({ safe_code_unchanged: true, entry_point_nonce_unchanged: true, cash_balance_unchanged: true });
    expect(Object.keys(report.responseShapes).sort()).toEqual(["prepare.pimlico.estimate", "prepare.pimlico.gasPrice", "prepare.pimlico.paymasterData", "prepare.pimlico.stub"]);
    expect(report.prepared).toMatchObject({ factoryPresent: false, paymaster: { address: "lowercase" }, paymasterData: { byteLength: 24 } });
    expect(report.prepared!.paymasterData!.digest16).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a stub that says isFinal: PASS with three Pimlico requests (no paymaster-data call is expected)", async () => {
    const { report, fake } = await simulate({ stubIsFinal: true });
    expect(report.verdict).toBe("PASS");
    expect(fake.count("pm_getPaymasterData")).toBe(0);
    expect(report.network.totals.pimlico).toBe(3);
    expect(report.network.expectedUsage["prepare.pimlico.paymasterData"]).toBe(0);
  });

  it.each([
    ["a zero paymaster", { stubExtra: { paymaster: "0x0000000000000000000000000000000000000000" }, finalExtra: { paymaster: "0x0000000000000000000000000000000000000000" } }, "integrity_error"],
    ["the paymaster nulled in the final answer", { finalExtra: { paymaster: null } }, "integrity_error"],
    ["odd-length paymasterData", { finalExtra: { paymasterData: "0xabc" } }, "integrity_error"],
    ["a substituted nonce", { finalExtra: { nonce: hexOf(BigInt(1)) } }, "integrity_error"],
    ["an injected factory", { finalExtra: { factory: PINNED.proxyFactory, factoryData: "0x1234" } }, "integrity_error"],
    ["a non-bigint gas limit", { finalExtra: { callGasLimit: "0x10" } }, "integrity_error"],
    ["substituted callData", { finalExtra: { callData: "0xdeadbeef" } }, "calldata_mismatch"],
  ])("scripted incompatible answer (%s): a SIMULATED FAIL-COMPAT, never a false PASS", async (_label, script, outcome) => {
    const { report } = await simulate(script as Script);
    expect(report.verdict).toBe("FAIL-COMPAT");
    expect(report.preparation.outcome).toBe(outcome);
    expect(report.network.trips).toEqual([]);
    expect(report.postState).toMatchObject({ safe_code_unchanged: true, cash_balance_unchanged: true });
    expect(printableReport(report)).toContain("SIMULATED FAIL-COMPAT");
  });

  it("a stub answer WITHOUT a paymaster makes the installed viem request the stub again; the guard blocks that repeat before dispatch: a SIMULATED INCONCLUSIVE that says L-1a was never reached — not FAIL-COMPAT, not PASS", async () => {
    const { report, fake } = await simulate({ stubOmit: ["paymaster"] });
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.reasons).toEqual(["guard:stub_repeat_blocked", "stub_response_lacked_paymaster", "initial_stub_response_observed", "l1a_validation_not_reached", "post_state_not_observed", "preparation_aborted_by_guard", "evidence_incomplete"]);
    expect(report.network.trips).toEqual(["stub_repeat_blocked"]);
    expect(report.preparation).toEqual({ outcome: "aborted_by_guard", errorName: null }); // production preparation never finished: no L-1a error exists
    expect(fake.count("pm_getPaymasterStubData")).toBe(1);
    expect(fake.count("eth_estimateUserOperationGas")).toBe(0);
    expect(fake.count("pm_getPaymasterData")).toBe(0);
    expect(report.network.deniedAttempts).toBe(1);
    expect(report.network.records.filter((r) => r.outcome === "denied")).toEqual([expect.objectContaining({ phase: "prepare", slot: "prepare.pimlico.stub", reason: "stub_repeat_blocked" })]);
    // The initial stub response WAS observed, successfully, and its shape is in the report.
    expect(report.network.records.find((r) => r.slot === "prepare.pimlico.stub" && r.outcome === "dispatched")).toMatchObject({ response: "result", httpStatus: 200 });
    expect(report.responseShapes["prepare.pimlico.stub"]).toMatchObject({ type: "object" });
    expect(Object.keys((report.responseShapes["prepare.pimlico.stub"] as { keys: object }).keys)).not.toContain("paymaster");
    // The guard stays tripped, so the post-run reads are not made.
    expect(report.postState).toEqual({});
    expect(report.prepared).toBeNull();
  });

  it("the interrupted stub-reentry report never claims L-1a rejected anything, is labeled SIMULATED, and carries no live-proof marker", async () => {
    const { report } = await simulate({ stubOmit: ["paymaster"] });
    const printed = printableReport(report);
    expect(printed).toContain("SIMULATED INCONCLUSIVE (offline fakes; NOT provider evidence)");
    expect(printed).not.toMatch(/LIVE /);
    expect(report.simulated).toBe(true);
    expect(report.evidenceKind).toBe("simulated-offline-self-test");
    expect(report.verdict).not.toBe("FAIL-COMPAT");
    expect(report.verdict).not.toBe("PASS");
    for (const claim of ["l1a_structural_integrity_refused_honest_answers", "calldata_binding_refused_honest_answers", "PreparedUserOperationIntegrityError", "PreparedCallDataMismatchError"]) expect(JSON.stringify(report)).not.toContain(claim);
    expect(report.reasons).toContain("l1a_validation_not_reached");
    expectNoLeak(printed);
  });

  it("an extra denied attempt recorded in the same run as the stub repeat withholds the diagnostic: INCONCLUSIVE, additional_denied_requests, nothing more dispatched", async () => {
    // The guard aborts the (already answered) first stub request's signal synchronously when it trips on the repeat; an
    // attempt made from that handler is therefore denied as already_tripped BEFORE the run is sealed and snapshotted.
    const extra = () => void fetch(CHAIN_HREF, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }) }).catch(() => undefined);
    const { report, fake } = await simulate({
      stubOmit: ["paymaster"],
      onStubRequest: (init) => init?.signal?.addEventListener("abort", extra, { once: true }),
    });
    expect(report.network.trips).toEqual(["stub_repeat_blocked"]);
    expect(report.network.deniedAttempts).toBe(2);
    expect(report.network.records.filter((r) => r.outcome === "denied").map((r) => (r as { reason: string }).reason).sort()).toEqual(["already_tripped", "stub_repeat_blocked"]);
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.reasons).toEqual(expect.arrayContaining(["guard:stub_repeat_blocked", "stub_repeat_unexplained", "additional_denied_requests"]));
    for (const withheld of ["stub_response_lacked_paymaster", "initial_stub_response_observed", "l1a_validation_not_reached"]) expect(report.reasons).not.toContain(withheld);
    expect(fake.count("pm_getPaymasterStubData")).toBe(1);
    expect(fake.count("eth_chainId")).toBe(1); // the pre-phase read only; the extra attempt never left the guard
  });

  it("an extra FORBIDDEN-method attempt while the stub repeat is still in flight of the same preparation is FAIL-SAFETY", async () => {
    const { report } = await simulate({ stubOmit: ["paymaster"] }, {
      deps: {
        ...DEPS,
        pimlico: {
          ...pimlico,
          prepareCashTransferUserOperation: async (args) => {
            await fetch(PIMLICO_HREF, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [] }) }).catch(() => undefined);
            return pimlico.prepareCashTransferUserOperation(args);
          },
        },
      },
    });
    expect(report.verdict).toBe("FAIL-SAFETY");
    expect(report.reasons).toEqual(["guard:forbidden_method"]);
    expect(report.reasons).not.toContain("l1a_validation_not_reached");
  });

  it("an otherwise-valid stub repeat after a stub answer that DID carry a paymaster is unexplained: INCONCLUSIVE (never FAIL-SAFETY, FAIL-COMPAT or PASS), never dispatched", async () => {
    const { report, fake } = await simulate({}, {
      deps: (backendInUse) => ({
        ...DEPS,
        pimlico: {
          ...pimlico,
          prepareCashTransferUserOperation: async (args) => {
            await pimlico.prepareCashTransferUserOperation(args);
            const stub = backendInUse.calls.find((c) => c.method === "pm_getPaymasterStubData")!;
            await fetch(PIMLICO_HREF, { method: "POST", headers: { "content-type": "application/json" }, body: String(stub.init?.body) });
            throw new Error("unreachable");
          },
        },
      }),
    });
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.reasons).toEqual(expect.arrayContaining(["guard:stub_repeat_blocked", "stub_repeat_unexplained", "preparation_aborted_by_guard"]));
    expect(report.reasons).not.toContain("stub_response_lacked_paymaster");
    expect(report.reasons).not.toContain("l1a_validation_not_reached");
    expect(report.network.trips).toEqual(["stub_repeat_blocked"]);
    expect(fake.count("pm_getPaymasterStubData")).toBe(1);
  });

  it.each([
    ["HTTP 503 on the estimate", "eth_estimateUserOperationGas", { status: 503, result: null }],
    ["HTTP 429 with Retry-After: 1 on the gas price", "pimlico_getUserOperationGasPrice", { status: 429, headers: { "retry-after": "1" }, result: null }],
    ["a retryable JSON-RPC error on the stub", "pm_getPaymasterStubData", { error: { code: -32603, message: PROVIDER_SECRET_TEXT } }],
  ])("%s: viem's retry is blocked before dispatch, the request went out once, INCONCLUSIVE", async (_label, method, answer) => {
    const { report, fake } = await simulate({ override: { [method]: () => answer as Answer } });
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.reasons).toContain("guard:library_retry_blocked");
    expect(fake.count(method)).toBe(1);
    expectNoLeak(printableReport(report));
  });

  it("a non-retryable JSON-RPC error: INCONCLUSIVE (unclassified preparation error), the provider's message nowhere in the report", async () => {
    const { report, fake } = await simulate({ override: { eth_estimateUserOperationGas: () => ({ error: { code: -32602, message: PROVIDER_SECRET_TEXT } }) } });
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.preparation.outcome).toBe("other_error");
    expect(report.network.records.find((r) => r.slot === "prepare.pimlico.estimate")).toMatchObject({ response: "rpc_error", rpcErrorCode: -32602 });
    expect(fake.count("eth_estimateUserOperationGas")).toBe(1);
    expectNoLeak(JSON.stringify(report));
  });

  it("a provider that hangs: the 60 s-style wall clock (shortened here) trips, in-flight work is aborted, INCONCLUSIVE", async () => {
    const { report } = await simulate({ override: { eth_estimateUserOperationGas: () => ({ hang: true }) } }, { wallClockMs: 400 });
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.reasons).toContain("guard:wall_clock_exceeded");
    expect(report.preparation.outcome).toBe("aborted_by_guard");
    expect(report.postState).toEqual({});
  });

  it.each([
    ["the wrong chain", { chainId: 8453 }, "chain_id_is_base_sepolia"],
    ["no EntryPoint code", { entryPointCode: "0x" as Hex }, "entry_point_has_code"],
    ["an undeployed Safe (Scenario B is deferred)", { safeCode: "0x" as Hex }, "safe_is_deployed"],
    ["another owner", { owners: [RECIPIENT] }, "single_expected_owner"],
    ["two owners", { owners: [OWNER, RECIPIENT] }, "single_expected_owner"],
    ["threshold 2", { threshold: BigInt(2) }, "threshold_is_one"],
    ["too little Cash", { balance: BigInt(9_999) }, "cash_balance_covers_amount"],
  ])("precondition: %s stops the run before Pimlico is contacted (INCONCLUSIVE)", async (_label, chain, precondition) => {
    const { report, fake } = await simulate({ chain });
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.reasons).toContain(`precondition_failed:${precondition}`);
    expect(report.network.totals.pimlico).toBe(0);
    expect(fake.calls.some((c) => c.endpoint === "pimlico")).toBe(false);
    expect(report.preparation.outcome).toBe("not_run");
  });

  it("a Safe that does not derive from the owner is refused before Pimlico", async () => {
    const other = getAddress("0x4444444444444444444444444444444444444444");
    const { report } = await simulate({}, { inputs: inputs({ safe: other }) });
    expect(report.verdict).toBe("INCONCLUSIVE");
    expect(report.reasons).toContain("precondition_failed:safe_derives_from_owner");
    expect(report.network.totals.pimlico).toBe(0);
  });

  it.each([
    ["Cash balance", { postBalance: BigInt(4_000_000) }, "cash_balance_unchanged"],
    ["EntryPoint nonce", { postNonceSeq: BigInt(8) }, "entry_point_nonce_unchanged"],
    ["Safe code", { postSafeCode: "0x60806040" as Hex }, "safe_code_unchanged"],
  ])("changed post-run %s: FAIL-SAFETY", async (_label, chain, field) => {
    const { report } = await simulate({ chain });
    expect(report.verdict).toBe("FAIL-SAFETY");
    expect(report.reasons).toContain(`post_state_changed:${field}`);
  });

  it("a result production accepted but that does not carry the authorized intent fails the independent checks: FAIL-SAFETY", async () => {
    const tampered: ProductionDeps = {
      ...DEPS,
      pimlico: {
        ...pimlico,
        prepareCashTransferUserOperation: async (args) => ({ ...(await pimlico.prepareCashTransferUserOperation(args)), callData: encodeExpectedCallData(getAddress("0x5555555555555555555555555555555555555555"), BigInt(AMOUNT)) }),
      },
    };
    const { report } = await simulate({}, { deps: tampered });
    expect(report.verdict).toBe("FAIL-SAFETY");
    expect(report.reasons).toEqual(expect.arrayContaining(["check_failed:calldata_matches_independent_encoding", "check_failed:recipient_matches"]));
  });

  it.each([
    ["a forbidden send method", () => fetch(PIMLICO_HREF, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [] }) }), "forbidden_method"],
    ["a broadcast on the chain RPC", () => fetch(CHAIN_HREF, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x00"] }) }), "forbidden_method"],
    ["an off-list host (CCIP-style lookup)", () => fetch("https://ccip.offchain.example/lookup", { method: "POST", body: "{}" }), "forbidden_host"],
    ["a WebSocket", async () => new ((globalThis as Record<string, unknown>).WebSocket as new (u: string) => unknown)("wss://evil.example"), "egress_api_blocked"],
  ])("a preparation that attempts %s is stopped before dispatch: FAIL-SAFETY", async (_label, attempt, trip) => {
    const rogue: ProductionDeps = {
      ...DEPS,
      pimlico: {
        ...pimlico,
        prepareCashTransferUserOperation: async () => {
          await attempt();
          throw new Error("unreachable");
        },
      },
    };
    const { report, fake } = await simulate({}, { deps: rogue });
    expect(report.verdict).toBe("FAIL-SAFETY");
    expect(report.reasons).toContain(`guard:${trip}`);
    expect(fake.calls.some((c) => /send/i.test(c.method))).toBe(false);
    expect(fake.calls.some((c) => c.endpoint === "pimlico")).toBe(false);
  });

  it("mode/transport pairing is refused before anything is installed or dispatched", async () => {
    const fake = backend();
    const base = { inputs: inputs(), loadDeps: async () => DEPS };
    const genuine = requireLiveAuthorization({
      env: {
        [GATE_ENV]: GATE_VALUE,
        [INPUT_ENV.safe]: SAFE,
        [INPUT_ENV.owner]: OWNER,
        [INPUT_ENV.recipient]: RECIPIENT,
        [INPUT_ENV.amount]: AMOUNT,
        [INPUT_ENV.chainRpcUrl]: CHAIN_URL,
        [INPUT_ENV.pimlicoApiKey]: PIMLICO_KEY,
        [INPUT_ENV.confirmation]: expectedConfirmation({ safe: SAFE, recipient: RECIPIENT, amountBaseUnits: AMOUNT }),
      },
      cliArgs: ["run", RUNNER_FILE],
    });
    await expect(observeCompatibility({ ...base, mode: "live", authorization: genuine, inputs: genuine.inputs, underlyingFetch: fake.fetch })).rejects.toThrow(/platform fetch/);
    await expect(observeCompatibility({ ...base, mode: "live", underlyingFetch: fake.fetch })).rejects.toThrow(/authorization issued/);
    await expect(observeCompatibility({ ...base, mode: "live", authorization: { kind: "live-authorization", inputs: inputs() }, underlyingFetch: fake.fetch })).rejects.toThrow(/authorization issued/);
    await expect(observeCompatibility({ ...base, mode: "simulated", authorization: genuine, underlyingFetch: fake.fetch })).rejects.toThrow(/must not carry/);
    await expect(observeCompatibility({ ...base, mode: "simulated", underlyingFetch: PLATFORM_FETCH })).rejects.toThrow(/never the platform fetch/);
    await expect(observeCompatibility({ ...base, mode: "simulated", inputs: inputs({ recipient: OWNER }), underlyingFetch: fake.fetch })).rejects.toBeInstanceOf(CompatRefusal);
    expect(fake.calls).toHaveLength(0);
    expect(globalThis.fetch).toBe(sentinel);
  });

  it("observationPairingProblem (pure, never calls the transport): a live run needs its authorization, the platform fetch AND a passed live evidence preflight", async () => {
    const genuine = requireLiveAuthorization({
      env: {
        [GATE_ENV]: GATE_VALUE,
        [INPUT_ENV.safe]: SAFE,
        [INPUT_ENV.owner]: OWNER,
        [INPUT_ENV.recipient]: RECIPIENT,
        [INPUT_ENV.amount]: AMOUNT,
        [INPUT_ENV.chainRpcUrl]: CHAIN_URL,
        [INPUT_ENV.pimlicoApiKey]: PIMLICO_KEY,
        [INPUT_ENV.confirmation]: expectedConfirmation({ safe: SAFE, recipient: RECIPIENT, amountBaseUnits: AMOUNT }),
      },
      cliArgs: ["run", RUNNER_FILE],
    });
    const root = mkdtempSync(path.join(os.tmpdir(), "ocf-compat-selftest-pair-"));
    try {
      writeFileSync(path.join(root, ".gitignore"), "/evidence/\n");
      mkdirSync(path.join(root, "evidence"), { mode: 0o700 });
      const simulatedPlan = (preflightEvidence({ root, simulated: true }) as { plan: EvidencePlan }).plan;
      const forgedLive = { ...simulatedPlan, simulated: false } as EvidencePlan;
      const live = { mode: "live" as const, authorization: genuine, inputs: genuine.inputs, underlyingFetch: PLATFORM_FETCH };
      expect(observationPairingProblem({ ...live })).toMatch(/evidence preflight/);
      expect(observationPairingProblem({ ...live, evidencePlan: simulatedPlan })).toMatch(/evidence preflight/);
      expect(observationPairingProblem({ ...live, evidencePlan: forgedLive })).toMatch(/evidence preflight/);
      expect(observationPairingProblem({ ...live, underlyingFetch: backend().fetch, evidencePlan: simulatedPlan })).toMatch(/platform fetch/);
      const fake = backend().fetch;
      expect(observationPairingProblem({ mode: "simulated", inputs: inputs(), underlyingFetch: fake, evidencePlan: simulatedPlan })).toBeNull();
      expect(observationPairingProblem({ mode: "simulated", inputs: inputs(), underlyingFetch: fake })).toBeNull();
      expect(observationPairingProblem({ mode: "simulated", inputs: inputs(), underlyingFetch: fake, evidencePlan: forgedLive })).toMatch(/simulated evidence plan/);
      expect(observationPairingProblem({ mode: "other" as "simulated", inputs: inputs(), underlyingFetch: fake })).toMatch(/unknown/);
      // A simulated observation with a forged plan is refused before anything is installed or dispatched.
      const fakeBackend = backend();
      await expect(observeCompatibility({ mode: "simulated", inputs: inputs(), underlyingFetch: fakeBackend.fetch, evidencePlan: forgedLive, loadDeps: async () => DEPS })).rejects.toThrow(/simulated evidence plan/);
      expect(fakeBackend.calls).toHaveLength(0);
      expect(globalThis.fetch).toBe(sentinel);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("production constants that differ from the pinned values are refused before any request", async () => {
    const fake = backend();
    const drifted: ProductionDeps = { ...DEPS, constants: { ...constants, REAL_CASH_TOKEN: { ...constants.REAL_CASH_TOKEN, address: "0x1111111111111111111111111111111111111111" } } };
    const observing = observeCompatibility({ mode: "simulated", inputs: inputs(), underlyingFetch: fake.fetch, loadDeps: async () => drifted });
    await expect(observing).rejects.toThrow(/constants differ/);
    expect(fake.calls).toHaveLength(0);
    restoreTestGlobals();
    expect(globalThis.fetch).toBe(sentinel);
  });
});

// ---------------------------------------------------------------------------
// 13. Verdict classes
// ---------------------------------------------------------------------------

describe("verdict classification", () => {
  const clean: VerdictInput = { trips: [], preconditionFailures: [], stageFailures: [], preparation: "ok", prepareResponsesAllSuccessful: true, prepareDispatchedAllSuccessful: true, stubHadStringPaymaster: true, deniedRequests: [], independentCheckFailures: [], postStateChanges: [], evidenceComplete: true };
  const EXPECTED_DENIAL = [{ slot: "prepare.pimlico.stub", reason: "stub_repeat_blocked" }];
  /** What a blocked stub repeat after a paymaster-less stub looks like on its own: exactly the one expected denial. */
  const stubLacked: Partial<VerdictInput> = { trips: ["stub_repeat_blocked"], preparation: "aborted_by_guard", prepareResponsesAllSuccessful: false, stubHadStringPaymaster: false, deniedRequests: EXPECTED_DENIAL, evidenceComplete: false };
  const DIAGNOSTIC = ["stub_response_lacked_paymaster", "initial_stub_response_observed", "l1a_validation_not_reached"];
  it.each<[string, Partial<VerdictInput>, string, string[]]>([
    ["clean", {}, "PASS", []],
    ["integrity refusal of complete honest answers", { preparation: "integrity_error" }, "FAIL-COMPAT", ["l1a_structural_integrity_refused_honest_answers"]],
    ["callData refusal of complete honest answers", { preparation: "calldata_mismatch" }, "FAIL-COMPAT", ["calldata_binding_refused_honest_answers"]],
    ["integrity refusal after a failed answer", { preparation: "integrity_error", prepareResponsesAllSuccessful: false }, "INCONCLUSIVE", ["compat_refusal_after_unsuccessful_provider_answer"]],
    ["integrity refusal with incomplete evidence", { preparation: "integrity_error", evidenceComplete: false }, "INCONCLUSIVE", ["evidence_incomplete"]],
    ["a forbidden method", { trips: ["forbidden_method"] }, "FAIL-SAFETY", ["guard:forbidden_method"]],
    ["a budget breach beats a compat refusal", { trips: ["budget_exceeded"], preparation: "integrity_error" }, "FAIL-SAFETY", ["guard:budget_exceeded"]],
    ["an unexpected repeat", { trips: ["unexpected_repeat"] }, "FAIL-SAFETY", ["guard:unexpected_repeat"]],
    ["a redirect", { trips: ["redirect_refused"] }, "FAIL-SAFETY", ["guard:redirect_refused"]],
    ["a changed post state", { postStateChanges: ["cash_balance_unchanged"] }, "FAIL-SAFETY", ["post_state_changed:cash_balance_unchanged"]],
    ["an independent check breach", { independentCheckFailures: ["recipient_matches"] }, "FAIL-SAFETY", ["check_failed:recipient_matches"]],
    ["a blocked library retry", { trips: ["library_retry_blocked"], preparation: "aborted_by_guard", evidenceComplete: false }, "INCONCLUSIVE", ["guard:library_retry_blocked", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["the wall clock", { trips: ["wall_clock_exceeded"], preparation: "aborted_by_guard", evidenceComplete: false }, "INCONCLUSIVE", ["guard:wall_clock_exceeded", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["an oversized answer", { trips: ["response_too_large"] }, "INCONCLUSIVE", ["guard:response_too_large"]],
    ["a failed precondition", { preconditionFailures: ["safe_is_deployed"], preparation: "not_run", evidenceComplete: false }, "INCONCLUSIVE", ["precondition_failed:safe_is_deployed", "preparation_not_run", "evidence_incomplete"]],
    ["an unclassified preparation error", { preparation: "other_error", evidenceComplete: false }, "INCONCLUSIVE", ["preparation_error_unclassified", "evidence_incomplete"]],
    ["a failed read", { stageFailures: ["post_read_failed"], evidenceComplete: false }, "INCONCLUSIVE", ["post_read_failed", "evidence_incomplete"]],
    ["ok but incomplete evidence", { evidenceComplete: false }, "INCONCLUSIVE", ["evidence_incomplete"]],
    ["the interrupted stub reentry (one expected denial)", stubLacked, "INCONCLUSIVE", ["guard:stub_repeat_blocked", ...DIAGNOSTIC, "post_state_not_observed", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["the same, plus a safety trip", { ...stubLacked, trips: ["stub_repeat_blocked", "forbidden_method"] }, "FAIL-SAFETY", ["guard:forbidden_method"]],
    ["the same, plus an unexpected repeat", { ...stubLacked, trips: ["stub_repeat_blocked", "unexpected_repeat"] }, "FAIL-SAFETY", ["guard:unexpected_repeat"]],
    ["the same, plus a changed post state", { ...stubLacked, postStateChanges: ["cash_balance_unchanged"] }, "FAIL-SAFETY", ["post_state_changed:cash_balance_unchanged"]],
    ["the same, plus an independent check breach", { ...stubLacked, independentCheckFailures: ["sender_matches"] }, "FAIL-SAFETY", ["check_failed:sender_matches"]],
    ["the same, plus the wall clock", { ...stubLacked, trips: ["stub_repeat_blocked", "wall_clock_exceeded"] }, "INCONCLUSIVE", ["guard:stub_repeat_blocked", "guard:wall_clock_exceeded", "stub_repeat_unexplained", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["the same, after an unsuccessful dispatched answer", { ...stubLacked, prepareDispatchedAllSuccessful: false }, "INCONCLUSIVE", ["guard:stub_repeat_blocked", "stub_repeat_unexplained", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["the same, with a failed read", { ...stubLacked, stageFailures: ["pre_read_failed"] }, "INCONCLUSIVE", ["guard:stub_repeat_blocked", ...DIAGNOSTIC, "post_state_not_observed", "pre_read_failed", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["the same, with an unclassified preparation error", { ...stubLacked, preparation: "other_error" }, "INCONCLUSIVE", ["guard:stub_repeat_blocked", ...DIAGNOSTIC, "post_state_not_observed", "preparation_error_unclassified", "evidence_incomplete"]],
    ["the stub repeat after a stub that DID carry a paymaster", { ...stubLacked, stubHadStringPaymaster: true }, "INCONCLUSIVE", ["guard:stub_repeat_blocked", "stub_repeat_unexplained", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["the stub repeat with no successful stub answer on record", { ...stubLacked, stubHadStringPaymaster: null }, "INCONCLUSIVE", ["guard:stub_repeat_blocked", "stub_repeat_unexplained", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["an additional already_tripped denial", { ...stubLacked, deniedRequests: [...EXPECTED_DENIAL, { slot: null, reason: "already_tripped" }] }, "INCONCLUSIVE", ["guard:stub_repeat_blocked", "stub_repeat_unexplained", "additional_denied_requests", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["a second already_tripped stub denial", { ...stubLacked, deniedRequests: [...EXPECTED_DENIAL, { slot: "prepare.pimlico.stub", reason: "already_tripped" }] }, "INCONCLUSIVE", ["guard:stub_repeat_blocked", "stub_repeat_unexplained", "additional_denied_requests", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["no denied record at all (trip list alone is not trusted)", { ...stubLacked, deniedRequests: [] }, "INCONCLUSIVE", ["guard:stub_repeat_blocked", "stub_repeat_unexplained", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["one denial on the wrong slot", { ...stubLacked, deniedRequests: [{ slot: "prepare.pimlico.gasPrice", reason: "stub_repeat_blocked" }] }, "INCONCLUSIVE", ["guard:stub_repeat_blocked", "stub_repeat_unexplained", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["one denial with the wrong reason", { ...stubLacked, deniedRequests: [{ slot: "prepare.pimlico.stub", reason: "already_tripped" }] }, "INCONCLUSIVE", ["guard:stub_repeat_blocked", "stub_repeat_unexplained", "preparation_aborted_by_guard", "evidence_incomplete"]],
    ["a paymaster-less stub flag with no stub-repeat trip (no diagnostic is attached)", { ...stubLacked, trips: [], deniedRequests: [] }, "INCONCLUSIVE", ["preparation_aborted_by_guard", "evidence_incomplete"]],
    ["an incomplete observation can never PASS (preparation ok, evidence incomplete)", { evidenceComplete: false, stubHadStringPaymaster: false, deniedRequests: [] }, "INCONCLUSIVE", ["evidence_incomplete"]],
    ["a genuine L-1a rejection of complete honest answers is still FAIL-COMPAT", { preparation: "integrity_error", stubHadStringPaymaster: true }, "FAIL-COMPAT", ["l1a_structural_integrity_refused_honest_answers"]],
    ["a genuine callData-binding rejection is still FAIL-COMPAT", { preparation: "calldata_mismatch" }, "FAIL-COMPAT", ["calldata_binding_refused_honest_answers"]],
  ])("%s -> %s", (_label, over, verdict, reasons) => {
    expect(classifyVerdict({ ...clean, ...over })).toEqual({ verdict, reasons });
  });
});

// ---------------------------------------------------------------------------
// 12. Shape classification
// ---------------------------------------------------------------------------

describe("shape classification never carries a value", () => {
  it.each<[unknown, unknown]>([
    [null, { type: "null" }],
    [undefined, { type: "undefined" }],
    [true, { type: "boolean", value: true }],
    [1.5, { type: "number", integer: false }],
    [BigInt(3), { type: "bigint" }],
    ["hello " + PROVIDER_SECRET_TEXT, { type: "string", length: 6 + PROVIDER_SECRET_TEXT.length, hex: null }],
    ["0x", { type: "string", length: 2, hex: { evenLength: true, letterCase: "none", byteLength: 0, quantityBits: null, leadingZero: false, address: null } }],
    ["0x0", { type: "string", length: 3, hex: { evenLength: false, letterCase: "none", byteLength: null, quantityBits: 0, leadingZero: false, address: null } }],
    ["0x00ff", { type: "string", length: 6, hex: { evenLength: true, letterCase: "lower", byteLength: 2, quantityBits: 8, leadingZero: true, address: null } }],
    ["0xABC", { type: "string", length: 5, hex: { evenLength: false, letterCase: "upper", byteLength: null, quantityBits: 12, leadingZero: false, address: null } }],
    ["0xgg", { type: "string", length: 4, hex: null }],
  ])("describeShape case %#", (value, shape) => {
    expect(describeShape(value)).toEqual(shape);
  });

  it("classifies address case without keeping the address", () => {
    const lettered = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    expect(describeHex(lettered)?.address).toBe("lowercase");
    expect(describeHex(`0x${lettered.slice(2).toUpperCase()}`)?.address).toBe("uppercase");
    expect(describeHex(PAYMASTER)?.address).toBe("lowercase"); // digits only: no letter case to classify
    expect(describeHex(OWNER)?.address).toBe("checksummed");
    expect(describeHex(OWNER.replace(/[a-f]/, (c) => c.toUpperCase()))?.address).toBe("mixed-invalid");
    expect(JSON.stringify(describeShape({ paymaster: OWNER }))).not.toContain(OWNER.slice(2, 12));
  });

  it("objects keep sorted safe key names only (unsafe keys masked, depth and width bounded); arrays keep length", () => {
    const shape = describeShape({ b: "0x01", a: [1, 2, 3, 4, 5, 6], [`${PROVIDER_SECRET_TEXT} key`]: 1, nested: { deeper: { deepest: { gone: 1 } } } });
    expect(JSON.stringify(shape)).not.toContain(PROVIDER_SECRET_TEXT);
    expect(shape).toMatchObject({ type: "object", keyCount: 4 });
    const keys = Object.keys((shape as { keys: Record<string, unknown> }).keys);
    expect(keys).toEqual(["<unsafe-key>", "a", "b", "nested"]);
    expect((shape as { keys: Record<string, { type: string; length?: number; items?: unknown[] }> }).keys.a).toMatchObject({ type: "array", length: 6 });
    expect(JSON.stringify(describeShape({ x: { y: { z: { w: 1 } } } }))).toContain('"keys":{}');
  });
});

// ---------------------------------------------------------------------------
// 10-11. Redaction
// ---------------------------------------------------------------------------

describe("redaction: no key, URL, address, callData, paymasterData or provider text in any report or printout", () => {
  it("across PASS, FAIL-COMPAT, INCONCLUSIVE and FAIL-SAFETY observations", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))));
    try {
      const runs = [
        await simulate(),
        await simulate({ stubExtra: { paymaster: "0x0000000000000000000000000000000000000000" }, finalExtra: { paymaster: "0x0000000000000000000000000000000000000000" } }),
        await simulate({ override: { eth_estimateUserOperationGas: () => ({ error: { code: -32602, message: PROVIDER_SECRET_TEXT } }) } }),
        await simulate({ override: { pm_getPaymasterStubData: () => ({ status: 500, result: PROVIDER_SECRET_TEXT }) } }),
        await simulate({ chain: { postBalance: BigInt(1) } }),
      ];
      expect(runs.map((r) => r.report.verdict)).toEqual(["PASS", "FAIL-COMPAT", "INCONCLUSIVE", "INCONCLUSIVE", "FAIL-SAFETY"]);
      for (const { report } of runs) {
        expectNoLeak(JSON.stringify(report));
        expectNoLeak(printableReport(report));
      }
      // The observation itself prints nothing.
      expect(logs).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("the leak detector is case-insensitive and printableReport refuses reports this harness did not produce", () => {
    expect(findsLeak(`x ${PIMLICO_KEY.toUpperCase()} y`, [PIMLICO_KEY])).toBe(true);
    expect(findsLeak("nothing here", [PIMLICO_KEY])).toBe(false);
    expect(printableReport({ verdict: "PASS", simulated: false } as CompatReport)).toMatch(/withheld/);
  });

  it("inputsProblem never names a value", () => {
    for (const bad of [inputs({ chainRpcUrl: "http://x.invalid/SYNTHETIC" }), inputs({ pimlicoApiKey: "SYN" }), inputs({ amountBaseUnits: "99999999" })]) {
      const message = inputsProblem(bad)!;
      expect(message).toBeTruthy();
      expect(message).not.toMatch(/SYNTHETIC|SYN\b|99999999|x\.invalid/);
    }
  });
});

// ---------------------------------------------------------------------------
// 18. Evidence
// ---------------------------------------------------------------------------

describe("evidence: read-only preflight before any request; one 0600 file, only after a verdict, only in a verified ignored directory", () => {
  const roots: string[] = [];
  type RootOpts = { gitignore?: string | null; evidence?: "dir" | "symlink" | "none" | "file" };
  const tempRoot = (opts: RootOpts = {}) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ocf-compat-selftest-"));
    roots.push(root);
    if (opts.gitignore !== null) writeFileSync(path.join(root, ".gitignore"), opts.gitignore ?? "node_modules\n/evidence/\n");
    const kind = opts.evidence ?? "dir";
    if (kind === "dir") mkdirSync(path.join(root, "evidence"), { mode: 0o700 });
    if (kind === "file") writeFileSync(path.join(root, "evidence"), "");
    if (kind === "symlink") {
      mkdirSync(path.join(root, "elsewhere"));
      symlinkSync(path.join(root, "elsewhere"), path.join(root, "evidence"));
    }
    return root;
  };
  /** Every entry under a temp root (recursively), so a test can prove a preflight created nothing. */
  const listing = (root: string): string[] =>
    readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(root, entry.name);
      return entry.isDirectory() && !entry.isSymbolicLink() ? [entry.name, ...listing(full).map((child) => path.join(entry.name, child))] : [entry.name];
    });
  const plan = (root: string, runId?: string): EvidencePlan => {
    const result = preflightEvidence({ root, simulated: true, runId });
    if (!result.ok) throw new Error(`expected a passing preflight, got ${result.reason}`);
    return result.plan;
  };
  afterAll(() => {
    for (const root of roots) {
      const evidence = path.join(root, "evidence");
      if (existsSync(evidence) && !lstatSync(evidence).isSymbolicLink()) chmodSync(evidence, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each<[string, RootOpts, string]>([
    ["no .gitignore", { gitignore: null }, "evidence_directory_not_ignored"],
    ["a .gitignore without /evidence/", { gitignore: "node_modules\nevidence-old/\n" }, "evidence_directory_not_ignored"],
    ["a .gitignore that re-includes part of it", { gitignore: "/evidence/\n!/evidence/keep.json\n" }, "evidence_directory_not_ignored"],
    ["no evidence directory", { evidence: "none" }, "evidence_directory_missing"],
    ["an evidence symlink", { evidence: "symlink" }, "evidence_directory_not_a_real_directory"],
    ["an evidence FILE", { evidence: "file" }, "evidence_directory_not_a_real_directory"],
  ])("preflight refuses with %s, creating nothing", (_label, opts, reason) => {
    const root = tempRoot(opts);
    const before = listing(root);
    expect(preflightEvidence({ root, simulated: true })).toEqual({ ok: false, reason });
    expect(listing(root)).toEqual(before);
  });

  it("preflight refuses an evidence directory whose real path is not <repository>/evidence", () => {
    const root = tempRoot();
    const elsewhere = tempRoot();
    const redirected: EvidenceFs = { ...NODE_EVIDENCE_FS, realpathSync: (file) => NODE_EVIDENCE_FS.realpathSync(file === path.join(root, "evidence") ? path.join(elsewhere, "evidence") : file) };
    expect(preflightEvidence({ root, simulated: true, fs: redirected })).toEqual({ ok: false, reason: "evidence_directory_outside_repository" });
    expect(preflightEvidence({ root, simulated: true }).ok).toBe(true);
  });

  it("preflight refuses an evidence directory that is group/world-writable or not writable by this user, creating nothing", () => {
    const loose = tempRoot();
    chmodSync(path.join(loose, "evidence"), 0o777);
    expect(preflightEvidence({ root: loose, simulated: true })).toEqual({ ok: false, reason: "evidence_directory_permissions_unsafe" });
    const locked = tempRoot();
    chmodSync(path.join(locked, "evidence"), 0o500);
    try {
      expect(preflightEvidence({ root: locked, simulated: true })).toEqual({ ok: false, reason: "evidence_directory_not_writable" });
      expect(readdirSync(path.join(locked, "evidence"))).toEqual([]);
    } finally {
      chmodSync(path.join(locked, "evidence"), 0o700);
    }
    const foreign: EvidenceFs = { ...NODE_EVIDENCE_FS, lstatSync: (file) => ({ ...NODE_EVIDENCE_FS.lstatSync(file), isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false, uid: (process.getuid?.() ?? 0) + 1 }) };
    expect(preflightEvidence({ root: tempRoot(), simulated: true, fs: foreign })).toEqual({ ok: false, reason: "evidence_directory_not_owned_by_this_user" });
  });

  it("preflight refuses an output name that already exists (file or link) — evidence is never overwritten", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, "evidence", "pimlico-prepare-compat-0badc0de-SIMULATED.json"), "{}");
    symlinkSync(path.join(root, "nowhere"), path.join(root, "evidence", "pimlico-prepare-compat-0000beef-SIMULATED.json"));
    expect(preflightEvidence({ root, simulated: true, runId: "0badc0de" })).toEqual({ ok: false, reason: "evidence_file_already_exists" });
    expect(preflightEvidence({ root, simulated: true, runId: "0000beef" })).toEqual({ ok: false, reason: "evidence_file_already_exists" });
    expect(readFileSync(path.join(root, "evidence", "pimlico-prepare-compat-0badc0de-SIMULATED.json"), "utf8")).toBe("{}");
  });

  it("preflight placement and identity rules: simulated never in the repository, live only there, a well-formed run id, no injected filesystem for live", () => {
    expect(preflightEvidence({ root: process.cwd(), simulated: true })).toEqual({ ok: false, reason: "simulated_report_refused_in_repository" });
    expect(preflightEvidence({ root: tempRoot(), simulated: false })).toEqual({ ok: false, reason: "live_evidence_only_in_repository" });
    expect(preflightEvidence({ root: process.cwd(), simulated: false, fs: NODE_EVIDENCE_FS })).toEqual({ ok: false, reason: "live_evidence_custom_fs_refused" });
    expect(preflightEvidence({ root: tempRoot(), simulated: true, runId: "../../x" })).toEqual({ ok: false, reason: "run_id_malformed" });
  });

  it("a passing preflight creates nothing, writes nothing and touches no network; it fixes the run id the observation then carries", async () => {
    const root = tempRoot();
    const before = listing(root);
    const passed = preflightEvidence({ root, simulated: true });
    expect(passed.ok).toBe(true);
    const issued = (passed as { plan: EvidencePlan }).plan;
    expect(Object.isFrozen(issued)).toBe(true);
    expect(listing(root)).toEqual(before);
    expect(globalThis.fetch).toBe(sentinel);
    const { report } = await simulate({}, { evidencePlan: issued });
    expect(report.runId).toBe(issued.runId);
  });

  it("the source of the preflight path holds no create/write/remove call (read-only by construction)", () => {
    const source = readFileSync(RUNNER_FILE, "utf8");
    const preflight = source.slice(source.indexOf("function evidenceDestinationProblem("), source.indexOf("export function writeEvidence("));
    expect(preflight.length).toBeGreaterThan(500);
    expect(preflight).not.toMatch(/openSync|writeFileSync|mkdir|unlinkSync|rmSync|renameSync|copyFile|appendFile|chmod|fetch\(/);
  });

  it("writeEvidence refuses a report the harness did not produce and a forged or mismatched plan, writing nothing", async () => {
    const root = tempRoot();
    const { report } = await simulate();
    expect(writeEvidence({ report: { simulated: true, runId: "00000000" } as CompatReport, plan: plan(root) })).toEqual({ ok: false, reason: "report_not_from_harness" });
    expect(writeEvidence({ report, plan: { kind: "evidence-plan", simulated: true, root, runId: report.runId, file: path.join(root, "evidence", "x.json") } })).toEqual({ ok: false, reason: "evidence_plan_not_from_preflight" });
    expect(writeEvidence({ report, plan: plan(root) })).toEqual({ ok: false, reason: "evidence_plan_mismatch" });
    expect(readdirSync(path.join(root, "evidence"))).toEqual([]);
  });

  it("a valid temporary root gets exactly one SIMULATED file, mode 0600, leak-free; a second write never overwrites it", async () => {
    const root = tempRoot();
    const issued = plan(root);
    const { report } = await simulate({ stubExtra: { paymaster: "0x0000000000000000000000000000000000000000" }, finalExtra: { paymaster: "0x0000000000000000000000000000000000000000" } }, { evidencePlan: issued });
    const written = writeEvidence({ report, plan: issued });
    expect(written).toEqual({ ok: true, file: path.join("evidence", `pimlico-prepare-compat-${report.runId}-SIMULATED.json`) });
    const file = path.join(root, (written as { file: string }).file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text)).toMatchObject({ simulated: true, evidenceKind: "simulated-offline-self-test", verdict: "FAIL-COMPAT" });
    expectNoLeak(text);
    expect(writeEvidence({ report, plan: issued })).toEqual({ ok: false, reason: "evidence_file_already_exists" });
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(readdirSync(path.join(root, "evidence"))).toHaveLength(1);
  });

  it("the final write re-checks the destination: a directory made unwritable after the preflight is refused with nothing written", async () => {
    const root = tempRoot();
    const issued = plan(root);
    const { report } = await simulate({}, { evidencePlan: issued });
    chmodSync(path.join(root, "evidence"), 0o500);
    try {
      expect(writeEvidence({ report, plan: issued })).toEqual({ ok: false, reason: "evidence_directory_not_writable" });
    } finally {
      chmodSync(path.join(root, "evidence"), 0o700);
    }
    expect(readdirSync(path.join(root, "evidence"))).toEqual([]);
  });

  it("a write that fails after the file was created removes that file and reports a fixed reason (no filesystem text)", async () => {
    const root = tempRoot();
    const issued = plan(root);
    const { report } = await simulate({}, { evidencePlan: issued });
    const failing: EvidenceFs = {
      ...NODE_EVIDENCE_FS,
      writeFileSync: () => {
        throw new Error(`ENOSPC: no space left on device, write ${root}`);
      },
    };
    const result = writeEvidence({ report, plan: issued, fs: failing });
    expect(result).toEqual({ ok: false, reason: "evidence_write_failed" });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(readdirSync(path.join(root, "evidence"))).toEqual([]);
  });

  it("a created file whose mode is not 0600 is removed BEFORE any content is written into it", async () => {
    const root = tempRoot();
    const issued = plan(root);
    const { report } = await simulate({}, { evidencePlan: issued });
    const writes = vi.fn(NODE_EVIDENCE_FS.writeFileSync);
    const loose: EvidenceFs = { ...NODE_EVIDENCE_FS, writeFileSync: writes, fstatSync: (fd) => ({ ...NODE_EVIDENCE_FS.fstatSync(fd), isFile: () => true, mode: 0o100644 }) };
    expect(writeEvidence({ report, plan: issued, fs: loose })).toEqual({ ok: false, reason: "evidence_mode_not_0600" });
    expect(writes).not.toHaveBeenCalled();
    expect(readdirSync(path.join(root, "evidence"))).toEqual([]);
  });

  it("a cleanup that also fails says so, with a fixed reason", async () => {
    const root = tempRoot();
    const issued = plan(root);
    const { report } = await simulate({}, { evidencePlan: issued });
    const stuck: EvidenceFs = {
      ...NODE_EVIDENCE_FS,
      writeFileSync: () => {
        throw new Error("EIO");
      },
      unlinkSync: () => {
        throw new Error("EPERM");
      },
    };
    expect(writeEvidence({ report, plan: issued, fs: stuck })).toEqual({ ok: false, reason: "evidence_write_failed_and_cleanup_failed" });
  });

  it("a live run passes only with a PASS verdict AND its evidence written; a failed write fails it (fixed codes only)", () => {
    expect(liveRunResult({ verdict: "PASS" }, { ok: true, file: "evidence/x.json" })).toEqual({ verdict: "PASS", evidence: "written" });
    expect(liveRunResult({ verdict: "PASS" }, { ok: false, reason: "evidence_write_failed" })).not.toEqual({ verdict: "PASS", evidence: "written" });
    expect(liveRunResult({ verdict: "PASS" }, { ok: false, reason: "evidence_write_failed" })).toEqual({ verdict: "PASS", evidence: "not_written:evidence_write_failed" });
    expect(liveRunResult({ verdict: "FAIL-COMPAT" }, { ok: true, file: "evidence/x.json" })).not.toEqual({ verdict: "PASS", evidence: "written" });
  });
});

// ---------------------------------------------------------------------------
// One attempt only: no automatic retry or repeat of the live observation
// ---------------------------------------------------------------------------

describe("one attempt only: the live observation is never retried or repeated automatically", () => {
  it("the live test pins retry and repeats to 0 beside its timeout", () => {
    expect(LIVE_TEST_OPTIONS).toEqual({ timeout: 120_000, retry: 0, repeats: 0 });
    expect(Object.isFrozen(LIVE_TEST_OPTIONS)).toBe(true);
  });

  it("the installed Vitest 4.1.11 lets a test's own retry/repeats win over config, CLI, suite and tags (pinned source; a change needs a new review)", () => {
    expect(JSON.parse(readFileSync("node_modules/vitest/package.json", "utf8")).version).toBe("4.1.11");
    const runnerDir = path.join(path.dirname(realpathSync("node_modules/vitest")), "..", "..", "@vitest+runner@4.1.11", "node_modules", "@vitest", "runner", "dist");
    const source = readFileSync(path.join(runnerDir, "chunk-artifact.js"), "utf8");
    expect(source).toContain("retry: options.retry ?? runner.config.retry,");
    expect(source).toContain("repeats: options.repeats,");
    expect(source).toContain("...tagsOptions,\n\t\t\t...options");
    expect(source).toContain("options = Object.assign({}, suiteOptions, options);");
    expect(source).toContain("const repeats = test.repeats ?? 0;");
    expect(source).toContain("const retry = getRetryCount(test.retry);");
    // The old third-argument options form now throws, so the options must be the second argument.
    expect(source).toContain('Signature "test(name, fn, { ... })" was deprecated in Vitest 3 and removed in Vitest 4.');
  });

  it.each<[string, Parameters<typeof automaticRerunProblem>[0], RegExp | null]>([
    ["retry 0, repeats 0", { retry: 0, repeats: 0, result: { retryCount: 0, repeatCount: 0 } }, null],
    ["nothing set", {}, null],
    ["retry { count: 0 }", { retry: { count: 0 } }, null],
    ["retry {}", { retry: {} }, null],
    ["retry 1", { retry: 1 }, /automatic test retries/],
    ["retry { count: 2 }", { retry: { count: 2 } }, /automatic test retries/],
    ["retry '1'", { retry: "1" }, /automatic test retries/],
    ["retry -1", { retry: -1 }, /automatic test retries/],
    ["repeats 1", { repeats: 1 }, /test repeats/],
    ["a retried attempt", { retry: 0, result: { retryCount: 1 } }, /repeated attempt/],
    ["a repeated attempt", { retry: 0, result: { repeatCount: 1 } }, /repeated attempt/],
  ])("automaticRerunProblem: %s", (_label, task, expected) => {
    const problem = automaticRerunProblem(task);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toMatch(expected);
  });

  it("the one-shot latch: the first claim passes, every later claim in the process is refused", () => {
    const latch = createAttemptLatch();
    expect(latch.claimed()).toBe(false);
    latch.claim();
    expect(latch.claimed()).toBe(true);
    expect(() => latch.claim()).toThrow(CompatRefusal);
    expect(() => latch.claim()).toThrow(/second live attempt/);
  });

  it.concurrent(
    "child run of the runner with --retry=3 and a wrong gate: attempted exactly ONCE (no second-attempt refusal), fails before any network",
    async () => {
      const before = ourEvidenceFiles();
      const result = await runChild([RUNNER, "--retry=3"], { [GATE_ENV]: "1" });
      expect(result.code, summary(result.output)).not.toBe(0);
      expect(summary(result.output)).toMatch(/^1 failed \(1\)/);
      expect(result.output).toContain("is not the exact authorization phrase");
      expect(result.output).not.toMatch(/second live attempt|automatic test retries|repeated attempt|retry x/);
      expect(result.output).not.toMatch(REACHED_NETWORK);
      expect(ourEvidenceFiles()).toBe(before);
    },
    CHILD_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 14. Read-only owner
// ---------------------------------------------------------------------------

describe("the owner stand-in the harness uses cannot sign", () => {
  it.each(["sign", "signMessage", "signTransaction", "signTypedData", "signAuthorization"] as const)("%s() rejects", async (method) => {
    const owner = safeModule.createReadOnlyOwnerAccount(OWNER) as unknown as Record<string, (arg: unknown) => Promise<unknown>>;
    await expect(owner[method]!({})).rejects.toThrow(/read-only owner account/);
  });
});

// ---------------------------------------------------------------------------
// 15. Import and source boundary
// ---------------------------------------------------------------------------

describe("import boundary: no database, signing, send or payment path is reachable from the runner", () => {
  const runnerSource = readFileSync(RUNNER_FILE, "utf8");

  /** Runtime import specifiers of a module: value imports, side-effect imports, re-exports and dynamic import() — `import type` and `typeof import()` excluded. */
  function runtimeSpecifiers(source: string): { static: string[]; dynamic: string[] } {
    const statics = [...source.matchAll(/^\s*import\s+(?!type\b)(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gm), ...source.matchAll(/^\s*export\s+(?!type\b)[^'";]*?\s+from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    const dynamics = [...source.matchAll(/(?<!typeof\s)\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);
    return { static: [...new Set(statics)].sort(), dynamic: [...new Set(dynamics)].sort() };
  }
  function resolveLocal(from: string, specifier: string): string | null {
    const base = specifier.startsWith("@/") ? specifier.slice(2) : specifier.startsWith(".") ? path.join(path.dirname(from), specifier) : null;
    if (base === null) return null;
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(candidate)) return path.normalize(candidate);
    throw new Error(`unresolved local import ${specifier} from ${from}`);
  }

  it("the runner's own runtime imports are exactly these; production code is reached ONLY by dynamic import", () => {
    const specifiers = runtimeSpecifiers(runnerSource);
    expect(specifiers.static).toEqual(["node:crypto", "node:fs", "node:path", "viem", "viem/account-abstraction", "viem/chains", "vitest"]);
    expect(specifiers.dynamic).toEqual(["@/lib/real/account/safe", "@/lib/real/constants", "@/lib/real/server/pimlico"]);
  });

  it("the transitive local graph is exactly pimlico.ts, account/safe.ts, constants.ts and payments/transfer.ts; external packages only viem and permissionless", () => {
    const seen = new Set<string>();
    const external = new Set<string>();
    const queue = runtimeSpecifiers(runnerSource).dynamic.map((s) => resolveLocal(RUNNER_FILE, s)!);
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const { static: statics, dynamic } = runtimeSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of [...statics, ...dynamic]) {
        const local = resolveLocal(file, specifier);
        if (local) queue.push(local);
        else external.add(specifier);
      }
    }
    expect([...seen].sort()).toEqual(["lib/real/account/safe.ts", "lib/real/constants.ts", "lib/real/payments/transfer.ts", "lib/real/server/pimlico.ts"]);
    expect([...external].sort()).toEqual(["permissionless", "permissionless/accounts", "permissionless/clients/pimlico", "viem", "viem/account-abstraction", "viem/accounts"]);
  });

  it("permissionless's installed runtime imports only viem, itself and the optional ox (pinned; a change needs a new review)", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
    const specifiers = new Set<string>();
    for (const file of walk("node_modules/permissionless/_esm")) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"'.][^"']*)["']/g)) specifiers.add(m[1]!.replace(/^(viem|ox|permissionless)\/.*$/, "$1/*"));
    }
    expect([...specifiers].sort()).toEqual(["ox", "permissionless/*", "viem", "viem/*"]);
  });

  it.each([
    "sendPreparedUserOperation",
    "sendUserOperation",
    "fetchUserOperationReceipt",
    "signUserOperation",
    "signTypedData",
    "signMessage",
    "signTransaction",
    "resolvePreparePayment",
    "resolveSubmitPayment",
    "reservePayment",
    "reserveHandlePayment",
    "writeContract",
    "sendTransaction",
    "sendRawTransaction",
    "deployContract",
    "createWalletClient",
    "privateKeyToAccount",
    "mnemonicToAccount",
    "hdKeyToAccount",
    "generatePrivateKey",
    "neon-store",
    "neondatabase",
    "turnkey-",
    "child_process",
    "dotenv",
    "@next/env",
    "loadEnv",
    ".env.local",
    '".env',
    "'.env",
    "readFileSync(\".env",
  ])("the runner source never mentions %s", (token) => {
    expect(runnerSource).not.toContain(token);
  });

  it("order inside the runner: one attempt, every refusal, the evidence preflight, then the (locked) guard, then production code; the guard is never uninstalled", () => {
    const suite = runnerSource.slice(runnerSource.indexOf("describe.skipIf("));
    const at = (needle: string) => {
      const index = suite.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    expect(suite).toContain('it("classifies honest Pimlico answers against L-1a as PASS / FAIL-COMPAT / FAIL-SAFETY / INCONCLUSIVE", LIVE_TEST_OPTIONS, async ({ task }) => {');
    const sequence = ["LIVE_ATTEMPT.claim();", "automaticRerunProblem(task)", "requireLiveAuthorization(", "preflightEvidence(", "observeCompatibility(", "writeEvidence(", "liveRunResult("].map(at);
    expect([...sequence].sort((a, b) => a - b)).toEqual(sequence);
    expect(suite.indexOf("LIVE_ATTEMPT.claim();")).toBeLessThan(suite.indexOf("process.env"));
    expect(suite).toContain("evidencePlan: preflight.plan");
    expect(suite).toContain('expect(liveRunResult(observation.report, written)).toEqual({ verdict: "PASS", evidence: "written" });');
    expect(suite).not.toMatch(/uninstall\(|\.uninstall\b/);
    const observe = runnerSource.slice(runnerSource.indexOf("export async function observeCompatibility("), runnerSource.indexOf("function noop()"));
    const install = observe.indexOf("installGuard(guard, { lock: live })");
    expect(install).toBeGreaterThan(-1);
    expect(observe.indexOf("observationPairingProblem(input)")).toBeGreaterThan(-1);
    expect(observe.indexOf("observationPairingProblem(input)")).toBeLessThan(install);
    expect(install).toBeLessThan(observe.indexOf("guardIsLocked(guard)"));
    expect(observe.indexOf("guardIsLocked(guard)")).toBeLessThan(observe.indexOf("input.loadDeps()"));
    expect(install).toBeLessThan(observe.indexOf("createPublicClient("));
    expect(observe).toContain("const live = input.mode === \"live\";");
    expect(observe).toContain("retryCount: 0");
    expect(observe).toContain("ccipRead: false");
    expect(runnerSource.match(/console\.(log|info|warn|error|debug)\(/g)).toHaveLength(2);
    expect(suite).toContain("console.log(printableReport(observation.report))");
  });
});
