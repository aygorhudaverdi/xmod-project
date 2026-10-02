import { test, expect, type Page } from "@playwright/test";

const num = async (page: Page, testId: string) => Number((await page.getByTestId(testId).textContent())!.replace(/[^\d.]/g, ""));

const openDashboard = async (page: Page) => {
  await page.getByTestId("tab-dash").click();
  await expect(page.getByTestId("dash-updated")).not.toHaveText("never");
};

test.describe("US-08 quality dashboard: live stats", () => {
  test("US-08 the dashboard tab is enabled and opens its panel", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("tab-dash")).toBeEnabled();
    await page.getByTestId("tab-dash").click();
    await expect(page.getByTestId("tab-dash")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("dash-stats")).toBeVisible();
    await expect(page.locator("#panel-calc")).toBeHidden();
  });

  test("US-08 stats update after a calculation", async ({ page }) => {
    await page.goto("/");
    await openDashboard(page);
    const before = await num(page, "dash-calc-ok");

    await page.getByTestId("tab-calc").click();
    await page.getByTestId("load-sample").click();
    await page.getByTestId("calculate").click();
    await expect(page.getByTestId("mod")).toBeVisible();

    await page.getByTestId("tab-dash").click(); // switching back refreshes immediately
    await expect.poll(() => num(page, "dash-calc-ok")).toBeGreaterThan(before);
    await expect(page.getByTestId("dash-total-requests")).not.toHaveText("–");
    await expect(page.getByTestId("dash-p95")).toContainText("ms");
    await expect(page.getByTestId("dash-uptime")).toContainText("s");
    await expect(page.getByTestId("dash-mod-bucket").first()).toBeVisible();
    await expect(page.getByTestId("dash-mod-mean")).toContainText("mean");
  });

  test("US-08 auto-refreshes every 5 s, and the pause toggle stops and resumes it", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    let calls = 0;
    page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/stats") calls++; });

    await openDashboard(page);
    await expect.poll(() => calls).toBe(1);
    const first = await page.getByTestId("dash-updated").getAttribute("datetime");

    await page.clock.runFor(5_000);
    await expect.poll(() => calls).toBe(2);
    await expect(page.getByTestId("dash-updated")).not.toHaveAttribute("datetime", first!);

    await page.getByTestId("dash-pause").click();
    await expect(page.getByTestId("dash-pause")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("dash-pause")).toHaveText("Resume auto-refresh");
    await page.clock.runFor(20_000);
    // Negative check: give any (unwanted) request a moment to be observed before asserting none happened.
    await page.waitForTimeout(300);
    expect(calls).toBe(2);

    await page.getByTestId("dash-pause").click();
    await expect(page.getByTestId("dash-pause")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => calls).toBe(3); // resuming refreshes immediately
    await page.clock.runFor(5_000);
    await expect.poll(() => calls).toBe(4);
  });

  test("US-08 leaving the tab stops polling", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    let calls = 0;
    page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/stats") calls++; });
    await openDashboard(page);
    await expect.poll(() => calls).toBe(1);
    await page.getByTestId("tab-calc").click();
    await page.clock.runFor(20_000);
    await page.waitForTimeout(300);
    expect(calls).toBe(1);
  });

  test("US-08 Grafana link defaults to localhost:3001 and can be overridden with ?grafana=", async ({ page }) => {
    await page.goto("/");
    await openDashboard(page);
    await expect(page.getByTestId("grafana-link")).toHaveAttribute("href", "http://localhost:3001");
    await page.goto("/?grafana=https://grafana.example.test/d/xmod-lab");
    await openDashboard(page);
    await expect(page.getByTestId("grafana-link")).toHaveAttribute("href", "https://grafana.example.test/d/xmod-lab");
  });

  test("US-08 a non-http ?grafana= value is ignored", async ({ page }) => {
    await page.goto("/?grafana=javascript:alert(1)");
    await openDashboard(page);
    await expect(page.getByTestId("grafana-link")).toHaveAttribute("href", "http://localhost:3001");
  });
});

test.describe("US-08 quality dashboard: test results", () => {
  test("US-08 shows an empty state when no Playwright results file exists", async ({ page }) => {
    // The test server is started with TEST_RESULTS_PATH pointing at a file that never exists (playwright.config.ts).
    await page.goto("/");
    await openDashboard(page);
    await expect(page.getByTestId("test-results-empty")).toContainText("No Playwright results");
    await expect(page.getByTestId("test-results-table")).toHaveCount(0);
  });

  test("US-08 renders pass/fail per project and the failed-test list", async ({ page }) => {
    await page.route("**/api/test-results", (route) => route.fulfill({
      json: {
        available: true, startTime: "2026-10-01T12:00:00Z", durationMs: 4200,
        totals: { passed: 40, failed: 2, flaky: 1, skipped: 0, total: 43 },
        projects: {
          api: { passed: 30, failed: 1, flaky: 0, skipped: 0, total: 31 },
          ui: { passed: 10, failed: 1, flaky: 1, skipped: 0, total: 12 },
        },
        failed: [
          { project: "api", title: "US-06 validation › unknown class", file: "api/x.spec.ts", line: 9, error: "Expected: 422" },
          { project: "ui", title: "<img src=x onerror=alert(1)>", file: "ui/y.spec.ts", line: 3, error: "<script>bad()</script>" },
        ],
      },
    }));
    await page.goto("/");
    await openDashboard(page);
    const api = page.locator('[data-testid="test-results-project"][data-project="api"]');
    await expect(api.getByTestId("tr-passed")).toHaveText("30");
    await expect(api.getByTestId("tr-failed")).toHaveText("1");
    const ui = page.locator('[data-testid="test-results-project"][data-project="ui"]');
    await expect(ui.getByTestId("tr-flaky")).toHaveText("1");
    await expect(page.getByTestId("failed-test")).toHaveCount(2);
    await expect(page.getByTestId("failed-test").first()).toContainText("US-06 validation › unknown class");
    // Test titles and error text are data: rendered as text, never as markup.
    await expect(page.getByTestId("failed-test").nth(1)).toContainText("<img src=x onerror=alert(1)>");
    await expect(page.locator("#test-results-body img, #test-results-body script")).toHaveCount(0);
  });

  test("US-08 a run with no failures says so", async ({ page }) => {
    await page.route("**/api/test-results", (route) => route.fulfill({
      json: { available: true, totals: { passed: 3, failed: 0, flaky: 0, skipped: 0, total: 3 },
        projects: { api: { passed: 3, failed: 0, flaky: 0, skipped: 0, total: 3 } }, failed: [] },
    }));
    await page.goto("/");
    await openDashboard(page);
    await expect(page.getByTestId("test-results-all-passed")).toBeVisible();
  });
});
