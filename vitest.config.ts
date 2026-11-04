import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: "test/global-setup.ts",
    // Black-box tests spawn installers and tools; node:test had no per-test limit.
    testTimeout: 60_000,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
      thresholds: { lines: 50, functions: 56, branches: 49, statements: 50 },
    },
  },
});
