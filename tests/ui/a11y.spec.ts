import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * WCAG 2.1 A/AA rules plus axe best practices. The original gate was serious/critical only; once those were
 * fixed the remaining moderate finding (region) was fixed too, and the gate now fails on any impact so
 * regressions of every severity are caught.
 */
async function violations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  return results.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(" ")) }));
}

test.describe("accessibility (axe, WCAG 2.1 AA)", () => {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${scheme} color scheme`, () => {
      test.use({ colorScheme: scheme });

      test(`US-01 calculator tab, empty form (${scheme})`, async ({ page }) => {
        await page.goto("/");
        expect(await violations(page)).toEqual([]);
      });

      test(`US-07 calculator tab with a result and claim breakdown (${scheme})`, async ({ page }) => {
        await page.goto("/");
        await page.getByTestId("load-sample").click();
        await page.getByTestId("add-claim").click();
        await page.getByTestId("calculate").click();
        await expect(page.getByTestId("claim-table")).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test(`US-06 calculator tab showing a validation error (${scheme})`, async ({ page }) => {
        await page.goto("/");
        await page.getByTestId("class-code").fill("9999");
        await page.getByTestId("payroll").fill("1");
        await page.getByTestId("calculate").click();
        await expect(page.getByTestId("error")).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test(`stories tab (${scheme})`, async ({ page }) => {
        await page.goto("/");
        await page.getByTestId("tab-stories").click();
        expect(await violations(page)).toEqual([]);
      });

      test(`US-08 quality dashboard tab, live stats and test results (${scheme})`, async ({ page }) => {
        await page.route("**/api/test-results", (route) => route.fulfill({ json: {
          available: true, totals: { passed: 1, failed: 1, flaky: 0, skipped: 0, total: 2 },
          projects: { api: { passed: 1, failed: 1, flaky: 0, skipped: 0, total: 2 } },
          failed: [{ project: "api", title: "a failing test", file: "api/x.spec.ts", line: 1, error: "Expected: 1" }],
        } }));
        await page.goto("/");
        await page.getByTestId("tab-dash").click();
        await expect(page.getByTestId("failed-test")).toBeVisible();
        await expect(page.getByTestId("dash-updated")).not.toHaveText("never");
        expect(await violations(page)).toEqual([]);
      });
    });
  }
});
