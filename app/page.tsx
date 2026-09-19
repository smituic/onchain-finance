import { ByMode } from "@/components/shell/by-mode";
import { HomeView } from "@/components/home/home-view";
import { RealHomeView } from "@/components/real/real-home-view";

export default function HomePage() {
  return <ByMode practice={<HomeView />} real={<RealHomeView />} />;
}
