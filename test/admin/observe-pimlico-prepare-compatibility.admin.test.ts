// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, inject, it } from "vitest";
import { createPublicClient, decodeFunctionData, encodeFunctionData, getAddress, http, isAddress, keccak256, toFunctionSelector, type Address, type Hex } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";

/**
 * MANUAL, LIVE OPERATOR RUNNER — L-1a honest-Pimlico compatibility,
 * PREPARATION ONLY. Never runs in an ordinary `pnpm test`: the suite below is
 * skipped unless GATE_ENV is present, and once it is present anything short
 * of a complete, exact authorization FAILS the run before any network
 * request. A live run needs its own separate approval; this file existing is
 * not one.
 *
 * What a live run does: it calls the production
 * prepareCashTransferUserOperation (lib/real/server/pimlico.ts) ONCE for a
 * small Cash transfer from an already deployed Base Sepolia Safe (Scenario A),
 * and classifies whether genuine Pimlico responses pass L-1a's structural
 * validation. It never signs, never submits, never touches a database, and
 * holds no private key: the owner is the production read-only stand-in,
 * whose every signing method throws.
 *
 * Network: every request goes through ONE guard installed on
 * globalThis.fetch BEFORE production code is loaded. viem's http transport
 * looks `fetch` up at request time (utils/rpc/http.ts: `options.fetchFn ??
 * fetch`), so both the chain client and the Pimlico transport that
 * pimlico.ts builds internally pass through it. The guard allows exactly two
 * URLs (the operator's chain RPC URL and the Base Sepolia Pimlico endpoint),
 * exactly the planned JSON-RPC methods per phase, checks targets and intent
 * BEFORE dispatch, refuses redirects, enforces a per-slot and per-endpoint
 * request budget, a 1 MiB response-byte ceiling (counted while the body
 * streams) and a 60 s wall clock, and once anything trips, denies every later
 * attempt. In a live run it is installed non-writable and non-configurable
 * and never uninstalled, so a delayed library retry can never reach the
 * network after the verdict and later code cannot swap it out. This is an
 * in-process guard, not OS-level egress isolation: code that reaches Node's
 * http/https/net modules directly is outside it (the import-boundary
 * self-test pins that production code reaches only viem and permissionless).
 *
 * The live test runs at most once per process: retry and repeats are pinned
 * to 0 on the test itself (Vitest 4 resolves `options.retry ??
 * config.retry`), the resolved values are re-checked inside the test, and a
 * one-shot latch refuses any second attempt before anything else happens.
 *
 * Evidence: the report holds fixed codes, booleans, counts, key names, type
 * and byte-length metadata and short digests only — never a URL, a key, an
 * address, full callData, paymasterData or factoryData, or provider text.
 * Before any request, a read-only preflight verifies the repository's
 * git-ignored /evidence/ directory (exists, real directory, inside the
 * repository, owner-only writable, writable by this user) and that the run's
 * file name is unused; it creates nothing. After the verdict ONE file is
 * exclusively created there, mode 0600 (checked before anything is written
 * into it). The run does not pass unless that file was written.
 *
 * Required environment, inline on ONE command that names ONLY this file (do
 * not export any of it):
 *   REAL_ADMIN_PIMLICO_COMPAT_PREPARE_ONLY=<GATE_VALUE below, exactly>
 *   REAL_ADMIN_PIMLICO_COMPAT_SAFE_ADDRESS=0x...       deployed Safe (Scenario A)
 *   REAL_ADMIN_PIMLICO_COMPAT_OWNER_ADDRESS=0x...      its single owner (never funded)
 *   REAL_ADMIN_PIMLICO_COMPAT_RECIPIENT_ADDRESS=0x...  intended recipient
 *   REAL_ADMIN_PIMLICO_COMPAT_AMOUNT_BASE_UNITS=...    1 to 1000000
 *   REAL_ADMIN_PIMLICO_COMPAT_CHAIN_RPC_URL=https://...  Base Sepolia RPC
 *   REAL_ADMIN_PIMLICO_COMPAT_PIMLICO_API_KEY=...
 *   REAL_ADMIN_PIMLICO_COMPAT_CONFIRMATION=observe-pimlico-prepare-compatibility:84532:<safe, lowercase>:<recipient, lowercase>:<amount>
 * and NONE of: DATABASE_URL (or any *DATABASE_URL*), PG* or POSTGRES*, NEON_*,
 * TURNKEY_*, REAL_SESSION_SECRET, PIMLICO_API_KEY, REAL_SMOKE_*, another
 * REAL_ADMIN_* variable, or anything named like a private key or mnemonic;
 * and none of the inherited proxy, TLS-trust, Node-option or Node-debug
 * variables (any letter case): HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY,
 * FTP_PROXY, WS_PROXY, WSS_PROXY, NODE_USE_ENV_PROXY,
 * NODE_TLS_REJECT_UNAUTHORIZED, NODE_EXTRA_CA_CERTS, NODE_USE_SYSTEM_CA,
 * NODE_OPTIONS, NODE_DEBUG, NODE_DEBUG_NATIVE, SSL_CERT_FILE, SSL_CERT_DIR,
 * SSLKEYLOGFILE. Only names are checked; no value is read or printed, and the
 * runner never changes the environment.
 *
 *   <the variables above> pnpm exec vitest run test/admin/observe-pimlico-prepare-compatibility.admin.test.ts
 *
 * Prints only the sanitized report and one evidence line. The run exits
 * nonzero unless the verdict is PASS AND the evidence file was written.
 */

// ---------------------------------------------------------------------------
// Identity, gate, pinned facts
// ---------------------------------------------------------------------------

export const RUNNER_NAME = "observe-pimlico-prepare-compatibility";
export const RUNNER_FILE = `test/admin/${RUNNER_NAME}.admin.test.ts`;
export const HARNESS_VERSION = 1;

export const GATE_ENV = "REAL_ADMIN_PIMLICO_COMPAT_PREPARE_ONLY";
/** The one accepted gate value. A generic flag ("1", "true", "yes") is refused, not honored. */
export const GATE_VALUE = "observe-one-preparation:base-sepolia-84532:never-sign-never-send";

export const INPUT_ENV = {
  safe: "REAL_ADMIN_PIMLICO_COMPAT_SAFE_ADDRESS",
  owner: "REAL_ADMIN_PIMLICO_COMPAT_OWNER_ADDRESS",
  recipient: "REAL_ADMIN_PIMLICO_COMPAT_RECIPIENT_ADDRESS",
  amount: "REAL_ADMIN_PIMLICO_COMPAT_AMOUNT_BASE_UNITS",
  chainRpcUrl: "REAL_ADMIN_PIMLICO_COMPAT_CHAIN_RPC_URL",
  pimlicoApiKey: "REAL_ADMIN_PIMLICO_COMPAT_PIMLICO_API_KEY",
  confirmation: "REAL_ADMIN_PIMLICO_COMPAT_CONFIRMATION",
} as const;
const OWN_ENV: ReadonlySet<string> = new Set([GATE_ENV, ...Object.values(INPUT_ENV)]);

/** Facts this harness was written against, pinned here and compared with the production constants before any request. */
export const PINNED = {
  chainId: 84532,
  chainIdHex: "0x14a34",
  entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address,
  cashToken: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address,
  pimlicoOrigin: "https://api.pimlico.io",
  pimlicoPath: "/v2/84532/rpc",
} as const;

export const MAX_AMOUNT_BASE_UNITS = BigInt(1_000_000);
export const WALL_CLOCK_MS = 60_000;
const LIVE_TEST_TIMEOUT_MS = 120_000;
/** Response bodies are capped in BYTES as they stream (not JavaScript string length). */
export const MAX_RESPONSE_BYTES = 1_048_576;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/** The platform fetch as it was when this module loaded — the only transport a live observation may dispatch through. */
export const PLATFORM_FETCH: FetchLike = globalThis.fetch;

export type Env = Record<string, string | undefined>;

/** A refusal. Its message names variables and rules — never a value. */
export class CompatRefusal extends Error {
  constructor(reason: string) {
    super(`${RUNNER_NAME} refused: ${reason}`);
    this.name = "CompatRefusal";
  }
}

/** What the guard throws for a denied request. Fixed text. */
export class GuardDeniedError extends Error {
  constructor() {
    super("Network request denied by the compatibility guard.");
    this.name = "GuardDeniedError";
  }
}

/** What the guard throws when an allowed dispatch failed in transport. Fixed text — the transport's own error is dropped. */
export class GuardDispatchFailure extends Error {
  constructor() {
    super("Network request failed at the compatibility guard.");
    this.name = "GuardDispatchFailure";
  }
}

// ---------------------------------------------------------------------------
// Authorization (pure over the env and CLI args it is given)
// ---------------------------------------------------------------------------

/** Variable-name families that must be ABSENT. Presence is checked; values are never read. */
const PROHIBITED_ENV: readonly RegExp[] = [
  /(^|_)DATABASE_URL($|_)/,
  /^PG[A-Z0-9_]*$/,
  /^POSTGRES/,
  /^NEON_/,
  /^TURNKEY_/,
  /^REAL_SESSION_SECRET$/,
  /^PIMLICO_API_KEY$/,
  /^REAL_SMOKE_/,
  /PRIVATE_KEY|MNEMONIC|SEED_PHRASE/,
];

/** Names (never values) of present variables that would arm or leak something this runner must not touch. */
export function prohibitedEnvNames(env: Env): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined)
    .filter((name) => (name.startsWith("REAL_ADMIN_") && !OWN_ENV.has(name)) || PROHIBITED_ENV.some((pattern) => pattern.test(name)))
    .sort();
}

/**
 * Inherited settings that can change how a credential-bearing request travels
 * or what is logged about it: proxies (honored by Node's fetch when
 * NODE_USE_ENV_PROXY or --use-env-proxy is set), TLS trust and verification
 * overrides, TLS key logging, NODE_OPTIONS (which can carry --require,
 * --use-env-proxy or --use-openssl-ca) and Node's debug logging (which can
 * print request URLs). Matched case-insensitively; values are never read.
 */
const NETWORK_ENV: readonly RegExp[] = [
  /^(HTTP|HTTPS|ALL|NO|FTP|WS|WSS)_PROXY$/i,
  /^NODE_USE_ENV_PROXY$/i,
  /^NODE_TLS_REJECT_UNAUTHORIZED$/i,
  /^NODE_EXTRA_CA_CERTS$/i,
  /^NODE_USE_SYSTEM_CA$/i,
  /^NODE_OPTIONS$/i,
  /^NODE_DEBUG(_NATIVE)?$/i,
  /^SSL_CERT_(FILE|DIR)$/i,
  /^SSLKEYLOGFILE$/i,
];

/** Names (never values) of present proxy, TLS, Node-option or Node-debug variables. */
export function networkEnvironmentNames(env: Env): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined)
    .filter((name) => NETWORK_ENV.some((pattern) => pattern.test(name)))
    .sort();
}

