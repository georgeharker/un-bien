import { defineConfig } from "vitest/config"

// Hermetic defaults; node environment, default include globs
// (src/**/*.test.ts).
export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
})