// Local UI acceptance only: actual letter routes, volatile memory, no production credentials.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { OpenAPIHono } from "@hono/zod-openapi";
import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { registerLoveLetterRoutes } from "../server/love-letter.js";
import { createCapabilityMemoryCollection } from "../tests/helpers/capability-memory.mjs";

const expectedCache = "D:/ProgramFiles/program/gulong-agent-build/current/cache/birthday-preview";
const cache = process.argv[2];
if (!cache || !path.isAbsolute(cache) || path.resolve(cache).toLowerCase() !== path.resolve(expectedCache).toLowerCase()) throw new Error("必须使用已经核验的项目固定预览缓存目录");
if ((await lstat(cache)).isSymbolicLink() || (await realpath(cache)).toLowerCase() !== path.resolve(cache).toLowerCase()) throw new Error("预览目录不能经过重解析目标");
const collection = createCapabilityMemoryCollection();
collection.createIndex = async () => "preview-memory-index";
const insert = collection.insertOne.bind(collection);
collection.insertOne = async (document) => {
  if (collection.rows.some((row) => row.guestHash === document.guestHash && row.requestId === document.requestId)) throw Object.assign(new Error("duplicate preview request"), { code: 11000 });
  return insert(document);
};
const app = new OpenAPIHono();
registerLoveLetterRoutes(app, {
  getCollection: async () => collection,
  enforceRateLimit: async () => ({ allowed: true }),
  fingerprintIp: () => "local-preview",
  isTrustedBrowserRequest: (c) => !c.req.header("origin") || c.req.header("origin") === "http://127.0.0.1:5173",
});
const wallId = "11111111-1111-4111-8111-111111111111";
const entry = `import React from "react";import {createRoot} from "react-dom/client";import "/src/styles.css";import {ConfirmDialogProvider} from "/src/components/ConfirmDialog.jsx";import {BirthdayWallPage} from "/src/components/BirthdayWallPage.jsx";import {LoveLetterPage} from "/src/components/LoveLetterPage.jsx";const letter=location.pathname.startsWith("/love-letter/");createRoot(document.getElementById("root")).render(React.createElement(ConfirmDialogProvider,null,letter?React.createElement(LoveLetterPage,{letterId:location.pathname.split("/")[2]}):React.createElement(BirthdayWallPage,{wallId:"${wallId}",user:null})));`;
const server = await createServer({
  configFile: false, root: process.cwd(), cacheDir: cache, envDir: cache,
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  plugins: [{
    name: "love-letter-memory-preview",
    resolveId(id) { if (id === "/__letter-preview.jsx") return "\0letter-preview.jsx"; },
    load(id) { if (id === "\0letter-preview.jsx") return entry; },
    configureServer(s) {
      s.middlewares.use(async (req, res, next) => {
        try {
          if (req.url?.startsWith("/api/love-letters")) {
            const chunks = []; let bytes = 0;
            for await (const chunk of req) { bytes += chunk.length; if (bytes > 131072) throw new Error("preview body limit"); chunks.push(chunk); }
            const response = await app.fetch(new Request(`http://127.0.0.1:5173${req.url}`, {
              method: req.method, headers: req.headers, ...(["GET", "HEAD"].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
            }));
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            res.end(Buffer.from(await response.arrayBuffer())); return;
          }
          if (req.url?.startsWith("/api/")) {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            if (req.method !== "GET") { res.statusCode = 405; res.end(JSON.stringify({ message: "此预览只允许在内存中保存测试情书" })); return; }
            res.end(JSON.stringify(req.url.startsWith("/api/birthday-walls/") ? { wall: { id: wallId, name: "小满", createdAt: new Date().toISOString() }, notes: [], stats: { total: 0 } } : { models: [] })); return;
          }
          if (req.url?.startsWith("/birthday-wall") || req.url?.startsWith("/love-letter/")) {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Referrer-Policy", "no-referrer");
            res.end(await s.transformIndexHtml(req.url, '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>电子情书本地验收</title></head><body><div id="root"></div><script type="module" src="/__letter-preview.jsx"></script></body></html>')); return;
          }
          next();
        } catch { res.statusCode = 500; res.end("本地预览失败"); }
      });
    },
  }, react()],
});
await server.listen();
server.printUrls();
const stop = async () => { await server.close(); process.exit(0); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
