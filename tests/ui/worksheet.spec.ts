import { test, expect, type Page, type Locator } from "@playwright/test";

/** "1,234.56" -> 123456 (integer cents, so sums are exact). */
const cents = (s: string | null) => Math.round(Number((s ?? "").replace(/[^\d.-]/g, "")) * 100);
const cellCents = async (l: Locator) => cents(await l.textContent());

const payroll = async (page: Page, code: string, amount: string, nth = 0) => {
  const row = page.getByTestId("payroll-row").nth(nth);
  await row.getByTestId("class-code").fill(code);
  await row.getByTestId("payroll").fill(amount);
};
const claim = async (page: Page, o: { id?: string; injury?: string; status?: "Open" | "Closed"; incurred: string }) => {
  await page.getByTestId("add-claim").click();
  const row = page.getByTestId("claim-row").last();
  if (o.id) await row.getByTestId("claim-id").fill(o.id);
  if (o.injury) await row.getByTestId("injury-type").selectOption(o.injury);
  if (o.status) await row.getByTestId("open-closed").selectOption(o.status);
  await row.getByTestId("incurred").fill(o.incurred);
  return row;
};
const result = (page: Page, id: string) => page.getByTestId("claim-result").filter({ has: page.getByTestId("claim-number").getByText(id, { exact: true }) });
const col = (row: Locator, c: string) => row.locator(`[data-col="${c}"]`);
const calculate = async (page: Page) => {
  await page.getByTestId("calculate").click();
  await expect(page.getByTestId("mod")).toBeVisible();
};

test.beforeEach(async ({ page }) => { await page.goto("/"); });

test.describe("US-07 worksheet entry", () => {
  test("US-07 a claim needs only the four visible fields; extras stay hidden", async ({ page }) => {
    await payroll(page, "0005", "1000000");
    const row = await claim(page, { id: "WC-1", injury: "minor-ppd", status: "Closed", incurred: "1000" });
    for (const id of ["claim-id", "injury-type", "open-closed", "incurred"]) await expect(row.getByTestId(id)).toBeVisible();
    await expect(row.getByTestId("net-incurred")).toBeHidden();
    await expect(row.getByTestId("cm-class")).toBeHidden();
    await expect(row.getByTestId("special-handling")).not.toHaveAttribute("open", "");
    await expect(row.getByTestId("treatment")).toBeHidden();
    await calculate(page);
    const r = result(page, "WC-1");
    await expect(r).toContainText("Minor Permanent Partial Disability");
    await expect(r).toContainText("Closed");
    await expect(col(r, "al")).toHaveText("1,000.00");
    await expect(col(r, "ap")).toHaveText("750.00");
    await expect(col(r, "ax")).toHaveText("250.00");
    await expect(page.getByTestId("mod")).toContainText("0.81"); // (750 + 15,634.80) / 20,200 = 0.8111
  });

  test("US-07 the injury type dropdown offers exactly the worksheet codes", async ({ page }) => {
    await page.getByTestId("add-claim").click();
    await expect(page.getByTestId("injury-type").locator("option")).toHaveText([
      "Death", "Permanent Total Disability", "Major Permanent Partial Disability", "Minor Permanent Partial Disability",
      "Temporary Total or Temporary Partial Disability", "Medical Only Claim", "Contract Medical or Hospital Allowances",
      'Compromised Death or "S" Claim',
    ]);
  });

  test("US-07 Open/Closed is informational: same mod either way, and the control says so", async ({ page }) => {
    await payroll(page, "0005", "1000000");
    const row = await claim(page, { incurred: "20000", status: "Open" });
    await expect(row.getByTestId("open-closed")).toHaveAttribute("title", /does not change the calculation/);
    await calculate(page);
    const open = await page.getByTestId("mod-before-cap").textContent();
    await row.getByTestId("open-closed").selectOption("Closed");
    await calculate(page);
    await expect(page.getByTestId("mod-before-cap")).toHaveText(open!);
  });

  test("US-01 entering a per-capita class switches the payroll label to units and shows the ELR", async ({ page }) => {
    const row = page.getByTestId("payroll-row").first();
    await row.getByTestId("class-code").fill("0005");
    await expect(row.getByTestId("elr-hint")).toHaveText("2.02 per $100 payroll");
    await expect(row.getByTestId("payroll-label")).toHaveText("Payroll ($)");
    await row.getByTestId("class-code").fill("7707");
    await expect(row.getByTestId("elr-hint")).toHaveText("126.50 per unit (per capita)");
    await expect(row.getByTestId("payroll-label")).toHaveText("Units (per capita)");
    await expect(row.getByTestId("payroll")).toHaveAttribute("placeholder", "units");
  });
});

