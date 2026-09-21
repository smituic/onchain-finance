import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppFrame } from "@/components/shell/app-frame";

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: "/" } }));
vi.mock("next/navigation", () => ({ usePathname: () => pathnameRef.current }));

describe("AppFrame isolation", () => {
  it("renders product navigation off the Turnkey PoC route", () => {
    pathnameRef.current = "/";
    render(
      <AppFrame>
        <p>Product</p>
      </AppFrame>,
    );
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
  });

  it("does not render product navigation on the isolated Turnkey PoC route", () => {
    pathnameRef.current = "/dev/turnkey-poc";
    render(
      <AppFrame>
        <p>Turnkey PoC</p>
      </AppFrame>,
    );
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    expect(screen.getByText("Turnkey PoC")).toBeInTheDocument();
  });
});
