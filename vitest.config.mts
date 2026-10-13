import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: true,
    // The main process's own command line, readable by a test through inject().
    // Only test/lib/real/provisioning-limits.smoke.test.ts uses it: that live
    // smoke refuses to run unless it is the one file that was selected.
    provide: { vitestCliArgs: process.argv.slice(2) },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
});
