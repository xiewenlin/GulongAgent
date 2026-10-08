const targets = process.argv.slice(2);
if (targets.length !== 2) throw new Error("Usage: node scripts/verify-compute-group-deployment.mjs <vercel-origin> <tencent-origin>");
for (const target of targets) {
  const origin = new URL(target).origin;
  const documentResponse = await fetch(`${origin}/api/openapi.json`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!documentResponse.ok) throw new Error(`${origin}: OpenAPI HTTP ${documentResponse.status}`);
  const document = await documentResponse.json();
  for (const [path, method] of [
    ["/api/desktop/compute-groups", "GET"], ["/api/desktop/nodes/compute-group", "GET"], ["/api/desktop/compute-access/verify", "POST"],
  ]) {
    if (!document.paths[path]) throw new Error(`${origin}: missing OpenAPI route ${path}`);
    const response = await fetch(`${origin}${path}`, { method, cache: "no-store", signal: AbortSignal.timeout(30_000),
      ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ node_id: "deployment-health-node", permit: "invalid" }) } : {}),
    });
    if (response.status !== 401) throw new Error(`${origin}${path}: expected authenticated route HTTP 401, received ${response.status}`);
    const payload = await response.json();
    if (payload.code !== "BINDING_REQUIRED") throw new Error(`${origin}${path}: incorrect binding gate`);
    console.log(`${origin}${path}: authenticated route verified (401)`);
  }
}
