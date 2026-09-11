"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PRODUCT_AREAS, type ProductArea } from "@/lib/product-areas";
import { cn } from "@/lib/utils";

function useIsActive() {
  const pathname = usePathname();
  return (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
}

/** Desktop navigation: every area, always visible. */
export function AppSidebarNav() {
  const isActive = useIsActive();

  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {PRODUCT_AREAS.map((area) => (
        <SidebarLink key={area.id} area={area} active={isActive(area.href)} />
      ))}
    </nav>
  );
}

function SidebarLink({ area, active }: { area: ProductArea; active: boolean }) {
  const Icon = area.icon;
  return (
    <Link
      href={area.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-4.5" />
      {area.label}
    </Link>
  );
}

/**
 * Mobile navigation. Carries the areas a user thinks of as places; Swap and
 * Borrow are reached from Home's actions and from the areas that lead to
 * them, keeping tap targets comfortable rather than fitting seven in a row.
 */
export function AppTabBarNav() {
  const isActive = useIsActive();
  const tabs = PRODUCT_AREAS.filter((area) => area.inTabBar);

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur-sm md:hidden"
    >
      <ul className="mx-auto flex max-w-xl items-stretch pb-[env(safe-area-inset-bottom)]">
        {tabs.map((area) => {
          const Icon = area.icon;
          const active = isActive(area.href);
          return (
            <li key={area.id} className="flex-1">
              <Link
                href={area.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-16 flex-col items-center justify-center gap-1 text-[0.6875rem] transition-colors",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Icon aria-hidden="true" className={cn("size-5", active && "stroke-[2.25]")} />
                {area.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
