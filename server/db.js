import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI?.trim();
const dbName = process.env.MONGODB_DB?.trim() || "gulong_platform";

let clientPromise;
let indexPromise;

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
    this.code = "CONFIG_REQUIRED";
  }
}

export function isDatabaseConfigured() {
  return Boolean(uri);
}

export async function getDb() {
  if (!uri) {
    throw new ConfigurationError("MongoDB 尚未配置，请设置 MONGODB_URI");
  }

  if (!clientPromise) {
    const client = new MongoClient(uri, {
      appName: "gulong-platform",
      maxPoolSize: 12,
      minPoolSize: 0,
      maxIdleTimeMS: 60_000,
      waitQueueTimeoutMS: 6_000,
      serverSelectionTimeoutMS: 6_000,
      retryReads: true,
      retryWrites: true,
    });
    clientPromise = client.connect();
  }

  return (await clientPromise).db(dbName);
}

export async function getCollection(name) {
  return (await getDb()).collection(name);
}

export async function ensureIndexes() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const db = await getDb();
      await Promise.all([
        db.collection("users").createIndex(
          { usernameNormalized: 1 },
          { unique: true, sparse: true, name: "uniq_username" },
        ),
        db.collection("users").createIndex(
          { emailNormalized: 1 },
          { unique: true, sparse: true, name: "uniq_email" },
        ),
        db.collection("sessions").createIndex(
          { tokenHash: 1 },
          { unique: true, name: "uniq_session_token" },
        ),
        db.collection("sessions").createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "ttl_sessions" },
        ),
        db.collection("apiKeys").createIndex(
          { prefix: 1 },
          { unique: true, name: "uniq_api_key_prefix" },
        ),
        db.collection("rateLimits").createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "ttl_rate_limits" },
        ),
        db.collection("payments").createIndex(
          { orderNo: 1 },
          { unique: true, name: "uniq_payment_order" },
        ),
        db.collection("tasks").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "tasks_by_owner" },
        ),
        db.collection("feedback").createIndex(
          { createdAt: -1 },
          { name: "feedback_recent" },
        ),
        db.collection("uploads").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "uploads_by_owner" },
        ),
      ]);
    })().catch((error) => {
      indexPromise = undefined;
      throw error;
    });
  }
  return indexPromise;
}

export async function pingDatabase() {
  if (!uri) return { configured: false, ok: false };
  try {
    await (await getDb()).command({ ping: 1 });
    return { configured: true, ok: true };
  } catch {
    return { configured: true, ok: false };
  }
}
