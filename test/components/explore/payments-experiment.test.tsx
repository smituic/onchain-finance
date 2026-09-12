import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaymentsExperiment } from "@/components/explore/experiments/payments-experiment";

describe("PaymentsExperiment", () => {
  it("starts with exactly $100 cash and no activity", () => {
    render(<PaymentsExperiment />);
    expect(screen.getByTestId("payments-experiment-cash")).toHaveTextContent("$100.00");
    expect(screen.getByText("Nothing yet — send or request money above.")).toBeInTheDocument();
  });

  it("sending moves cash immediately and records activity", () => {
    render(<PaymentsExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "Send $25 to Maya Chen" }));

    expect(screen.getByTestId("payments-experiment-cash")).toHaveTextContent("$75.00");
    expect(screen.getByText("Sent to Maya Chen")).toBeInTheDocument();
    expect(screen.getByText("What changed")).toBeInTheDocument();
  });

  it("requesting money moves nothing", () => {
    render(<PaymentsExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "Request $25 from Jordan Lee" }));

    expect(screen.getByTestId("payments-experiment-cash")).toHaveTextContent("$100.00");
    expect(screen.getByText(/didn't move any money/)).toBeInTheDocument();
    expect(screen.queryByText("Received from Jordan Lee")).not.toBeInTheDocument();
  });

  it("completing the request moves cash exactly once", () => {
    render(<PaymentsExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "Request $25 from Jordan Lee" }));
    fireEvent.click(screen.getByRole("button", { name: "Simulate Jordan Lee paying it" }));

    expect(screen.getByTestId("payments-experiment-cash")).toHaveTextContent("$125.00");
    expect(screen.getByText("Received from Jordan Lee")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Simulate Jordan Lee paying it" })).not.toBeInTheDocument();
  });

  it("send and request are each one-shot per fixture", () => {
    render(<PaymentsExperiment />);
    expect(screen.getByRole("button", { name: "Send $25 to Maya Chen" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send $25 to Maya Chen" }));
    expect(screen.getByRole("button", { name: "Send $25 to Maya Chen" })).toBeDisabled();

    expect(screen.getByRole("button", { name: "Request $25 from Jordan Lee" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Request $25 from Jordan Lee" }));
    expect(screen.getByRole("button", { name: "Request $25 from Jordan Lee" })).toBeDisabled();
  });

  it("reset restores $100 cash and clears activity", () => {
    render(<PaymentsExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "Send $25 to Maya Chen" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset experiment" }));

    expect(screen.getByTestId("payments-experiment-cash")).toHaveTextContent("$100.00");
    expect(screen.getByText("Nothing yet — send or request money above.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send $25 to Maya Chen" })).not.toBeDisabled();
  });

  it("links to the full Pay feature", () => {
    render(<PaymentsExperiment />);
    expect(screen.getByRole("link", { name: "Open full Pay" })).toHaveAttribute("href", "/pay");
  });
});
