import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// A deliberately unreachable database proves missing site credentials never
// invoke index initialization; no real DB/model/account is contacted.
test("anonymous/optional/delegated site authentication fails closed before database initialization", () => {
  const script = `
    import assert from 'node:assert/strict';
    import { Hono } from 'hono';
    import { authenticate } from './server/security.js';
    const app = new Hono();
    app.get('/required', async c => (await authenticate(c, { scopes: ['tasks:read'] })).error);
    app.get('/optional', async c => c.json({ absent: await authenticate(c, { required:false }) === null }));
    assert.equal((await app.request('/required')).status, 401);
    assert.deepEqual(await (await app.request('/optional')).json(), { absent:true });
    assert.equal((await app.request('/required', {headers:{Authorization:'Bearer gge_at_fake_not_a_site_key'}})).status, 401);
    assert.deepEqual(await (await app.request('/optional', {headers:{Authorization:'Bearer desktop-token-not-a-site-key'}})).json(), { absent:true });
    console.log('anonymous-auth-no-db');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("../../", import.meta.url), env: { ...process.env, MONGODB_URI: "mongodb://127.0.0.1:1/unreachable-auth-test", MONGODB_DB: "unreachable-auth-test" },
    timeout: 4000, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /anonymous-auth-no-db/);
});
