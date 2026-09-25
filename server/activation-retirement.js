import { getCollection, withDatabaseTransaction } from "./db.js";

export const RETIRED_ACTIVATION_PRODUCT = "minimax-h3-super-video";

export async function inspectRetiredActivationCodes({ collectionProvider = getCollection, session } = {}) {
  const options = { projection: { _id: 1, status: 1 }, ...(session ? { session } : {}) };
  const records = await (await collectionProvider("activationCodes")).find({ product: RETIRED_ACTIVATION_PRODUCT }, options).toArray();
  const licenseIds = records.map((record) => record._id);
  const bindings = licenseIds.length
    ? await (await collectionProvider("nodeAccountBindings")).find({ activationLicenseId: { $in: licenseIds }, status: "active" }, { projection: { _id: 1 }, ...(session ? { session } : {}) }).toArray()
    : [];
  const bindingIds = bindings.map((binding) => binding._id);
  const inFlightTasks = bindingIds.length
    ? await (await collectionProvider("h3SharedTasks")).countDocuments({
      status: { $in: ["claimed", "processing"] },
      $or: [
        { "claimedByNode.bindingId": { $in: bindingIds } },
        { "claimRequestedByNode.bindingId": { $in: bindingIds } },
        { "executedByNode.bindingId": { $in: bindingIds } },
      ],
    }, session ? { session } : {})
    : 0;
  const statuses = Object.fromEntries(["unused", "used", "revoked"].map((status) => [status, records.filter((record) => record.status === status).length]));
  return { count: records.length, statuses, activeBindings: bindings.length, inFlightTasks, licenseIds };
}

export async function purgeRetiredActivationCodes({ expectedCount, collectionProvider = getCollection, transaction = withDatabaseTransaction }) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) throw new Error("必须提供精确的预期激活码数量");
  return transaction(async (session) => {
    const current = await inspectRetiredActivationCodes({ collectionProvider, session });
    if (current.count !== expectedCount) throw new Error(`激活码数量已变化：预期 ${expectedCount} 条，实际 ${current.count} 条；未执行删除`);
    if (current.inFlightTasks) throw new Error(`该授权仍关联 ${current.inFlightTasks} 个处理中任务；未执行删除`);
    const now = new Date();
    const bindingResult = current.licenseIds.length
      ? await (await collectionProvider("nodeAccountBindings")).updateMany(
        { activationLicenseId: { $in: current.licenseIds }, status: "active" },
        { $set: { status: "revoked", revokedAt: now, updatedAt: now }, $unset: { tokenHash: "" } },
        { session },
      )
      : { modifiedCount: 0 };
    const deletion = await (await collectionProvider("activationCodes")).deleteMany({ product: RETIRED_ACTIVATION_PRODUCT }, { session });
    if (deletion.deletedCount !== expectedCount) throw new Error("实际删除数量与预期不符，事务已回滚");
    await (await collectionProvider("authAudit")).insertOne({
      action: "retired_super_video_activation_codes_purged",
      product: RETIRED_ACTIVATION_PRODUCT,
      deletedCount: deletion.deletedCount,
      revokedBindingCount: bindingResult.modifiedCount,
      createdAt: now,
    }, { session });
    return { deleted: deletion.deletedCount, revokedBindings: bindingResult.modifiedCount };
  });
}