/** null when the Vitest command line is exactly `run <this file>`; otherwise why not. */
export function selectionProblem(cliArgs: unknown): string | null {
  if (!Array.isArray(cliArgs) || cliArgs.some((arg) => typeof arg !== "string")) return "the Vitest command line is not available to this run";
  if (cliArgs[0] !== "run") return 'it must be started with "vitest run" (no watch mode, no other command)';
  const rest = cliArgs.slice(1) as string[];
  if (rest.length !== 1 || (rest[0] !== RUNNER_FILE && rest[0] !== `./${RUNNER_FILE}`)) return "it must be the ONE argument on the command line, by its exact path, with no flags or filters";
  return null;
}

export type CompatInputs = Readonly<{
  safe: Address;
  owner: Address;
  recipient: Address;
  amountBaseUnits: string;
  chainRpcUrl: string;
  pimlicoApiKey: string;
}>;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const AMOUNT_SHAPE = /^[1-9][0-9]{0,6}$/;
const PIMLICO_KEY_SHAPE = /^[A-Za-z0-9_-]{8,256}$/;

function isNormalizedAddress(value: unknown): value is Address {
  return typeof value === "string" && isAddress(value, { strict: true }) && getAddress(value) === value;
}

/** null when the inputs are well formed and mutually consistent; otherwise a reason that names no value. */
export function inputsProblem(inputs: CompatInputs): string | null {
  if (!isNormalizedAddress(inputs.safe)) return "the Safe address is not a valid address";
  if (!isNormalizedAddress(inputs.owner)) return "the owner address is not a valid address";
  if (!isNormalizedAddress(inputs.recipient)) return "the recipient address is not a valid address";
  if (new Set([inputs.safe, inputs.owner, inputs.recipient]).size !== 3) return "the Safe, owner and recipient must be three different addresses (the owner is never a payment recipient)";
  if ([ZERO_ADDRESS, PINNED.cashToken, PINNED.entryPoint, PINNED.proxyFactory].map((a) => getAddress(a)).includes(inputs.recipient)) {
    return "the recipient may not be the zero address, the Cash token, the EntryPoint or the Safe proxy factory";
  }
  if (typeof inputs.amountBaseUnits !== "string" || !AMOUNT_SHAPE.test(inputs.amountBaseUnits) || BigInt(inputs.amountBaseUnits) > MAX_AMOUNT_BASE_UNITS) {
    return `the amount must be a whole number of Cash base units from 1 to ${MAX_AMOUNT_BASE_UNITS.toString()}`;
  }
  const url = inputs.chainRpcUrl;
  if (typeof url !== "string" || url.length === 0 || url.length > 2048 || /\s/.test(url)) return "the chain RPC URL is missing or malformed";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "the chain RPC URL is not a URL";
  }
  if (parsed.protocol !== "https:") return "the chain RPC URL must use https";
  if (parsed.username !== "" || parsed.password !== "") return "the chain RPC URL must not carry credentials before the host";
  if (parsed.hash !== "") return "the chain RPC URL must not have a fragment";
  if (parsed.hostname === "pimlico.io" || parsed.hostname.endsWith(".pimlico.io")) return "the chain RPC URL must not be a Pimlico host (chain and Pimlico requests are budgeted separately)";
  if (typeof inputs.pimlicoApiKey !== "string" || !PIMLICO_KEY_SHAPE.test(inputs.pimlicoApiKey)) return "the Pimlico API key is missing or malformed";
  return null;
}

function readAddress(env: Env, name: string): Address | null {
  const raw = env[name];
  if (typeof raw !== "string" || !isAddress(raw, { strict: true })) return null;
  return getAddress(raw);
}

export function parseInputs(env: Env): { ok: true; inputs: CompatInputs } | { ok: false; reason: string } {
  const safe = readAddress(env, INPUT_ENV.safe);
  if (!safe) return { ok: false, reason: `${INPUT_ENV.safe} is missing or not a valid (checksummed or all-lowercase) address` };
  const owner = readAddress(env, INPUT_ENV.owner);
  if (!owner) return { ok: false, reason: `${INPUT_ENV.owner} is missing or not a valid (checksummed or all-lowercase) address` };
  const recipient = readAddress(env, INPUT_ENV.recipient);
  if (!recipient) return { ok: false, reason: `${INPUT_ENV.recipient} is missing or not a valid (checksummed or all-lowercase) address` };
  const inputs: CompatInputs = Object.freeze({
    safe,
    owner,
    recipient,
    amountBaseUnits: env[INPUT_ENV.amount] ?? "",
    chainRpcUrl: env[INPUT_ENV.chainRpcUrl] ?? "",
    pimlicoApiKey: env[INPUT_ENV.pimlicoApiKey] ?? "",
  });
  const problem = inputsProblem(inputs);
  return problem ? { ok: false, reason: problem } : { ok: true, inputs };
}

/** The confirmation an operator composes for these inputs. Never printed by the runner. */
export function expectedConfirmation(inputs: Pick<CompatInputs, "safe" | "recipient" | "amountBaseUnits">): string {
  return [RUNNER_NAME, String(PINNED.chainId), inputs.safe.toLowerCase(), inputs.recipient.toLowerCase(), inputs.amountBaseUnits].join(":");
}

export type LiveAuthorization = Readonly<{ kind: "live-authorization"; inputs: CompatInputs }>;
const ISSUED_AUTHORIZATIONS = new WeakSet<object>();

/**
 * The live run's authorization, or a CompatRefusal. In order: the exact gate
 * phrase; no prohibited (credential, gate or foreign admin) variable present;
 * no inherited proxy, TLS, Node-option or Node-debug variable present; the
 * exact one-file command line; well-formed inputs; and a confirmation
 * naming this runner, the chain, the Safe, the recipient and the amount.
 */
export function requireLiveAuthorization(input: { env: Env; cliArgs: unknown }): LiveAuthorization {
  const { env } = input;
  const gate = env[GATE_ENV];
  if (gate === undefined) throw new CompatRefusal(`${GATE_ENV} is not set`);
  if (gate !== GATE_VALUE) throw new CompatRefusal(`${GATE_ENV} is not the exact authorization phrase this runner documents (a generic value such as 1 or true is refused)`);
  const prohibited = prohibitedEnvNames(env);
  if (prohibited.length > 0) throw new CompatRefusal(`variables that must be absent are present; unset them first: ${prohibited.join(", ")}`);
  const network = networkEnvironmentNames(env);
  if (network.length > 0) throw new CompatRefusal(`inherited proxy, TLS, Node-option or Node-debug variables must be absent; unset them first: ${network.join(", ")}`);
  const selection = selectionProblem(input.cliArgs);
  if (selection) throw new CompatRefusal(selection);
  const parsed = parseInputs(env);
  if (!parsed.ok) throw new CompatRefusal(parsed.reason);
  if (env[INPUT_ENV.confirmation] !== expectedConfirmation(parsed.inputs)) {
    throw new CompatRefusal(`${INPUT_ENV.confirmation} is missing or does not name this runner, chain, Safe, recipient and amount exactly`);
  }
  const authorization: LiveAuthorization = Object.freeze({ kind: "live-authorization", inputs: parsed.inputs });
  ISSUED_AUTHORIZATIONS.add(authorization);
  return authorization;
}

// ---------------------------------------------------------------------------
// Request plan and budget
// ---------------------------------------------------------------------------

export type Phase = "idle" | "pre" | "prepare" | "post";
export type Endpoint = "chain" | "pimlico";
type PlannedPhase = Exclude<Phase, "idle">;
type SlotKind =
  | "chainId"
  | "code.entryPoint"
  | "code.safe"
  | "call.proxyCreationCode"
  | "call.getOwners"
  | "call.getThreshold"
  | "call.balanceOf"
  | "call.getNonce"
  | "pimlico.gasPrice"
  | "pimlico.stub"
  | "pimlico.estimate"
  | "pimlico.paymasterData";

export type PlannedRequest = Readonly<{ id: string; phase: PlannedPhase; endpoint: Endpoint; kind: SlotKind; method: string; max: number }>;

const planned = (phase: PlannedPhase, endpoint: Endpoint, kind: SlotKind, method: string): PlannedRequest => Object.freeze({ id: `${phase}.${kind}`, phase, endpoint, kind, method, max: 1 });

/**
 * EVERY request a run may make, each at most once. Nothing else is
 * dispatched.
 *
 *  pre (harness, read-only): chain id; EntryPoint code; Safe derivation from
 *    the owner (one proxyCreationCode() read, through the production
 *    createRealSafeAccount); Safe code; getOwners(); getThreshold(); Cash
 *    balanceOf(Safe). Any failed precondition stops the run before Pimlico.
 *  prepare (production prepareCashTransferUserOperation, deployed Safe):
 *    proxyCreationCode() (its own Safe derivation), EntryPoint getNonce, Safe
 *    code; Pimlico gas price, paymaster stub, gas estimate, paymaster data
 *    (skipped by viem when the stub says isFinal).
 *  post (harness, read-only): Safe code, EntryPoint getNonce at the prepared
 *    nonce's key, Cash balanceOf(Safe) — compared with what was read before.
 *
 * Chain total 13 (eth_chainId 1, eth_getCode 4, eth_call 8); Pimlico total
 * 4. No retries: viem's own transport retries are refused before dispatch.
 */
export const REQUEST_PLAN: readonly PlannedRequest[] = Object.freeze([
  planned("pre", "chain", "chainId", "eth_chainId"),
  planned("pre", "chain", "code.entryPoint", "eth_getCode"),
  planned("pre", "chain", "call.proxyCreationCode", "eth_call"),
  planned("pre", "chain", "code.safe", "eth_getCode"),
  planned("pre", "chain", "call.getOwners", "eth_call"),
  planned("pre", "chain", "call.getThreshold", "eth_call"),
  planned("pre", "chain", "call.balanceOf", "eth_call"),
  planned("prepare", "chain", "call.proxyCreationCode", "eth_call"),
  planned("prepare", "chain", "call.getNonce", "eth_call"),
  planned("prepare", "chain", "code.safe", "eth_getCode"),
  planned("prepare", "pimlico", "pimlico.gasPrice", "pimlico_getUserOperationGasPrice"),
  planned("prepare", "pimlico", "pimlico.stub", "pm_getPaymasterStubData"),
  planned("prepare", "pimlico", "pimlico.estimate", "eth_estimateUserOperationGas"),
  planned("prepare", "pimlico", "pimlico.paymasterData", "pm_getPaymasterData"),
  planned("post", "chain", "code.safe", "eth_getCode"),
  planned("post", "chain", "call.getNonce", "eth_call"),
  planned("post", "chain", "call.balanceOf", "eth_call"),
]);

export const REQUEST_CEILINGS: Readonly<Record<Endpoint, number>> = Object.freeze({ chain: 13, pimlico: 4 });
for (const endpoint of ["chain", "pimlico"] as const) {
  const sum = REQUEST_PLAN.filter((p) => p.endpoint === endpoint).reduce((total, p) => total + p.max, 0);
  if (sum !== REQUEST_CEILINGS[endpoint]) throw new Error(`${RUNNER_NAME}: the ${endpoint} request plan does not add up to its ceiling`);
}

