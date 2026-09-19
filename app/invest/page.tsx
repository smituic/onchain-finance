import type { Metadata } from "next";
import { ByMode } from "@/components/shell/by-mode";
import { PracticeOnly } from "@/components/shell/practice-only";
import { InvestView } from "@/components/invest/invest-view";

export const metadata: Metadata = {
  title: "Invest — onchain-finance",
};

export default function InvestPage() {
  return <ByMode practice={<InvestView />} real={<PracticeOnly areaId="invest" />} />;
}