test.describe("US-03 injury types drive the engine input", () => {
  test("US-03 Death applies the $175,000 Average Death Value and Ap = PT - 250", async ({ page }) => {
    await payroll(page, "0005", "1000000");
    await claim(page, { id: "D1", injury: "death", incurred: "40000" });
    await calculate(page);
    const r = result(page, "D1");
    await expect(col(r, "al")).toHaveText("175,000.00");
    await expect(col(r, "ap")).toHaveText("8,250.00");
    await expect(r.getByTestId("claim-rule")).toContainText("death");
  });

  test('US-03 "S" claim reveals Net incurred and uses the compromise ratio (100,000 gross, 40,000 net -> AL 70,000, Ap 3,150)', async ({ page }) => {
    await payroll(page, "0005", "1000000");
    const row = await claim(page, { id: "S1", injury: "s-claim", incurred: "100000" });
    await expect(row.getByTestId("net-incurred")).toBeVisible();
    await expect(row.getByTestId("treatment")).toBeDisabled();
    await row.getByTestId("net-incurred").fill("40000");
    await calculate(page);
    await expect(page.getByTestId("pt")).toHaveText("8,500.00");
    const r = result(page, "S1");
    await expect(col(r, "al")).toHaveText("70,000.00");
    await expect(col(r, "ap")).toHaveText("3,150.00");
    await expect(r).toContainText('Compromised Death or "S" Claim');
  });

  test("US-03 Contract medical reveals Class, hides special handling, and Ap = incurred x D-ratio (500,000 in 0005 -> 113,000)", async ({ page }) => {
    await payroll(page, "0005", "1000000");
    const row = await claim(page, { id: "CM-1", injury: "contract-medical", incurred: "500000" });
    await expect(row.getByTestId("cm-class")).toBeVisible();
    await expect(row.getByTestId("special-handling")).toBeHidden();
    await row.getByTestId("cm-class").fill("0005");
    await calculate(page);
    const r = result(page, "CM-1");
    await expect(r).toContainText("Contract Medical or Hospital Allowances");
    await expect(col(r, "al")).toHaveText("500,000.00");
    await expect(col(r, "ap")).toHaveText("113,000.00");
    await expect(r.getByTestId("claim-rule")).toContainText("contract medical");
  });
});

