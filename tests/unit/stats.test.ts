import { describe, it, expect } from "vitest";
import { histogramQuantile, summarizeMetrics, summarizePlaywright, type PromMetric, type PwReport } from "../../src/server/stats";

describe("histogramQuantile (same estimate as PromQL histogram_quantile)", () => {
  const b = (pairs: [number, number][]) => pairs.map(([le, count]) => ({ le, count }));
  it("returns null with no observations", () => {
    expect(histogramQuantile(0.95, b([[0.1, 0], [Infinity, 0]]))).toBeNull();
  });
  it("interpolates linearly inside the bucket that holds the rank", () => {
    // 100 obs: 50 <= 0.01, 100 <= 0.1. p95 rank 95 -> 45 of 50 into (0.01, 0.1] -> 0.01 + 0.09 * 0.9
    expect(histogramQuantile(0.95, b([[0.01, 50], [0.1, 100], [Infinity, 100]]))).toBeCloseTo(0.091, 10);
  });
  it("the first bucket interpolates from zero", () => {
    expect(histogramQuantile(0.5, b([[0.2, 10], [Infinity, 10]]))).toBeCloseTo(0.1, 10);
  });
  it("a rank in +Inf returns the highest finite edge rather than Infinity", () => {
    expect(histogramQuantile(0.99, b([[0.5, 90], [1, 95], [Infinity, 100]]))).toBe(1);
  });
  it("ignores input order", () => {
    expect(histogramQuantile(0.5, b([[Infinity, 4], [1, 4], [0.5, 2]]))).toBe(0.5);
  });
});

describe("summarizeMetrics", () => {
  const h = (route: string, status: number, buckets: [string, number][], count: number): PromMetric["values"] => [
    ...buckets.map(([le, value]) => ({ value, labels: { le, method: "POST", route, status }, metricName: "xmod_http_request_duration_seconds_bucket" })),
    { value: count, labels: { method: "POST", route, status }, metricName: "xmod_http_request_duration_seconds_count" },
  ];
  const metrics: PromMetric[] = [
    { name: "xmod_http_request_duration_seconds", type: "histogram", values: [
      ...h("/api/xmod/calculate", 200, [["0.01", 8], ["0.1", 10], ["+Inf", 10]], 10),
      ...h("/api/xmod/calculate", 422, [["0.01", 2], ["0.1", 2], ["+Inf", 2]], 2),
      ...h("/metrics", 200, [["0.01", 0], ["0.1", 50], ["+Inf", 50]], 50), // dashboard polling: excluded
      ...h("unmatched", 404, [["0.01", 1], ["0.1", 1], ["+Inf", 1]], 1),
    ] },
    { name: "xmod_calculations_total", type: "counter", values: [
      { value: 10, labels: { outcome: "ok" } }, { value: 2, labels: { outcome: "validation_error" } },
    ] },
    { name: "xmod_mod_value", type: "histogram", values: [
      { value: 3, labels: { le: "0.85" }, metricName: "xmod_mod_value_bucket" },
      { value: 9, labels: { le: "1" }, metricName: "xmod_mod_value_bucket" },
      { value: 10, labels: { le: "+Inf" }, metricName: "xmod_mod_value_bucket" },
      { value: 9.5, labels: {}, metricName: "xmod_mod_value_sum" },
      { value: 10, labels: {}, metricName: "xmod_mod_value_count" },
    ] },
  ];
  const s = summarizeMetrics(metrics, 61.4, new Date("2026-01-01T00:00:00Z"));

  it("counts traffic but leaves out the routes the dashboard itself polls", () => {
    expect(s.totalRequests).toBe(13);
    expect(s.requestsByRoute).toEqual({ "/api/xmod/calculate": 12, unmatched: 1 });
    expect(s.statusClasses).toEqual({ "2xx": 10, "3xx": 0, "4xx": 3, "5xx": 0 });
  });
  it("reports calculations by outcome", () => {
    expect(s.calculations).toEqual({ ok: 10, validation_error: 2, server_error: 0, total: 12 });
  });
  it("estimates latency percentiles from /api/* buckets only", () => {
    // 12 api obs: 10 <= 10ms, 12 <= 100ms. p50 rank 6 -> 6/10 of 10ms = 6ms
    expect(s.latency.p50Ms).toBe(6);
    // p95 rank 11.4 -> 10ms + 90ms * (1.4 / 2) = 73ms
    expect(s.latency.p95Ms).toBe(73);
  });
  it("turns cumulative mod buckets into per-range counts", () => {
    expect(s.mods).toEqual({ count: 10, mean: 0.95, buckets: [
      { le: "0–0.85", count: 3 }, { le: "0.85–1", count: 6 }, { le: "> 1", count: 1 },
    ] });
  });
  it("rounds uptime and stamps the time", () => {
    expect(s.uptimeSeconds).toBe(61);
    expect(s.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  });
  it("an empty registry gives zeros and null latency, not NaN", () => {
    const e = summarizeMetrics([], 0);
    expect(e.totalRequests).toBe(0);
    expect(e.latency.p95Ms).toBeNull();
    expect(e.mods.mean).toBeNull();
  });
});

describe("summarizePlaywright", () => {
  const test = (projectName: string, status: string, message?: string) => ({
    projectName, status, results: [{ status: status === "expected" ? "passed" : "failed", errors: message ? [{ message }] : [] }],
  });
  const report: PwReport = {
    stats: { startTime: "2026-01-01T00:00:00Z", duration: 1234 },
    suites: [{
      title: "api/x.spec.ts", file: "api/x.spec.ts",
      specs: [{ title: "top-level", file: "api/x.spec.ts", line: 3, tests: [test("api", "expected")] }],
      suites: [{
        title: "US-06 validation", specs: [
          { title: "rejects", file: "api/x.spec.ts", line: 9, tests: [test("api", "unexpected", "\u001b[31mError: expect(received).toBe(expected)\u001b[39m\n\nExpected: 422")] },
          { title: "flaky one", file: "api/x.spec.ts", line: 12, tests: [test("api", "flaky")] },
        ],
      }],
    }, {
      title: "ui/y.spec.ts", file: "ui/y.spec.ts",
      specs: [{ title: "page", file: "ui/y.spec.ts", line: 1, tests: [test("ui", "expected"), test("ui", "skipped")] }],
    }],
  };
  const s = summarizePlaywright(report);

  it("counts per project and in total", () => {
    expect(s.projects).toEqual({
      api: { passed: 1, failed: 1, flaky: 1, skipped: 0, total: 3 },
      ui: { passed: 1, failed: 0, flaky: 0, skipped: 1, total: 2 },
    });
    expect(s.totals).toEqual({ passed: 2, failed: 1, flaky: 1, skipped: 1, total: 5 });
  });
  it("lists failed tests with describe path, location and the first error line without ANSI codes", () => {
    expect(s.failed).toEqual([{
      project: "api", title: "US-06 validation › rejects", file: "api/x.spec.ts", line: 9,
      error: "Error: expect(received).toBe(expected)",
    }]);
  });
  it("carries run metadata", () => {
    expect(s).toMatchObject({ available: true, startTime: "2026-01-01T00:00:00Z", durationMs: 1234 });
  });
});
