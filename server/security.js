import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { ObjectId } from "mongodb";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ensureIndexes, getCollection } from "./db.js";

const scrypt = promisify(scryptCallback);
export const SESSION_COOKIE = "gulong_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;

function secret(name) {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${name} 未配置`);
  }
  return `gulong-local-development-${name}`;
}

export function normalizeUsername(value) {
  return value?.trim().normalize("NFKC").toLowerCase() || undefined;
}

export function normalizeEmail(value) {
  return value?.trim().normalize("NFKC").toLowerCase() || undefined;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$v1$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [algorithm, version, saltValue, hashValue] = encoded.split("$");
    if (algorithm !== "scrypt" || version !== "v1") return false;
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(hashValue, "base64url");
    const actual = Buffer.from(await scrypt(password, salt, expected.length));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function hashOpaqueToken(token, purpose = "token") {
  return createHmac("sha256", secret("API_KEY_PEPPER"))
    .update(`${purpose}:${token}`)
    .digest("hex");
}

export function fingerprintIp(value = "unknown") {
  return createHash("sha256")
    .update(`${secret("SESSION_SECRET")}:${value}`)
    .digest("hex")
    .slice(0, 24);
}

export async function issueSession(c, userId, { externalAuth } = {}) {
  await ensureIndexes();
  const raw = `gls_${randomBytes(32).toString("base64url")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_AGE_SECONDS * 1000);
  await (await getCollection("sessions")).insertOne({
    tokenHash: hashOpaqueToken(raw, "session"),
    userId: new ObjectId(userId),
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    ipFingerprint: fingerprintIp(c.req.header("x-forwarded-for") || "local"),
    ...(externalAuth ? { externalAuth: sealExternalAuth(externalAuth) } : {}),
  });
  setCookie(c, SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_AGE_SECONDS,
  });
}

export async function revokeSession(c) {
  const raw = getCookie(c, SESSION_COOKIE);
  if (raw) {
    await (await getCollection("sessions")).deleteOne({
      tokenHash: hashOpaqueToken(raw, "session"),
    });
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function createApiKey(userId, { name, scopes }) {
  await ensureIndexes();
  const raw = `gla_live_${randomBytes(30).toString("base64url")}`;
  const prefix = raw.slice(0, 18);
  const now = new Date();
  const record = {
    ownerId: new ObjectId(userId),
    name: name.trim(),
    prefix,
    keyHash: hashOpaqueToken(raw, "api-key"),
    scopes,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  };
  const result = await (await getCollection("apiKeys")).insertOne(record);
  return {
    id: result.insertedId.toString(),
    key: raw,
    prefix,
    name: record.name,
    scopes,
    createdAt: now,
  };
}

function publicUser(user) {
  return {
    id: user._id.toString(),
    username: user.username || null,
    email: user.email || null,
    displayName: user.displayName || null,
    avatar: user.avatar || null,
    authProvider: user.authProvider || "local",
    role: user.role || "user",
    createdAt: user.createdAt,
  };
}

function encryptedValueKey(purpose = "external-auth") {
  return createHash("sha256")
    .update(`gulong-${purpose}:${secret("SESSION_SECRET")}`)
    .digest();
}

function sealEncryptedValue(value, purpose) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptedValueKey(purpose), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function readEncryptedValue(sealed, purpose) {
  try {
    const [version, ivValue, tagValue, ciphertextValue] = String(sealed || "").split(".");
    if (version !== "v1") return null;
    const decipher = createDecipheriv("aes-256-gcm", encryptedValueKey(purpose), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8"));
  } catch {
    return null;
  }
}

export function sealExternalAuth(value) {
  return sealEncryptedValue(value, "external-auth");
}

export function readExternalAuth(session) {
  return readEncryptedValue(session?.externalAuth, "external-auth");
}

export function sealUserSecret(value, purpose) {
  return sealEncryptedValue(value, `user-secret:${purpose}`);
}

export function readUserSecret(sealed, purpose) {
  return readEncryptedValue(sealed, `user-secret:${purpose}`);
}

async function authenticateApiKey(raw, requiredScopes) {
  if (!raw.startsWith("gla_live_")) return null;
  const prefix = raw.slice(0, 18);
  const apiKeys = await getCollection("apiKeys");
  const key = await apiKeys.findOne({ prefix, revokedAt: null });
  if (!key || key.keyHash !== hashOpaqueToken(raw, "api-key")) return null;
  const allowed = key.scopes || [];
  if (requiredScopes.some((scope) => !allowed.includes("*") && !allowed.includes(scope))) {
    return { forbidden: true };
  }
  const user = await (await getCollection("users")).findOne({ _id: key.ownerId, status: "active" });
  if (!user) return null;
  void apiKeys.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } });
  return { kind: "apiKey", user: publicUser(user), key };
}

export async function authenticate(c, { required = true, scopes = [] } = {}) {
  await ensureIndexes();
  const authorization = c.req.header("authorization") || "";
  if (authorization.startsWith("Bearer ")) {
    const apiAuth = await authenticateApiKey(authorization.slice(7).trim(), scopes);
    if (apiAuth?.forbidden) {
      return { error: c.json({ code: "FORBIDDEN", message: "API Key 权限不足" }, 403) };
    }
    if (apiAuth) return apiAuth;
  }

  const raw = getCookie(c, SESSION_COOKIE);
  if (raw) {
    const session = await (await getCollection("sessions")).findOne({
      tokenHash: hashOpaqueToken(raw, "session"),
      expiresAt: { $gt: new Date() },
    });
    if (session) {
      const user = await (await getCollection("users")).findOne({
        _id: session.userId,
        status: "active",
      });
      if (user) {
        if (!session.lastSeenAt || Date.now() - new Date(session.lastSeenAt).getTime() > 5 * 60_000) {
          void (await getCollection("sessions")).updateOne(
            { _id: session._id },
            { $set: { lastSeenAt: new Date() } },
          ).catch(() => {});
        }
        return { kind: "session", user: publicUser(user), session };
      }
    }
  }

  if (!required) return null;
  return { error: c.json({ code: "UNAUTHORIZED", message: "请先登录或提供有效 API Key" }, 401) };
}

export function isTrustedBrowserRequest(c) {
  const origin = c.req.header("origin");
  if (!origin) return true;
  const configured = process.env.APP_ORIGIN?.trim();
  const current = new URL(c.req.url).origin;
  return origin === current || (configured && origin === configured);
}
