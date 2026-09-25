import assert from "node:assert/strict";
import test from "node:test";
import { inspectRetiredActivationCodes, purgeRetiredActivationCodes, RETIRED_ACTIVATION_PRODUCT } from "../../server/activation-retirement.js";

function fakeStore() {
  const state = {
    codes: [
      { _id: "super-unused", product: RETIRED_ACTIVATION_PRODUCT, status: "unused" },
      { _id: "super-used", product: RETIRED_ACTIVATION_PRODUCT, status: "used" },
      { _id: "ultra-used", product: "minimax-h3-ultra-video", status: "used" },
    ],
    bindings: [{ _id: "super-binding", activationLicenseId: "super-used", status: "active", tokenHash: "token-hash" }],
    inFlightTasks: 0,
    audits: [],
  };
  const collectionProvider = async (name) => ({
    activationCodes: {
      find: (filter) => ({ toArray: async () => state.codes.filter((code) => code.product === filter.product) }),
      deleteMany: async (filter) => {
        const before = state.codes.length;
        state.codes = state.codes.filter((code) => code.product !== filter.product);
        return { deletedCount: before - state.codes.length };
      },
    },
    nodeAccountBindings: {
      find: (filter) => ({ toArray: async () => state.bindings.filter((binding) => filter.activationLicenseId.$in.includes(binding.activationLicenseId) && binding.status === filter.status) }),
      updateMany: async (filter, update) => {
        let modifiedCount = 0;
        for (const binding of state.bindings) {
          if (!filter.activationLicenseId.$in.includes(binding.activationLicenseId) || binding.status !== filter.status) continue;
          Object.assign(binding, update.$set);
          delete binding.tokenHash;
          modifiedCount += 1;
        }
        return { modifiedCount };
      },
    },
    h3SharedTasks: { countDocuments: async () => state.inFlightTasks },
    authAudit: { insertOne: async (record) => { state.audits.push(record); return { acknowledged: true }; } },
  })[name];
  return { state, collectionProvider, transaction: async (work) => work({}) };
}

test("只统计超能视频授权，预检查不触碰超清视频授权", async () => {
  const store = fakeStore();
  const summary = await inspectRetiredActivationCodes({ collectionProvider: store.collectionProvider });
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.statuses, { unused: 1, used: 1, revoked: 0 });
  assert.equal(summary.activeBindings, 1);
  assert.equal(summary.inFlightTasks, 0);
  assert.equal(store.state.codes.length, 3);
});

test("数量变化或正在执行任务时拒绝清理，成功清理只删超能码并撤销其绑定", async () => {
  const store = fakeStore();
  const options = { collectionProvider: store.collectionProvider, transaction: store.transaction };
  await assert.rejects(purgeRetiredActivationCodes({ ...options, expectedCount: 3 }), /数量已变化/);
  store.state.inFlightTasks = 1;
  await assert.rejects(purgeRetiredActivationCodes({ ...options, expectedCount: 2 }), /处理中任务/);
  assert.equal(store.state.codes.length, 3);
  store.state.inFlightTasks = 0;
  assert.deepEqual(await purgeRetiredActivationCodes({ ...options, expectedCount: 2 }), { deleted: 2, revokedBindings: 1 });
  assert.deepEqual(store.state.codes.map((code) => code._id), ["ultra-used"]);
  assert.equal(store.state.bindings[0].status, "revoked");
  assert.equal(store.state.bindings[0].tokenHash, undefined);
  assert.equal(store.state.audits[0].deletedCount, 2);
  assert.equal((await inspectRetiredActivationCodes({ collectionProvider: store.collectionProvider })).count, 0);
});
