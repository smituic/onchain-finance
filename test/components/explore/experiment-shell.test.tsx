import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExperimentShell } from "@/components/explore/experiment-shell";
import type { Experiment } from "@/components/explore/experiments";

const experiment: Experiment = {
  id: "liquidity",
  question: "A test question?",
  hook: "A test hook.",
  areaId: "swap",
};

describe("ExperimentShell", () => {
  it("tells the user this experiment can't touch their main Practice balances", () => {
    render(
      <ExperimentShell experiment={experiment} onReset={vi.fn()} canReset={false}>
        <p>Sandbox content</p>
      </ExperimentShell>,
    );

    expect(
      screen.getByText(
        "This experiment uses separate Practice money — your main balances won't change.",
      ),
    ).toBeInTheDocument();
  });
});
