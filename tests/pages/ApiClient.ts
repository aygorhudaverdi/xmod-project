import type { APIRequestContext, APIResponse } from "@playwright/test";

export const CALCULATE = "/api/xmod/calculate";

/** A response read once: status, headers, raw text, parsed JSON (undefined when the body is not JSON). */
export interface Reply {
  status: number;
  headers: Record<string, string>;
  text: string;
  bytes: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

async function toReply(r: APIResponse): Promise<Reply> {
  const buf = await r.body();
  const text = buf.toString("utf8");
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status(), headers: r.headers(), text, bytes: buf.length, json };
}

export interface SendOptions {
  /** Serialised by Playwright as JSON. */
  data?: unknown;
  /** Sent byte for byte; use for bodies that are not valid or not plain JSON objects. */
  raw?: string | Buffer;
  headers?: Record<string, string>;
}

/** Typed request helpers for the REST API. Actions and read accessors only, no assertions. */
export class ApiClient {
  constructor(private readonly request: APIRequestContext) {}

  async send(method: string, path: string, opts: SendOptions = {}): Promise<Reply> {
    const r = await this.request.fetch(path, {
      method,
      headers: opts.headers,
      data: opts.raw ?? (opts.data as object | undefined),
    });
    return toReply(r);
  }

  get(path: string, headers?: Record<string, string>) {
    return this.send("GET", path, { headers });
  }

  calculate(data: unknown, headers?: Record<string, string>) {
    return this.send("POST", CALCULATE, { data, headers });
  }

  /** POST a byte-exact body. contentType null sends no content-type header at all. */
  calculateRaw(raw?: string | Buffer, contentType: string | null = "application/json") {
    const headers: Record<string, string> = {};
    if (contentType !== null) headers["content-type"] = contentType;
    return this.send("POST", CALCULATE, { raw, headers });
  }

  /** The `calculations` counters from /api/stats. */
  async calculationCounters(): Promise<{ ok: number; validation_error: number; server_error: number; total: number }> {
    return (await this.get("/api/stats")).json.calculations;
  }

  /** Prometheus text exposition. */
  async metricsText(): Promise<string> {
    return (await this.get("/metrics")).text;
  }
}
