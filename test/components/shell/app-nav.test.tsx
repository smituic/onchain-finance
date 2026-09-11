import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebarNav, AppTabBarNav } from "@/components/shell/app-nav";
import { PRODUCT_AREAS } from "@/lib/product-areas";

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: "/" } }));
vi.mock("next/navigation", () => ({ usePathname: () => pathnameRef.current }));

describe("app navigation", () => {
  beforeEach(() => {
    pathnameRef.current = "/";
  });

  it("reaches every product area from the desktop sidebar", () => {
    render(<AppSidebarNav />);

    for (const area of PRODUCT_AREAS) {
      expect(screen.getByRole("link", { name: area.label })).toHaveAttribute("href", area.href);
    }
    expect(screen.getAllByRole("link")).toHaveLength(7);
  });

  it("shows the places a user visits in the mobile tab bar", () => {
    render(<AppTabBarNav />);
    const nav = screen.getByRole("navigation");

    for (const label of ["Home", "Pay", "Save", "Invest", "Explore"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
    // Swap and Borrow are reached from Home's actions, keeping tap targets usable.
    expect(within(nav).queryByRole("link", { name: "Swap" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Borrow" })).not.toBeInTheDocument();
  });

  it("marks the current area as the active page", () => {
    pathnameRef.current = "/save";
    render(<AppSidebarNav />);

    expect(screen.getByRole("link", { name: "Save" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("marks Home active only on the root path", () => {
    pathnameRef.current = "/";
    const { unmount } = render(<AppSidebarNav />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    unmount();

    pathnameRef.current = "/swap";
    render(<AppSidebarNav />);
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Swap" })).toHaveAttribute("aria-current", "page");
  });
});
