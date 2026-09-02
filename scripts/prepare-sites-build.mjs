#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker", "index.js");
const hosting = path.join(root, ".openai", "hosting.json");
const client = path.join(dist, "client");

for (const file of [index, worker, hosting]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
copyFileSync(worker, path.join(dist, "server", "index.js"));
copyFileSync(hosting, path.join(dist, ".openai", "hosting.json"));

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolute, relative) : [relative];
    })
    .filter((relative) => relative !== "deployment-manifest.json")
    .sort();
}

const files = Object.fromEntries(listFiles(client).map((relative) => {
  const absolute = path.join(client, ...relative.split("/"));
  const bytes = readFileSync(absolute);
  return [relative, {
    bytes: statSync(absolute).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }];
}));
const commit = /^[0-9a-f]{40}$/i.test(process.env.GITHUB_SHA || "") ? process.env.GITHUB_SHA.toLowerCase() : null;
writeFileSync(path.join(client, "deployment-manifest.json"), `${JSON.stringify({ version: 1, commit, files }, null, 2)}\n`);

console.log("Prepared Sites build and deterministic client deployment manifest.");
