// Production verification is GET-only: no orders, billing, memberships or GPU.
const TOOL = "/api/v1/desktop/agent/tools/minimax-h3-shared";
const values = process.argv.slice(2);
const phase = values.find(value => value.startsWith("--phase="))?.slice(8);
const targets = values.filter(value => !value.startsWith("--"));
const expected = phase === "active";
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function resolve(document, schema) {
  const seen = new Set();
  while (schema?.$ref) {
    requireValue(schema.$ref.startsWith("#/") && !seen.has(schema.$ref), "Invalid OpenAPI reference");
    seen.add(schema.$ref);
    schema = schema.$ref.slice(2).split("/").map(key => key.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((value, key) => value?.[key], document);
  }
  return schema;
}
function property(document, schema, name) { return resolve(document, resolve(document, schema)?.properties?.[name]); }
function literal(schema) { return schema && Object.hasOwn(schema, "const") ? schema.const : schema?.enum?.[0]; }
async function get(origin, path, token) {
  const response = await fetch(origin + path, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", headers: { Accept: "application/json", "Cache-Control": "no-cache", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30_000) });
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("JSON exceeds verification limit"); }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error(`${origin}${path}: invalid JSON (${response.status})`); }
  return { status: response.status, data };
}
function checkPolicy(policy, fromSchema = false) {
  const value = name => fromSchema ? literal(policy?.properties?.[name]) : policy?.[name];
  requireValue(value("version") === 1 && value("requestField") === "require_no_charge" && value("enforced") === expected && value("onUnavailable") === "reject_without_order_or_charge", `Contract does not match phase=${phase}`);
}
try {
  requireValue(["baseline", "active"].includes(phase) && targets.length === 2 && values.length === 3, "Usage: --phase=baseline|active <vercel-origin> <tencent-origin>");
  const origins = targets.map(target => { const url = new URL(target); requireValue(url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, "Expected HTTPS origin"); return url.origin; });
  requireValue(new Set(origins).size === 2, "Expected two distinct production targets");
  const tokens = [process.env.H3_NO_CHARGE_VERIFY_VERCEL_TOKEN, process.env.H3_NO_CHARGE_VERIFY_TENCENT_TOKEN];
  const results = [];
  for (const [index, origin] of origins.entries()) {
    const document = await get(origin, "/api/openapi.json"); requireValue(document.status === 200, `${origin}: OpenAPI status ${document.status}`);
    const api = document.data, post = api.paths?.["/api/h3/tasks"]?.post;
    const request = resolve(api, post?.requestBody?.content?.["application/json"]?.schema);
    requireValue(property(api, request, "require_no_charge")?.type === "boolean" && !request.required?.includes("require_no_charge"), `${origin}: optional boolean missing`);
    requireValue(post.responses?.[403] && api.paths?.["/api/admin/h3/tasks/{id}/retry"]?.post?.responses?.[403], `${origin}: no-charge rejection missing`);
    const responseSchema = api.paths?.[TOOL]?.get?.responses?.[200]?.content?.["application/json"]?.schema;
    checkPolicy(property(api, property(api, responseSchema, "tool"), "noChargeCreation"), true);
    for (const path of [TOOL, "/api/h3/tasks"]) {
      const anonymous = await get(origin, path); requireValue(anonymous.status === 401, `${origin}${path}: anonymous status ${anonymous.status}`);
    }
    let authenticatedToolVerified = false;
    if (tokens[index]) {
      requireValue(!/[\r\n\0]/.test(tokens[index]) && tokens[index] === tokens[index].trim(), "Invalid verification token");
      requireValue(["https://sologle.com", "https://www.sologle.com", "https://111.229.70.235"].includes(origin), "Credentials may only be sent to official targets");
      const result = await get(origin, TOOL, tokens[index]); requireValue(result.status === 200, `${origin}: authenticated tool status ${result.status}`);
      checkPolicy(result.data.tool?.noChargeCreation); authenticatedToolVerified = true;
    }
    results.push({ origin, openapi_phase_verified: true, anonymous_auth_verified: true, authenticated_tool_verified: authenticatedToolVerified });
  }
  console.log(JSON.stringify({ ok: true, phase, mutations_sent: 0, billing_behavior_verified: false, results }, null, 2));
} catch (error) { console.error(JSON.stringify({ ok: false, message: error.message, mutations_sent: 0 })); process.exitCode = 1; }
