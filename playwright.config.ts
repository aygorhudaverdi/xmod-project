import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
export default defineConfig({
  testDir: "./tests",
  testMatch: ["api/**/*.spec.ts", "ui/**/*.spec.ts"],
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/results.json" }]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: `PORT=${PORT} npx tsx src/server/server.ts`, url: `http://localhost:${PORT}/api/health`, reuseExistingServer: !process.env.CI },
  projects: [
    { name: "api", testMatch: "api/**/*.spec.ts" },
    { name: "ui", testMatch: "ui/**/*.spec.ts", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: process.env.CHROMIUM_PATH } } },
  ],
});
