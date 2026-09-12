export type Experiment = {
  id: string;
  /** The question the experiment answers — the entry point's title. */
  question: string;
  /** What the user will actually do, in one line. Not a summary of an answer. */
  hook: string;
  /**
   * Set only when the experiment can already be played somewhere in the
   * product. Swap's price-impact explainer is a working demonstration of
   * the first one; the rest wait on the experiment engine.
   */
  href?: string;
};

export const EXPLORE_EXPERIMENTS: Experiment[] = [
  {
    id: "price-impact",
    question: "Why do large trades move prices?",
    hook: "Convert $10,000 at once and watch the price move against you.",
    href: "/swap",
  },
  {
    id: "eth-drawdown",
    question: "What happens if ETH falls 40%?",
    hook: "Drop the market and see what it does to money borrowed against it.",
    href: "/borrow",
  },
  {
    id: "lending-yield",
    question: "Where does lending yield come from?",
    hook: "Follow a dollar from your savings to the person borrowing it.",
    href: "/save",
  },
  {
    id: "thin-liquidity",
    question: "Why can a valuable token still be hard to sell?",
    hook: "Try to sell a big position and see what actually lands in your account.",
  },
  {
    id: "tokenization",
    question: "How can a stock exist on-chain?",
    hook: "Buy a simulated tokenized investment and see what actually changes.",
    href: "/invest",
  },
];
