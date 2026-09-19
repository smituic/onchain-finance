import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCdpPocConfig } from "@/lib/poc/cdp/config";
import { CdpPocView } from "./cdp-poc-view";

export const metadata: Metadata = {
  title: "CDP PoC — onchain-finance (dev)",
  robots: { index: false, follow: false },
};

/**
 * Disposable developer diagnostic for the CDP smart-account proof-of-concept
 * (branch poc/cdp-real-account). Not part of the product: no navigation
 * links here, and the route is a 404 unless NEXT_PUBLIC_CDP_POC_ENABLED=true
 * at build time.
 */
export default function CdpPocPage() {
  const config = getCdpPocConfig();
  if (!config.enabled) notFound();

  return <CdpPocView projectId={config.projectId} rpcUrl={config.rpcUrl} problems={config.problems} />;
}
