import type { Metadata } from "next";
import { ByMode } from "@/components/shell/by-mode";
import { PracticeOnly } from "@/components/shell/practice-only";
import { BorrowView } from "@/components/borrow/borrow-view";

export const metadata: Metadata = {
  title: "Borrow — onchain-finance",
};

export default function BorrowPage() {
  return <ByMode practice={<BorrowView />} real={<PracticeOnly areaId="borrow" />} />;
}
