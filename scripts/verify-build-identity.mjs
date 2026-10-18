#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { assertManifestIdentity } from "./deployment-build-identity.mjs";

const [manifestPath, expected = process.env.GITHUB_SHA] = process.argv.slice(2);
if (!manifestPath) throw new Error("缺少待验证的发布清单路径");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const commit = assertManifestIdentity(manifest, expected);
console.log(JSON.stringify({ ok: true, commit, state: "prepublish-identity-verified" }));
