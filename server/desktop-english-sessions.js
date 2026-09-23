import { createHash, randomBytes, randomUUID } from "node:crypto";

export const ACCESS_SECONDS = 900;
const REFRESH_MS = 30 * 24 * 60 * 60_000;
const TOKEN_RE = /^gec_(at|rt)_([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/;
const digest = (token) => createHash("sha256").update(token).digest("hex");
const failure = () => Object.assign(new Error("桌面登录已失效，请重新登录"), { status: 401, code: "AUTH_EXPIRED" });
function parse(token, kind) {
  const match = TOKEN_RE.exec(String(token || ""));
  if (!match || match[1] !== kind) throw failure();
  return { id: match[2], hash: digest(token) };
}
function pair(id) {
  const token = (kind) => `gec_${kind}_${id}.${randomBytes(32).toString("base64url")}`;
  return { access_token: token("at"), refresh_token: token("rt"), expires_in: ACCESS_SECONDS, token_type: "Bearer" };
}

// A family is one atomic document. No password or upstream token is persisted.
export function createEnglishSessionStore({ getCollection, now = () => new Date() }) {
  let indexes;
  async function collection() {
    const rows = await getCollection("englishDesktopSessions");
    indexes ||= rows.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "ttl_english_desktop_sessions" })
      .catch((error) => { indexes = undefined; throw error; });
    await indexes;
    return rows;
  }
  async function userFor(ownerId) {
    const user = await (await getCollection("users")).findOne({ _id: ownerId, status: "active" },
      { projection: { _id: 1, status: 1, username: 1, displayName: 1, email: 1, role: 1, authProvider: 1 } });
    if (!user) throw failure();
    return user;
  }
  return {
    async issue(user) {
      if (!user?._id || user.status !== "active") throw failure();
      const time = now(); const id = randomUUID(); const tokens = pair(id);
      await (await collection()).insertOne({ _id: id, ownerId: user._id,
        accessHash: digest(tokens.access_token), refreshHash: digest(tokens.refresh_token),
        usedRefreshHashes: [], createdAt: time, updatedAt: time, revokedAt: null,
        accessExpiresAt: new Date(+time + ACCESS_SECONDS * 1000), expiresAt: new Date(+time + REFRESH_MS) });
      return tokens;
    },
    async authenticate(token) {
      const { id, hash } = parse(token, "at"); const time = now();
      const session = await (await collection()).findOne({ _id: id, accessHash: hash,
        revokedAt: null, accessExpiresAt: { $gt: time }, expiresAt: { $gt: time } });
      if (!session) throw failure();
      return userFor(session.ownerId);
    },
    async refresh(token) {
      const { id, hash } = parse(token, "rt"); const time = now(); const rows = await collection();
      const session = await rows.findOne({ _id: id, revokedAt: null, expiresAt: { $gt: time } });
      if (!session) throw failure();
      if (session.refreshHash !== hash) {
        // A guessed secret cannot revoke a known session id; a proven replay can.
        if (session.usedRefreshHashes?.includes(hash)) await rows.updateOne({ _id: id }, { $set: { revokedAt: time } });
        throw failure();
      }
      await userFor(session.ownerId);
      if ((session.usedRefreshHashes?.length || 0) >= 4096) throw failure();
      const tokens = pair(id);
      const updated = await rows.updateOne({ _id: id, refreshHash: hash, revokedAt: null, expiresAt: { $gt: time } }, {
        $set: { refreshHash: digest(tokens.refresh_token), accessHash: digest(tokens.access_token),
          accessExpiresAt: new Date(Math.min(+session.expiresAt, +time + ACCESS_SECONDS * 1000)), updatedAt: time },
        $push: { usedRefreshHashes: hash },
      });
      if (updated.modifiedCount !== 1) {
        await rows.updateOne({ _id: id, usedRefreshHashes: hash }, { $set: { revokedAt: time } });
        throw failure();
      }
      return { ...tokens, expires_in: Math.min(ACCESS_SECONDS, Math.floor((+session.expiresAt - +time) / 1000)) };
    },
    async revoke(accessToken, refreshToken) {
      const rows = await collection(); const time = now();
      for (const [token, kind, field] of [[accessToken, "at", "accessHash"], [refreshToken, "rt", "refreshHash"]]) {
        if (!token) continue;
        let parsed;
        try { parsed = parse(token, kind); } catch { continue; }
        await rows.updateOne({ _id: parsed.id, [field]: parsed.hash }, { $set: { revokedAt: time } });
      }
    },
  };
}
