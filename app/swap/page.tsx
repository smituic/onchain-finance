import type { Metadata } from "next";
import { SwapForm } from "@/components/swap/swap-form";

export const metadata: Metadata = {
  title: "Swap — onchain-finance",
};

export default function SwapPage() {
  return <SwapForm />;
}
