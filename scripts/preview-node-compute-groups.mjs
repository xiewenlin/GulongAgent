// Loopback-only UI acceptance: actual admin routes, memory data, no credentials.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { registerComputeGroupRoutes } from "../server/compute-groups.js";
import { registerCapabilityConsumerAcceptanceRoutes } from "../server/capability-consumer-acceptance.js";
import { createCapabilityMemoryCollection } from "../tests/helpers/capability-memory.mjs";

const cache = process.argv[2], expected = "D:/ProgramFiles/program/gulong-agent-build/current/cache/node-group-preview";
if (!cache || !path.isAbsolute(cache) || path.resolve(cache).toLowerCase() !== path.resolve(expected).toLowerCase()) throw new Error("必须使用固定受控预览缓存目录");
if ((await lstat(cache)).isSymbolicLink() || (await realpath(cache)).toLowerCase() !== path.resolve(cache).toLowerCase()) throw new Error("预览缓存不能经过重解析目标");
const tables = new Map();
const table = (name) => { if (!tables.has(name)) tables.set(name, createCapabilityMemoryCollection()); return tables.get(name); };
for (let n = 1; n <= 120; n++) table("computeGroups").rows.push({ id: `gug_${n.toString(16).padStart(32, "0")}`, name: n === 120 ? "影视团队 · 搜索测试" : `创作团队 ${n}`, createdAt: new Date() });
for (const digit of ["1", "2"]) table("nodeAccountBindings").rows.push({ _id: new ObjectId(digit.repeat(24)), userId: new ObjectId("a".repeat(24)), nodeId: digit.repeat(64), nodeName: digit === "1" ? "培训 1 号机（本地验收样例）" : "离线节点（本地验收样例）", status: "active", revokedAt: null, computeGroupId: table("computeGroups").rows[0].id, updatedAt: new Date(), lastSeenAt: new Date(Date.now() - (digit === "1" ? 1000 : 600000)) });
const app = new OpenAPIHono();
const guards = {
  getCollection: async (name) => table(name),
  // Synthetic heartbeat for the explicitly labelled loopback sample only.
  readNodeHeartbeats: async () => [{ bindingId: "1".repeat(24), nodeId: "1".repeat(64), lastSeenAt: new Date(Date.now() - 1000) }],
  requireAdmin: async () => ({ user: { id: "a".repeat(24), role: "admin" } }),
  requireTrustedMutation: (c) => c.req.header("origin") === "http://127.0.0.1:5173" ? null : c.json({ message: "仅限本地预览" }, 403),
};
registerCapabilityConsumerAcceptanceRoutes(app, guards);
let tail = Promise.resolve();
registerComputeGroupRoutes(app, { ...guards, enforceRateLimit: async () => ({ allowed: true }), transaction: (operation) => {
  const result = tail.then(async () => {
    const before = new Map(); for (const [name, value] of tables) before.set(name, await value.find({}).toArray());
    try { return await operation({}); } catch (error) { for (const [name, value] of tables) value.rows.splice(0, value.rows.length, ...(before.get(name) || [])); throw error; }
  }); tail = result.catch(() => {}); return result;
} });
app.get("/api/admin/capability-verifications", (c) => c.json({ verifications: [] }));
const entry = `import React from "react";import{createRoot}from"react-dom/client";import"/src/styles.css";import{ConfirmDialogProvider}from"/src/components/ConfirmDialog.jsx";import{CapabilityConsumersPanel}from"/src/components/CapabilityConsumersPanel.jsx";createRoot(document.getElementById("root")).render(React.createElement(ConfirmDialogProvider,null,React.createElement(CapabilityConsumersPanel)));`;
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: cache, envDir: cache, plugins: [{ name: "node-group-memory-preview",
  resolveId(id) { if (id === "/__node-group-preview.jsx") return "\0node-group-preview.jsx"; },
  load(id) { if (id === "\0node-group-preview.jsx") return entry; },
  configureServer(s) { s.middlewares.use(async (req, res, next) => {
    try {
      if (req.url?.startsWith("/api/")) {
        const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) throw new Error("body limit"); chunks.push(chunk); }
        const result = await app.fetch(new Request(`http://127.0.0.1:5173${req.url}`, { method: req.method, headers: req.headers, ...(["GET", "HEAD"].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) }));
        res.statusCode = result.status; result.headers.forEach((value, key) => res.setHeader(key, value)); res.end(Buffer.from(await result.arrayBuffer())); return;
      }
      if (req.url?.startsWith("/admin/node-group-preview")) { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(await s.transformIndexHtml(req.url, '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>节点算力分组本地验收</title></head><body><div id="root" style="max-width:1200px;margin:auto;padding:24px"></div><script type="module" src="/__node-group-preview.jsx"></script></body></html>')); return; }
      next();
    } catch { res.statusCode = 500; res.end("本地预览失败"); }
  }); },
}, react()], server: { host: "127.0.0.1", port: 5173, strictPort: true } });
await server.listen(); server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await server.close(); process.exit(0); });
