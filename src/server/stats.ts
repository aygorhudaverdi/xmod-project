/**
 * Pure helpers behind the in-app Quality dashboard:
 *   - summarizeMetrics: prom-client registry JSON -> the numbers the dashboard shows (GET /api/stats)
 *   - summarizePlaywright: Playwright JSON reporter output -> pass/fail per project (GET /api/test-results)
 * Kept free of Express so they can be unit tested with fixtures.
 */

// ------------------------------------------------------------------ metrics
export interface PromValue { value: number; labels: Record<string, string | number>; metricName?: string }
export interface PromMetric { name: string; type: string; values: PromValue[] }

export interface Bucket { le: number; count: number } // cumulative, as Prometheus exposes them

/** Same estimate as PromQL histogram_quantile: linear interpolation inside the bucket holding the rank. */
export function histogramQuantile(q: number, buckets: Bucket[]): number | null {
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const total = sorted.at(-1)?.count ?? 0;
  if (total === 0) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of sorted) {
    if (b.count >= rank) {
      if (!Number.isFinite(b.le)) return prevLe; // rank fell in +Inf: best answer is the highest finite edge
      const inBucket = b.count - prevCount;
      return inBucket === 0 ? b.le : prevLe + (b.le - prevLe) * ((rank - prevCount) / inBucket);
    }
    prevLe = b.le;
    prevCount = b.count;
  }
  return prevLe;
}

/** Endpoints the dashboard itself polls; left out of traffic numbers so watching the page does not inflate them. */
export const DASHBOARD_ROUTES = new Set(["/metrics", "/api/stats", "/api/test-results"]);

const leOf = (v: PromValue) => (v.labels.le === "+Inf" ? Infinity : Number(v.labels.le));

export interface StatsSummary {
  generatedAt: string;
  uptimeSeconds: number;
  totalRequests: number;
  requestsByRoute: Record<string, number>;
  statusClasses: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
  calculations: { ok: number; validation_error: number; server_error: number; total: number };
  latency: { p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; note: string };
  mods: { count: number; mean: number | null; buckets: { le: string; count: number }[] };
}

export function summarizeMetrics(metrics: PromMetric[], uptimeSeconds: number, now = new Date()): StatsSummary {
  const byName = new Map(metrics.map((m) => [m.name, m]));

  const http = byName.get("xmod_http_request_duration_seconds")?.values ?? [];
  const requestsByRoute: Record<string, number> = {};
  const statusClasses = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  const latencyBuckets = new Map<number, number>();
  for (const v of http) {
    const route = String(v.labels.route);
    if (DASHBOARD_ROUTES.has(route)) continue;
    if (v.metricName?.endsWith("_count")) {
      requestsByRoute[route] = (requestsByRoute[route] ?? 0) + v.value;
      const cls = `${String(v.labels.status)[0]}xx` as keyof typeof statusClasses;
      if (cls in statusClasses) statusClasses[cls] += v.value;
    } else if (v.metricName?.endsWith("_bucket") && route.startsWith("/api/")) {
      const le = leOf(v);
      latencyBuckets.set(le, (latencyBuckets.get(le) ?? 0) + v.value);
    }
  }
  const lb = [...latencyBuckets].map(([le, count]) => ({ le, count }));
  const ms = (q: number) => {
    const s = histogramQuantile(q, lb);
    return s === null ? null : Math.round(s * 1000 * 100) / 100;
  };

  const calc = { ok: 0, validation_error: 0, server_error: 0, total: 0 };
  for (const v of byName.get("xmod_calculations_total")?.values ?? []) {
    const k = String(v.labels.outcome) as keyof typeof calc;
    if (k in calc && k !== "total") calc[k] += v.value;
    calc.total += v.value;
  }

  const modValues = byName.get("xmod_mod_value")?.values ?? [];
  const modCount = modValues.find((v) => v.metricName?.endsWith("_count"))?.value ?? 0;
  const modSum = modValues.find((v) => v.metricName?.endsWith("_sum"))?.value ?? 0;
  // Cumulative -> per-bucket counts, labelled by range for display.
  const cumulative = modValues.filter((v) => v.metricName?.endsWith("_bucket")).sort((a, b) => leOf(a) - leOf(b));
  let prev = 0;
  let prevLe = "0";
  const modBuckets = cumulative.map((v) => {
    const le = String(v.labels.le);
    const out = { le: le === "+Inf" ? `> ${prevLe}` : `${prevLe}–${le}`, count: v.value - prev };
    prev = v.value;
    prevLe = le;
    return out;
  });

  return {
    generatedAt: now.toISOString(),
    uptimeSeconds: Math.round(uptimeSeconds),
    totalRequests: Object.values(requestsByRoute).reduce((s, n) => s + n, 0),
    requestsByRoute,
    statusClasses,
    calculations: calc,
    latency: {
      p50Ms: ms(0.5), p95Ms: ms(0.95), p99Ms: ms(0.99),
      note: "Approximate: interpolated from histogram buckets over /api/* since process start (same method as PromQL histogram_quantile).",
    },
    mods: { count: modCount, mean: modCount ? Math.round((modSum / modCount) * 1000) / 1000 : null, buckets: modBuckets },
  };
}

