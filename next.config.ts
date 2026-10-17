import type { NextConfig } from "next";
import { REAL_API_MAX_BODY_BYTES } from "./lib/real/server/request-gate";

const nextConfig: NextConfig = {
  // 3B-2: make the proxy body-copy ceiling explicit (it equals the framework's
  // 10 MB default) and tie it to the request gate's declared-length ceiling.
  // Past this limit Next.js silently keeps only a prefix of the body, so the
  // gate (lib/real/server/request-gate.ts) refuses any larger declared length
  // before a route can see it. One constant, two uses: do not set a literal here.
  experimental: {
    proxyClientMaxBodySize: REAL_API_MAX_BODY_BYTES,
  },
  // S4: static anti-framing / anti-sniffing headers on every response.
  // Deliberately NOT a full script/style Content-Security-Policy (deferred),
  // and no Strict-Transport-Security here — HSTS is left to the hosting
  // layer until the production deployment is verified.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
