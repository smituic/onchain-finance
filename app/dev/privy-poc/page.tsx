import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isPocEnabled, readPrivyPocEnv, validatePrivyPocConfig } from "@/lib/poc/privy/config";
import { PrivyPocView } from "./privy-poc-view";

/**
 * Developer-only Privy proof-of-concept. DISPOSABLE — not product UI, not in
 * navigation, 404 unless NEXT_PUBLIC_PRIVY_POC_ENABLED=true at build time.
 */
export const metadata: Metadata = {
  title: "Privy PoC (dev) — onchain-finance",
  robots: { index: false, follow: false, nocache: true },
};

export default function PrivyPocPage() {
  const env = readPrivyPocEnv();
  if (!isPocEnabled(env)) notFound();
  return <PrivyPocView validation={validatePrivyPocConfig(env)} />;
}
