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
    // testIgnore: these globs would otherwise also match tests/agent/api and tests/agent/ui.
    { name: "api", testMatch: "api/**/*.spec.ts", testIgnore: "agent/**" },
    { name: "ui", testMatch: "ui/**/*.spec.ts", testIgnore: "agent/**", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: process.env.CHROMIUM_PATH } } },
    // Agent-generated, human-approved tests (docs/AGENT_TESTING.md). No retries: a flaky agent test must surface.
    {
      name: "agent",
      testDir: "./tests/agent",
      testMatch: "**/*.spec.ts",
      retries: 0,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: process.env.CHROMIUM_PATH },
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
      },
    },
    // Starting browser state for the Playwright MCP agents (tests/seed.spec.ts); not part of any CI job.
    { name: "seed", testMatch: "seed.spec.ts", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: process.env.CHROMIUM_PATH } } },
  ],
});
