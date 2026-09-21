import { isServerTurnkeyPocConfig, readServerTurnkeyPocConfig } from "../config";

export function requireServerTurnkeyPocConfig() {
  const config = readServerTurnkeyPocConfig();
  if (!isServerTurnkeyPocConfig(config)) {
    throw new Error(config.error);
  }
  return config;
}

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export function disabledResponse(): Response {
  return jsonError("Not found", 404);
}

export function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unexpected error.";
}
