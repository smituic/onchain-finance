import {
  ArrowDownUp,
  Compass,
  HandCoins,
  House,
  PiggyBank,
  Send,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

export type ProductAreaId = "home" | "pay" | "save" | "invest" | "swap" | "borrow" | "explore";

export type ProductArea = {
  id: ProductAreaId;
  label: string;
  href: string;
  icon: LucideIcon;
  /** One line, in the user's language, describing what the area is for. */
  purpose: string;
  /**
   * Whether the area appears in the mobile tab bar. The bar carries the
   * places a user visits; Swap and Borrow are things a user does, reached
   * from Home's action row and from the areas they belong to. See
   * components/shell/app-nav.tsx.
   */
  inTabBar: boolean;
};

export const PRODUCT_AREAS: ProductArea[] = [
  {
    id: "home",
    label: "Home",
    href: "/",
    icon: House,
    purpose: "Everything you have, in one place.",
    inTabBar: true,
  },
  {
    id: "pay",
    label: "Pay",
    href: "/pay",
    icon: Send,
    purpose: "Send, receive, and request money.",
    inTabBar: true,
  },
  {
    id: "save",
    label: "Save",
    href: "/save",
    icon: PiggyBank,
    purpose: "Set money aside and let it earn.",
    inTabBar: true,
  },
  {
    id: "invest",
    label: "Invest",
    href: "/invest",
    icon: TrendingUp,
    purpose: "Put money into things that can grow over time.",
    inTabBar: true,
  },
  {
    id: "swap",
    label: "Swap",
    href: "/swap",
    icon: ArrowDownUp,
    purpose: "Convert one thing you hold into another.",
    inTabBar: false,
  },
  {
    id: "borrow",
    label: "Borrow",
    href: "/borrow",
    icon: HandCoins,
    purpose: "Borrow against what you already own.",
    inTabBar: false,
  },
  {
    id: "explore",
    label: "Explore",
    href: "/explore",
    icon: Compass,
    purpose: "Short, hands-on experiments with how money works.",
    inTabBar: true,
  },
];

export const PRODUCT_AREAS_BY_ID = Object.fromEntries(
  PRODUCT_AREAS.map((area) => [area.id, area]),
) as Record<ProductAreaId, ProductArea>;

/** The actions Home offers directly, in the order they're shown. */
export const HOME_ACTION_AREA_IDS: ProductAreaId[] = ["pay", "save", "invest", "swap", "borrow"];
