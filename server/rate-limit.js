import { getCollection, isDatabaseConfigured } from "./db.js";

const memory = new Map();

export async function enforceRateLimit(key, { limit = 20, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const bucket = Math.floor(now / windowMs);
  const id = `${key}:${bucket}`;

  if (!isDatabaseConfigured()) {
    const current = memory.get(id) || { count: 0, expiresAt: now + windowMs };
    current.count += 1;
    memory.set(id, current);
    if (memory.size > 2_000) {
      for (const [candidate, value] of memory) {
        if (value.expiresAt < now) memory.delete(candidate);
      }
    }
    return { allowed: current.count <= limit, remaining: Math.max(0, limit - current.count) };
  }

  const document = await (await getCollection("rateLimits")).findOneAndUpdate(
    { _id: id },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date((bucket + 1) * windowMs) },
    },
    { upsert: true, returnDocument: "after" },
  );
  const count = document?.count || 1;
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}
