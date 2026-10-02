import { createApp } from "./app.js";
const port = Number(process.env.PORT ?? 3000);
const server = createApp().listen(port, () => console.log(`X-Mod Lab listening on http://localhost:${port}`));

// In a container node is PID 1 and gets SIGTERM on `docker stop`; close cleanly instead of waiting to be killed.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
