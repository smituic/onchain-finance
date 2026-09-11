import type { Metadata } from "next";
import { PayView } from "@/components/pay/pay-view";

export const metadata: Metadata = {
  title: "Pay — onchain-finance",
};

export default function PayPage() {
  return <PayView />;
}
