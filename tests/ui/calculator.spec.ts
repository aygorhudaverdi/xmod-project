import { test, expect, type Page } from "@playwright/test";

const fillPayroll = async (page: Page, code: string, amount: string, nth = 0) => {
  const row = page.getByTestId("payroll-row").nth(nth);
  await row.getByTestId("class-code").fill(code);
  await row.getByTestId("payroll").fill(amount);
};
const addClaim = async (page: Page, o: { id?: string; indemnity: string; medical?: string }, nth = 0) => {
  await page.getByTestId("add-claim").click();
  const row = page.getByTestId("claim-row").nth(nth);
  if (o.id) await row.getByTestId("claim-id").fill(o.id);
  await row.getByTestId("indemnity").fill(o.indemnity);
  if (o.medical) await row.getByTestId("medical").fill(o.medical);
  return row;
};

test.beforeEach(async ({ page }) => { await page.goto("/"); });

test("page loads with calculator selected and the stories and dashboard tabs available", async ({ page }) => {
  await expect(page).toHaveTitle("X-Mod Lab");
  await expect(page.getByTestId("tab-calc")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tab-stories")).toBeEnabled();
  await expect(page.getByTestId("tab-dash")).toBeEnabled();
});

test("US-01 calculates the reference risk", async ({ page }) => {
  await fillPayroll(page, "0005", "1000000");
  await page.getByTestId("calculate").click();
  await expect(page.getByTestId("mod")).toContainText("0.77");
  await expect(page.getByTestId("e")).toHaveText("20,200.00");
  await expect(page.getByTestId("pt")).toHaveText("8,500.00");
  await expect(page.getByTestId("ee")).toHaveText("15,634.80");
  await expect(page.getByTestId("eligibility")).toHaveText("Eligible");
});

test("US-07 shows claim breakdown with the applied rule", async ({ page }) => {
  await fillPayroll(page, "0005", "1000000");
  await addClaim(page, { id: "C-100", indemnity: "1000" });
  await addClaim(page, { id: "C-200", indemnity: "1000" }, 1);
  await page.getByTestId("calculate").click();
  await expect(page.getByTestId("claim-result")).toHaveCount(2);
  await expect(page.getByTestId("claim-result").first()).toContainText("C-100");
  await expect(page.getByTestId("claim-result").first()).toContainText("750.00");
  await expect(page.getByTestId("mod")).toContainText("0.85");
});

test("US-04 shows the cap badge, and removes it when unaudited payroll is excluded", async ({ page }) => {
  await page.getByTestId("load-sample").click();
  await page.getByTestId("calculate").click();
  await expect(page.getByTestId("cap-applied")).toBeVisible();
  await expect(page.getByTestId("mod")).toContainText("1.02");
  await page.getByTestId("excl-unaudited").check();
  await page.getByTestId("calculate").click();
  await expect(page.getByTestId("cap-applied")).toHaveCount(0);
  await expect(page.getByTestId("mod")).toContainText("1.18");
});

test("US-03 non-compensable claim is excluded in the UI", async ({ page }) => {
  await fillPayroll(page, "0005", "1000000");
  const row = await addClaim(page, { indemnity: "50000" });
  await row.getByTestId("non-compensable").check();
  await page.getByTestId("calculate").click();
  await expect(page.getByTestId("ap")).toHaveText("0.00");
  await expect(page.getByTestId("claim-result")).toContainText("non-compensable");
});

test("US-05 below-threshold risk shows Not eligible with a reason", async ({ page }) => {
  await fillPayroll(page, "3634", "500000");
  await page.getByTestId("calculate").click();
  await expect(page.getByTestId("eligibility")).toHaveText("Not eligible");
  await expect(page.getByTestId("eligibility-reason")).toContainText("not rated prior year");
});

test("US-06 unknown class shows an error and no mod", async ({ page }) => {
  await fillPayroll(page, "9999", "1000");
  await page.getByTestId("calculate").click();
  await expect(page.getByTestId("error-code")).toHaveText("UNKNOWN_CLASS");
  await expect(page.getByTestId("mod")).toHaveCount(0);
});

test("US-06 a later valid calculation clears the previous error", async ({ page }) => {
  await fillPayroll(page, "9999", "1000");
  await page.getByTestId("calculate").click();
  await expect(page.getByTestId("error")).toBeVisible();
  await fillPayroll(page, "0005", "1000000");
  await page.getByTestId("calculate").click();
  await expect(page.getByTestId("error")).toHaveCount(0);
  await expect(page.getByTestId("mod")).toBeVisible();
});

test("add and remove rows; reset clears results", async ({ page }) => {
  await page.getByTestId("add-payroll").click();
  await expect(page.getByTestId("payroll-row")).toHaveCount(2);
  await page.getByTestId("remove-payroll").first().click();
  await expect(page.getByTestId("payroll-row")).toHaveCount(1);
  await page.getByTestId("load-sample").click();
  await page.getByTestId("calculate").click();
  await expect(page.getByTestId("mod")).toBeVisible();
  await page.getByTestId("reset").click();
  await expect(page.getByTestId("mod")).toHaveCount(0);
  await expect(page.getByTestId("claim-row")).toHaveCount(0);
});

test("stories tab lists every story with acceptance criteria", async ({ page }) => {
  await page.getByTestId("tab-stories").click();
  for (const id of ["US-01", "US-02", "US-03", "US-04", "US-05", "US-06", "US-07", "US-08"]) {
    await expect(page.getByTestId(`story-${id}`)).toBeVisible();
  }
  await expect(page.locator("#panel-calc")).toBeHidden();
});

test("tabs follow the WAI-ARIA keyboard pattern: arrows, Home/End, roving tabindex", async ({ page }) => {
  await page.getByTestId("tab-calc").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("tab-stories")).toBeFocused();
  await expect(page.getByTestId("tab-stories")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tab-stories")).toHaveAttribute("tabindex", "0");
  await expect(page.getByTestId("tab-calc")).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("End");
  await expect(page.getByTestId("tab-dash")).toBeFocused();
  await expect(page.getByTestId("dash-stats")).toBeVisible();
  await page.keyboard.press("ArrowRight"); // wraps around
  await expect(page.getByTestId("tab-calc")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("tab-dash")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(page.getByTestId("tab-calc")).toBeFocused();
  await expect(page.locator("#panel-calc")).toBeVisible();
});

test("tabs are keyboard operable and expose ARIA state", async ({ page }) => {
  await page.getByTestId("tab-stories").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tab-stories")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toBeVisible();
});