export const ALLOWED_METHODS: Readonly<Record<Endpoint, ReadonlySet<string>>> = Object.freeze({
  chain: new Set(REQUEST_PLAN.filter((p) => p.endpoint === "chain").map((p) => p.method)),
  pimlico: new Set(REQUEST_PLAN.filter((p) => p.endpoint === "pimlico").map((p) => p.method)),
});

/** How many times each planned request should have run on a complete observation. */
export function expectedUsage(stubIsFinal: boolean | null): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const p of REQUEST_PLAN) usage[p.id] = p.kind === "pimlico.paymasterData" && stubIsFinal === true ? 0 : 1;
  return usage;
}

// ---------------------------------------------------------------------------
// ABIs (this harness's own, independent of the production encoders)
// ---------------------------------------------------------------------------

const PROXY_FACTORY_ABI = [{ type: "function", name: "proxyCreationCode", stateMutability: "pure", inputs: [], outputs: [{ name: "", type: "bytes" }] }] as const;
const SAFE_READ_ABI = [
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address[]" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;
const ENTRY_POINT_ABI = [{ type: "function", name: "getNonce", stateMutability: "view", inputs: [{ name: "sender", type: "address" }, { name: "key", type: "uint192" }], outputs: [{ name: "nonce", type: "uint256" }] }] as const;
const SAFE_4337_EXECUTE_ABI = [
  {
    type: "function",
    name: "executeUserOpWithErrorString",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

const SELECTOR = {
  proxyCreationCode: toFunctionSelector(PROXY_FACTORY_ABI[0]),
  getOwners: toFunctionSelector(SAFE_READ_ABI[0]),
  getThreshold: toFunctionSelector(SAFE_READ_ABI[1]),
  balanceOf: toFunctionSelector(ERC20_ABI[0]),
  getNonce: toFunctionSelector(ENTRY_POINT_ABI[0]),
} as const;

/** The Safe execution of exactly one Cash transfer, encoded here independently of production. */
export function encodeExpectedCallData(recipient: Address, amount: bigint): Hex {
  const transfer = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [recipient, amount] });
  return encodeFunctionData({ abi: SAFE_4337_EXECUTE_ABI, functionName: "executeUserOpWithErrorString", args: [PINNED.cashToken, BigInt(0), transfer, 0] });
}

// ---------------------------------------------------------------------------
// Shape classification (no values leave this section)
// ---------------------------------------------------------------------------

export type HexShape = {
  evenLength: boolean;
  letterCase: "none" | "lower" | "upper" | "mixed";
  byteLength: number | null;
  /** Bit length as an unsigned quantity, for values up to 32 bytes. */
  quantityBits: number | null;
  leadingZero: boolean;
  address: "lowercase" | "uppercase" | "checksummed" | "mixed-invalid" | null;
};
export type Shape =
  | { type: "null" }
  | { type: "undefined" }
  | { type: "boolean"; value: boolean }
  | { type: "number"; integer: boolean }
  | { type: "bigint" }
  | { type: "string"; length: number; hex: HexShape | null }
  | { type: "array"; length: number; items: Shape[] }
  | { type: "object"; keys: Record<string, Shape>; keyCount: number }
  | { type: "other" };

const SAFE_KEY = /^[A-Za-z0-9_]{1,64}$/;
const bitsOf = (value: bigint) => (value === BigInt(0) ? 0 : value.toString(2).length);
const HEX = /^0x[0-9a-fA-F]*$/;

export function describeHex(value: string): HexShape | null {
  if (!HEX.test(value)) return null;
  const digits = value.slice(2);
  const hasLower = /[a-f]/.test(digits);
  const hasUpper = /[A-F]/.test(digits);
  const letterCase = hasLower && hasUpper ? "mixed" : hasLower ? "lower" : hasUpper ? "upper" : "none";
  let address: HexShape["address"] = null;
  if (digits.length === 40) {
    if (letterCase === "mixed") address = isAddress(value, { strict: true }) ? "checksummed" : "mixed-invalid";
    else address = letterCase === "upper" ? "uppercase" : "lowercase";
  }
  return {
    evenLength: digits.length % 2 === 0,
    letterCase,
    byteLength: digits.length % 2 === 0 ? digits.length / 2 : null,
    quantityBits: digits.length > 0 && digits.length <= 64 ? bitsOf(BigInt(value)) : null,
    leadingZero: digits.length > 1 && digits[0] === "0",
    address,
  };
}

/** Runtime type and formatting metadata of a provider value — key names (when safe), types, lengths — never the value itself. */
export function describeShape(value: unknown, depth = 0): Shape {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number") return { type: "number", integer: Number.isInteger(value) };
  if (typeof value === "bigint") return { type: "bigint" };
  if (typeof value === "string") return { type: "string", length: value.length, hex: describeHex(value) };
  if (Array.isArray(value)) return { type: "array", length: value.length, items: depth >= 3 ? [] : value.slice(0, 4).map((item) => describeShape(item, depth + 1)) };
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const keys: Record<string, Shape> = {};
    if (depth < 3) {
      for (const [key, item] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 32)) {
        keys[SAFE_KEY.test(key) ? key : "<unsafe-key>"] = describeShape(item, depth + 1);
      }
    }
    return { type: "object", keys, keyCount: entries.length };
  }
  return { type: "other" };
}

const digest16 = (value: string) => createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 16);

// ---------------------------------------------------------------------------
// Network guard
// ---------------------------------------------------------------------------

export const SAFETY_TRIPS = [
  "forbidden_request_form",
  "forbidden_host",
  "forbidden_method",
  "forbidden_target",
  "request_intent_mismatch",
  "phase_violation",
  "budget_exceeded",
  "unexpected_repeat",
  "redirect_refused",
  "egress_api_blocked",
] as const;
/**
 * stub_repeat_blocked: a second paymaster-stub request that was allowed in
 * endpoint, phase, method and intent, refused ONLY because its one slot was
 * already used by a successful answer. The installed viem re-requests the stub
 * from inside gas estimation when the first stub answer carried no string
 * `paymaster` (estimateUserOperationGas re-runs prepareUserOperation with
 * `paymaster` in its parameters). It is still never dispatched. The verdict
 * decides what it means (see classifyVerdict): at most INCONCLUSIVE, because
 * the blocked repeat stops the preparation before L-1a's validator is reached.
 */
export const INCONCLUSIVE_TRIPS = ["library_retry_blocked", "wall_clock_exceeded", "response_too_large", "stub_repeat_blocked"] as const;
export type TripReason = (typeof SAFETY_TRIPS)[number] | (typeof INCONCLUSIVE_TRIPS)[number];
export type DenyReason = TripReason | "already_tripped" | "sealed";
export const isSafetyTrip = (reason: TripReason) => (SAFETY_TRIPS as readonly string[]).includes(reason);

export type ResponseKind = "result" | "rpc_error" | "http_error" | "malformed" | "network_failure" | "redirect" | "too_large";
export type RequestRecord =
  | { seq: number; phase: Phase; endpoint: Endpoint | null; method: string | null; slot: string | null; outcome: "denied"; reason: DenyReason }
  | { seq: number; phase: Phase; endpoint: Endpoint; method: string; slot: string; outcome: "dispatched"; httpStatus: number | null; response: ResponseKind; rpcErrorCode: number | null; elapsedMs: number };

export type GuardConfig = {
  underlying: FetchLike;
  chainRpcUrl: string;
  pimlicoApiKey: string;
  safe: Address;
  expectedCallData: Hex;
  wallClockMs: number;
  maxResponseBytes?: number;
  now?: () => number;
};

type BodyRead = { ok: true; text: string } | { ok: false; failure: "too_large" | "read_failed" };

/**
 * Reads a response body with a hard BYTE ceiling: a declared Content-Length
 * above it is refused before reading; otherwise bytes are counted chunk by
 * chunk and the stream is cancelled as soon as the count passes the ceiling
 * (a missing or understated Content-Length changes nothing). Exactly `max`
 * bytes are accepted. A read stalls no longer than `signal` stays unaborted.
 * Decodes like Response.text() (UTF-8, replacement characters, BOM stripped).
 */
export async function readBoundedBody(response: Response, max: number, signal: AbortSignal): Promise<BodyRead> {
  const cancel = async (reader?: ReadableStreamDefaultReader<Uint8Array>) => {
    try {
      await (reader ? reader.cancel() : response.body?.cancel());
    } catch {
      // nothing to report: the body is abandoned either way
    }
  };
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\s*[0-9]+\s*$/.test(declared) && Number(declared) > max) {
    await cancel();
    return { ok: false, failure: "too_large" };
  }
  if (response.body === null) return { ok: true, text: "" };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return { ok: false, failure: "read_failed" };
  }
  let onAbort: () => void = noop;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(noop);
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        await cancel(reader);
        return { ok: false, failure: "read_failed" };
      }
      size += chunk.value.byteLength;
      if (size > max) {
        await cancel(reader);
        return { ok: false, failure: "too_large" };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return { ok: true, text: text + decoder.decode() };
  } catch {
    await cancel(reader);
    return { ok: false, failure: "read_failed" };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export type NetworkGuard = ReturnType<typeof createNetworkGuard>;

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : null);
const recordableMethod = (method: string) => (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(method) ? method : "unrecognized");
const SAFE_INTEGER_CODE = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);

