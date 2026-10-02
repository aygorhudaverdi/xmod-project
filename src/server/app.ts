import express from "express";
import client from "prom-client";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };
import { calculateMod, classCodes, classInfo, planInfo, ValidationError, type RatingInput } from "../engine/xmod.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // ---- Prometheus metrics (scraped later by Prometheus -> Grafana)
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const httpDuration = new client.Histogram({
    name: "xmod_http_request_duration_seconds", help: "HTTP request latency",
    labelNames: ["method", "route", "status"], registers: [registry],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
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
    res.on("finish", () => end({ method: req.method, route: req.route?.path ?? req.path, status: res.statusCode }));
    next();
  });

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
