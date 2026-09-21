import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isTurnkeyPocEnabled } from "@/lib/poc/turnkey/config";
import { TurnkeyPocUi } from "./poc-ui";

export const metadata: Metadata = {
  title: "Turnkey PoC",
  robots: { index: false, follow: false },
};

export default function TurnkeyPocPage() {
  if (!isTurnkeyPocEnabled()) notFound();
  return <TurnkeyPocUi />;
}
