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
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "api", testMatch: "api/**/*.spec.ts" },
    { name: "ui", testMatch: "ui/**/*.spec.ts", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: process.env.CHROMIUM_PATH } } },
  ],
});
