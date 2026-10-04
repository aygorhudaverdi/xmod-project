import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Hosted mode without mocks: Chromium resolves an invented hostname to the real test server on 127.0.0.1, so the
// page runs under a non-local location.hostname exactly as it would on Render.
const HOSTED = "hosted.xmod.test";
// File-level (launch options force a worker): the mapping only adds HOSTED, so localhost pages are unaffected.
test.use({ launchOptions: { args: [`--host-resolver-rules=MAP ${HOSTED} 127.0.0.1`], executablePath: process.env.CHROMIUM_PATH } });
const hostedUrl = (path = "/") => {
  const port = new URL(String(test.info().project.use.baseURL)).port;
  return `http://${HOSTED}:${port}${path}`;
};
const openDashboard = async (page: Page, url = "/") => {
  await page.goto(url);
  await page.getByTestId("tab-dash").click();
  await expect(page.getByTestId("dash-updated")).not.toHaveText("never");
};

test.describe("US-08 Grafana link on a local page", () => {
  test("US-08 the link is visible and points to localhost:3001; no hosted note", async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByTestId("grafana-link")).toBeVisible();
    await expect(page.getByTestId("grafana-link")).toHaveAttribute("href", "http://localhost:3001");
    await expect(page.getByTestId("grafana-note")).toBeHidden();
    await expect(page.getByTestId("grafana-url-input")).toBeHidden();
  });

  test("US-08 ?grafana=https://example.com overrides the link", async ({ page }) => {
    await openDashboard(page, "/?grafana=https://example.com");
    await expect(page.getByTestId("grafana-link")).toHaveAttribute("href", "https://example.com");
  });
});

test.describe("US-08 Grafana link on a hosted page (DEF-011)", () => {
  test("US-08 no dead localhost link: the note and the URL input are shown instead", async ({ page }) => {
    await openDashboard(page, hostedUrl());
    expect(await page.evaluate(() => location.hostname)).toBe(HOSTED);
    await expect(page.getByTestId("grafana-link")).toBeHidden();
    await expect(page.getByTestId("grafana-note")).toHaveText(
      "Grafana runs locally with docker compose (see README). The panels above are live from this deployment.");
    await expect(page.getByTestId("grafana-url-input")).toBeVisible();
    await expect(page.getByLabel("Grafana URL")).toBeVisible();
    // The live panels still work from the hosted origin.
    await expect(page.getByTestId("dash-total-requests")).not.toHaveText("–");
  });

  test("US-08 entering a Grafana URL shows the link, and it is remembered after a reload", async ({ page }) => {
    await openDashboard(page, hostedUrl());
    await page.getByTestId("grafana-url-input").fill("https://grafana.example.com/d/xmod-lab");
    await page.getByTestId("grafana-url-input").press("Enter");
    await expect(page.getByTestId("grafana-link")).toBeVisible();
    await expect(page.getByTestId("grafana-link")).toHaveAttribute("href", "https://grafana.example.com/d/xmod-lab");
    await page.reload();
    await page.getByTestId("tab-dash").click();
    await expect(page.getByTestId("grafana-link")).toHaveAttribute("href", "https://grafana.example.com/d/xmod-lab");
    await expect(page.getByTestId("grafana-url-input")).toHaveValue("https://grafana.example.com/d/xmod-lab");
    // Clearing the field removes the link again.
    await page.getByTestId("grafana-url-input").fill("");
    await page.getByTestId("grafana-url-input").press("Enter");
    await expect(page.getByTestId("grafana-link")).toBeHidden();
  });

  for (const bad of ["javascript:alert(1)", "ftp://grafana.example.com", "grafana.example.com"]) {
    test(`US-08 a non-http(s) URL is rejected inline: ${bad}`, async ({ page }) => {
      await openDashboard(page, hostedUrl());
      await page.getByTestId("grafana-url-input").fill(bad);
      await page.getByTestId("grafana-url-input").press("Enter");
      await expect(page.getByTestId("grafana-url-message")).toContainText("Enter a full http:// or https:// address");
      await expect(page.getByTestId("grafana-link")).toBeHidden();
    });
  }

  test("US-08 ?grafana= override also works on a hosted page", async ({ page }) => {
    await openDashboard(page, hostedUrl("/?grafana=https://example.com"));
    await expect(page.getByTestId("grafana-link")).toBeVisible();
    await expect(page.getByTestId("grafana-link")).toHaveAttribute("href", "https://example.com");
    await expect(page.getByTestId("grafana-note")).toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`US-08 axe: no violations on the hosted dashboard tab with the note and an error (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openDashboard(page, hostedUrl());
      await page.getByTestId("grafana-url-input").fill("nope");
      await page.getByTestId("grafana-url-input").press("Enter");
      await expect(page.getByTestId("grafana-url-message")).not.toBeEmpty();
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
      expect(r.violations.map((v) => `${v.id} (${v.impact})`)).toEqual([]);
    });
  }
});
