import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Turnkey PoC",
  robots: { index: false, follow: false },
};

export default function TurnkeyPocLayout({ children }: { children: ReactNode }) {
  return children;
}
