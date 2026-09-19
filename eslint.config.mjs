import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Architectural fences (see ARCHITECTURE.md), enforced as lint errors
 * rather than review discipline. ESLint flat config *replaces* a rule's
 * options when a later block matches the same file, so each block below
 * carries its complete `no-restricted-imports` set — composed from the
 * pieces here — rather than relying on blocks layering.
 */

// Blockchain SDKs (Phase 2). None are installed yet; the fence exists ahead
// of them so Real Mode's account/chain code can only land inside lib/real/**
// and the server-side route handlers under app/api/real/**. Components,
// pages, and stores talk to lib/real's interface, never to a chain SDK.
const CHAIN_SDK_PACKAGES = ["viem", "@base-org/account", "wagmi", "@wagmi/core", "ethers", "web3"];
const CHAIN_SDK_MESSAGE =
  "Blockchain SDKs may only be imported inside lib/real/** (and app/api/real/** route handlers). Everything else goes through lib/real's interface — see ARCHITECTURE.md.";
const noChainSdk = {
  paths: CHAIN_SDK_PACKAGES.map((name) => ({ name, message: CHAIN_SDK_MESSAGE })),
  patterns: [{ group: CHAIN_SDK_PACKAGES.map((name) => `${name}/*`), message: CHAIN_SDK_MESSAGE }],
};

// Framework-agnostic layers: no React, Next.js, or Zustand.
const noFramework = (layer) => ({
  paths: [
    { name: "react", message: `${layer} must stay framework-agnostic — no React imports.` },
    { name: "react-dom", message: `${layer} must stay framework-agnostic — no React imports.` },
    { name: "next", message: `${layer} must stay framework-agnostic — no Next.js imports.` },
    {
      name: "zustand",
      message: `${layer} must stay framework-agnostic — wire it to a store from the presentation layer, not from within ${layer}.`,
    },
  ],
  patterns: [
    { group: ["react/*", "react-dom/*", "next/*", "zustand/*"], message: `${layer} must stay framework-agnostic.` },
  ],
});

const restrictImports = (...pieces) => [
  "error",
  {
    paths: pieces.flatMap((piece) => piece.paths ?? []),
    patterns: pieces.flatMap((piece) => piece.patterns ?? []),
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Everything in the app that isn't one of the special layers below.
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    ignores: ["app/api/real/**", "lib/real/**", "components/explore/**", "lib/explore/**"],
    rules: { "no-restricted-imports": restrictImports(noChainSdk) },
  },
  {
    // The Practice simulation engine must stay framework-agnostic, and —
    // Practice and Real being parallel paths — must never depend on Real
    // Mode or on app stores.
    files: ["simulation/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictImports(noFramework("simulation/"), noChainSdk, {
        patterns: [
          {
            group: ["@/lib/real", "@/lib/real/*", "@/lib/stores/*"],
            message:
              "The Practice simulation engine must never depend on Real Mode or on app stores — Practice and Real are parallel paths (see ARCHITECTURE.md).",
          },
        ],
      }),
    },
  },
  {
    // Real Mode's account/chain layer (Phase 2): framework-agnostic like
    // simulation/, and the other half of the same boundary — it must never
    // read or write Practice state. Reserved now; populated in Batch 2.
    files: ["lib/real/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictImports(noFramework("lib/real/"), {
        paths: [
          {
            name: "@/simulation",
            message:
              "lib/real/ must never touch the Practice simulation — Practice and Real are parallel paths (see ARCHITECTURE.md).",
          },
        ],
        patterns: [
          {
            group: ["@/simulation/*", "@/lib/stores/*"],
            message: "lib/real/ must never touch the Practice simulation or app stores (see ARCHITECTURE.md).",
          },
        ],
      }),
    },
  },
  {
    // Explore's sandboxes run an isolated, ephemeral SimulationState (see
    // ARCHITECTURE.md's "Explore sandbox" section) and must never be able
    // to reach the user's real Practice Mode portfolio.
    files: ["components/explore/**/*.{ts,tsx}", "lib/explore/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictImports(noChainSdk, {
        paths: [
          {
            name: "@/lib/stores/simulation-store",
            message:
              "Explore experiments run in an isolated sandbox and must never dispatch into the user's real Practice Mode store — use lib/explore/use-experiment-simulation instead.",
          },
        ],
      }),
    },
  },
]);

export default eslintConfig;
