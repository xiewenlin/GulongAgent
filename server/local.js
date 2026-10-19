import { serve } from "@hono/node-server";
import app from "./app.js";
import { enablePersistentDigitalLiveMediaRuntime } from "./digital-live-realtime-routes.js";

const port = Number(process.env.API_PORT || 8787);
enablePersistentDigitalLiveMediaRuntime();

serve({ fetch: app.fetch, port }, () => {
  console.log(`Gulong API listening on http://127.0.0.1:${port}`);
});
