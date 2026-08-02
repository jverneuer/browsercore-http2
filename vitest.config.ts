import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Self-contained config for @browsercore/http2. The root workspace defines a
// cross-package project whose coverage aggregate spans every package; this
// local config scopes both the test run and coverage to THIS package only, so
// `vitest run --coverage` from this directory reports a clean 100% on src/.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    test: {
        name: "@browsercore/http2",
        root: resolve(here, "."),
        include: ["tests/**/*.test.ts"],
        environment: "node",
        globals: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
        coverage: {
            provider: "v8",
            include: ["src/**"],
            all: true,
            reporter: ["json-summary", "html"],
        },
    },
});
