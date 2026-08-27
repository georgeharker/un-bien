import { defineConfig } from "vitest/config";

// Only override what we must: a shared setup file that gives every test a
// hermetic `REMOTE_PI_*` env (see vitest.setup.ts). Everything else stays on
// vitest defaults (node environment, default include globs).
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
  },
});
