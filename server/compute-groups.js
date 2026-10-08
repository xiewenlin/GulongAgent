import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "@hono/zod-openapi";
import { getCollection as databaseCollection } from "./db.js";
import { hashOpaqueToken } from "./security.js";
import { enforceRateLimit as databaseRateLimit } from "./rate-limit.js";
import { GULONG_ENGINE_PLAN_ID, productSubscription, readGulongEngineEntitlement } from "./english-coach-products.js";

export const COMPUTE_GROUP_ID_PATTERN = /^gug_[a-f0-9]{32}$/;
export const normalizeComputeGroupId = (value) => value == null || value === "" ? null : String(value);
export const computeGroupsMatch = (userGroup, nodeGroup) => normalizeComputeGroupId(userGroup) === normalizeComputeGroupId(nodeGroup);
export const computeGroupFilter = (groupId, field = "computeGroupId") => ({ [field]: normalizeComputeGroupId(groupId) });
const groupError = (code, message, status = 403) => Object.assign(new Error(message), { code, status });

export async function getUserComputeGroupId(userId, getCollection = databaseCollection) {
  if (!ObjectId.isValid(userId)) throw groupError("COMPUTE_GROUP_OWNER_UNAVAILABLE", "无法确认任务所属用户的分组");
  const user = await (await getCollection("users")).findOne({ _id: new ObjectId(userId) }, { projection: { computeGroupId: 1, status: 1 } });
  if (!user || user.status === "disabled" || user.status === "deleted") throw groupError("COMPUTE_GROUP_OWNER_UNAVAILABLE", "任务所属用户不存在或已停用");
  return normalizeComputeGroupId(user.computeGroupId);
}

const publicGroup = (group) => group ? { id: group.id, name: group.name, createdAt: group.createdAt } : null;
const literalRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const groupIdSchema = z.string().regex(COMPUTE_GROUP_ID_PATTERN).nullable();
const groupSchema = z.object({ id: z.string().regex(COMPUTE_GROUP_ID_PATTERN), name: z.string(), createdAt: z.iso.datetime() });

