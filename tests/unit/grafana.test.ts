import { describe, it, expect } from "vitest";
import { DEFAULT_GRAFANA, isLocalHost, parseGrafanaUrl, resolveGrafana } from "../../web/grafana.js";

describe("US-08 Grafana link rules (web/grafana.js, DEF-011)", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"])("US-08 %s is a local host", (h) => expect(isLocalHost(h)).toBe(true));
  it.each(["xmod-lab.onrender.com", "example.com", "127.0.0.2", "localhost.example.com", ""])("US-08 %j is not local", (h) => expect(isLocalHost(h)).toBe(false));

  it.each([
    ["https://grafana.example.com", "https://grafana.example.com"],
    ["  http://localhost:3001  ", "http://localhost:3001"],
    ["https://g.example.com/d/xmod-lab?orgId=1", "https://g.example.com/d/xmod-lab?orgId=1"],
  ])("US-08 accepts http/https URL %j", (v, out) => expect(parseGrafanaUrl(v)).toBe(out));
  it.each(["javascript:alert(1)", "ftp://example.com", "data:text/html,x", "grafana.example.com", "/relative", "", "   ", null, undefined])(
    "US-08 rejects %j", (v) => expect(parseGrafanaUrl(v)).toBeNull());

  it("US-08 local page: default localhost:3001; server GRAFANA_URL beats it; a visitor override beats both", () => {
    expect(resolveGrafana({ hostname: "localhost", override: null, serverUrl: null })).toEqual({ url: DEFAULT_GRAFANA, hosted: false });
    expect(resolveGrafana({ hostname: "127.0.0.1", override: null, serverUrl: "http://grafana.internal:3000" }).url).toBe("http://grafana.internal:3000");
    expect(resolveGrafana({ hostname: "localhost", override: "https://mine.example", serverUrl: "http://x.example" }).url).toBe("https://mine.example");
  });

  it("US-08 hosted page: no dead localhost link; only a visitor URL or a real server-configured URL is shown", () => {
    const hosted = "xmod-lab.onrender.com";
    // The server reports its default http://localhost:3001 when GRAFANA_URL is unset: that is a dead link here.
    expect(resolveGrafana({ hostname: hosted, override: null, serverUrl: "http://localhost:3001" })).toEqual({ url: null, hosted: true });
    expect(resolveGrafana({ hostname: hosted, override: null, serverUrl: null })).toEqual({ url: null, hosted: true });
    expect(resolveGrafana({ hostname: hosted, override: null, serverUrl: "https://grafana.example.com" }).url).toBe("https://grafana.example.com");
    expect(resolveGrafana({ hostname: hosted, override: "https://mine.example", serverUrl: "http://localhost:3001" }).url).toBe("https://mine.example");
    expect(resolveGrafana({ hostname: hosted, override: "javascript:alert(1)", serverUrl: null }).url).toBeNull();
  });
});
