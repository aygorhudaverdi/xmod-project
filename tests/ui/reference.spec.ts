import { test, expect, type Page } from "@playwright/test";

const current = (page: Page) => page.locator('[data-testid="table2-row"][aria-current="true"]');
const openTab = async (page: Page) => {
  await page.goto("/");
  await page.getByTestId("tab-reference").click();
  await expect(page.getByTestId("table2-row")).toHaveCount(92);
};

test.describe("US-10 Reference tables: Table II", () => {
  test("US-10 the tab lists all 92 bands, the constants, and 'and over' on the last row", async ({ page }) => {
    await openTab(page);
    await expect(page.getByTestId("table2-constants")).toContainText("Maximum Loss Value: $175,000");
    await expect(page.getByTestId("table2-constants")).toContainText("Average Death Value: $175,000");
    const rows = page.getByTestId("table2-row");
    await expect(rows.first().locator("th, td")).toHaveText(["0", "7,248", "4,500"]);
    await expect(rows.nth(17).locator("th, td")).toHaveText(["46,360", "50,076", "13,000"]);
    await expect(rows.last().locator("th, td")).toHaveText(["3,293,540", "and over", "75,000"]);
    await expect(page.getByTestId("table2").locator("thead th")).toHaveText(["Expected losses from ($)", "to ($)", "Primary threshold ($)"]);
    await expect(rows.first().locator("td").last()).toHaveCSS("text-align", "right");
  });

  test("US-10 E-09 typing 47636.59 highlights the 46,360-50,076 band and shows 13,000", async ({ page }) => {
    await openTab(page);
    await page.getByTestId("lookup-input").fill("47636.59");
    await expect(current(page)).toHaveCount(1);
    await expect(current(page).locator("th, td")).toHaveText(["46,360", "50,076", "13,000"]);
    await expect(page.getByTestId("lookup-result")).toContainText("$13,000");
    await expect(page.getByTestId("lookup-result")).toContainText("$47,637");
    await expect(current(page)).toBeInViewport();
    // A visible highlight, not only an attribute.
    const bg = await current(page).locator("td").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const plain = await page.getByTestId("table2-row").first().locator("td").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe(plain);
  });

  test("US-10 E-05 typing 7248 then 7249 moves the highlight to the next band", async ({ page }) => {
    await openTab(page);
    await page.getByTestId("lookup-input").fill("7248");
    await expect(current(page).locator("td").last()).toHaveText("4,500");
    await page.getByTestId("lookup-input").fill("7249");
    await expect(current(page).locator("td").last()).toHaveText("5,000");
    await expect(current(page)).toHaveCount(1);
  });

  test("US-10 E-10 invalid input shows an inline message, clears the highlight, and raises no dialog", async ({ page }) => {
    let dialog = false;
    page.on("dialog", (d) => { dialog = true; void d.dismiss(); });
    await openTab(page);
    await page.getByTestId("lookup-input").fill("47636.59");
    await expect(current(page)).toHaveCount(1);
    for (const bad of ["abc", "-1"]) {
      await page.getByTestId("lookup-input").fill(bad);
      await expect(page.getByTestId("lookup-message")).toContainText("Enter a dollar amount");
      await expect(page.getByTestId("lookup-result")).toBeEmpty();
      await expect(current(page)).toHaveCount(0);
    }
    await page.getByTestId("lookup-input").fill("$1,000");
    await expect(page.getByTestId("lookup-message")).toBeEmpty();
    await expect(current(page).locator("td").last()).toHaveText("4,500");
    expect(dialog).toBe(false);
  });

  test("US-10 the Calculator's Primary Threshold link opens the tab on the band it used", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("sample-select").selectOption("death"); // E 60,600 -> PT 14,500
    await page.getByTestId("load-sample").click();
    await page.getByTestId("calculate").click();
    await expect(page.getByTestId("pt")).toHaveText("14,500.00");
    await page.getByTestId("pt-link").click();
    await expect(page.getByTestId("tab-reference")).toHaveAttribute("aria-selected", "true");
    await expect(current(page)).toHaveCount(1);
    await expect(current(page).locator("th, td")).toHaveText(["58,015", "62,241", "14,500"]);
    await expect(current(page)).toBeInViewport();
    await expect(page.getByTestId("lookup-result")).toContainText("used by your calculation");
  });

  test("US-10 at 375 px the table scrolls inside its container, not the page", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await openTab(page);
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(pageOverflow).toBeLessThanOrEqual(0);
    const wrap = page.locator(".table2-wrap");
    const { sh, ch } = await wrap.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(sh).toBeGreaterThan(ch); // the 92 rows scroll vertically inside the container
    await page.getByTestId("lookup-input").fill("3293540");
    await expect(current(page)).toBeInViewport();
    await expect(page.getByTestId("table2").locator("thead th").first()).toBeVisible(); // sticky header stays in view
  });
});
