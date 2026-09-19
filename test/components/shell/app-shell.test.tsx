import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: "/" } }));
vi.mock("next/navigation", () => ({ usePathname: () => pathnameRef.current }));

describe("AppShell", () => {
  beforeEach(() => {
    pathnameRef.current = "/";
  });

  it("wraps product routes in the nav chrome", () => {
    render(
      <AppShell>
        <div>product child</div>
      </AppShell>,
    );
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
    expect(screen.getByText("product child")).toBeInTheDocument();
  });

  it("skips product chrome on disposable /dev PoC routes", () => {
    pathnameRef.current = "/dev/privy-poc";
    render(
      <AppShell>
        <div>poc child</div>
      </AppShell>,
    );
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Practice" })).not.toBeInTheDocument();
    expect(screen.getByText("poc child")).toBeInTheDocument();
  });
});
