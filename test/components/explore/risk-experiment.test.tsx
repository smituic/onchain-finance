import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RiskExperiment } from "@/components/explore/experiments/risk-experiment";

describe("RiskExperiment", () => {
  it("starts with roughly $1,000 in each of the three curated investments", () => {
    render(<RiskExperiment />);
    expect(screen.getByTestId("risk-holding-BTC")).toHaveTextContent("Bitcoin");
    expect(screen.getByTestId("risk-holding-BROAD")).toHaveTextContent("U.S. Stock Market");
    expect(screen.getByTestId("risk-holding-TBILL")).toHaveTextContent("Short-Term Treasuries");
    expect(screen.getByTestId("risk-holding-BROAD")).toHaveTextContent("$1,000.00");
    expect(screen.getByTestId("risk-holding-TBILL")).toHaveTextContent("$1,000.00");
  });

  it("one market fall moves each holding by its own registered amount", () => {
    render(<RiskExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "Market falls" }));

    // BTC -25%, BROAD -10%, TBILL -1% off $1,000 cost bases.
    expect(screen.getByTestId("risk-holding-BTC")).toHaveTextContent("−$249.99");
    expect(screen.getByTestId("risk-holding-BROAD")).toHaveTextContent("−$100.00");
    expect(screen.getByTestId("risk-holding-TBILL")).toHaveTextContent("−$10.00");
    expect(screen.getByText("What changed")).toBeInTheDocument();
  });

  it("one market rise is the same magnitude in the other direction", () => {
    render(<RiskExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "Market rises" }));

    expect(screen.getByTestId("risk-holding-BTC")).toHaveTextContent("+$249.99");
    expect(screen.getByTestId("risk-holding-BROAD")).toHaveTextContent("+$100.00");
    expect(screen.getByTestId("risk-holding-TBILL")).toHaveTextContent("+$10.00");
  });

  it("scenarios are measured from genesis, not compounded across clicks", () => {
    render(<RiskExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "Market falls" }));
    fireEvent.click(screen.getByRole("button", { name: "Market falls" }));

    // Still exactly one -25% move on BTC, not two compounded.
    expect(screen.getByTestId("risk-holding-BTC")).toHaveTextContent("−$249.99");
  });

  it("explains tokenization without claiming a token is automatically legal ownership", () => {
    render(<RiskExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "What are these, underneath?" }));

    expect(
      screen.getByText(/doesn't by itself give you legal ownership of a real-world asset/),
    ).toBeInTheDocument();
  });

  it("reset restores every holding to its starting value", () => {
    render(<RiskExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "Market falls" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset experiment" }));

    expect(screen.getByTestId("risk-holding-BROAD")).toHaveTextContent("$1,000.00");
    expect(screen.queryByText("What changed")).not.toBeInTheDocument();
  });

  it("links to the full Invest feature", () => {
    render(<RiskExperiment />);
    expect(screen.getByRole("link", { name: "Try it in Invest" })).toHaveAttribute("href", "/invest");
  });
});
