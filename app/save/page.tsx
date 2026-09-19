import type { Metadata } from "next";
import { ByMode } from "@/components/shell/by-mode";
import { PracticeOnly } from "@/components/shell/practice-only";
import { SaveView } from "@/components/save/save-view";

export const metadata: Metadata = {
  title: "Save — onchain-finance",
};

export default function SavePage() {
  return <ByMode practice={<SaveView />} real={<PracticeOnly areaId="save" />} />;
}
