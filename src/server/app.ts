import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
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

export interface AppOptions {
  /** Requests per window per client on POST /api/xmod/calculate. Defaults: RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS env, else 120 per minute. */
  rateLimit?: { limit: number; windowMs: number };
}

const apiError = (res: express.Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } });

export function createApp(options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy (Render), set TRUST_PROXY=1 so rate limiting sees the client IP, not the proxy's.
  app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 0));

  // ---- Security headers. The UI uses only same-origin scripts and styles, so the CSP needs no 'unsafe-inline'.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // No upgrade-insecure-requests: the app is also served over plain http (localhost, docker compose).
      },
    },
  }));

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
    info ? res.json(info) : apiError(res, 404, "UNKNOWN_CLASS", `Unknown class code ${req.params.code}`);
  });

  const limits = options.rateLimit ?? {
    limit: Number(process.env.RATE_LIMIT_MAX ?? 120),
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  };
  const calculateLimiter = rateLimit({
    ...limits,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res, _next, opts) => {
      res.set("Retry-After", String(Math.ceil(opts.windowMs / 1000)));
      apiError(res, 429, "RATE_LIMITED", `Too many calculation requests; limit is ${opts.limit} per ${opts.windowMs / 1000}s`);
    },
  });

  app.post("/api/xmod/calculate", calculateLimiter, (req, res) => {
    try {
      const result = calculateMod(req.body as RatingInput);
      calcTotal.inc({ outcome: "ok" });
      modGauge.observe(result.mod);
      res.json(result);
    } catch (e) {
      if (e instanceof ValidationError) {
        calcTotal.inc({ outcome: "validation_error" });
        return apiError(res, 422, e.code, e.message);
      }
      if (e instanceof TypeError) {
        calcTotal.inc({ outcome: "validation_error" });
        return apiError(res, 400, "MALFORMED_REQUEST", "Request body is not a valid rating input");
      }
      calcTotal.inc({ outcome: "server_error" });
      apiError(res, 500, "INTERNAL", "Unexpected error");
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

  // Anything else under /api is a JSON 404, never the HTML "Cannot GET" page (DEF-005).
  app.use("/api", (req, res) => apiError(res, 404, "NOT_FOUND", `No API route for ${req.method} ${req.originalUrl.split("?")[0]}`));

  app.use(express.static(fileURLToPath(new URL("../../web", import.meta.url))));

  // JSON error contract for every error, so no request can reach Express's HTML handler and its stack trace
  // (DEF-001: body-parser errors; DEF-005: undecodable URL params and any other thrown error).
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === "entity.parse.failed") return apiError(res, 400, "MALFORMED_JSON", "Request body is not valid JSON");
    if (err?.type === "entity.too.large") return apiError(res, 413, "PAYLOAD_TOO_LARGE", "Request body too large");
    const status = Number(err?.status ?? err?.statusCode);
    if (status >= 400 && status < 500) return apiError(res, status, "BAD_REQUEST", "The request could not be processed");
    console.error(`[${req.method} ${req.originalUrl}]`, err);
    apiError(res, 500, "INTERNAL", "Unexpected error");
  });
  return app;
}
