import { BASE_SEPOLIA_CHAIN_ID, PIMLICO_ALLOWED_METHODS } from "../constants";
import type { ServerTurnkeyPocConfig } from "../config";

const ALLOWED = new Set<string>(PIMLICO_ALLOWED_METHODS);

export function pimlicoRpcUrl(config: ServerTurnkeyPocConfig): string {
  return `https://api.pimlico.io/v2/${BASE_SEPOLIA_CHAIN_ID}/rpc?apikey=${config.pimlicoApiKey}`;
}

export function assertAllowedPimlicoMethod(method: unknown): string {
  if (typeof method !== "string" || !ALLOWED.has(method)) {
    throw new Error("Pimlico method is not allowed for this PoC proxy.");
  }
  return method;
}

export async function proxyPimlicoRequest(config: ServerTurnkeyPocConfig, body: unknown): Promise<Response> {
  if (!body || typeof body !== "object") {
    throw new Error("Invalid JSON-RPC body.");
  }
  const record = body as Record<string, unknown>;
  assertAllowedPimlicoMethod(record.method);

  const response = await fetch(pimlicoRpcUrl(config), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}
