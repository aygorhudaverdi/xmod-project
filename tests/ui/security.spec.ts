import { test, expect } from "@playwright/test";

const PAYLOADS = [
  `<img src=x onerror="window.__xss=1">`,
  `<script>window.__xss=1</script>`,
  `"><svg onload="window.__xss=1">`,
  `javascript:window.__xss=1`,
];

test.describe("US-07 security: user input is rendered inertly (XSS)", () => {
  test("US-07 injection-style claim ids are shown as text in the breakdown and never executed", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("payroll-row").first().getByTestId("class-code").fill("0005");
    await page.getByTestId("payroll-row").first().getByTestId("payroll").fill("1000000");
    for (const [i, id] of PAYLOADS.entries()) {
      await page.getByTestId("add-claim").click();
      const row = page.getByTestId("claim-row").nth(i);
      await row.getByTestId("claim-id").fill(id);
      await row.getByTestId("indemnity").fill("1000");
    }
    await page.getByTestId("calculate").click();
    await expect(page.getByTestId("claim-result")).toHaveCount(PAYLOADS.length);
    for (const [i, id] of PAYLOADS.entries()) {
      await expect(page.getByTestId("claim-result").nth(i).locator("td").first()).toHaveText(id);
    }
    await expect(page.locator("#result img, #result script, #result svg")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("US-07 an error message carrying markup is rendered as text", async ({ page }) => {
    // Force an API error whose message echoes attacker-controlled input.
    await page.route("**/api/xmod/calculate", (route) => route.fulfill({
      status: 422, json: { error: { code: "<b>X</b>", message: `Unknown class code <img src=x onerror="window.__xss=1">` } },
    }));
    await page.goto("/");
    await page.getByTestId("calculate").click();
    await expect(page.getByTestId("error-message")).toHaveText(`Unknown class code <img src=x onerror="window.__xss=1">`);
    await expect(page.getByTestId("error-code")).toHaveText("<b>X</b>");
    await expect(page.locator("#result img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });
});

test.describe("security: Content-Security-Policy", () => {
  test("the whole UI works under the CSP with no violations", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`));
    });
    await page.goto("/");
    await page.getByTestId("load-sample").click();
    await page.getByTestId("calculate").click();
    await expect(page.getByTestId("mod")).toBeVisible();
    await page.getByTestId("tab-stories").click();
    await page.getByTestId("tab-dash").click();
    await expect(page.getByTestId("dash-updated")).not.toHaveText("never");
    await expect(page.getByTestId("dash-mod-bucket").first()).toBeVisible();
    expect(violations).toEqual([]);
  });

  test("an injected inline script is blocked by the CSP", async ({ page }) => {
    await page.goto("/");
    const ran = await page.evaluate(async () => {
      const s = document.createElement("script");
      s.textContent = "window.__inline = 1";
      document.body.append(s);
      await new Promise((r) => setTimeout(r, 50));
      return (window as unknown as { __inline?: number }).__inline;
    });
    expect(ran).toBeUndefined();
  });
});
