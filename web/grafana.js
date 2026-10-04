// Where the Quality dashboard's "Open Grafana" link should point (pure functions, unit tested in tests/unit/grafana.test.ts).
// Grafana only runs locally (docker compose), so on a hosted deployment a localhost link would be dead (DEF-011).

export const DEFAULT_GRAFANA = "http://localhost:3001";
export const STORAGE_KEY = "xmod.grafanaUrl";

/** True when the page itself is served from this machine. */
export const isLocalHost = (hostname) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(String(hostname).toLowerCase());

/** A usable Grafana URL (absolute http/https), trimmed; null for anything else (javascript:, ftp:, relative, garbage). */
export function parseGrafanaUrl(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Decide the link for this page.
 *  - local page: the visitor's override, else the server's GRAFANA_URL, else the default localhost:3001.
 *  - hosted page: the visitor's override, else a server URL only if it is NOT a localhost URL (an operator who set
 *    GRAFANA_URL to a real Grafana); otherwise no link, and the note explains why.
 * @returns {{ url: string | null, hosted: boolean }}
 */
export function resolveGrafana({ hostname, override, serverUrl }) {
  const hosted = !isLocalHost(hostname);
  const own = parseGrafanaUrl(override);
  const server = parseGrafanaUrl(serverUrl);
  if (!hosted) return { url: own ?? server ?? DEFAULT_GRAFANA, hosted };
  const serverIsLocal = server !== null && isLocalHost(new URL(server).hostname);
  return { url: own ?? (server && !serverIsLocal ? server : null), hosted };
}
