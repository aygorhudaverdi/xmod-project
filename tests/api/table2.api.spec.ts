import { test, expect } from "@playwright/test";

type Band = { min: number; max: number | null; threshold: number };

test.describe("US-10 GET /api/table2", () => {
  test("US-10 returns all 92 contiguous bands from 0 to 'and over', thresholds 4,500 to 75,000", async ({ request }) => {
    const r = await request.get("/api/table2");
    expect(r.status()).toBe(200);
    const t = await r.json();
    expect(t).toMatchObject({ maximumLossValue: 175_000, averageDeathValue: 175_000 });
    const bands: Band[] = t.bands;
    expect(bands).toHaveLength(92);
    expect(bands[0]).toEqual({ min: 0, max: 7_248, threshold: 4_500 });
    expect(bands.at(-1)).toEqual({ min: 3_293_540, max: null, threshold: 75_000 });
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].min, `band ${i} starts right after band ${i - 1}`).toBe(bands[i - 1].max! + 1);
      expect(bands[i].threshold).toBeGreaterThan(bands[i - 1].threshold);
    }
    expect(bands.slice(0, -1).every((b) => b.max !== null && b.max >= b.min)).toBe(true);
    expect(Math.min(...bands.map((b) => b.threshold))).toBe(4_500);
    expect(Math.max(...bands.map((b) => b.threshold))).toBe(75_000);
  });
});

test.describe("US-10 GET /api/table2/lookup", () => {
  const cases: [string, string, number][] = [
    ["E-05", "7248", 4_500], ["E-05", "7249", 5_000],
    ["E-06", "19923", 8_000], ["E-06", "19924", 8_500],
    ["E-07", "27391", 9_500], ["E-07", "27392", 10_000],
    ["E-08", "3293539", 74_000], ["E-08", "3293540", 75_000],
  ];
  for (const [id, expected, threshold] of cases) {
    test(`US-10 ${id} expected ${expected} -> threshold ${threshold}`, async ({ request }) => {
      const b = await (await request.get(`/api/table2/lookup?expected=${expected}`)).json();
      expect(b).toMatchObject({ expected: Number(expected), roundedExpected: Number(expected), threshold });
      expect(b.band.min).toBeLessThanOrEqual(Number(expected));
      if (b.band.max !== null) expect(b.band.max).toBeGreaterThanOrEqual(Number(expected));
    });
  }

  test("US-10 E-09 47,636.59 rounds to 47,637 and falls in 46,360-50,076 -> 13,000", async ({ request }) => {
    const b = await (await request.get("/api/table2/lookup?expected=47636.59")).json();
    expect(b).toEqual({ expected: 47_636.59, roundedExpected: 47_637, threshold: 13_000, band: { min: 46_360, max: 50_076 } });
  });

  test("US-10 rounding is half-up to whole dollars at a band edge (7,248.49 -> 4,500; 7,248.50 -> 5,000)", async ({ request }) => {
    expect((await (await request.get("/api/table2/lookup?expected=7248.49")).json()).threshold).toBe(4_500);
    expect((await (await request.get("/api/table2/lookup?expected=7248.50")).json()).threshold).toBe(5_000);
  });

  test("US-10 the open-ended last band reports max null", async ({ request }) => {
    const b = await (await request.get("/api/table2/lookup?expected=99999999")).json();
    expect(b).toMatchObject({ threshold: 75_000, band: { min: 3_293_540, max: null } });
  });

  for (const [label, qs] of [["E-10 negative", "?expected=-1"], ["E-10 non-numeric", "?expected=abc"], ["E-10 missing", ""],
    ["empty", "?expected="], ["exponent", "?expected=1e5"], ["hex", "?expected=0x10"], ["repeated", "?expected=1&expected=2"]] as const) {
    test(`US-10 ${label} expected -> 422 BAD_EXPECTED`, async ({ request }) => {
      const r = await request.get(`/api/table2/lookup${qs}`);
      expect(r.status()).toBe(422);
      expect(r.headers()["content-type"]).toContain("application/json");
      expect((await r.json()).error).toEqual({ code: "BAD_EXPECTED", message: expect.any(String) });
    });
  }

  test("US-10 lookup agrees with the threshold the calculator uses", async ({ request }) => {
    const calc = await (await request.post("/api/xmod/calculate", { data: { payroll: [{ classCode: "0005", payroll: 2_358_250 }], claims: [] } })).json();
    const look = await (await request.get(`/api/table2/lookup?expected=${calc.expectedLosses}`)).json();
    expect(look.threshold).toBe(calc.primaryThreshold);
  });
});
