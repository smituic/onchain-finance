import type { Metadata } from "next";
import { BorrowView } from "@/components/borrow/borrow-view";

export const metadata: Metadata = {
  title: "Borrow — onchain-finance",
};

export default function BorrowPage() {
  return <BorrowView />;
}
