import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiquidationExperiment } from "@/components/explore/experiments/liquidation-experiment";

describe("LiquidationExperiment", () => {
  it("starts from a coherent, round starting position", () => {
    render(<LiquidationExperiment />);
    expect(screen.getByTestId("value-row-eth-price")).toHaveTextContent("$3,000.00");
    expect(screen.getByTestId("value-row-your-eth")).toHaveTextContent("$6,000.00");
    expect(screen.getByTestId("value-row-your-eth")).toHaveTextContent("2 ETH");
    expect(screen.getByTestId("value-row-you-owe")).toHaveTextContent("$3,000.00");
    expect(screen.getByTestId("position-health")).toHaveTextContent("Healthy");
    expect(screen.getByTestId("position-health")).toHaveTextContent("Sold below $2,000.00");
  });

  it("a 20% drop raises risk without liquidating", () => {
    render(<LiquidationExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "ETH falls 20%" }));

    expect(screen.queryByTestId("experiment-liquidation-notice")).not.toBeInTheDocument();
    expect(screen.getByTestId("position-health")).toHaveTextContent("Getting risky");
    expect(screen.getByTestId("value-row-eth-price")).toHaveTextContent("$2,400.00");
    expect(screen.getByTestId("value-row-you-owe")).toHaveTextContent("$3,000.00");
    expect(screen.getByText("What changed")).toBeInTheDocument();
  });

  it("a severe 40% drop triggers real liquidation using the engine's own threshold", () => {
    render(<LiquidationExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "ETH falls 40%" }));

    const notice = screen.getByTestId("experiment-liquidation-notice");
    expect(notice).toHaveTextContent("Your ETH was sold to repay your loan");
    // $3,600 raised clears the full $3,000 debt; $600 comes back as cash.
    expect(notice).toHaveTextContent("$600.00");
    expect(notice).toHaveTextContent("cleared");
  });

  it("scenarios are measured from the starting price, not compounded from the last click", () => {
    render(<LiquidationExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "ETH falls 20%" }));
    fireEvent.click(screen.getByRole("button", { name: "ETH falls 20%" }));

    // Still exactly the single -20% outcome (62.50% LTV / $2,400 collateral),
    // not -36% compounded.
    expect(screen.getByTestId("position-health")).toHaveTextContent("Getting risky");
    expect(screen.getByTestId("value-row-eth-price")).toHaveTextContent("$2,400.00");
  });

  it("disables scenarios once collateral is gone, and reset brings it back", () => {
    render(<LiquidationExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "ETH falls 40%" }));
    expect(screen.getByRole("button", { name: "ETH falls 20%" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Reset experiment" }));

    expect(screen.queryByTestId("experiment-liquidation-notice")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ETH falls 20%" })).not.toBeDisabled();
    expect(screen.getByTestId("position-health")).toHaveTextContent("Healthy");
    expect(screen.getByTestId("value-row-you-owe")).toHaveTextContent("$3,000.00");
  });

  it("links to the full Borrow feature", () => {
    render(<LiquidationExperiment />);
    expect(screen.getByRole("link", { name: "Open full Borrow" })).toHaveAttribute("href", "/borrow");
  });
});
