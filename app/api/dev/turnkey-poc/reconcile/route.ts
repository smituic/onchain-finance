import { isTurnkeyPocEnabled } from "@/lib/poc/turnkey/config";
import { normalizeHash } from "@/lib/poc/turnkey/identifiers";
import { asErrorMessage, disabledResponse, jsonError, requireServerTurnkeyPocConfig } from "@/lib/poc/turnkey/server/http";
import { pimlicoRpcUrl } from "@/lib/poc/turnkey/server/pimlico";
import { readPocSession } from "@/lib/poc/turnkey/server/session";
import { normalizeOperationStatus } from "@/lib/poc/turnkey/status";

export async function POST(request: Request) {
  if (!isTurnkeyPocEnabled()) return disabledResponse();
  try {
    const config = requireServerTurnkeyPocConfig();
    const session = await readPocSession(config.sessionSecret);
    if (!session) return jsonError("No app session.", 401);

    const body = (await request.json()) as { userOperationHash?: string };
    const userOperationHash = normalizeHash(body.userOperationHash);
    if (!userOperationHash) return jsonError("userOperationHash is required.", 400);

    const response = await fetch(pimlicoRpcUrl(config), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getUserOperationReceipt",
        params: [userOperationHash],
      }),
    });
    const json = (await response.json()) as {
      result?: {
        success?: boolean;
        receipt?: { transactionHash?: string; status?: string };
        userOpHash?: string;
      } | null;
      error?: { message?: string };
    };

    if (!response.ok || json.error) {
      return Response.json({
        status: "unknown",
        userOperationHash,
        transactionHash: null,
        receiptStatus: null,
        error: json.error?.message ?? "Bundler lookup failed.",
        autoResend: false,
      });
    }

    if (!json.result) {
      return Response.json({
        status: "pending",
        userOperationHash,
        transactionHash: null,
        receiptStatus: null,
        autoResend: false,
      });
    }

    const transactionHash = normalizeHash(json.result.receipt?.transactionHash);
    if (
      normalizeHash(json.result.userOpHash) !== userOperationHash ||
      typeof json.result.success !== "boolean" ||
      !transactionHash ||
      !["0x0", "0x1"].includes(json.result.receipt?.status ?? "")
    ) {
      return Response.json({
        status: "unknown", userOperationHash, transactionHash: null,
        receiptStatus: null, error: "Incomplete or mismatched bundler receipt.", autoResend: false,
      });
    }
    const success = json.result.success && json.result.receipt?.status === "0x1";
    return Response.json({
      status: normalizeOperationStatus(success ? "confirmed" : "failed"),
      userOperationHash,
      transactionHash,
      receiptStatus: success ? "success" : "reverted",
      autoResend: false,
    });
  } catch (error) {
    return jsonError(asErrorMessage(error), 500);
  }
}
