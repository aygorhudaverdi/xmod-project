import { test, expect } from "@playwright/test";

// Seed for the Playwright MCP agents (docs/AGENT_TESTING.md): opens the app and nothing else.
test("seed", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("X-Mod Lab");
});
