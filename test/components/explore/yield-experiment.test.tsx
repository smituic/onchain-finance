import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YieldExperiment } from "@/components/explore/experiments/yield-experiment";

describe("YieldExperiment", () => {
  it("starts with exactly $1,000 in savings and nothing earned yet", () => {
    render(<YieldExperiment />);
    expect(screen.getByText("$1,000.00")).toBeInTheDocument();
    expect(screen.getByText("Practice time skipped")).toBeInTheDocument();
    expect(screen.getByText("0 months")).toBeInTheDocument();
  });

  it("one month earns the engine's own 4%/yr interest on $1,000", () => {
    render(<YieldExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "1 month" }));

    expect(screen.getByText("$1,003.29")).toBeInTheDocument();
    expect(screen.getByText("What changed")).toBeInTheDocument();
  });

  it("twelve months matches the engine's compounding-per-step math", () => {
    render(<YieldExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "12 months" }));

    expect(screen.getByText("$1,040.17")).toBeInTheDocument();
  });

  it("each button jumps to an absolute total, independent of click order", () => {
    render(<YieldExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "12 months" }));
    fireEvent.click(screen.getByRole("button", { name: "1 month" }));

    // Not 13 months of compounding — exactly the 1-month figure.
    expect(screen.getByText("$1,003.29")).toBeInTheDocument();
    expect(screen.getByTestId("value-row-practice-time-skipped")).toHaveTextContent("1 month");
  });

  it("does not claim the engine models an exact calendar year or precise APY", () => {
    render(<YieldExperiment />);
    expect(screen.queryByText(/exactly.*calendar year/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Practice months — each one 30 days/)).toBeInTheDocument();
  });

  it("uses 'months', not 'steps', in its user-facing copy", () => {
    render(<YieldExperiment />);
    expect(screen.queryByText(/\bsteps?\b/)).not.toBeInTheDocument();
  });

  it("reset restores the $1,000 starting balance", () => {
    render(<YieldExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "12 months" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset experiment" }));

    expect(screen.getByText("$1,000.00")).toBeInTheDocument();
    expect(screen.getByText("0 months")).toBeInTheDocument();
    expect(screen.queryByText("What changed")).not.toBeInTheDocument();
  });

  it("links to the full Save feature", () => {
    render(<YieldExperiment />);
    expect(screen.getByRole("link", { name: "Try it in Save" })).toHaveAttribute("href", "/save");
  });
});
