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
]);

export default eslintConfig;