export function createNetworkGuard(config: GuardConfig) {
  const now = config.now ?? (() => Date.now());
  const startedAt = now();
  const maxBytes = config.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error(`${RUNNER_NAME}: the response byte ceiling must be a non-negative integer`);
  const chainHref = new URL(config.chainRpcUrl).href;
  const pimlicoHref = new URL(`${PINNED.pimlicoOrigin}${PINNED.pimlicoPath}?apikey=${config.pimlicoApiKey}`).href;
  const safeLower = config.safe.toLowerCase();
  const usage = new Map<string, { used: number; lastFailed: boolean }>(REQUEST_PLAN.map((p) => [p.id, { used: 0, lastFailed: false }]));
  const totals: Record<Endpoint, number> = { chain: 0, pimlico: 0 };
  const records: RequestRecord[] = [];
  const trips: TripReason[] = [];
  const shapes: Record<string, Shape> = {};
  const controller = new AbortController();
  let phase: Phase = "idle";
  let sealed = false;
  let seq = 0;
  let observedNonce: bigint | null = null;
  let postNonceKey: bigint | null = null;
  let stubIsFinal: boolean | null = null;
  /** Whether the successful stub answer carried a string `paymaster` (null: no successful stub answer seen). */
  let stubHadStringPaymaster: boolean | null = null;
  let resolveTripped: (reason: TripReason) => void = () => undefined;
  const tripped = new Promise<TripReason>((resolve) => {
    resolveTripped = resolve;
  });
  const timer = setTimeout(() => trip("wall_clock_exceeded"), config.wallClockMs);
  (timer as { unref?: () => void }).unref?.();

  function trip(reason: TripReason) {
    trips.push(reason);
    if (trips.length === 1) {
      clearTimeout(timer);
      controller.abort();
      resolveTripped(reason);
    }
  }

  function deny(at: { seq: number; phase: Phase; endpoint?: Endpoint | null; method?: string | null; slot?: string | null }, reason: DenyReason): Promise<never> {
    if (reason !== "already_tripped" && reason !== "sealed") trip(reason);
    records.push({ seq: at.seq, phase: at.phase, endpoint: at.endpoint ?? null, method: at.method ?? null, slot: at.slot ?? null, outcome: "denied", reason });
    return Promise.reject(new GuardDeniedError());
  }

  function userOperationIntentOk(op: unknown): boolean {
    if (!isPlainObject(op)) return false;
    if (lower(op.sender) !== safeLower) return false;
    if (op.callData !== config.expectedCallData) return false;
    for (const key of ["factory", "factoryData", "initCode", "authorization", "eip7702Auth"]) if (key in op) return false;
    if (typeof op.nonce !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(op.nonce)) return false;
    return observedNonce !== null && BigInt(op.nonce) === observedNonce;
  }

  function callMatches(params: unknown[], to: Address, data: (data: Hex) => boolean): boolean {
    if (params.length < 1 || params.length > 2) return false;
    if (params.length === 2 && params[1] !== "latest") return false;
    const call = params[0];
    if (!isPlainObject(call) || Object.keys(call).some((key) => key !== "to" && key !== "data")) return false;
    if (lower(call.to) !== to.toLowerCase() || typeof call.data !== "string" || !HEX.test(call.data)) return false;
    try {
      return data(call.data as Hex);
    } catch {
      return false;
    }
  }

  function matches(kind: SlotKind, params: unknown[] | undefined): boolean {
    const list = params ?? [];
    switch (kind) {
      case "chainId":
      case "pimlico.gasPrice":
        return list.length === 0;
      case "code.entryPoint":
      case "code.safe": {
        const target = kind === "code.safe" ? safeLower : PINNED.entryPoint.toLowerCase();
        return (list.length === 1 || (list.length === 2 && list[1] === "latest")) && lower(list[0]) === target;
      }
      case "call.proxyCreationCode":
        return callMatches(list, PINNED.proxyFactory, (data) => data.toLowerCase() === SELECTOR.proxyCreationCode);
      case "call.getOwners":
        return callMatches(list, config.safe, (data) => data.toLowerCase() === SELECTOR.getOwners);
      case "call.getThreshold":
        return callMatches(list, config.safe, (data) => data.toLowerCase() === SELECTOR.getThreshold);
      case "call.balanceOf":
        return callMatches(list, PINNED.cashToken, (data) => {
          const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
          return decoded.functionName === "balanceOf" && decoded.args[0].toLowerCase() === safeLower;
        });
      case "call.getNonce":
        return callMatches(list, PINNED.entryPoint, (data) => {
          const decoded = decodeFunctionData({ abi: ENTRY_POINT_ABI, data });
          if (decoded.args[0].toLowerCase() !== safeLower) return false;
          return phase !== "post" || (postNonceKey !== null && decoded.args[1] === postNonceKey);
        });
      case "pimlico.stub":
      case "pimlico.paymasterData":
        return (
          list.length === 4 &&
          userOperationIntentOk(list[0]) &&
          lower(list[1]) === PINNED.entryPoint.toLowerCase() &&
          list[2] === PINNED.chainIdHex &&
          // No paymaster context: viem serializes the absent context as null. An empty object is the only other form accepted.
          (list[3] === null || (isPlainObject(list[3]) && Object.keys(list[3]).length === 0))
        );
      case "pimlico.estimate":
        return list.length === 2 && userOperationIntentOk(list[0]) && lower(list[1]) === PINNED.entryPoint.toLowerCase();
    }
  }

  function onResult(slot: PlannedRequest, result: unknown) {
    if (slot.id === "prepare.call.getNonce" && typeof result === "string" && /^0x[0-9a-fA-F]{64}$/.test(result)) observedNonce = BigInt(result);
    if (slot.endpoint === "pimlico") shapes[slot.id] = describeShape(result);
    if (slot.kind === "pimlico.stub") {
      stubIsFinal = isPlainObject(result) && result.isFinal === true;
      stubHadStringPaymaster = isPlainObject(result) && typeof result.paymaster === "string";
    }
  }

  /** Why a request matching an already-used slot is refused. Only the stub repeat after a SUCCESSFUL stub gets its own, non-safety reason. */
  function repeatReason(slot: PlannedRequest, lastFailed: boolean): TripReason {
    if (lastFailed) return "library_retry_blocked";
    if (slot.kind === "pimlico.stub") return "stub_repeat_blocked";
    return slot.endpoint === "pimlico" ? "unexpected_repeat" : "budget_exceeded";
  }

  async function guardedFetch(input: unknown, init?: unknown): Promise<Response> {
    const at = { seq: ++seq, phase };
    if (sealed) return deny(at, "sealed");
    if (trips.length > 0) return deny(at, "already_tripped");
    if (now() - startedAt >= config.wallClockMs) return deny(at, "wall_clock_exceeded");

    // Form: a plain URL or string, a POST with a string body. A Request object (whose body could be a stream) is refused.
    if (typeof input !== "string" && !(input instanceof URL)) return deny(at, "forbidden_request_form");
    if (!isPlainObject(init) || init.method !== "POST" || typeof init.body !== "string") return deny(at, "forbidden_request_form");
    let href: string;
    try {
      href = new URL(String(input)).href;
    } catch {
      return deny(at, "forbidden_request_form");
    }
    const endpoint: Endpoint | null = href === chainHref ? "chain" : href === pimlicoHref ? "pimlico" : null;
    if (!endpoint) return deny(at, "forbidden_host");

    let rpc: unknown;
    try {
      rpc = JSON.parse(init.body);
    } catch {
      return deny({ ...at, endpoint }, "forbidden_request_form");
    }
    if (!isPlainObject(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" || (rpc.params !== undefined && !Array.isArray(rpc.params))) {
      return deny({ ...at, endpoint }, "forbidden_request_form");
    }
    const method = rpc.method;
    const where = { ...at, endpoint, method: recordableMethod(method) };
    if (!ALLOWED_METHODS[endpoint].has(method)) return deny(where, "forbidden_method");
    const candidates = REQUEST_PLAN.filter((p) => p.phase === phase && p.endpoint === endpoint && p.method === method);
    if (candidates.length === 0) return deny(where, "phase_violation");
    const slot = candidates.find((p) => matches(p.kind, rpc.params as unknown[] | undefined));
    if (!slot) return deny(where, endpoint === "pimlico" ? "request_intent_mismatch" : "forbidden_target");
    const state = usage.get(slot.id)!;
    if (state.used >= slot.max) return deny({ ...where, slot: slot.id }, repeatReason(slot, state.lastFailed));
    if (totals[endpoint] >= REQUEST_CEILINGS[endpoint]) return deny({ ...where, slot: slot.id }, "budget_exceeded");
    state.used += 1;
    totals[endpoint] += 1;

    const startedRequest = now();
    const record = (response: ResponseKind, httpStatus: number | null, rpcErrorCode: number | null) =>
      records.push({ seq: at.seq, phase: at.phase, endpoint, method, slot: slot.id, outcome: "dispatched", httpStatus, response, rpcErrorCode, elapsedMs: Math.max(0, now() - startedRequest) });

    const signals = [controller.signal, ...(init.signal instanceof AbortSignal ? [init.signal] : [])];
    let response: Response;
    try {
      response = await config.underlying(href, { method: "POST", headers: { "content-type": "application/json" }, body: init.body, redirect: "manual", signal: AbortSignal.any(signals) });
    } catch {
      state.lastFailed = true;
      record("network_failure", null, null);
      throw new GuardDispatchFailure();
    }
    if (response.type === "opaqueredirect" || response.redirected || (response.status >= 300 && response.status < 400)) {
      state.lastFailed = true;
      record("redirect", response.status || null, null);
      trip("redirect_refused");
      throw new GuardDeniedError();
    }
    const read = await readBoundedBody(response, maxBytes, controller.signal);
    if (!read.ok && read.failure === "too_large") {
      state.lastFailed = true;
      record("too_large", response.status, null);
      trip("response_too_large");
      throw new GuardDeniedError();
    }
    if (!read.ok) {
      state.lastFailed = true;
      record("network_failure", response.status, null);
      throw new GuardDispatchFailure();
    }
    const text = read.text;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const hasResult = isPlainObject(body) && "result" in body && !("error" in body);
    const rpcError = isPlainObject(body) && isPlainObject(body.error) ? SAFE_INTEGER_CODE(body.error.code) : null;
    const kind: ResponseKind = !response.ok ? "http_error" : hasResult ? "result" : isPlainObject(body) && isPlainObject(body.error) ? "rpc_error" : "malformed";
    state.lastFailed = kind !== "result";
    record(kind, response.status, rpcError);
    if (kind === "result") onResult(slot, (body as Record<string, unknown>).result);
    // Only the content type is passed back: in particular a Retry-After header is dropped, so viem cannot schedule an
    // uncapped wait (its retry is refused here regardless).
    const contentType = response.headers.get("content-type") ?? "application/json";
    return new Response(response.status === 204 || response.status === 205 ? null : text, { status: response.status, headers: { "content-type": contentType } });
  }

  function blockedConstructor(name: string) {
    return function BlockedEgress() {
      records.push({ seq: ++seq, phase, endpoint: null, method: name, slot: null, outcome: "denied", reason: sealed ? "sealed" : "egress_api_blocked" });
      if (!sealed) trip("egress_api_blocked");
      throw new GuardDeniedError();
    };
  }

  const PHASE_ORDER: readonly Phase[] = ["idle", "pre", "prepare", "post"];
  return {
    fetch: guardedFetch as unknown as typeof fetch,
    blockedConstructor,
    tripped,
    signal: controller.signal,
    setPhase(next: PlannedPhase) {
      if (PHASE_ORDER.indexOf(next) <= PHASE_ORDER.indexOf(phase)) throw new Error(`${RUNNER_NAME}: phases only move forward`);
      phase = next;
    },
    setPostNonceKey(key: bigint) {
      postNonceKey = key;
    },
    hasTripped: () => trips.length > 0,
    seal() {
      sealed = true;
      clearTimeout(timer);
      controller.abort();
    },
    snapshot() {
      return {
        records: records.map((r) => ({ ...r })),
        trips: [...trips],
        totals: { ...totals },
        usage: Object.fromEntries([...usage].map(([id, state]) => [id, state.used])) as Record<string, number>,
        shapes: { ...shapes },
        stubIsFinal,
        stubHadStringPaymaster,
        observedNonce,
      };
    },
  };
}

const GUARDED_GLOBALS = ["WebSocket", "EventSource", "XMLHttpRequest"] as const;

/**
 * Installs the guard on globalThis.fetch and replaces the other browser-style
 * egress constructors with ones that trip it. Unlocked (the simulated
 * self-test), it returns a restore function. Locked (every live run), each
 * property is installed non-writable and non-configurable, so later code can
 * neither assign, redefine nor delete it, and the returned function refuses:
 * a locked guard is never uninstalled. `target` exists so the self-test can
 * exercise the locked form on a throwaway object instead of its own globals.
 */
export function installGuard(guard: NetworkGuard, options: { lock?: boolean; target?: object } = {}): () => void {
  const target = (options.target ?? globalThis) as Record<string, unknown>;
  const lock = options.lock === true;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ["fetch", ...GUARDED_GLOBALS]) saved.set(name, Object.getOwnPropertyDescriptor(target, name));
  const property = (value: unknown): PropertyDescriptor => ({ value, configurable: !lock, writable: !lock, enumerable: true });
  Object.defineProperty(target, "fetch", property(guard.fetch));
  for (const name of GUARDED_GLOBALS) Object.defineProperty(target, name, property(guard.blockedConstructor(name)));
  if (lock) {
    return () => {
      throw new Error(`${RUNNER_NAME}: a locked guard is never uninstalled`);
    };
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else delete target[name];
    }
  };
}

