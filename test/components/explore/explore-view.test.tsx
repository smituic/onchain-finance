import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExploreView } from "@/components/explore/explore-view";
import { EXPLORE_EXPERIMENTS } from "@/components/explore/experiments";

describe("ExploreView", () => {
  it("renders the full experiment catalog, each linking directly into its own experiment", () => {
    render(<ExploreView />);

    expect(screen.getByRole("heading", { name: "Explore" })).toBeInTheDocument();
    expect(EXPLORE_EXPERIMENTS).toHaveLength(5);

    for (const experiment of EXPLORE_EXPERIMENTS) {
      const link = screen.getByRole("link", { name: new RegExp(experiment.question.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
      expect(link).toHaveAttribute("href", `/explore/${experiment.id}`);
    }
  });

  it("has no link-only 'Soon' placeholders — every experiment is playable", () => {
    render(<ExploreView />);
    expect(screen.queryByText("Soon")).not.toBeInTheDocument();
  });
});
