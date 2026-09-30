import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