/** True only when every guarded property on `target` is the guard's own, non-writable and non-configurable. */
export function guardIsLocked(guard: NetworkGuard, target: object = globalThis): boolean {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(target, "fetch");
  if (!fetchDescriptor || fetchDescriptor.value !== guard.fetch || fetchDescriptor.writable !== false || fetchDescriptor.configurable !== false) return false;
  return GUARDED_GLOBALS.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    return descriptor !== undefined && typeof descriptor.value === "function" && descriptor.writable === false && descriptor.configurable === false;
  });
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type Verdict = "PASS" | "FAIL-COMPAT" | "FAIL-SAFETY" | "INCONCLUSIVE";
export type PreparationOutcome = "not_run" | "ok" | "integrity_error" | "calldata_mismatch" | "other_error" | "aborted_by_guard";
export type VerdictInput = {
  trips: readonly TripReason[];
  preconditionFailures: readonly string[];
  stageFailures: readonly string[];
  preparation: PreparationOutcome;
  /** Every request in the prepare phase was dispatched (none denied) and got a successful (HTTP 2xx, JSON-RPC result) answer. */
  prepareResponsesAllSuccessful: boolean;
  /** Every request that WAS dispatched in the prepare phase got a successful answer (denied attempts are not counted). */
  prepareDispatchedAllSuccessful: boolean;
  /** Whether the successful stub answer carried a string `paymaster` (null: no successful stub answer was observed). */
  stubHadStringPaymaster: boolean | null;
  /**
   * EVERY request the guard denied, in order: the slot it matched (null when
   * none) and the fixed denial reason. The trip list alone is not enough: once
   * the guard has tripped, later attempts are denied as already_tripped without
   * adding a trip.
   */
  deniedRequests: readonly { slot: string | null; reason: string }[];
  independentCheckFailures: readonly string[];
  postStateChanges: readonly string[];
  evidenceComplete: boolean;
};

/**
 * Precedence: FAIL-SAFETY (a safety trip, an independent-check breach on a
 * returned result, or changed post-run state) > INCONCLUSIVE (anything that
 * leaves the observation incomplete or unattributable) > FAIL-COMPAT (an
 * L-1a / callData refusal of honest, complete provider answers) > PASS.
 *
 * Interrupted stub reentry. When a successful stub answer carries no string
 * `paymaster`, the installed viem asks for the stub again from inside gas
 * estimation. The guard refuses that repeat before dispatch, so the
 * preparation never completes and L-1a's validator is never reached: the
 * observation says nothing about whether L-1a accepts or rejects any provider
 * answer. It is therefore never FAIL-COMPAT and never PASS.
 *
 * The diagnostic reasons (stub_response_lacked_paymaster,
 * initial_stub_response_observed, l1a_validation_not_reached and, when the
 * post-run state could not be read, post_state_not_observed) are attached only
 * when ALL of these hold: a successful stub answer lacked a string paymaster;
 * the prepare-phase answers that were dispatched all succeeded; the guard
 * denied EXACTLY ONE request in the whole run; that request matched slot
 * prepare.pimlico.stub and was refused as stub_repeat_blocked; and no trip
 * other than stub_repeat_blocked occurred. Any additional denied request
 * (including an already_tripped one), any other trip, a failed stub answer or
 * a stub repeat after a stub that did carry a paymaster is NOT given the
 * diagnostic: it is INCONCLUSIVE with stub_repeat_unexplained (and
 * additional_denied_requests when more than the one expected denial exists).
 * Known safety breaches keep their FAIL-SAFETY precedence. None of this says
 * what the real provider does; only a live observation can.
 */
