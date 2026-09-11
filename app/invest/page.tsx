import type { Metadata } from "next";
import { InvestView } from "@/components/invest/invest-view";

export const metadata: Metadata = {
  title: "Invest — onchain-finance",
};

export default function InvestPage() {
  return <InvestView />;
}
