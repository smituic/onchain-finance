import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { PracticeOnly } from "@/components/shell/practice-only";
import { useModeStore } from "@/lib/stores/mode-store";
import { PRODUCT_AREAS_BY_ID, type ProductAreaId } from "@/lib/product-areas";

describe("PracticeOnly", () => {
  beforeEach(() => {
    localStorage.clear();
    useModeStore.setState({ mode: "real", realModeEnabled: true, hasAcknowledgedRealIntro: true, hasHydrated: true });
  });

  it.each<ProductAreaId>(["save", "invest", "swap", "borrow"])(
    "names %s as Practice-only, under the area's own heading and purpose",
    (areaId) => {
      const area = PRODUCT_AREAS_BY_ID[areaId];
      render(<PracticeOnly areaId={areaId} />);

      expect(screen.getByRole("heading", { name: area.label })).toBeInTheDocument();
      expect(screen.getByText(area.purpose)).toBeInTheDocument();
      expect(screen.getByText(`${area.label} is Practice-only for now.`)).toBeInTheDocument();
      // It's a product state, not a failure.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("'Try it in Practice' switches the app back to Practice Mode", () => {
    render(<PracticeOnly areaId="save" />);

    fireEvent.click(screen.getByRole("button", { name: "Try it in Practice" }));

    expect(useModeStore.getState().mode).toBe("practice");
  });
});
