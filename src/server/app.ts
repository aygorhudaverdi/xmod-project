import express from "express";
import client from "prom-client";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { calculateMod, classCodes, classInfo, planInfo, ValidationError, type RatingInput } from "../engine/xmod.js";
import { summarizeMetrics, summarizePlaywright, type PromMetric } from "./stats.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Bounded `route` label: the matched route pattern, or one of two fixed buckets. Using the raw path for
 * unmatched requests let any client create a new time series per URL (DEF-003).
 */
const FIXED_API_PATHS = new Set(["/api/health", "/api/plan", "/api/classes", "/api/xmod/calculate", "/metrics"]);
function routeLabel(req: express.Request, res: express.Response): string {
  if (req.route?.path) return req.baseUrl + req.route.path;
  // Body-parser errors (400 malformed JSON, 413) are raised before routing; keep them on their endpoint.
  if (FIXED_API_PATHS.has(req.path)) return req.path;
  return res.statusCode === 404 ? "unmatched" : "static";
}

export function createApp() {
  const app = express();

  // ---- Prometheus metrics (scraped later by Prometheus -> Grafana)
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const httpDuration = new client.Histogram({
    name: "xmod_http_request_duration_seconds", help: "HTTP request latency",
    labelNames: ["method", "route", "status"], registers: [registry],
    // 0.2 and 0.5 are bucket edges so the p95 < 200 ms / p99 < 500 ms targets are measured, not interpolated.
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2.5],
  });
  const calcTotal = new client.Counter({
    name: "xmod_calculations_total", help: "X-Mod calculations by outcome", labelNames: ["outcome"], registers: [registry],
  });
  const modGauge = new client.Histogram({
    name: "xmod_mod_value", help: "Distribution of calculated mods", registers: [registry],
    buckets: [0.5, 0.7, 0.85, 1, 1.15, 1.3, 1.5, 2, 3],
  });

  app.use((req, res, next) => {
    const end = httpDuration.startTimer();
    res.on("finish", () => end({ method: req.method, route: routeLabel(req, res), status: res.statusCode }));
    next();
  });
  // After the timer: a body-parser failure skips later middleware, so a parser placed first left
  // 400/413 responses out of the metrics entirely (DEF-004).
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", (_req, res) => res.json({ status: "ok", version: pkg.version }));
  app.get("/api/plan", (_req, res) => res.json(planInfo()));
  app.get("/api/classes", (req, res) => {
    const q = String(req.query.q ?? "");
    const list = classCodes().filter((c) => c.startsWith(q)).slice(0, 50).map((c) => classInfo(c));
    res.json(list);
  });
  app.get("/api/classes/:code", (req, res) => {
    const info = classInfo(req.params.code);
    info ? res.json(info) : res.status(404).json({ error: { code: "UNKNOWN_CLASS", message: `Unknown class code ${req.params.code}` } });
  });

  app.post("/api/xmod/calculate", (req, res) => {
    try {
      const result = calculateMod(req.body as RatingInput);
      calcTotal.inc({ outcome: "ok" });
      modGauge.observe(result.mod);
      res.json(result);
    } catch (e) {
      if (e instanceof ValidationError) {
        calcTotal.inc({ outcome: "validation_error" });
        return res.status(422).json({ error: { code: e.code, message: e.message } });
      }
      if (e instanceof TypeError) {
        calcTotal.inc({ outcome: "validation_error" });
        return res.status(400).json({ error: { code: "MALFORMED_REQUEST", message: "Request body is not a valid rating input" } });
      }
      calcTotal.inc({ outcome: "server_error" });
      res.status(500).json({ error: { code: "INTERNAL", message: "Unexpected error" } });
    }
  });

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  // ---- Quality dashboard feeds (JSON views of /metrics and of the Playwright JSON report)
  app.get("/api/stats", async (_req, res) => {
    const metrics = (await registry.getMetricsAsJSON()) as unknown as PromMetric[];
    res.set("Cache-Control", "no-store");
    res.json({
      ...summarizeMetrics(metrics, process.uptime()),
      links: { grafana: process.env.GRAFANA_URL || "http://localhost:3001" },
    });
  });

  // Fixed server-side path (env or default); never taken from the request.
  const resultsPath = resolve(ROOT, process.env.TEST_RESULTS_PATH || "test-results/results.json");
  app.get("/api/test-results", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    let raw: string;
    try {
      raw = await readFile(resultsPath, "utf8");
    } catch {
      return res.json({ available: false, message: "No Playwright results found. Run `npx playwright test`, then refresh." });
    }
    try {
      res.json(summarizePlaywright(JSON.parse(raw)));
    } catch {
      res.json({ available: false, message: "The Playwright results file could not be read (invalid or partial JSON)." });
    }
  });

  app.use(express.static(fileURLToPath(new URL("../../web", import.meta.url))));
  // JSON error contract for body-parser failures (malformed JSON, oversize payload)
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === "entity.parse.failed")
      return res.status(400).json({ error: { code: "MALFORMED_JSON", message: "Request body is not valid JSON" } });
    if (err?.type === "entity.too.large")
      return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" } });
    next(err);
  });
  return app;
}
