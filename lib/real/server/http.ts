import { isRealModeEnabled, isRealServerConfig, readRealServerConfig } from "./config";

export function requireRealServerConfig() {
  const config = readRealServerConfig();
  if (!isRealServerConfig(config)) throw new Error(config.error);
  return config;
}

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export function disabledResponse(): Response {
  return jsonError("Not found", 404);
}

/**
 * Pre-2f hardening: every route's outer catch used to do
 * `jsonError(asErrorMessage(error), 500)`, forwarding whatever text an
 * uncaught exception happened to carry — including
 * requireRealServerConfig()'s "Missing server configuration: <ENV_VAR
 * NAMES>", raw Postgres errors (e.g. a malformed UUID's "invalid input
 * syntax for type uuid"), or a viem RPC error whose `.message` embeds the
 * request URL (and, for Pimlico, its API key query param). A generic 500
 * body is the fix for every unexpected-exception case at once; anything
 * that deserves a specific, safe message is handled by its own outcome
 * branch before this ever runs.
 */
export const GENERIC_SERVER_ERROR_MESSAGE = "Something went wrong. Please try again.";

export function jsonInternalError(): Response {
  return jsonError(GENERIC_SERVER_ERROR_MESSAGE, 500);
}

/**
 * Parses a request body as JSON, returning null on any parse failure
 * instead of throwing — so a malformed body becomes a clean 400 at the
 * call site, never an uncaught exception that would otherwise fall through
 * to jsonInternalError()'s generic 500.
 */
export async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export { isRealModeEnabled };
