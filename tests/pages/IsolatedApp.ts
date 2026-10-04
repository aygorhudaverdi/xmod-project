import { request as pwRequest, type APIRequestContext } from "@playwright/test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, type AppOptions } from "../../src/server/app";
import { ApiClient } from "./ApiClient";

/**
 * An in-process app on an ephemeral port with its own rate limiter and metrics registry.
 * Used where a test needs a tiny rate limit or exact counter deltas, never the shared server.
 */
export class IsolatedApp {
  private constructor(private readonly server: Server, private readonly context: APIRequestContext, readonly api: ApiClient) {}

  static async start(options: AppOptions = { rateLimit: { limit: 1_000_000, windowMs: 60_000 } }): Promise<IsolatedApp> {
    const server = createApp(options).listen(0);
    await new Promise((r) => server.once("listening", r));
    const context = await pwRequest.newContext({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    return new IsolatedApp(server, context, new ApiClient(context));
  }

  async stop(): Promise<void> {
    await this.context.dispose();
    await new Promise((r) => this.server.close(r));
  }
}
