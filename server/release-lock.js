const LEGACY_PROTOCOL = "trusted-worker-v1";

function releasedChannelSnapshot(channel, now) {
  const snapshot = {
    ...channel,
    distributionStatus: "failed",
    releaseError: "过期的旧版直传发行已自动清理",
    releaseFailedAt: now,
    updatedAt: now,
  };
  delete snapshot.releasePublishId;
  delete snapshot.releaseUpdatingAt;
  return snapshot;
}

export async function recoverExpiredDirectReleaseLock(channel, {
  uploads,
  channels,
  deleteStoredObject,
  now = new Date(),
}) {
  if (!channel || channel.distributionStatus !== "uploading") {
    return { channel, blocked: false, cleaned: false };
  }
  if (!channel.releasePublishId) {
    return { channel, blocked: true, cleaned: false };
  }

  const upload = await uploads.findOne({
    _id: channel.releasePublishId,
    protocol: LEGACY_PROTOCOL,
    status: { $in: ["prepared", "uploading"] },
  });
  const expiresAt = upload?.expiresAt ? new Date(upload.expiresAt) : null;
  if (!upload || !expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt > now) {
    return { channel, blocked: true, cleaned: false };
  }

  let cleanupPendingObjectKey = null;
  if (upload.objectKey) {
    try {
      await deleteStoredObject(upload.objectKey);
    } catch {
      cleanupPendingObjectKey = upload.objectKey;
    }
  }

  const uploadSet = {
    status: "expired",
    error: "旧版直传协议已停用，过期发行尝试已清理",
    failedAt: now,
    updatedAt: now,
  };
  if (cleanupPendingObjectKey) uploadSet.cleanupPendingObjectKey = cleanupPendingObjectKey;
  await uploads.updateOne(
    { _id: upload._id, protocol: LEGACY_PROTOCOL, status: { $in: ["prepared", "uploading"] } },
    { $set: uploadSet },
  );

  const released = await channels.updateOne(
    {
      _id: channel._id,
      distributionStatus: "uploading",
      releasePublishId: channel.releasePublishId,
    },
    {
      $set: {
        distributionStatus: "failed",
        releaseError: "过期的旧版直传发行已自动清理",
        releaseFailedAt: now,
        updatedAt: now,
      },
      $unset: { releasePublishId: "", releaseUpdatingAt: "" },
    },
  );
  if (released.modifiedCount) {
    return { channel: releasedChannelSnapshot(channel, now), blocked: false, cleaned: true };
  }

  const current = await channels.findOne({ _id: channel._id });
  return {
    channel: current,
    blocked: current?.distributionStatus === "uploading",
    cleaned: current?.distributionStatus !== "uploading",
  };
}
