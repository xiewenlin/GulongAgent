import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateLetterPath } from "../../shared/private-page.js";
import { recordAnalyticsEvent } from "../../server/analytics.js";
import platform from "../../api/platform.js";

test("letter capability links never enter analytics, including encoded paths or explicit page paths", async () => {
  for (const path of ["/love-letter", "/love-letter/test?utm_source=private", "https://sologle.com/love-letter/test", "/%6cove-letter/test", "/love-letter%2ftest"]) {
    assert.equal(isPrivateLetterPath(path), true);
    // No database is configured: any accidental collection access would reject.
    await recordAnalyticsEvent({ path });
  }
  for (const path of ["/birthday-wall/test", "/workflows", "/love-letterpress"]) assert.equal(isPrivateLetterPath(path), false);
  const response = await platform.fetch(new Request("https://example.test/api/platform?_platform_path=analytics/events", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://example.test" },
    body: JSON.stringify({ eventType: "PAGE_VIEW", visitorId: "visitor-example", sessionId: "session-example", path: "/love-letter/private-link" }),
  }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
});

test("Vercel platform entry preserves anonymous letter routing and privacy headers", async () => {
  const response = await platform.fetch(new Request("https://example.test/api/platform?_platform_path=love-letters/deployment-check"));
  assert.equal(response.status, 404);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("x-robots-tag"), /noindex/);
  const rejected = await platform.fetch(new Request("https://example.test/api/platform?_platform_path=love-letters", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://untrusted.invalid", "sec-fetch-site": "cross-site" }, body: "{}",
  }));
  assert.equal(rejected.status, 403);
});
