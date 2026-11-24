import type { Address } from "viem";
import { BASE_SEPOLIA_CHAIN_ID, REAL_CASH_TOKEN } from "../constants";
import type { RealPublicClient } from "./client";

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

/**
 * M3D server chain-read caller deadline: how long the CALLER waits for the
 * whole of readCashBalance (chain-id check plus both contract reads), on one
 * timer that is never reset between stages. A provisional, approved
 * controlled-development value — not provider-latency calibrated, not an RPC
 * SLA, not a whole-route deadline.
 */
export const CASH_BALANCE_READ_DEADLINE_MS = 15_000;

/**
 * The read could not be established within the deadline. A fixed message —
 * never an RPC URL, key or provider body — and it says nothing about the
 * balance itself: never zero, never absent.
 */
export class CashBalanceReadDeadlineError extends Error {
  constructor() {
    super("The balance read did not finish in time.");
    this.name = "CashBalanceReadDeadlineError";
  }
}

/**
 * Runs one whole read operation under a single caller deadline. The timer is
 * armed before `run` starts any read and cleared as soon as `run` settles
 * first; on expiry the returned promise rejects and a late result or late
 * rejection of `run` is consumed here and never reaches the caller (a promise
 * settles once). `checkpoint` throws once the deadline has fired: `run` calls
 * it after every await, so a late answer can never start another read stage.
 * State is per call. This bounds the caller's wait only — it does not abort
 * an in-flight viem request, which may still finish (or retry) on its own.
 */
function withCashBalanceReadDeadline<T>(run: (checkpoint: () => void) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new CashBalanceReadDeadlineError());
    }, CASH_BALANCE_READ_DEADLINE_MS);
    const checkpoint = () => {
      if (expired) throw new CashBalanceReadDeadlineError();
    };
    run(checkpoint).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type CashBalance = {
  token: "USDC";
  decimals: number;
  /** Exact base-unit amount (uint256, as returned by balanceOf) — a decimal string, never a float. */
  balanceBaseUnits: string;
};

/**
 * A read-only ERC20 balance read for the CASH token, scoped to Base
 * Sepolia and the configured Circle testnet USDC contract — both fixed by
 * REAL_CASH_TOKEN, never by a caller-supplied address. No signing, no
 * Turnkey, no Pimlico, no UserOperation: this only ever calls
 * PublicClient.getChainId/readContract.
 *
 * Validates the RPC endpoint is actually Base Sepolia (a live getChainId
 * call, not just the locally-configured chain object, since a misconfigured
 * BASE_SEPOLIA_RPC_URL could silently point elsewhere) and that the
 * contract's own decimals() still matches REAL_CASH_TOKEN.decimals, so a
 * balance is never silently shown for the wrong network or token.
 *
 * Bounded by CASH_BALANCE_READ_DEADLINE_MS for the whole operation: a missed
 * deadline REJECTS (CashBalanceReadDeadlineError) — it is never a balance,
 * never zero — and every caller already maps a throw to its fixed failure
 * outcome. Ordinary errors before the deadline propagate unchanged.
 */
export function readCashBalance(input: { publicClient: RealPublicClient; safeAddress: Address }): Promise<CashBalance> {
  return withCashBalanceReadDeadline(async (checkpoint) => {
    const chainId = await input.publicClient.getChainId();
    checkpoint();
    if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
      throw new Error(`Expected Base Sepolia (chain id ${BASE_SEPOLIA_CHAIN_ID}), but the configured RPC reports chain id ${chainId}.`);
    }

    const [balanceBaseUnits, decimals] = await Promise.all([
      input.publicClient.readContract({
        address: REAL_CASH_TOKEN.address,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [input.safeAddress],
      }),
      input.publicClient.readContract({
        address: REAL_CASH_TOKEN.address,
        abi: ERC20_BALANCE_ABI,
        functionName: "decimals",
      }),
    ]);
    checkpoint();

    if (decimals !== REAL_CASH_TOKEN.decimals) {
      throw new Error(`Expected ${REAL_CASH_TOKEN.decimals}-decimal USDC, but the contract reports ${decimals} decimals.`);
    }

    return { token: REAL_CASH_TOKEN.symbol, decimals, balanceBaseUnits: balanceBaseUnits.toString() };
  });
}