export function classifyVerdict(input: VerdictInput): { verdict: Verdict; reasons: string[] } {
  const safety = [
    ...input.trips.filter(isSafetyTrip).map((t) => `guard:${t}`),
    ...input.independentCheckFailures.map((c) => `check_failed:${c}`),
    ...input.postStateChanges.map((c) => `post_state_changed:${c}`),
  ];
  if (safety.length > 0) return { verdict: "FAIL-SAFETY", reasons: [...new Set(safety)] };
  const stubRepeatTripped = input.trips.includes("stub_repeat_blocked");
  const onlyDenial = input.deniedRequests.length === 1 ? input.deniedRequests[0]! : null;
  const interruptedStubReentry =
    stubRepeatTripped &&
    input.stubHadStringPaymaster === false &&
    input.prepareDispatchedAllSuccessful &&
    input.trips.every((t) => t === "stub_repeat_blocked") &&
    onlyDenial !== null &&
    onlyDenial.slot === "prepare.pimlico.stub" &&
    onlyDenial.reason === "stub_repeat_blocked";
  const compatError = input.preparation === "integrity_error" || input.preparation === "calldata_mismatch";
  const inconclusive = [
    ...input.trips.filter((t) => !isSafetyTrip(t)).map((t) => `guard:${t}`),
    ...(stubRepeatTripped && !interruptedStubReentry ? ["stub_repeat_unexplained"] : []),
    ...(stubRepeatTripped && !interruptedStubReentry && input.deniedRequests.length > 1 ? ["additional_denied_requests"] : []),
    ...(interruptedStubReentry
      ? ["stub_response_lacked_paymaster", "initial_stub_response_observed", "l1a_validation_not_reached", ...(input.evidenceComplete ? [] : ["post_state_not_observed"])]
      : []),
    ...input.preconditionFailures.map((p) => `precondition_failed:${p}`),
    ...input.stageFailures,
    ...(input.preparation === "other_error" ? ["preparation_error_unclassified"] : []),
    ...(input.preparation === "aborted_by_guard" ? ["preparation_aborted_by_guard"] : []),
    ...(input.preparation === "not_run" ? ["preparation_not_run"] : []),
    ...(compatError && !input.prepareResponsesAllSuccessful ? ["compat_refusal_after_unsuccessful_provider_answer"] : []),
    ...(input.evidenceComplete ? [] : ["evidence_incomplete"]),
  ];
  if (inconclusive.length > 0) return { verdict: "INCONCLUSIVE", reasons: [...new Set(inconclusive)] };
  if (input.preparation === "integrity_error") return { verdict: "FAIL-COMPAT", reasons: ["l1a_structural_integrity_refused_honest_answers"] };
  if (input.preparation === "calldata_mismatch") return { verdict: "FAIL-COMPAT", reasons: ["calldata_binding_refused_honest_answers"] };
  if (input.preparation === "ok") return { verdict: "PASS", reasons: [] };
  return { verdict: "INCONCLUSIVE", reasons: ["unclassified"] };
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

type PimlicoModule = typeof import("@/lib/real/server/pimlico");
type SafeModule = typeof import("@/lib/real/account/safe");
type ConstantsModule = typeof import("@/lib/real/constants");
export type ProductionDeps = {
  pimlico: Pick<PimlicoModule, "prepareCashTransferUserOperation" | "PreparedUserOperationIntegrityError" | "PreparedCallDataMismatchError">;
  safe: Pick<SafeModule, "createRealSafeAccount" | "createReadOnlyOwnerAccount">;
  constants: Pick<ConstantsModule, "REAL_CASH_TOKEN" | "REAL_SAFE" | "BASE_SEPOLIA_CHAIN_ID">;
};

export type PreparedSummary = {
  fieldNames: string[];
  numeric: Record<string, { type: string; bits: number | null }>;
  nonce: { keyBits: number; sequenceBits: number } | null;
  factoryPresent: boolean;
  paymaster: { address: HexShape["address"]; digest16: string } | null;
  paymasterData: { byteLength: number | null; digest16: string } | null;
};

export type CompatReport = {
  harness: typeof RUNNER_NAME;
  harnessVersion: number;
  evidenceKind: "live-provider-observation" | "simulated-offline-self-test";
  simulated: boolean;
  scenario: "A-deployed-safe";
  runId: string;
  startedAt: string;
  durationMs: number;
  verdict: Verdict;
  reasons: string[];
  preconditions: Record<string, boolean>;
  preparation: { outcome: PreparationOutcome; errorName: string | null };
  checks: Record<string, boolean>;
  postState: Record<string, boolean>;
  network: {
    totals: Record<Endpoint, number>;
    ceilings: Record<Endpoint, number>;
    usage: Record<string, number>;
    expectedUsage: Record<string, number>;
    trips: TripReason[];
    deniedAttempts: number;
    records: RequestRecord[];
  };
  responseShapes: Record<string, Shape>;
  prepared: PreparedSummary | null;
};

export type ObserveInput = {
  mode: "live" | "simulated";
  authorization?: LiveAuthorization;
  inputs: CompatInputs;
  underlyingFetch: FetchLike;
  /** From preflightEvidence: REQUIRED for a live observation (whose run id it fixes); optional for a simulated one. */
  evidencePlan?: EvidencePlan;
  /** Called only AFTER the guard is installed. */
  loadDeps: () => Promise<ProductionDeps>;
  wallClockMs?: number;
  now?: () => number;
};

export type Observation = {
  report: CompatReport;
  /** Self-test only: the live runner keeps the sealed guard installed for the rest of the process. */
  uninstall: () => void;
  /** Settles once every production promise this run started has settled (late retries included). */
  settled: Promise<void>;
};

/** Strings that must never appear in a report or evidence file, per report. Never exported. */
const LEAK_PROBES = new WeakMap<CompatReport, readonly string[]>();

const ERROR_NAMES = new Set([
  "AbortError",
  "CallExecutionError",
  "ContractFunctionExecutionError",
  "ContractFunctionRevertedError",
  "EstimateUserOperationGasError",
  "GuardDeniedError",
  "GuardDispatchFailure",
  "HttpRequestError",
  "InternalRpcError",
  "InvalidParamsRpcError",
  "LimitExceededRpcError",
  "MethodNotFoundRpcError",
  "MethodNotSupportedRpcError",
  "RangeError",
  "ResourceUnavailableRpcError",
  "RpcRequestError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "UnknownRpcError",
  "UserOperationExecutionError",
]);
/** An error's class name when it is one of the fixed library/runtime names above — never a message, cause or stack. */
export function safeErrorName(error: unknown): string {
  return error instanceof Error && ERROR_NAMES.has(error.name) ? error.name : "UnlistedError";
}

const U128 = (BigInt(1) << BigInt(128)) - BigInt(1);
const U256 = (BigInt(1) << BigInt(256)) - BigInt(1);
const NUMERIC_WIDTHS: Record<string, bigint> = {
  nonce: U256,
  callGasLimit: U128,
  verificationGasLimit: U128,
  preVerificationGas: U256,
  maxFeePerGas: U128,
  maxPriorityFeePerGas: U128,
  paymasterVerificationGasLimit: U128,
  paymasterPostOpGasLimit: U128,
};
const PREPARED_FIELDS = new Set([
  "sender",
  "nonce",
  "factory",
  "factoryData",
  "callData",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "paymaster",
  "paymasterData",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
]);

/** The harness's own checks on a result production already accepted. Any false here is a safety breach, not a compat failure. */
export function independentChecks(prepared: unknown, context: { inputs: CompatInputs; expectedCallData: Hex; observedNonce: bigint | null }): Record<string, boolean> {
  const p = isPlainObject(prepared) ? prepared : {};
  const checks: Record<string, boolean> = {};
  checks.no_unexpected_fields = isPlainObject(prepared) && Object.keys(p).every((key) => PREPARED_FIELDS.has(key));
  checks.sender_matches = typeof p.sender === "string" && isAddress(p.sender, { strict: false }) && getAddress(p.sender) === context.inputs.safe;
  checks.nonce_matches_chain_read = typeof p.nonce === "bigint" && context.observedNonce !== null && p.nonce === context.observedNonce;
  checks.factory_absent = p.factory === undefined && p.factoryData === undefined;
  checks.calldata_matches_independent_encoding = p.callData === context.expectedCallData;
  let call = { target: false, value: false, operation: false, transfer: false, recipient: false, amount: false };
  try {
    const outer = decodeFunctionData({ abi: SAFE_4337_EXECUTE_ABI, data: p.callData as Hex });
    const [to, value, data, operation] = outer.args;
    const inner = decodeFunctionData({ abi: ERC20_ABI, data });
    call = {
      target: getAddress(to) === getAddress(PINNED.cashToken),
      value: value === BigInt(0),
      operation: operation === 0,
      transfer: inner.functionName === "transfer",
      recipient: inner.functionName === "transfer" && getAddress(inner.args[0]) === context.inputs.recipient,
      amount: inner.functionName === "transfer" && inner.args[1] === BigInt(context.inputs.amountBaseUnits),
    };
  } catch {
    // every decoded field stays false
  }
  checks.call_target_is_cash_token = call.target;
  checks.call_value_zero = call.value;
  checks.call_operation_is_call = call.operation;
  checks.inner_call_is_transfer = call.transfer;
  checks.recipient_matches = call.recipient;
  checks.amount_matches = call.amount;
  checks.paymaster_present_nonzero = typeof p.paymaster === "string" && /^0x[0-9a-fA-F]{40}$/.test(p.paymaster) && !/^0x0{40}$/.test(p.paymaster);
  checks.paymaster_data_whole_bytes = typeof p.paymasterData === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(p.paymasterData);
  checks.numeric_fields_bigint_within_width = Object.entries(NUMERIC_WIDTHS).every(([field, max]) => typeof p[field] === "bigint" && (p[field] as bigint) >= BigInt(0) && (p[field] as bigint) <= max);
  return checks;
}

function summarizePrepared(prepared: Record<string, unknown>): PreparedSummary {
  const numeric: PreparedSummary["numeric"] = {};
  for (const field of Object.keys(NUMERIC_WIDTHS)) {
    const value = prepared[field];
    numeric[field] = { type: typeof value, bits: typeof value === "bigint" && value >= BigInt(0) ? bitsOf(value) : null };
  }
  const nonce = prepared.nonce;
  const mask64 = (BigInt(1) << BigInt(64)) - BigInt(1);
  return {
    fieldNames: Object.keys(prepared).sort(),
    numeric,
    nonce: typeof nonce === "bigint" && nonce >= BigInt(0) ? { keyBits: bitsOf(nonce >> BigInt(64)), sequenceBits: bitsOf(nonce & mask64) } : null,
    factoryPresent: prepared.factory !== undefined || prepared.factoryData !== undefined,
    paymaster: typeof prepared.paymaster === "string" ? { address: describeHex(prepared.paymaster)?.address ?? null, digest16: digest16(prepared.paymaster) } : null,
    paymasterData: typeof prepared.paymasterData === "string" ? { byteLength: describeHex(prepared.paymasterData)?.byteLength ?? null, digest16: digest16(prepared.paymasterData) } : null,
  };
}

/** Every string a report must never contain for these inputs (and, when known, the prepared byte fields). */
function leakProbesFor(inputs: CompatInputs, extra: readonly unknown[]): string[] {
  const url = new URL(inputs.chainRpcUrl);
  const addresses = [inputs.safe, inputs.owner, inputs.recipient].flatMap((a) => [a, a.toLowerCase(), a.slice(2).toLowerCase()]);
  const probes = [inputs.pimlicoApiKey, inputs.chainRpcUrl, url.href, url.host, url.pathname, url.search, "apikey", ...addresses, ...extra.filter((v): v is string => typeof v === "string")];
  return [...new Set(probes.filter((p) => p.length >= 6 && p !== "/"))];
}

export function findsLeak(text: string, probes: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return probes.some((probe) => haystack.includes(probe.toLowerCase()));
}

/**
 * The first reason an observation's mode, authorization, transport and
 * evidence plan do not belong together, or null. Pure: it never calls the
 * transport. Order for a live run: authorization, then transport, then the
 * evidence preflight plan.
 */
export function observationPairingProblem(input: Pick<ObserveInput, "mode" | "authorization" | "inputs" | "underlyingFetch" | "evidencePlan">): string | null {
  if (input.mode === "live") {
    if (!input.authorization || !ISSUED_AUTHORIZATIONS.has(input.authorization)) return "a live observation needs the authorization issued by requireLiveAuthorization";
    if (input.authorization.inputs !== input.inputs) return "a live observation must use exactly the authorized inputs";
    if (input.underlyingFetch !== PLATFORM_FETCH) return "a live observation dispatches only through the platform fetch captured at load; a substituted transport is refused";
    if (!input.evidencePlan || !ISSUED_PLANS.has(input.evidencePlan) || input.evidencePlan.simulated) return "a live observation needs a passed live evidence preflight (preflightEvidence) before any request";
    return null;
  }
  if (input.mode !== "simulated") return "unknown observation mode";
  if (input.authorization !== undefined) return "a simulated observation must not carry a live authorization";
  if (input.underlyingFetch === PLATFORM_FETCH) return "a simulated observation must use a fake transport, never the platform fetch";
  if (input.evidencePlan !== undefined && (!ISSUED_PLANS.has(input.evidencePlan) || !input.evidencePlan.simulated)) return "a simulated observation may carry only a simulated evidence plan issued by preflightEvidence";
  return null;
}

/**
 * Runs ONE observation. Refusals (wrong mode/transport/authorization/evidence
 * pairing, malformed inputs, a live guard that did not lock, production
 * constants that differ from PINNED) throw a CompatRefusal before the guard
 * dispatches anything. Everything after that is captured into the report: no
 * library error, message or stack escapes, and every production promise is
 * caught so none can surface later as an unhandled rejection.
 */
export async function observeCompatibility(input: ObserveInput): Promise<Observation> {
  const pairing = observationPairingProblem(input);
  if (pairing) throw new CompatRefusal(pairing);
  const problem = inputsProblem(input.inputs);
  if (problem) throw new CompatRefusal(problem);

  const live = input.mode === "live";
  const inputs = input.inputs;
  const now = input.now ?? (() => Date.now());
  const started = now();
  const runId = input.evidencePlan ? input.evidencePlan.runId : randomBytes(4).toString("hex");
  const expectedCallData = encodeExpectedCallData(inputs.recipient, BigInt(inputs.amountBaseUnits));
  const guard = createNetworkGuard({
    underlying: input.underlyingFetch,
    chainRpcUrl: inputs.chainRpcUrl,
    pimlicoApiKey: inputs.pimlicoApiKey,
    safe: inputs.safe,
    expectedCallData,
    wallClockMs: input.wallClockMs ?? WALL_CLOCK_MS,
    now,
  });
  let uninstall: () => void;
  try {
    uninstall = installGuard(guard, { lock: live });
  } catch {
    guard.seal();
    throw new CompatRefusal("the network guard could not be installed");
  }
  if (live && !guardIsLocked(guard)) {
    guard.seal();
    throw new CompatRefusal("the network guard could not be locked in place");
  }
  const background: Promise<unknown>[] = [];

  let deps: ProductionDeps;
  try {
    deps = await input.loadDeps();
  } catch {
    guard.seal();
    throw new CompatRefusal("the production modules could not be loaded");
  }
  const constantsMatch =
    deps.constants.BASE_SEPOLIA_CHAIN_ID === PINNED.chainId &&
    getAddress(deps.constants.REAL_CASH_TOKEN.address) === getAddress(PINNED.cashToken) &&
    getAddress(deps.constants.REAL_SAFE.proxyFactoryAddress) === getAddress(PINNED.proxyFactory) &&
    getAddress(deps.constants.REAL_SAFE.entryPoint.address) === getAddress(PINNED.entryPoint) &&
    getAddress(entryPoint07Address) === getAddress(PINNED.entryPoint) &&
    deps.constants.REAL_SAFE.entryPoint.version === "0.7";
  if (!constantsMatch) {
    guard.seal();
    throw new CompatRefusal("the production chain, Cash token, EntryPoint or Safe factory constants differ from the values this harness was written against");
  }

  // Created after the guard: its transport resolves `fetch` per request either way. No retries, no CCIP-read lookups.
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(inputs.chainRpcUrl, { retryCount: 0 }), ccipRead: false });

  type Step<T> = { ok: true; value: T } | { ok: false; tripped: boolean };
  async function step<T>(work: () => Promise<T>): Promise<Step<T>> {
    let promise: Promise<T>;
    try {
      promise = work();
    } catch {
      return { ok: false, tripped: guard.hasTripped() };
    }
    background.push(promise.then(noop, noop));
    const halted = {};
    const winner = await Promise.race([promise.then((value) => ({ value }), () => null), guard.tripped.then(() => halted)]);
    if (guard.hasTripped() || winner === halted) return { ok: false, tripped: true };
    if (winner === null) return { ok: false, tripped: false };
    return { ok: true, value: (winner as { value: T }).value };
  }

  const preconditions: Record<string, boolean> = {};
  const stageFailures: string[] = [];
  const checks: Record<string, boolean> = {};
  const postState: Record<string, boolean> = {};
  let preparation: PreparationOutcome = "not_run";
  let errorName: string | null = null;
  let prepared: Record<string, unknown> | null = null;
  let preComplete = false;
  let postComplete = false;

  const before: { codeHash?: Hex; balance?: bigint } = {};
  const holds = (name: string, ok: boolean) => {
    preconditions[name] = ok;
    return ok;
  };
  guard.setPhase("pre");
  pre: {
    const read = async <T,>(work: () => Promise<T>): Promise<{ value: T } | null> => {
      const result = await step(work);
      if (result.ok) return { value: result.value };
      if (!result.tripped) stageFailures.push("pre_read_failed");
      return null;
    };
    const chainId = await read(() => publicClient.getChainId());
    if (!chainId || !holds("chain_id_is_base_sepolia", chainId.value === PINNED.chainId)) break pre;
    const entryPointCode = await read(() => publicClient.getCode({ address: PINNED.entryPoint }));
    if (!entryPointCode || !holds("entry_point_has_code", typeof entryPointCode.value === "string" && entryPointCode.value.length > 2)) break pre;
    const derived = await read(() => deps.safe.createRealSafeAccount({ owner: deps.safe.createReadOnlyOwnerAccount(inputs.owner), publicClient }));
    if (!derived || !holds("safe_derives_from_owner", getAddress(derived.value.address) === inputs.safe)) break pre;
    const safeCode = await read(() => publicClient.getCode({ address: inputs.safe }));
    if (!safeCode || !holds("safe_is_deployed", typeof safeCode.value === "string" && safeCode.value.length > 2)) break pre;
    before.codeHash = keccak256(safeCode.value as Hex);
    const owners = await read(() => publicClient.readContract({ address: inputs.safe, abi: SAFE_READ_ABI, functionName: "getOwners" }));
    if (!owners || !holds("single_expected_owner", owners.value.length === 1 && getAddress(owners.value[0]) === inputs.owner)) break pre;
    const threshold = await read(() => publicClient.readContract({ address: inputs.safe, abi: SAFE_READ_ABI, functionName: "getThreshold" }));
    if (!threshold || !holds("threshold_is_one", threshold.value === BigInt(1))) break pre;
    const balance = await read(() => publicClient.readContract({ address: PINNED.cashToken, abi: ERC20_ABI, functionName: "balanceOf", args: [inputs.safe] }));
    if (!balance || !holds("cash_balance_covers_amount", balance.value >= BigInt(inputs.amountBaseUnits))) break pre;
    before.balance = balance.value;
    preComplete = true;
  }

  if (preComplete && !guard.hasTripped()) {
    guard.setPhase("prepare");
    let caught: unknown;
    const result = await step(() =>
      deps.pimlico
        .prepareCashTransferUserOperation({ publicClient, pimlicoApiKey: inputs.pimlicoApiKey, ownerAddress: inputs.owner, recipient: inputs.recipient, amountBaseUnits: inputs.amountBaseUnits })
        .catch((error: unknown) => {
          caught = error;
          throw error;
        }),
    );
    if (result.ok) {
      preparation = "ok";
      prepared = result.value as unknown as Record<string, unknown>;
    } else if (result.tripped) {
      preparation = "aborted_by_guard";
      errorName = caught === undefined ? null : safeErrorName(caught);
    } else {
      preparation =
        caught instanceof deps.pimlico.PreparedUserOperationIntegrityError ? "integrity_error" : caught instanceof deps.pimlico.PreparedCallDataMismatchError ? "calldata_mismatch" : "other_error";
      errorName = preparation === "integrity_error" ? "PreparedUserOperationIntegrityError" : preparation === "calldata_mismatch" ? "PreparedCallDataMismatchError" : safeErrorName(caught);
    }
    if (prepared) {
      Object.assign(checks, independentChecks(prepared, { inputs, expectedCallData, observedNonce: guard.snapshot().observedNonce }));
      if (typeof prepared.nonce === "bigint") guard.setPostNonceKey(prepared.nonce >> BigInt(64));
    }

    if (!guard.hasTripped()) {
      guard.setPhase("post");
      post: {
        const read = async <T,>(work: () => Promise<T>): Promise<{ value: T } | null> => {
          const r = await step(work);
          if (r.ok) return { value: r.value };
          if (!r.tripped) stageFailures.push("post_read_failed");
          return null;
        };
        const code = await read(() => publicClient.getCode({ address: inputs.safe }));
        if (!code) break post;
        postState.safe_code_unchanged = keccak256((code.value ?? "0x") as Hex) === before.codeHash;
        if (prepared && typeof prepared.nonce === "bigint") {
          const preparedNonce = prepared.nonce;
          const nonce = await read(() => publicClient.readContract({ address: PINNED.entryPoint, abi: ENTRY_POINT_ABI, functionName: "getNonce", args: [inputs.safe, preparedNonce >> BigInt(64)] }));
          if (!nonce) break post;
          postState.entry_point_nonce_unchanged = nonce.value === preparedNonce;
        }
        const balance = await read(() => publicClient.readContract({ address: PINNED.cashToken, abi: ERC20_ABI, functionName: "balanceOf", args: [inputs.safe] }));
        if (!balance) break post;
        postState.cash_balance_unchanged = balance.value === before.balance;
        postComplete = true;
      }
    }
  }

  guard.seal();
  const snapshot = guard.snapshot();
  const expected = expectedUsage(snapshot.stubIsFinal);
  const prepareRecords = snapshot.records.filter((r) => r.phase === "prepare");
  const prepareResponsesAllSuccessful = prepareRecords.length > 0 && prepareRecords.every((r) => r.outcome === "dispatched" && r.response === "result");
  const prepareDispatched = prepareRecords.filter((r) => r.outcome === "dispatched");
  const prepareDispatchedAllSuccessful = prepareDispatched.length > 0 && prepareDispatched.every((r) => r.outcome === "dispatched" && r.response === "result");
  const deniedRequests = snapshot.records.flatMap((r) => (r.outcome === "denied" ? [{ slot: r.slot, reason: r.reason }] : []));
  const preAndPostUsedOnce = (ids: string[]) => ids.every((id) => snapshot.usage[id] === 1);
  const evidenceComplete =
    preparation === "ok"
      ? postComplete && Object.keys(expected).every((id) => snapshot.usage[id] === expected[id])
      : preparation === "integrity_error" || preparation === "calldata_mismatch"
        ? preComplete &&
          postComplete &&
          prepareResponsesAllSuccessful &&
          preAndPostUsedOnce(REQUEST_PLAN.filter((p) => p.phase === "pre").map((p) => p.id)) &&
          preAndPostUsedOnce(["post.code.safe", "post.call.balanceOf"])
        : false;

  const { verdict, reasons } = classifyVerdict({
    trips: snapshot.trips,
    preconditionFailures: Object.entries(preconditions)
      .filter(([, ok]) => !ok)
      .map(([name]) => name),
    stageFailures: [...new Set(stageFailures)],
    preparation,
    prepareResponsesAllSuccessful,
    prepareDispatchedAllSuccessful,
    stubHadStringPaymaster: snapshot.stubHadStringPaymaster,
    deniedRequests,
    independentCheckFailures: Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name),
    postStateChanges: Object.entries(postState)
      .filter(([, ok]) => !ok)
      .map(([name]) => name),
    evidenceComplete,
  });

  const simulated = !live;
  const report: CompatReport = {
    harness: RUNNER_NAME,
    harnessVersion: HARNESS_VERSION,
    evidenceKind: simulated ? "simulated-offline-self-test" : "live-provider-observation",
    simulated,
    scenario: "A-deployed-safe",
    runId,
    startedAt: new Date(started).toISOString(),
    durationMs: Math.max(0, now() - started),
    verdict,
    reasons,
    preconditions,
    preparation: { outcome: preparation, errorName },
    checks,
    postState,
    network: {
      totals: snapshot.totals,
      ceilings: { ...REQUEST_CEILINGS },
      usage: snapshot.usage,
      expectedUsage: expected,
      trips: snapshot.trips,
      deniedAttempts: snapshot.records.filter((r) => r.outcome === "denied").length,
      records: snapshot.records,
    },
    responseShapes: snapshot.shapes,
    prepared: prepared ? summarizePrepared(prepared) : null,
  };

  const probes = leakProbesFor(inputs, [expectedCallData, prepared?.callData, prepared?.factoryData, typeof prepared?.paymasterData === "string" && prepared.paymasterData.length >= 10 ? prepared.paymasterData : undefined]);
  const finalReport = findsLeak(JSON.stringify(report), probes) ? withheld(report) : report;
  LEAK_PROBES.set(finalReport, probes);
  return { report: finalReport, uninstall, settled: Promise.all(background).then(noop, noop) };
}

