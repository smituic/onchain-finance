import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
    // Architectural boundary (see ARCHITECTURE.md): the simulation engine
    // must stay framework-agnostic so Phase 2 can swap it for a real
    // testnet-backed implementation without rewriting this layer.
    files: ["simulation/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "simulation/ must stay framework-agnostic — no React imports." },
            { name: "react-dom", message: "simulation/ must stay framework-agnostic — no React imports." },
            { name: "next", message: "simulation/ must stay framework-agnostic — no Next.js imports." },
            { name: "zustand", message: "simulation/ must stay framework-agnostic — wire it to Zustand from the presentation layer, not from within simulation/." },
          ],
          patterns: ["react/*", "react-dom/*", "next/*", "zustand/*"],
        },
      ],
    },
  },
  {
    // Explore's sandboxes run an isolated, ephemeral SimulationState (see
    // ARCHITECTURE.md's "Explore sandbox" section) and must never be able
    // to reach the user's real Practice Mode portfolio. This makes that
    // isolation a lint failure, not just a review discipline.
    files: ["components/explore/**/*.{ts,tsx}", "lib/explore/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/stores/simulation-store",
              message:
                "Explore experiments run in an isolated sandbox and must never dispatch into the user's real Practice Mode store — use lib/explore/use-experiment-simulation instead.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
