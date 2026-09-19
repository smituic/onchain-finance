import type { Metadata } from "next";
import { ByMode } from "@/components/shell/by-mode";
import { PracticeOnly } from "@/components/shell/practice-only";
import { SwapForm } from "@/components/swap/swap-form";

export const metadata: Metadata = {
  title: "Swap — onchain-finance",
};

export default function SwapPage() {
  return <ByMode practice={<SwapForm />} real={<PracticeOnly areaId="swap" />} />;
}