test.describe("US-03 special handling disclosure", () => {
  test("US-03 subrogation and joint coverage reveal Net incurred and differ by $125", async ({ page }) => {
    await payroll(page, "0005", "1000000");
    const ap = async (treatment: string) => {
      await page.getByTestId("reset").click();
      await payroll(page, "0005", "1000000");
      const row = await claim(page, { id: "X", incurred: "10000" });
      await row.getByTestId("special-handling").locator("summary").click();
      await row.getByTestId("treatment").selectOption(treatment);
      await expect(row.getByTestId("net-incurred")).toBeVisible();
      await row.getByTestId("net-incurred").fill("5000");
      await calculate(page);
      return cellCents(col(result(page, "X"), "ap"));
    };
    expect(await ap("joint")).toBe(await ap("subrogation") + 12_500);
  });

  test("US-03 fraud treatment uses the net/gross ratio like subrogation", async ({ page }) => {
    await payroll(page, "0005", "1000000");
    const row = await claim(page, { id: "F", incurred: "10000" });
    await row.getByTestId("special-handling").locator("summary").click();
    await row.getByTestId("treatment").selectOption("fraud");
    await row.getByTestId("net-incurred").fill("5000");
    await calculate(page);
    await expect(col(result(page, "F"), "al")).toHaveText("5,000.00");
    await expect(col(result(page, "F"), "ap")).toHaveText("4,000.00"); // 8,500 x 0.5 - 250
  });

  test("US-03 non-compensable, EL + WC and accident id still work from the disclosure", async ({ page }) => {
    await payroll(page, "0005", "1000000");
    const nc = await claim(page, { id: "NC", incurred: "50000" });
    await nc.getByTestId("special-handling").locator("summary").click();
    await nc.getByTestId("non-compensable").check();
    const el = await claim(page, { id: "EL", incurred: "20000" });
    await el.getByTestId("special-handling").locator("summary").click();
    await el.getByTestId("el-wc").check();
    for (const id of ["A", "B", "C"]) {
      const r = await claim(page, { id, incurred: "20000" });
      await r.getByTestId("special-handling").locator("summary").click();
      await r.getByTestId("accident-id").fill("ACC-1");
    }
    await calculate(page);
    await expect(col(result(page, "NC"), "ap")).toHaveText("0.00");
    await expect(result(page, "NC").getByTestId("claim-rule")).toContainText("non-compensable");
    await expect(col(result(page, "EL"), "ap")).toHaveText("8,250.00");
    await expect(result(page, "EL").getByTestId("claim-rule")).toContainText("EL + WC");
    const acc = page.getByTestId("claim-result").filter({ hasText: "accident:ACC-1" });
    await expect(acc).toContainText("Multi-person accident");
    await expect(col(acc, "ap")).toHaveText("16,500.00"); // 2 x PT - 500
  });
});

