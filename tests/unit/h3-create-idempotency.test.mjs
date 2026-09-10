import assert from "node:assert/strict";
import test from "node:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import {
  h3TaskRequestFingerprint,
  normalizeH3TaskInput,
  registerH3SharedRoutes,
} from "../../server/h3-shared.js";

function requestBody(overrides = {}) {
  return {
    source_channel: "desktop_agent",
    model: "minimax_h3_shared",
    prompt: "雨夜追车",
    duration_seconds: 5,
    aspect_ratio: "9:16",
    profile: "balanced",
    assets: { images: [], videos: [], audio: [] },
    ...overrides,
  };
}

test("H3 request fingerprint binds the normalized payload rather than JSON spelling", () => {
  const snakeCase = normalizeH3TaskInput(requestBody());
  const camelCase = normalizeH3TaskInput({
    sourceChannel: "desktop_agent",
    model: "minimax_h3_shared",
    originalPrompt: "  雨夜追车  ",
    durationSeconds: 5,
    aspectRatio: "9:16",
    profile: "BALANCED",
    assets: { images: [], videos: [], audio: [] },
  });

  assert.equal(h3TaskRequestFingerprint(snakeCase), h3TaskRequestFingerprint(camelCase));
  assert.notEqual(
    h3TaskRequestFingerprint(snakeCase),
    h3TaskRequestFingerprint(normalizeH3TaskInput(requestBody({ duration_seconds: 6 }))),
  );
  assert.notEqual(
    h3TaskRequestFingerprint(snakeCase),
    h3TaskRequestFingerprint(normalizeH3TaskInput(requestBody({ prompt: "雪夜追车" }))),
  );
});

test("H3 create replays the original success and rejects a changed payload for the same key", async () => {
  const app = new OpenAPIHono();
  const adminId = new ObjectId();
  let storedTask = null;
  let taskInsertions = 0;
  const collections = {
    h3SharedTasks: {
      findOne: async (filter) => filter.idempotencyKey && storedTask?.idempotencyKey === filter.idempotencyKey ? storedTask : null,
      insertOne: async (document) => {
        storedTask = document;
        taskInsertions += 1;
        return { insertedId: document._id };
      },
    },
    wallets: { findOne: async () => ({ ownerId: adminId, balanceFen: 500 }) },
    h3TaskAudits: { insertOne: async () => ({ insertedId: new ObjectId() }) },
  };
  registerH3SharedRoutes(app, {
    getCollection: async (name) => collections[name] || {
      findOne: async () => null,
      insertOne: async () => ({ insertedId: new ObjectId() }),
      updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }),
    },
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ user: { id: adminId.toString(), email: "admin@example.com", role: "admin" } }),
    requireAdmin: async () => ({ user: { id: adminId.toString(), role: "admin" } }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => { throw new Error("not used"); },
    queueCoordinator: { invalidate: async () => {} },
  });
  const submit = (body) => app.request("http://localhost/api/h3/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "desktop-admin-0001" },
    body: JSON.stringify(body),
  });

  const created = await submit(requestBody());
  assert.equal(created.status, 201);
  const createdPayload = await created.json();
  assert.equal(createdPayload.idempotent, false);
  assert.equal(createdPayload.billing.chargeId, `h3:exempt:${storedTask.orderNo}`);

  const replay = await submit(requestBody());
  assert.equal(replay.status, 200);
  const replayPayload = await replay.json();
  assert.equal(replayPayload.idempotent, true);
  assert.equal(replayPayload.task.id, storedTask._id.toString());
  assert.equal(replayPayload.billing.chargeId, createdPayload.billing.chargeId);

  const conflict = await submit(requestBody({ prompt: "雪夜追车" }));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(taskInsertions, 1);
});

test("H3 create replays insufficient balance as 402 and rejects a changed payload for the same key", async () => {
  const app = new OpenAPIHono();
  const userId = new ObjectId();
  let storedTask = null;
  let taskInsertions = 0;
  let walletReservations = 0;

  const collections = {
    h3SharedTasks: {
      async findOne(filter) {
        return filter.idempotencyKey && storedTask?.idempotencyKey === filter.idempotencyKey
          ? storedTask
          : null;
      },
      async insertOne(document) {
        storedTask = document;
        taskInsertions += 1;
        return { insertedId: document._id };
      },
      async updateOne(filter, update) {
        if (storedTask && storedTask._id.equals(filter._id)) Object.assign(storedTask, update.$set || {});
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    subscriptions: { findOne: async () => null },
    wallets: {
      findOne: async () => null,
      async findOneAndUpdate() {
        walletReservations += 1;
        return null;
      },
    },
  };

  registerH3SharedRoutes(app, {
    getCollection: async (name) => collections[name] || {
      findOne: async () => null,
      insertOne: async () => ({ insertedId: new ObjectId() }),
      updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }),
    },
    enforceRateLimit: async () => ({ allowed: true }),
    authenticate: async () => ({ user: { id: userId.toString(), email: "user@example.com", role: "user" } }),
    requireAdmin: async () => ({ user: { id: userId.toString(), role: "admin" } }),
    requireTrustedMutation: () => null,
    verifyActivationReceipt: async () => { throw new Error("not used"); },
    queueCoordinator: { invalidate: async () => {} },
  });

  const submit = (body) => app.request("http://localhost/api/h3/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "desktop-create-0001" },
    body: JSON.stringify(body),
  });

  const first = await submit(requestBody());
  assert.equal(first.status, 402);
  assert.deepEqual(await first.json(), {
    code: "INSUFFICIENT_BALANCE",
    message: "可用余额不足，本次任务需要 1.00 元",
    requiredFen: 100,
  });
  assert.match(storedTask.requestFingerprint, /^[a-f0-9]{64}$/);

  const replay = await submit(requestBody());
  assert.equal(replay.status, 402);
  assert.deepEqual(await replay.json(), {
    code: "INSUFFICIENT_BALANCE",
    message: "可用余额不足，本次任务需要 1.00 元",
    requiredFen: 100,
    idempotent: true,
  });

  const conflict = await submit(requestBody({ duration_seconds: 6 }));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    code: "IDEMPOTENCY_KEY_CONFLICT",
    message: "同一 Idempotency-Key 不能用于不同的 MiniMax H3 创建请求",
  });
  assert.equal(taskInsertions, 1);
  assert.equal(walletReservations, 1);
});
