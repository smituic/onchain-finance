import type { Metadata } from "next";
import { SaveView } from "@/components/save/save-view";

export const metadata: Metadata = {
  title: "Save — onchain-finance",
};

export default function SavePage() {
  return <SaveView />;
}
