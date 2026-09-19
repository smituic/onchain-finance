import type { Metadata } from "next";
import { ByMode } from "@/components/shell/by-mode";
import { PayView } from "@/components/pay/pay-view";
import { RealPayView } from "@/components/real/real-pay-view";

export const metadata: Metadata = {
  title: "Pay — onchain-finance",
};

export default function PayPage() {
  return <ByMode practice={<PayView />} real={<RealPayView />} />;
}
