import type { Metadata } from "next";
import { ExploreModeNotice } from "@/components/explore/explore-mode-notice";
import { ExploreView } from "@/components/explore/explore-view";

export const metadata: Metadata = {
  title: "Explore — onchain-finance",
};

// Explore is not wrapped in ByMode: its experiments always run on their own
// separate Practice money, whichever mode the app is in.
export default function ExplorePage() {
  return (
    <div className="flex flex-col gap-6">
      <ExploreModeNotice />
      <ExploreView />
    </div>
  );
}