function noop() {
  return undefined;
}

/** The report reduced to its verdict when a leak probe matched — fail closed, never print the suspect content. */
function withheld(report: CompatReport): CompatReport {
  return {
    ...report,
    verdict: "INCONCLUSIVE",
    reasons: ["report_withheld_sensitive_value_detected"],
    preconditions: {},
    checks: {},
    postState: {},
    network: { ...report.network, records: [] },
    responseShapes: {},
    prepared: null,
  };
}

/** The one printable rendering of a report. Refuses (returns a fixed line) if the report did not come from observeCompatibility or would leak. */
export function printableReport(report: CompatReport): string {
  const probes = LEAK_PROBES.get(report);
  const label = report.simulated ? `SIMULATED ${report.verdict} (offline fakes; NOT provider evidence)` : `LIVE ${report.verdict}`;
  if (!probes) return `[${RUNNER_NAME}] report withheld: not produced by this harness`;
  const json = JSON.stringify({ label, ...report }, null, 2);
  return findsLeak(json, probes) ? `[${RUNNER_NAME}] report withheld: a sensitive value was detected` : json;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** The filesystem operations evidence handling uses. Injectable for the offline self-test only; a live report always uses Node's. */
export type EvidenceFs = {
  readFileSync: (file: string, encoding: "utf8") => string;
  lstatSync: (file: string) => { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean; mode: number; uid: number; ino: number; dev: number };
  realpathSync: (file: string) => string;
  accessSync: (file: string, mode: number) => void;
  openSync: (file: string, flags: string, mode: number) => number;
  fstatSync: (fd: number) => { isFile(): boolean; mode: number; ino: number; dev: number };
  writeFileSync: (fd: number, data: string) => void;
  fsyncSync: (fd: number) => void;
  closeSync: (fd: number) => void;
  unlinkSync: (file: string) => void;
};

export const NODE_EVIDENCE_FS: EvidenceFs = Object.freeze({
  readFileSync: (file: string, encoding: "utf8") => readFileSync(file, encoding),
  lstatSync: (file: string) => lstatSync(file),
  realpathSync: (file: string) => realpathSync(file),
  accessSync: (file: string, mode: number) => accessSync(file, mode),
  openSync: (file: string, flags: string, mode: number) => openSync(file, flags, mode),
  fstatSync: (fd: number) => fstatSync(fd),
  writeFileSync: (fd: number, data: string) => writeFileSync(fd, data),
  fsyncSync: (fd: number) => fsyncSync(fd),
  closeSync: (fd: number) => closeSync(fd),
  unlinkSync: (file: string) => unlinkSync(file),
});

/** Where ONE run's evidence will go, issued only by a passed preflightEvidence. */
export type EvidencePlan = Readonly<{ kind: "evidence-plan"; simulated: boolean; root: string; runId: string; file: string }>;
const ISSUED_PLANS = new WeakSet<object>();

const evidenceFileName = (runId: string, simulated: boolean) => `pimlico-prepare-compat-${runId}${simulated ? "-SIMULATED" : ""}.json`;
const errorCode = (error: unknown) => (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : null);

/**
 * The first reason <root>/evidence/<file for runId> is not a safe, unused
 * destination, or null. Read-only: it reads .gitignore and stats paths; it
 * never creates, writes, renames or removes anything. Reasons are fixed codes
 * (never a path or a filesystem message). A live destination must be the
 * repository (the working directory); a simulated one must not be.
 */
function evidenceDestinationProblem(fs: EvidenceFs, root: string, simulated: boolean, runId: string): string | null {
  const repository = path.resolve(process.cwd());
  if (simulated && root === repository) return "simulated_report_refused_in_repository";
  if (!simulated && root !== repository) return "live_evidence_only_in_repository";
  if (!/^[0-9a-f]{8}$/.test(runId)) return "run_id_malformed";
  let lines: string[];
  try {
    lines = fs
      .readFileSync(path.join(root, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim());
  } catch {
    return "evidence_directory_not_ignored";
  }
  // The exact rule must be present and nothing may re-include part of it.
  if (!lines.includes("/evidence/") || lines.some((line) => line.startsWith("!") && line.includes("evidence"))) return "evidence_directory_not_ignored";
  const directory = path.join(root, "evidence");
  let stat: ReturnType<EvidenceFs["lstatSync"]>;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    return "evidence_directory_missing";
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return "evidence_directory_not_a_real_directory";
  try {
    if (fs.realpathSync(directory) !== path.join(fs.realpathSync(root), "evidence")) return "evidence_directory_outside_repository";
  } catch {
    return "evidence_directory_outside_repository";
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return "evidence_directory_not_owned_by_this_user";
  if ((stat.mode & 0o022) !== 0) return "evidence_directory_permissions_unsafe";
  try {
    fs.accessSync(directory, fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    return "evidence_directory_not_writable";
  }
  try {
    fs.lstatSync(path.join(directory, evidenceFileName(runId, simulated)));
    return "evidence_file_already_exists";
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return "evidence_destination_unverifiable";
  }
  return null;
}

/**
 * Checks, BEFORE any request, that this run's evidence file can be created
 * where it must go, and fixes the run id it will carry. Read-only (see
 * evidenceDestinationProblem); no network. It cannot prove a later write will
 * succeed — writeEvidence re-checks everything and stays authoritative.
 */
export function preflightEvidence(input: { root: string; simulated: boolean; runId?: string; fs?: EvidenceFs }): { ok: true; plan: EvidencePlan } | { ok: false; reason: string } {
  if (!input.simulated && input.fs !== undefined) return { ok: false, reason: "live_evidence_custom_fs_refused" };
  const fs = input.fs ?? NODE_EVIDENCE_FS;
  const root = path.resolve(input.root);
  const runId = input.runId ?? randomBytes(4).toString("hex");
  const problem = evidenceDestinationProblem(fs, root, input.simulated, runId);
  if (problem) return { ok: false, reason: problem };
  const plan: EvidencePlan = Object.freeze({ kind: "evidence-plan", simulated: input.simulated, root, runId, file: path.join(root, "evidence", evidenceFileName(runId, input.simulated)) });
  ISSUED_PLANS.add(plan);
  return { ok: true, plan };
}

/**
 * Writes ONE evidence file for a report produced by observeCompatibility, at
 * the destination its preflight plan fixed, or refuses with a fixed reason.
 * Re-runs every preflight check first. Exclusive create (never overwrites,
 * never follows a link), mode 0600 verified on the open descriptor BEFORE
 * anything is written into it, written in full and synced, then re-verified
 * on the path. A file this call created but could not complete is removed;
 * nothing else is ever removed.
 */
export function writeEvidence(input: { report: CompatReport; plan: EvidencePlan; authorization?: LiveAuthorization; fs?: EvidenceFs }): { ok: true; file: string } | { ok: false; reason: string } {
  const { report, plan } = input;
  const probes = LEAK_PROBES.get(report);
  if (!probes) return { ok: false, reason: "report_not_from_harness" };
  if (!ISSUED_PLANS.has(plan)) return { ok: false, reason: "evidence_plan_not_from_preflight" };
  if (plan.simulated !== report.simulated || plan.runId !== report.runId) return { ok: false, reason: "evidence_plan_mismatch" };
  if (!report.simulated) {
    if (!input.authorization || !ISSUED_AUTHORIZATIONS.has(input.authorization)) return { ok: false, reason: "live_report_without_authorization" };
    if (input.fs !== undefined) return { ok: false, reason: "live_evidence_custom_fs_refused" };
  }
  const fs = input.fs ?? NODE_EVIDENCE_FS;
  const problem = evidenceDestinationProblem(fs, plan.root, plan.simulated, plan.runId);
  if (problem) return { ok: false, reason: problem };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (findsLeak(json, probes)) return { ok: false, reason: "sensitive_value_detected" };

  let fd: number;
  try {
    fd = fs.openSync(plan.file, "wx", 0o600);
  } catch {
    return { ok: false, reason: "evidence_write_failed" };
  }
  let open = true;
  const close = () => {
    if (open) {
      open = false;
      fs.closeSync(fd);
    }
  };
  const discard = (reason: string): { ok: false; reason: string } => {
    try {
      close();
    } catch {
      // the descriptor is released either way
    }
    try {
      fs.unlinkSync(plan.file);
    } catch {
      return { ok: false, reason: `${reason}_and_cleanup_failed` };
    }
    return { ok: false, reason };
  };
  let opened: ReturnType<EvidenceFs["fstatSync"]>;
  try {
    opened = fs.fstatSync(fd);
  } catch {
    return discard("evidence_write_failed");
  }
  if (!opened.isFile() || (opened.mode & 0o777) !== 0o600) return discard("evidence_mode_not_0600");
  try {
    fs.writeFileSync(fd, json);
    fs.fsyncSync(fd);
    close();
  } catch {
    return discard("evidence_write_failed");
  }
  let after: ReturnType<EvidenceFs["lstatSync"]>;
  try {
    after = fs.lstatSync(plan.file);
  } catch {
    return { ok: false, reason: "evidence_file_unverifiable_after_write" };
  }
  // A different file at the path is not ours to remove.
  if (after.ino !== opened.ino || after.dev !== opened.dev) return { ok: false, reason: "evidence_file_replaced_after_write" };
  if (!after.isFile() || after.isSymbolicLink() || (after.mode & 0o777) !== 0o600) return discard("evidence_mode_not_0600");
  return { ok: true, file: path.relative(plan.root, plan.file) };
}

/** What a live run must achieve to pass: a PASS verdict AND its evidence file written. Fixed codes only. */
export function liveRunResult(report: Pick<CompatReport, "verdict">, written: { ok: true; file: string } | { ok: false; reason: string }): { verdict: Verdict; evidence: string } {
  return { verdict: report.verdict, evidence: written.ok ? "written" : `not_written:${written.reason}` };
}

// ---------------------------------------------------------------------------
// One attempt only (no automatic test retry or repeat)
// ---------------------------------------------------------------------------

/**
 * Pinned on the live test itself. In the installed Vitest 4.1.11 a test's own
 * `retry` wins over the configuration and CLI (`options.retry ??
 * config.retry`), `repeats` comes only from the test or its suite, and test
 * options override suite and tag options.
 */
export const LIVE_TEST_OPTIONS = Object.freeze({ timeout: LIVE_TEST_TIMEOUT_MS, retry: 0, repeats: 0 });

/** null when the running task can only ever be attempted once; otherwise why not. Pure over the task fields Vitest sets. */
export function automaticRerunProblem(task: { retry?: unknown; repeats?: unknown; result?: { retryCount?: unknown; repeatCount?: unknown } | null }): string | null {
  const retry = task.retry;
  const retryCount = retry === undefined ? 0 : typeof retry === "number" ? retry : isPlainObject(retry) ? (retry.count ?? 0) : Number.NaN;
  if (retryCount !== 0) return "automatic test retries are configured for this run; the live observation runs at most once (remove every retry setting)";
  if ((task.repeats ?? 0) !== 0) return "test repeats are configured for this run; the live observation runs at most once";
  if ((task.result?.retryCount ?? 0) !== 0 || (task.result?.repeatCount ?? 0) !== 0) return "this is a repeated attempt of the live test; it is refused";
  return null;
}

/** A one-shot latch: the first claim succeeds, every later claim in this process is refused. */
export function createAttemptLatch(): { claim: () => void; claimed: () => boolean } {
  let used = false;
  return {
    claim() {
      if (used) throw new CompatRefusal("a second live attempt in this process is refused; start a new, separately authorized run instead");
      used = true;
    },
    claimed: () => used,
  };
}
const LIVE_ATTEMPT = createAttemptLatch();

// ---------------------------------------------------------------------------
// The manual runner
// ---------------------------------------------------------------------------

async function loadProductionDeps(): Promise<ProductionDeps> {
  const [pimlico, safe, constants] = await Promise.all([import("@/lib/real/server/pimlico"), import("@/lib/real/account/safe"), import("@/lib/real/constants")]);
  return { pimlico, safe, constants };
}

/** Present (any value) arms the suite; anything short of a complete authorization then FAILS it. Absent: skipped. */
const gatePresent = process.env[GATE_ENV] !== undefined;

describe.skipIf(!gatePresent)("ADMIN (manual, live, separately authorized): observe ONE Pimlico preparation — preparation only, never signs or submits", () => {
  it("classifies honest Pimlico answers against L-1a as PASS / FAIL-COMPAT / FAIL-SAFETY / INCONCLUSIVE", LIVE_TEST_OPTIONS, async ({ task }) => {
    // At most one attempt per process, whatever the configuration says.
    LIVE_ATTEMPT.claim();
    const rerun = automaticRerunProblem(task);
    if (rerun) throw new CompatRefusal(rerun);
    // Every refusal happens here, before the guard exists or production code is loaded.
    const authorization = requireLiveAuthorization({ env: process.env, cliArgs: inject("vitestCliArgs") });
    // Read-only: verifies the evidence destination and fixes the run id. Creates nothing; no network.
    const preflight = preflightEvidence({ root: process.cwd(), simulated: false });
    if (!preflight.ok) throw new CompatRefusal(`the evidence preflight failed (${preflight.reason}); nothing was sent`);
    // Installs (and locks) the guard, THEN loads production code. The guard stays installed (sealed) afterwards.
    const observation = await observeCompatibility({ mode: "live", authorization, inputs: authorization.inputs, underlyingFetch: PLATFORM_FETCH, evidencePlan: preflight.plan, loadDeps: loadProductionDeps });
    console.log(printableReport(observation.report));
    const written = writeEvidence({ report: observation.report, plan: preflight.plan, authorization });
    console.log(written.ok ? `[${RUNNER_NAME}] evidence written: ${written.file}` : `[${RUNNER_NAME}] evidence NOT written: ${written.reason}`);
    // Never retried, never re-observed: a failed write fails this one run.
    expect(liveRunResult(observation.report, written)).toEqual({ verdict: "PASS", evidence: "written" });
  });
});
