import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
export default defineConfig({
  testDir: "./tests",
  testMatch: ["api/**/*.spec.ts", "ui/**/*.spec.ts"],
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
    ...(process.env.CI ? [["github"] as ["github"]] : []),
  ],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  // PORT goes through `env`, not `PORT=... cmd`, so the command also works in Windows cmd.exe (DEF-002).
  webServer: {
    command: "npx tsx src/server/server.ts",
    // TEST_RESULTS_PATH points at a file that never exists, so the dashboard's empty state is deterministic.
    // All tests share one client IP, so the shared server's rate limit is raised; the 429 behavior is tested
    // against its own in-process app with a tiny limit (tests/api/security.spec.ts).
    env: { PORT: String(PORT), TEST_RESULTS_PATH: "tests/fixtures/never-written-results.json", RATE_LIMIT_MAX: "1000000" },
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "api", testMatch: "api/**/*.spec.ts" },
    { name: "ui", testMatch: "ui/**/*.spec.ts", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: process.env.CHROMIUM_PATH } } },
  ],
});
