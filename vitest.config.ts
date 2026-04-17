import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/tests/**/*.test.ts", "**/__tests__/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["apps/api/src/**/*.ts", "apps/dashboard/src/**/*.ts", "packages/shared/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/tests/**", "**/__tests__/**", "**/scripts/**"],
      thresholds: {
        lines: 50,
        functions: 45,
        branches: 40,
        statements: 50,
      },
    },
  },
});
