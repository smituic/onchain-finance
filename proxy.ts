import type { NextRequest } from "next/server";
import { checkRealApiRequest } from "@/lib/real/server/request-gate";

/**
 * The single request gate for Real Mode's API (S4). The rules live in
 * lib/real/server/request-gate.ts; this file only wires them to every
 * /api/real/** request. Returning nothing lets the request continue to its
 * route handler.
 */
export function proxy(request: NextRequest) {
  return checkRealApiRequest(request) ?? undefined;
}

export const config = {
  matcher: "/api/real/:path*",
};