test.describe("US-07 worksheet results reconcile", () => {
  test("US-07 totals rows equal the sum of rows; Ep + Ee = E and Ap + Ax = AL on every line and in the period totals", async ({ page }) => {
    await payroll(page, "0005", "1000000");
    await page.getByTestId("add-payroll").click();
    await payroll(page, "3634", "500000", 1);
    await claim(page, { id: "a", incurred: "4000" });
    await claim(page, { id: "b", incurred: "300000" });
    await claim(page, { id: "d", injury: "death", incurred: "90000" });
    await calculate(page);

    const classRows = page.getByTestId("class-row");
    await expect(classRows).toHaveCount(2);
    const ptotal = page.locator('[data-testid="totals-row"][data-table="payroll"]');
    for (const c of ["expected", "ep", "ee"]) {
      let s = 0;
      for (const r of await classRows.all()) s += await cellCents(col(r, c));
      expect(s, `payroll column ${c}`).toBe(await cellCents(col(ptotal, c)));
    }
    for (const r of [...await classRows.all(), ptotal]) {
      expect(await cellCents(col(r, "ep")) + await cellCents(col(r, "ee"))).toBe(await cellCents(col(r, "expected")));
    }

    const claimRows = page.getByTestId("claim-result");
    const ctotal = page.locator('[data-testid="totals-row"][data-table="claims"]');
    for (const c of ["al", "ap", "ax"]) {
      let s = 0;
      for (const r of await claimRows.all()) s += await cellCents(col(r, c));
      expect(s, `claims column ${c}`).toBe(await cellCents(col(ctotal, c)));
    }
    for (const r of [...await claimRows.all(), ctotal]) {
      expect(await cellCents(col(r, "ap")) + await cellCents(col(r, "ax"))).toBe(await cellCents(col(r, "al")));
    }

    // Experience Period Totals agree with both summaries.
    expect(await cellCents(page.getByTestId("e"))).toBe(await cellCents(col(ptotal, "expected")));
    expect(await cellCents(page.getByTestId("ee"))).toBe(await cellCents(col(ptotal, "ee")));
    expect(await cellCents(page.getByTestId("al"))).toBe(await cellCents(col(ctotal, "al")));
    expect(await cellCents(page.getByTestId("ax"))).toBe(await cellCents(col(ctotal, "ax")));
    expect(await cellCents(page.getByTestId("ep")) + await cellCents(page.getByTestId("ee"))).toBe(await cellCents(page.getByTestId("e")));
  });

  test("US-07 heading, Primary Threshold, Loss-Free Rating and the formula explanation", async ({ page }) => {
    await page.getByTestId("employer").fill("Acme Fictional Co");
    await page.getByTestId("policy-number").fill("POL-123");
    await page.getByTestId("effective-date").fill("2026-01-01");
    await page.getByTestId("issue-date").fill("2025-11-15");
    await payroll(page, "0005", "1000000");
    await calculate(page);
    await expect(page.getByTestId("ws-employer")).toHaveText("Acme Fictional Co");
    await expect(page.getByTestId("ws-policy")).toHaveText("POL-123");
    await expect(page.getByTestId("ws-effective")).toHaveText("Jan 1, 2026");
    await expect(page.getByTestId("ws-issued")).toHaveText("Nov 15, 2025");
    await expect(page.getByTestId("primary-threshold")).toContainText("Primary Threshold");
    await expect(page.getByTestId("pt")).toHaveText("8,500.00");
    await expect(page.getByTestId("loss-free-rating")).toContainText("Loss-Free Rating");
    await expect(page.getByTestId("loss-free")).toHaveText("0.77");
    const explain = page.getByTestId("calc-explain");
    await expect(explain).not.toHaveAttribute("open", "");
    await explain.locator("summary").click();
    await expect(explain).toContainText("(0.00 + 15,634.80) ÷ 20,200.00 = 0.774");
  });

  test("US-07 policy years group the payroll summary (display only)", async ({ page }) => {
    await payroll(page, "0005", "500000");
    await page.getByTestId("payroll-row").first().getByTestId("policy-year").fill("2024");
    await page.getByTestId("add-payroll").click();
    await payroll(page, "0005", "500000", 1);
    await page.getByTestId("payroll-row").nth(1).getByTestId("policy-year").fill("2023");
    await calculate(page);
    await expect(page.getByTestId("policy-year-group")).toHaveText(["Policy year 2023", "Policy year 2024"]);
    await expect(page.getByTestId("e")).toHaveText("20,200.00"); // same as one 1,000,000 line: grouping does not change the math
  });

  test("US-04 the cap badge comes with its explanation", async ({ page }) => {
    await page.getByTestId("load-sample").click(); // default sample: one large claim
    await calculate(page);
    await expect(page.getByTestId("cap-applied")).toBeVisible();
    await expect(page.getByTestId("cap-explanation")).toContainText("loss-free rating plus 25 points");
    await expect(page.getByTestId("cap-explanation")).toContainText("1.18241584158");
  });
});

test.describe("US-01 sample risks", () => {
  const samples: [string, string, string, Record<string, string>][] = [
    ["loss-free", "Loss-free", "0.77", { ap: "0.00" }],
    ["two-small", "Two small claims", "0.85", { ap: "1,500.00" }],
    ["one-large", "One large claim (cap applies)", "1.02", { ap: "8,250.00" }],
    ["death", "Death claim", "0.90", { al: "175,000.00", ap: "14,250.00", pt: "14,500.00" }],
    ["per-capita", "Per-capita class 7707", "0.87", { e: "12,650.00" }],
  ];
  for (const [key, label, mod, extra] of samples) {
    test(`US-01 sample "${label}" gives mod ${mod}`, async ({ page }) => {
      await page.getByTestId("sample-select").selectOption(key);
      await page.getByTestId("load-sample").click();
      await calculate(page);
      await expect(page.getByTestId("mod")).toContainText(mod);
      for (const [id, v] of Object.entries(extra)) await expect(page.getByTestId(id)).toHaveText(v);
      if (key === "one-large") await expect(page.getByTestId("cap-applied")).toBeVisible();
      if (key === "per-capita") await expect(col(page.getByTestId("class-row"), "payroll")).toHaveText("100 units");
    });
  }
});