export function registerComputeGroupRoutes(app, dependencies) {
  const getCollection = dependencies.getCollection || databaseCollection;
  const rateLimit = dependencies.enforceRateLimit || databaseRateLimit;
  const entitlement = dependencies.readGulongEngineEntitlement || ((ownerId) => readGulongEngineEntitlement(ownerId, new Date(), getCollection));
  const hash = dependencies.hashOpaqueToken || hashOpaqueToken;
  const now = dependencies.now || (() => new Date());
  app.openAPIRegistry.registerComponent("securitySchemes", "sessionCookie", { type: "apiKey", in: "cookie", name: "gulong_session", description: "官网登录会话；修改操作同时校验可信来源。" });

  app.use("/api/admin/compute-groups*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
  app.use("/api/desktop/compute-*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
  async function limited(c, key, limit = 120) {
    const result = await rateLimit(key, { limit, windowMs: 60_000 });
    return result.allowed ? null : c.json({ code: "RATE_LIMITED", message: "操作过于频繁，请稍后重试" }, 429);
  }
  async function bindingAuth(c, nodeId = null) {
    const raw = String(c.req.header("X-Gulong-Account-Binding") || "").trim();
    if (!raw.startsWith("gab_") || raw.length < 32 || raw.length > 200) return { error: c.json({ code: "BINDING_REQUIRED", message: "请先在桌面端绑定古龙账号" }, 401) };
    const binding = await (await getCollection("nodeAccountBindings")).findOne({ tokenHash: hash(raw, "h3-account-binding"), status: "active", revokedAt: null });
    if (!binding) return { error: c.json({ code: "BINDING_REVOKED", message: "节点账号绑定已失效，请重新绑定" }, 401) };
    const user = await (await getCollection("users")).findOne({ _id: binding.userId, status: "active" });
    if (!user) return { error: c.json({ code: "BINDING_REVOKED", message: "节点所属账号不可用" }, 401) };
    if (nodeId && nodeId !== binding.nodeId) return { error: c.json({ code: "NODE_BINDING_MISMATCH", message: "只能设置或验证当前绑定节点" }, 403) };
    return { binding, user };
  }
  async function audit(action, details) {
    await (await getCollection("computeGroupAudits")).insertOne({ action, ...details, createdAt: now() });
  }
  async function findUser(id) {
    const filters = [{ chandlerUserId: id }];
    if (ObjectId.isValid(id)) filters.unshift({ _id: new ObjectId(id) });
    return (await getCollection("users")).findOne({ $or: filters });
  }
  async function userGroupView(user) {
    const computeGroupId = normalizeComputeGroupId(user.computeGroupId);
    const group = computeGroupId ? await (await getCollection("computeGroups")).findOne({ id: computeGroupId }) : null;
    const subscription = await (await getCollection("subscriptions")).findOne({ ownerId: user._id });
    const product = productSubscription(subscription, GULONG_ENGINE_PLAN_ID);
    return { computeGroupId, computeGroup: publicGroup(group), eligible: Boolean(product && product.enabled !== false && !["cancelled", "canceled", "revoked"].includes(product.status)) };
  }
  async function listGroups(c) {
    const query = String(c.req.query("q") || "").trim().slice(0, 100);
    const cursor = String(c.req.query("cursor") || "");
    if (cursor && !COMPUTE_GROUP_ID_PATTERN.test(cursor)) return c.json({ code: "VALIDATION_ERROR", message: "分组分页游标无效" }, 400);
    const limit = Math.max(1, Math.min(200, Number.parseInt(c.req.query("limit") || "100", 10) || 100));
    const filter = { ...(query ? { name: { $regex: literalRegex(query), $options: "i" } } : {}), ...(cursor ? { id: { $gt: cursor } } : {}) };
    const groups = await (await getCollection("computeGroups")).find(filter).sort({ id: 1 }).limit(limit + 1).toArray();
    const page = groups.slice(0, limit);
    return c.json({ groups: page.map(publicGroup), nextCursor: groups.length > limit ? page.at(-1).id : null });
  }
  app.get("/api/admin/compute-groups", async (c) => {
    const auth = await dependencies.requireAdmin(c); if (auth.error) return auth.error;
    return listGroups(c);
  });
  app.post("/api/admin/compute-groups", async (c) => {
    const rejected = dependencies.requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await dependencies.requireAdmin(c); if (auth.error) return auth.error;
    const blocked = await limited(c, `compute-group-create:${auth.user.id}`, 30); if (blocked) return blocked;
    const parsed = z.object({ name: z.string().trim().min(1).max(80) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: "VALIDATION_ERROR", message: "请输入 1 至 80 字的分组名称" }, 400);
    const group = { id: `gug_${randomBytes(16).toString("hex")}`, name: parsed.data.name, nameNormalized: parsed.data.name.normalize("NFKC").toLowerCase(), createdBy: new ObjectId(auth.user.id), createdAt: now() };
    try { await (await getCollection("computeGroups")).insertOne(group); }
    catch (error) { if (error.code === 11000) return c.json({ code: "COMPUTE_GROUP_EXISTS", message: "此名称的分组已存在，请直接选择" }, 409); throw error; }
    await audit("group_created", { groupId: group.id, actorUserId: group.createdBy });
    return c.json({ group: publicGroup(group) }, 201);
  });
  app.get("/api/admin/users/:id/compute-group", async (c) => {
    const auth = await dependencies.requireAdmin(c); if (auth.error) return auth.error;
    const user = await findUser(c.req.param("id"));
    if (!user) return c.json({ code: "USER_NOT_FOUND", message: "用户不存在" }, 404);
    c.header("Cache-Control", "private, no-store");
    return c.json(await userGroupView(user));
  });
  app.put("/api/admin/users/:id/compute-group", async (c) => {
    const rejected = dependencies.requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await dependencies.requireAdmin(c); if (auth.error) return auth.error;
    const parsed = z.object({ groupId: groupIdSchema }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: "VALIDATION_ERROR", message: "请选择已创建的分组，或选择未分组" }, 400);
    const user = await findUser(c.req.param("id"));
    if (!user) return c.json({ code: "USER_NOT_FOUND", message: "用户不存在" }, 404);
    const groupId = parsed.data.groupId;
    if (groupId && !await (await getCollection("computeGroups")).findOne({ id: groupId })) return c.json({ code: "COMPUTE_GROUP_NOT_FOUND", message: "分组不存在，请先新建分组" }, 404);
    if (groupId && !(await userGroupView(user)).eligible) return c.json({ code: "GULONG_ENGINE_SUBSCRIPTION_REQUIRED", message: "请先为该用户设置古龙引擎包月订阅，再分配算力分组" }, 403);
    if (!computeGroupsMatch(groupId, user.computeGroupId)) {
      const running = await Promise.all([
        ["h3SharedTasks", "requesterUserId"], ["capabilityOrders", "requesterUserId"], ["codexMarketTasks", "ownerId"],
      ].map(async ([collection, ownerField]) => (await getCollection(collection)).findOne({ ...(collection === "codexMarketTasks" ? { $or: [{ ownerId: user._id }, { executorOwnerId: user._id }] } : { [ownerField]: user._id }), status: { $in: ["claimed", "processing", "optimizing"] } })));
      if (running.some(Boolean)) return c.json({ code: "USER_GROUP_BUSY", message: "该用户仍有执行中的共享任务，请完成或取消任务后再修改分组" }, 409);
    }
    await (await getCollection("users")).updateOne({ _id: user._id }, { $set: { computeGroupId: groupId, computeGroupUpdatedAt: now() } });
    // Queued jobs follow the new membership assignment. Running jobs are still
    // checked against current authoritative groups before output/callback.
    await Promise.all([
      ["h3SharedTasks", "requesterUserId"], ["capabilityOrders", "requesterUserId"], ["codexMarketTasks", "ownerId"],
    ].map(async ([collection, ownerField]) => (await getCollection(collection)).updateMany({ [ownerField]: user._id, status: "queued" }, { $set: { computeGroupId: groupId, updatedAt: now() } })));
    await audit("user_assigned", { userId: user._id, groupId, previousGroupId: normalizeComputeGroupId(user.computeGroupId), actorUserId: new ObjectId(auth.user.id) });
    return c.json({ ok: true, ...await userGroupView({ ...user, computeGroupId: groupId }) });
  });
  app.get("/api/desktop/compute-groups", async (c) => {
    const auth = await bindingAuth(c); if (auth.error) return auth.error;
    const blocked = await limited(c, `compute-group-list:${auth.binding._id}`); if (blocked) return blocked;
    return listGroups(c);
  });
  async function nodeGroupView(binding) {
    const groupId = normalizeComputeGroupId(binding.computeGroupId);
    const group = groupId ? await (await getCollection("computeGroups")).findOne({ id: groupId }) : null;
    return { ok: true, node_id: binding.nodeId, group_id: groupId, group: publicGroup(group), policy: "same_group_only", ungrouped_policy: "ungrouped_nodes_only" };
  }
  app.get("/api/desktop/nodes/compute-group", async (c) => {
    const auth = await bindingAuth(c, c.req.query("node_id")); if (auth.error) return auth.error;
    c.header("Cache-Control", "private, no-store"); return c.json(await nodeGroupView(auth.binding));
  });
  app.put("/api/desktop/nodes/compute-group", async (c) => {
    const parsed = z.object({ node_id: z.string().min(12).max(160), group_id: groupIdSchema }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: "VALIDATION_ERROR", message: "节点 ID 或分组 ID 无效" }, 400);
    const auth = await bindingAuth(c, parsed.data.node_id); if (auth.error) return auth.error;
    const blocked = await limited(c, `compute-node-group:${auth.binding._id}`, 30); if (blocked) return blocked;
    const groupId = parsed.data.group_id;
    if (groupId && !await (await getCollection("computeGroups")).findOne({ id: groupId })) return c.json({ code: "COMPUTE_GROUP_NOT_FOUND", message: "分组不存在，请选择管理员已创建的分组" }, 404);
    if (computeGroupsMatch(groupId, auth.binding.computeGroupId)) return c.json(await nodeGroupView(auth.binding));
    const [h3Busy, capabilityBusy] = await Promise.all([
      (await getCollection("h3SharedTasks")).findOne({ "claimedByNode.bindingId": auth.binding._id, status: { $in: ["claimed", "processing"] } }),
      (await getCollection("capabilityOrders")).findOne({ "assignedNode.bindingId": auth.binding._id, status: { $in: ["claimed", "processing"] } }),
    ]);
    if (h3Busy || capabilityBusy) return c.json({ code: "NODE_GROUP_BUSY", message: "节点仍有运行中的任务，请完成或取消任务后再修改分组" }, 409);
    await (await getCollection("nodeAccountBindings")).updateOne({ _id: auth.binding._id, status: "active" }, { $set: { computeGroupId: groupId, computeGroupUpdatedAt: now() } });
    await audit("node_assigned", { bindingId: auth.binding._id, nodeId: auth.binding.nodeId, groupId, previousGroupId: normalizeComputeGroupId(auth.binding.computeGroupId), actorUserId: auth.user._id });
    return c.json(await nodeGroupView({ ...auth.binding, computeGroupId: groupId }));
  });
  app.post("/api/v1/compute-access/authorize", async (c) => {
    const rejected = dependencies.requireTrustedMutation(c); if (rejected) return rejected;
    const auth = await dependencies.authenticate(c, { scopes: ["tasks:write"] }); if (auth.error) return auth.error;
    const requesterId = new ObjectId(auth.user.id);
    const blocked = await limited(c, `compute-permit:${requesterId}`); if (blocked) return blocked;
    if (auth.user.role !== "admin" && !(await entitlement(requesterId)).active) return c.json({ code: "GULONG_ENGINE_SUBSCRIPTION_REQUIRED", message: "请先开通有效的古龙引擎包月会员" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const nodeId = String(body.node_id || "");
    if (!/^[A-Za-z0-9._:-]{12,160}$/.test(nodeId)) return c.json({ code: "VALIDATION_ERROR", message: "目标节点 ID 无效" }, 400);
    const bindings = await (await getCollection("nodeAccountBindings")).find({ nodeId, status: "active", revokedAt: null }).limit(2).toArray();
    if (bindings.length !== 1) return c.json({ code: "NODE_NOT_AVAILABLE", message: "目标节点未绑定或身份不唯一，请重新绑定节点" }, 404);
    const binding = bindings[0];
    const userGroupId = await getUserComputeGroupId(requesterId, getCollection);
    if (!computeGroupsMatch(userGroupId, binding.computeGroupId)) return c.json({ code: "COMPUTE_GROUP_MISMATCH", message: "用户与节点不属于同一分组，无法调用该节点" }, 403);
    const raw = `gcp_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now().getTime() + 90_000);
    await (await getCollection("computeAccessPermits")).insertOne({ tokenHash: hash(raw, "compute-access-permit"), requesterUserId: requesterId, bindingId: binding._id, nodeId, computeGroupId: userGroupId, expiresAt, createdAt: now(), status: "issued" });
    return c.json({ ok: true, permit: raw, node_id: nodeId, group_id: userGroupId, expires_at: expiresAt.toISOString(), one_time: true });
  });
  app.post("/api/desktop/compute-access/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const auth = await bindingAuth(c, String(body.node_id || "")); if (auth.error) return auth.error;
    const blocked = await limited(c, `compute-permit-verify:${auth.binding._id}`); if (blocked) return blocked;
    const raw = String(body.permit || "");
    if (!/^gcp_[A-Za-z0-9_-]{43}$/.test(raw) || body.node_id !== auth.binding.nodeId) return c.json({ code: "COMPUTE_PERMIT_INVALID", message: "调用许可无效，请重新获取" }, 403);
    const permits = await getCollection("computeAccessPermits");
    const filter = { tokenHash: hash(raw, "compute-access-permit"), bindingId: auth.binding._id, nodeId: auth.binding.nodeId, status: "issued", expiresAt: { $gt: now() } };
    const permit = await permits.findOne(filter);
    if (!permit) return c.json({ code: "COMPUTE_PERMIT_INVALID", message: "调用许可已使用、过期或不属于当前节点" }, 403);
    const user = await (await getCollection("users")).findOne({ _id: permit.requesterUserId, status: "active" });
    if (!user || (user.role !== "admin" && !(await entitlement(user._id)).active)) return c.json({ code: "GULONG_ENGINE_SUBSCRIPTION_REQUIRED", message: "调用用户的古龙引擎包月会员已失效" }, 403);
    if (!computeGroupsMatch(user.computeGroupId, auth.binding.computeGroupId) || !computeGroupsMatch(user.computeGroupId, permit.computeGroupId)) return c.json({ code: "COMPUTE_GROUP_MISMATCH", message: "用户或节点分组已变更，请重新选择同组节点" }, 403);
    const consumed = await permits.findOneAndUpdate(filter, { $set: { status: "used", usedAt: now() } }, { returnDocument: "after" });
    if (!consumed) return c.json({ code: "COMPUTE_PERMIT_INVALID", message: "此调用许可已被使用，请重新获取" }, 403);
    await audit("local_access_allowed", { userId: user._id, bindingId: auth.binding._id, nodeId: auth.binding.nodeId, groupId: normalizeComputeGroupId(user.computeGroupId) });
    return c.json({ ok: true, allowed: true, node_id: auth.binding.nodeId, group_id: normalizeComputeGroupId(user.computeGroupId), requester_user_id: user._id.toString(), authorization_id: consumed._id.toString() });
  });
  const groupListSchema = z.object({ groups: z.array(groupSchema), nextCursor: groupIdSchema });
  const userGroupSchema = z.object({ ok: z.boolean().optional(), computeGroupId: groupIdSchema, computeGroup: groupSchema.nullable(), eligible: z.boolean() });
  const nodeGroupSchema = z.object({ ok: z.literal(true), node_id: z.string(), group_id: groupIdSchema, group: groupSchema.nullable(), policy: z.literal("same_group_only"), ungrouped_policy: z.literal("ungrouped_nodes_only") });
  const permitSchema = z.object({ ok: z.literal(true), permit: z.string(), node_id: z.string(), group_id: groupIdSchema, expires_at: z.iso.datetime(), one_time: z.literal(true) });
  const verificationSchema = z.object({ ok: z.literal(true), allowed: z.literal(true), node_id: z.string(), group_id: groupIdSchema, requester_user_id: z.string(), authorization_id: z.string() });
  for (const [method, path, summary, binding] of [
    ["get", "/api/admin/compute-groups", "管理员搜索会员算力分组", false], ["post", "/api/admin/compute-groups", "新建唯一 ID 的会员算力分组", false],
    ["get", "/api/admin/users/{id}/compute-group", "查看用户算力分组", false], ["put", "/api/admin/users/{id}/compute-group", "分配古龙引擎包月用户算力分组", false],
    ["get", "/api/desktop/compute-groups", "已绑定节点搜索全部用户分组名称和 ID", true],
    ["get", "/api/desktop/nodes/compute-group", "读取当前绑定节点的算力分组", true], ["put", "/api/desktop/nodes/compute-group", "设置当前绑定节点算力分组", true],
    ["post", "/api/v1/compute-access/authorize", "会员获取本地或局域网节点一次性调用许可", false],
    ["post", "/api/desktop/compute-access/verify", "目标绑定节点原子验证并消耗同组调用许可", true],
  ]) {
    const responseSchema = path.endsWith("/authorize") ? permitSchema : path.endsWith("/verify") ? verificationSchema : path.includes("/nodes/") ? nodeGroupSchema : path.includes("/users/") ? userGroupSchema : method === "post" ? z.object({ group: groupSchema }) : groupListSchema;
    const bodySchema = path.endsWith("/authorize") ? z.object({ node_id: z.string() }) : path.endsWith("/verify") ? z.object({ node_id: z.string(), permit: z.string() }) : path.includes("/nodes/") ? z.object({ node_id: z.string(), group_id: groupIdSchema }) : path.includes("/users/") ? z.object({ groupId: groupIdSchema }) : z.object({ name: z.string().min(1).max(80) });
    app.openAPIRegistry.registerPath({ method, path, tags: ["Compute Groups"], summary,
    security: binding ? [{ accountBinding: [] }] : [{ sessionCookie: [] }, { bearerAuth: [] }],
    description: "算力分组独立于发行渠道。仅相同分组 ID 可调用；未分组只匹配未分组。管理员新建/分配、绑定节点配置均审计。名称 q 模糊搜索，limit 最大200，nextCursor 翻页。直连许可90秒有效且仅可消耗一次，验证时重新检查会员和用户/节点权威分组。完整 JSON 合同见 docs/compute-groups.md。",
    request: { ...(path.includes("{id}") ? { params: z.object({ id: z.string() }) } : {}),
      ...(method === "get" && path.endsWith("/compute-groups") ? { query: z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().regex(COMPUTE_GROUP_ID_PATTERN).optional() }) } : {}),
      ...(method === "get" && path.includes("/nodes/") ? { query: z.object({ node_id: z.string().optional() }) } : {}),
      ...(method === "post" || method === "put" ? { body: { required: true, content: { "application/json": { schema: bodySchema } } } } : {}),
    },
    responses: { [method === "post" && path === "/api/admin/compute-groups" ? 201 : 200]: { description: "分组/许可操作成功", content: { "application/json": { schema: responseSchema } } }, 400: { description: "参数无效" }, 401: { description: "未登录或节点未绑定" }, 403: { description: "权限、订阅或分组不匹配；许可无效" }, 404: { description: "用户/分组/节点不存在" }, 409: { description: "分组名称已存在或用户/节点仍在执行任务" }, 429: { description: "请求过于频繁" } } });
  }
}
