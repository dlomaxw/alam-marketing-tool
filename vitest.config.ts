import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { config } from "dotenv";

// The integration suite talks to a real database, so it needs the same
// environment the app uses. Unit tests are unaffected: they touch no env.
config({ path: ".env.local" });

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "./src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests share one database and clean up after themselves, so
    // they must not run concurrently with each other.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