// ------------------------------------------------------------------ Playwright results
interface PwResult { status: string; errors?: { message?: string }[]; error?: { message?: string } }
interface PwTest { projectName: string; status: string; results: PwResult[] }
interface PwSpec { title: string; file: string; line: number; tests: PwTest[] }
interface PwSuite { title: string; file?: string; specs?: PwSpec[]; suites?: PwSuite[] }
export interface PwReport { suites?: PwSuite[]; stats?: { startTime?: string; duration?: number }; errors?: { message?: string }[] }

export interface ProjectCounts { passed: number; failed: number; flaky: number; skipped: number; total: number }
export interface TestResultsSummary {
  available: boolean;
  message?: string;
  startTime?: string;
  durationMs?: number;
  totals?: ProjectCounts;
  projects?: Record<string, ProjectCounts>;
  failed?: { project: string; title: string; file: string; line: number; error: string }[];
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const STATUS_KEY: Record<string, keyof Omit<ProjectCounts, "total">> = {
  expected: "passed", unexpected: "failed", flaky: "flaky", skipped: "skipped",
};
const empty = (): ProjectCounts => ({ passed: 0, failed: 0, flaky: 0, skipped: 0, total: 0 });

export function summarizePlaywright(report: PwReport): TestResultsSummary {
  const projects: Record<string, ProjectCounts> = {};
  const totals = empty();
  const failed: NonNullable<TestResultsSummary["failed"]> = [];

  const walk = (suite: PwSuite, path: string[]) => {
    const here = suite.file && suite.title === suite.file ? path : [...path, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const p = (projects[t.projectName || "default"] ??= empty());
        // Playwright statuses: expected | unexpected | flaky | skipped
        const key: keyof Omit<ProjectCounts, "total"> = STATUS_KEY[t.status] ?? "failed";
        p[key]++; p.total++; totals[key]++; totals.total++;
        if (key === "failed") {
          const last = t.results.at(-1);
          const msg = last?.errors?.[0]?.message ?? last?.error?.message ?? "(no error message)";
          failed.push({
            project: t.projectName, title: [...here, spec.title].join(" › "), file: spec.file, line: spec.line,
            error: stripAnsi(msg).split("\n").find((l) => l.trim()) ?? "",
          });
        }
      }
    }
    for (const s of suite.suites ?? []) walk(s, here);
  };
  for (const s of report.suites ?? []) walk(s, []);

  return {
    available: true, startTime: report.stats?.startTime, durationMs: report.stats?.duration,
    totals, projects, failed,
  };
}
