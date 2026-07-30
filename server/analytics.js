import { getCollection } from "./db.js";

const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const PAID_PAYMENT_STATUSES = ["paid", "completed"];

function shanghaiDayStart(value = new Date()) {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - SHANGHAI_OFFSET_MS);
}

function dayKey(value) {
  return new Date(value.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function number(value) {
  return Number(value || 0);
}

function rounded(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(number(value) * factor) / factor;
}

function percent(part, total) {
  return total > 0 ? rounded((part / total) * 100, 1) : 0;
}

function change(current, previous) {
  if (previous > 0) return rounded(((current - previous) / previous) * 100, 1);
  return current > 0 ? 100 : null;
}

function rowForPeriod(rows, period) {
  return rows.find((row) => (row.period || row._id) === period) || {};
}

function periodExpression(dateField, currentStart) {
  return { $cond: [{ $gte: [dateField, currentStart] }, "current", "previous"] };
}

function uniqueIds(values) {
  return new Set(values.filter(Boolean).map((value) => value.toString()));
}

export async function recordAnalyticsEvent(input) {
  const analytics = await getCollection("analyticsEvents");
  await analytics.insertOne({
    ...input,
    createdAt: new Date(),
  });
}

export async function buildAdminAnalyticsDashboard(requestedDays = 30) {
  const days = [7, 30, 90].includes(Number(requestedDays)) ? Number(requestedDays) : 30;
  const now = new Date();
  const todayStart = shanghaiDayStart(now);
  const nextDay = new Date(todayStart.getTime() + DAY_MS);
  const currentStart = new Date(todayStart.getTime() - (days - 1) * DAY_MS);
  const previousStart = new Date(currentStart.getTime() - days * DAY_MS);
  const dayExpression = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: "+08:00" } });

  const users = await getCollection("users");
  const sessions = await getCollection("sessions");
  const analytics = await getCollection("analyticsEvents");
  const payments = await getCollection("payments");
  const offlinePayments = await getCollection("offlinePayments");
  const subscriptions = await getCollection("subscriptions");
  const tasks = await getCollection("tasks");
  const uploads = await getCollection("uploads");
  const feedback = await getCollection("feedback");
  const apiKeys = await getCollection("apiKeys");
  const configurations = await getCollection("userConfigurations");
  const memories = await getCollection("memories");
  const releaseChannels = await getCollection("releaseChannels");
  const releaseJobs = await getCollection("releaseJobs");

  const [
    userDaily,
    sessionDaily,
    eventDaily,
    paymentDaily,
    offlineDaily,
    taskDaily,
    uploadDaily,
    userPeriods,
    sessionPeriods,
    eventPeriods,
    paymentPeriods,
    offlinePeriods,
    taskPeriods,
    uploadPeriods,
    subscriptionPeriods,
    revenueKinds,
    revenueProviders,
    billingCycles,
    trafficSources,
    devices,
    topPages,
    workflows,
    taskStatuses,
    brainStatuses,
    scaleRows,
  ] = await Promise.all([
    users.aggregate([
      { $match: { createdAt: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: dayExpression("$createdAt"), registrations: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    sessions.aggregate([
      { $match: { lastSeenAt: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: dayExpression("$lastSeenAt"), activeUsers: { $addToSet: "$userId" }, sessions: { $sum: 1 } } },
      { $project: { _id: 1, activeUsers: { $size: "$activeUsers" }, sessions: 1 } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    analytics.aggregate([
      { $match: { createdAt: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: { day: dayExpression("$createdAt"), eventType: "$eventType" }, events: { $sum: 1 }, visitors: { $addToSet: "$visitorId" }, sessions: { $addToSet: "$sessionId" } } },
      { $project: { _id: 0, day: "$_id.day", eventType: "$_id.eventType", events: 1, visitors: { $size: "$visitors" }, sessions: { $size: "$sessions" } } },
    ]).toArray(),
    payments.aggregate([
      { $set: { analyticsDate: { $ifNull: ["$paidAt", "$updatedAt"] } } },
      { $match: { status: { $in: PAID_PAYMENT_STATUSES }, analyticsDate: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: dayExpression("$analyticsDate"), revenueFen: { $sum: "$amountFen" }, paidOrders: { $sum: 1 }, payers: { $addToSet: "$ownerId" }, subscriptionRevenueFen: { $sum: { $cond: [{ $eq: ["$kind", "subscription"] }, "$amountFen", 0] } }, rechargeRevenueFen: { $sum: { $cond: [{ $eq: ["$kind", "recharge"] }, "$amountFen", 0] } } } },
      { $project: { _id: 1, revenueFen: 1, paidOrders: 1, payers: { $size: "$payers" }, subscriptionRevenueFen: 1, rechargeRevenueFen: 1 } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    offlinePayments.aggregate([
      { $set: { analyticsDate: { $ifNull: ["$reviewedAt", "$updatedAt"] } } },
      { $match: { status: "approved", analyticsDate: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: dayExpression("$analyticsDate"), revenueFen: { $sum: "$amountFen" }, paidOrders: { $sum: 1 }, payers: { $addToSet: "$ownerId" } } },
      { $project: { _id: 1, revenueFen: 1, paidOrders: 1, payers: { $size: "$payers" } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    tasks.aggregate([
      { $match: { createdAt: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: dayExpression("$createdAt"), tasks: { $sum: 1 }, taskUsers: { $addToSet: "$ownerId" }, completedTasks: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } } } },
      { $project: { _id: 1, tasks: 1, taskUsers: { $size: "$taskUsers" }, completedTasks: 1 } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    uploads.aggregate([
      { $match: { kind: "brain", createdAt: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: dayExpression("$createdAt"), brainUploads: { $sum: 1 }, brainUsers: { $addToSet: "$ownerId" }, bytes: { $sum: "$size" } } },
      { $project: { _id: 1, brainUploads: 1, brainUsers: { $size: "$brainUsers" }, bytes: 1 } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    users.aggregate([
      { $match: { createdAt: { $gte: previousStart, $lt: nextDay } } },
      { $group: { _id: periodExpression("$createdAt", currentStart), registrations: { $sum: 1 } } },
    ]).toArray(),
    sessions.aggregate([
      { $match: { lastSeenAt: { $gte: previousStart, $lt: nextDay } } },
      { $group: { _id: periodExpression("$lastSeenAt", currentStart), activeUsers: { $addToSet: "$userId" }, sessions: { $sum: 1 } } },
      { $project: { _id: 1, activeUsers: { $size: "$activeUsers" }, sessions: 1 } },
    ]).toArray(),
    analytics.aggregate([
      { $match: { createdAt: { $gte: previousStart, $lt: nextDay } } },
      { $group: { _id: { period: periodExpression("$createdAt", currentStart), eventType: "$eventType" }, events: { $sum: 1 }, visitors: { $addToSet: "$visitorId" }, sessions: { $addToSet: "$sessionId" } } },
      { $project: { _id: 0, period: "$_id.period", eventType: "$_id.eventType", events: 1, visitors: { $size: "$visitors" }, sessions: { $size: "$sessions" } } },
    ]).toArray(),
    payments.aggregate([
      { $set: { analyticsDate: { $ifNull: ["$paidAt", "$updatedAt"] } } },
      { $match: { status: { $in: PAID_PAYMENT_STATUSES }, analyticsDate: { $gte: previousStart, $lt: nextDay } } },
      { $group: { _id: periodExpression("$analyticsDate", currentStart), revenueFen: { $sum: "$amountFen" }, paidOrders: { $sum: 1 }, payers: { $addToSet: "$ownerId" } } },
      { $project: { _id: 1, revenueFen: 1, paidOrders: 1, payers: { $size: "$payers" } } },
    ]).toArray(),
    offlinePayments.aggregate([
      { $set: { analyticsDate: { $ifNull: ["$reviewedAt", "$updatedAt"] } } },
      { $match: { status: "approved", analyticsDate: { $gte: previousStart, $lt: nextDay } } },
      { $group: { _id: periodExpression("$analyticsDate", currentStart), revenueFen: { $sum: "$amountFen" }, paidOrders: { $sum: 1 }, payers: { $addToSet: "$ownerId" } } },
      { $project: { _id: 1, revenueFen: 1, paidOrders: 1, payers: { $size: "$payers" } } },
    ]).toArray(),
    tasks.aggregate([
      { $match: { createdAt: { $gte: previousStart, $lt: nextDay } } },
      { $group: { _id: periodExpression("$createdAt", currentStart), tasks: { $sum: 1 }, users: { $addToSet: "$ownerId" } } },
      { $project: { _id: 1, tasks: 1, users: { $size: "$users" } } },
    ]).toArray(),
    uploads.aggregate([
      { $match: { kind: "brain", createdAt: { $gte: previousStart, $lt: nextDay } } },
      { $group: { _id: periodExpression("$createdAt", currentStart), brainUploads: { $sum: 1 }, users: { $addToSet: "$ownerId" } } },
      { $project: { _id: 1, brainUploads: 1, users: { $size: "$users" } } },
    ]).toArray(),
    subscriptions.aggregate([
      { $set: { analyticsDate: { $ifNull: ["$currentPeriodStart", "$createdAt"] } } },
      { $match: { analyticsDate: { $gte: previousStart, $lt: nextDay } } },
      { $group: { _id: periodExpression("$analyticsDate", currentStart), subscriptions: { $sum: 1 } } },
    ]).toArray(),
    payments.aggregate([
      { $set: { analyticsDate: { $ifNull: ["$paidAt", "$updatedAt"] } } },
      { $match: { status: { $in: PAID_PAYMENT_STATUSES }, analyticsDate: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: "$kind", amountFen: { $sum: "$amountFen" }, orders: { $sum: 1 } } },
      { $sort: { amountFen: -1 } },
    ]).toArray(),
    payments.aggregate([
      { $set: { analyticsDate: { $ifNull: ["$paidAt", "$updatedAt"] } } },
      { $match: { status: { $in: PAID_PAYMENT_STATUSES }, analyticsDate: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: "$provider", amountFen: { $sum: "$amountFen" }, orders: { $sum: 1 } } },
      { $sort: { amountFen: -1 } },
    ]).toArray(),
    payments.aggregate([
      { $set: { analyticsDate: { $ifNull: ["$paidAt", "$updatedAt"] } } },
      { $match: { status: { $in: PAID_PAYMENT_STATUSES }, kind: "subscription", analyticsDate: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: "$cycle", amountFen: { $sum: "$amountFen" }, orders: { $sum: 1 } } },
      { $sort: { amountFen: -1 } },
    ]).toArray(),
    analytics.aggregate([
      { $match: { eventType: "PAGE_VIEW", createdAt: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: "$source", views: { $sum: 1 }, visitors: { $addToSet: "$visitorId" } } },
      { $project: { _id: 0, source: "$_id", views: 1, visitors: { $size: "$visitors" } } },
      { $sort: { visitors: -1 } },
    ]).toArray(),
    analytics.aggregate([
      { $match: { eventType: "PAGE_VIEW", createdAt: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: "$deviceType", views: { $sum: 1 }, visitors: { $addToSet: "$visitorId" } } },
      { $project: { _id: 0, device: "$_id", views: 1, visitors: { $size: "$visitors" } } },
      { $sort: { visitors: -1 } },
    ]).toArray(),
    analytics.aggregate([
      { $match: { eventType: "PAGE_VIEW", createdAt: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: "$path", views: { $sum: 1 }, visitors: { $addToSet: "$visitorId" } } },
      { $project: { _id: 0, path: "$_id", views: 1, visitors: { $size: "$visitors" } } },
      { $sort: { views: -1 } },
      { $limit: 8 },
    ]).toArray(),
    tasks.aggregate([
      { $match: { createdAt: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: "$workflowId", tasks: { $sum: 1 }, users: { $addToSet: "$ownerId" }, completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } } } },
      { $project: { _id: 0, workflowId: "$_id", tasks: 1, users: { $size: "$users" }, completed: 1 } },
      { $sort: { tasks: -1 } },
      { $limit: 8 },
    ]).toArray(),
    tasks.aggregate([
      { $match: { createdAt: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $project: { _id: 0, status: "$_id", count: 1 } },
      { $sort: { count: -1 } },
    ]).toArray(),
    uploads.aggregate([
      { $match: { kind: "brain" } },
      { $group: { _id: "$status", count: { $sum: 1 }, bytes: { $sum: "$size" } } },
      { $project: { _id: 0, status: "$_id", count: 1, bytes: 1 } },
      { $sort: { count: -1 } },
    ]).toArray(),
    Promise.all([
      users.countDocuments({}),
      users.countDocuments({ status: "active" }),
      users.countDocuments({ role: "admin" }),
      subscriptions.countDocuments({
        status: { $nin: ["cancelled", "canceled"] },
        currentPeriodStart: { $lte: now },
        currentPeriodEnd: { $gt: now },
      }),
      apiKeys.distinct("ownerId", { revokedAt: null }),
      configurations.distinct("ownerId", { provider: "minimax" }),
      uploads.distinct("ownerId", { kind: "brain" }),
      tasks.distinct("ownerId"),
      memories.distinct("ownerId"),
      tasks.countDocuments({}),
      uploads.countDocuments({ kind: "brain" }),
      feedback.countDocuments({ status: "open" }),
      releaseChannels.countDocuments({ enabled: true }),
      releaseJobs.countDocuments({ status: "failed" }),
    ]),
  ]);

  const currentUsers = rowForPeriod(userPeriods, "current");
  const previousUsers = rowForPeriod(userPeriods, "previous");
  const currentSessions = rowForPeriod(sessionPeriods, "current");
  const previousSessions = rowForPeriod(sessionPeriods, "previous");
  const eventPeriod = (period, type) => eventPeriods.find((row) => row.period === period && row.eventType === type) || {};
  const currentPages = eventPeriod("current", "PAGE_VIEW");
  const previousPages = eventPeriod("previous", "PAGE_VIEW");
  const currentDownloads = eventPeriod("current", "DOWNLOAD_CLICK");
  const previousDownloads = eventPeriod("previous", "DOWNLOAD_CLICK");
  const currentCheckouts = eventPeriod("current", "CHECKOUT_START");
  const currentPayments = rowForPeriod(paymentPeriods, "current");
  const previousPayments = rowForPeriod(paymentPeriods, "previous");
  const currentOffline = rowForPeriod(offlinePeriods, "current");
  const previousOffline = rowForPeriod(offlinePeriods, "previous");
  const currentTasks = rowForPeriod(taskPeriods, "current");
  const previousTasks = rowForPeriod(taskPeriods, "previous");
  const currentUploads = rowForPeriod(uploadPeriods, "current");
  const previousUploads = rowForPeriod(uploadPeriods, "previous");
  const currentSubscriptions = rowForPeriod(subscriptionPeriods, "current");
  const previousSubscriptions = rowForPeriod(subscriptionPeriods, "previous");
  const currentRevenueFen = number(currentPayments.revenueFen) + number(currentOffline.revenueFen);
  const previousRevenueFen = number(previousPayments.revenueFen) + number(previousOffline.revenueFen);
  const currentPaidOrders = number(currentPayments.paidOrders) + number(currentOffline.paidOrders);
  const previousPaidOrders = number(previousPayments.paidOrders) + number(previousOffline.paidOrders);

  const trendMap = new Map();
  for (let index = 0; index < days; index += 1) {
    const date = new Date(currentStart.getTime() + index * DAY_MS);
    trendMap.set(dayKey(date), { date: dayKey(date), registrations: 0, activeUsers: 0, visitors: 0, pageViews: 0, downloads: 0, revenueFen: 0, paidOrders: 0, tasks: 0, brainUploads: 0 });
  }
  for (const row of userDaily) if (trendMap.has(row._id)) trendMap.get(row._id).registrations = number(row.registrations);
  for (const row of sessionDaily) if (trendMap.has(row._id)) Object.assign(trendMap.get(row._id), { activeUsers: number(row.activeUsers), sessions: number(row.sessions) });
  for (const row of eventDaily) {
    const bucket = trendMap.get(row.day); if (!bucket) continue;
    if (row.eventType === "PAGE_VIEW") Object.assign(bucket, { visitors: number(row.visitors), pageViews: number(row.events) });
    if (row.eventType === "DOWNLOAD_CLICK") bucket.downloads = number(row.events);
  }
  for (const row of paymentDaily) if (trendMap.has(row._id)) Object.assign(trendMap.get(row._id), { revenueFen: number(row.revenueFen), paidOrders: number(row.paidOrders) });
  for (const row of offlineDaily) if (trendMap.has(row._id)) { const bucket = trendMap.get(row._id); bucket.revenueFen += number(row.revenueFen); bucket.paidOrders += number(row.paidOrders); }
  for (const row of taskDaily) if (trendMap.has(row._id)) Object.assign(trendMap.get(row._id), { tasks: number(row.tasks), taskUsers: number(row.taskUsers) });
  for (const row of uploadDaily) if (trendMap.has(row._id)) Object.assign(trendMap.get(row._id), { brainUploads: number(row.brainUploads), brainUsers: number(row.brainUsers) });
  const trend = [...trendMap.values()];
  const today = trend.find((row) => row.date === dayKey(now)) || trend.at(-1);

  const cohortUsers = await users.find({ createdAt: { $gte: currentStart, $lt: nextDay } }).project({ _id: 1 }).toArray();
  const cohortIds = cohortUsers.map((row) => row._id);
  const currentActiveUserIds = await sessions.distinct("userId", { lastSeenAt: { $gte: currentStart, $lt: nextDay } });
  const [cohortLoginIds, cohortTaskIds, cohortUploadIds, cohortKeyIds, cohortConfigIds, cohortCheckoutIds, cohortPaidIds, cohortOfflinePaidIds, pendingPaymentRows, pendingOfflineRows, currentOnlinePayerRows, currentOfflinePayerRows] = await Promise.all([
    cohortIds.length ? sessions.distinct("userId", { userId: { $in: cohortIds } }) : [],
    cohortIds.length ? tasks.distinct("ownerId", { ownerId: { $in: cohortIds } }) : [],
    cohortIds.length ? uploads.distinct("ownerId", { ownerId: { $in: cohortIds }, kind: "brain" }) : [],
    cohortIds.length ? apiKeys.distinct("ownerId", { ownerId: { $in: cohortIds }, revokedAt: null }) : [],
    cohortIds.length ? configurations.distinct("ownerId", { ownerId: { $in: cohortIds }, provider: "minimax" }) : [],
    cohortIds.length ? payments.distinct("ownerId", { ownerId: { $in: cohortIds }, createdAt: { $gte: currentStart, $lt: nextDay } }) : [],
    cohortIds.length ? payments.distinct("ownerId", { ownerId: { $in: cohortIds }, status: { $in: PAID_PAYMENT_STATUSES } }) : [],
    cohortIds.length ? offlinePayments.distinct("ownerId", { ownerId: { $in: cohortIds }, status: "approved" }) : [],
    payments.aggregate([{ $match: { status: "pending" } }, { $group: { _id: null, amountFen: { $sum: "$amountFen" }, count: { $sum: 1 } } }]).toArray(),
    offlinePayments.aggregate([{ $match: { status: "pending" } }, { $group: { _id: null, amountFen: { $sum: "$amountFen" }, count: { $sum: 1 } } }]).toArray(),
    payments.aggregate([
      { $set: { analyticsDate: { $ifNull: ["$paidAt", "$updatedAt"] } } },
      { $match: { status: { $in: PAID_PAYMENT_STATUSES }, analyticsDate: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: "$ownerId" } },
    ]).toArray(),
    offlinePayments.aggregate([
      { $set: { analyticsDate: { $ifNull: ["$reviewedAt", "$updatedAt"] } } },
      { $match: { status: "approved", analyticsDate: { $gte: currentStart, $lt: nextDay } } },
      { $group: { _id: "$ownerId" } },
    ]).toArray(),
  ]);
  const activatedIds = uniqueIds([...cohortTaskIds, ...cohortUploadIds, ...cohortKeyIds, ...cohortConfigIds]);
  const paidCohortIds = uniqueIds([...cohortPaidIds, ...cohortOfflinePaidIds]);
  const pendingAmountFen = number(pendingPaymentRows[0]?.amountFen) + number(pendingOfflineRows[0]?.amountFen);
  const pendingOrders = number(pendingPaymentRows[0]?.count) + number(pendingOfflineRows[0]?.count);
  const currentPayerIds = uniqueIds([...currentOnlinePayerRows.map((row) => row._id), ...currentOfflinePayerRows.map((row) => row._id)]);
  const scale = {
    totalUsers: number(scaleRows[0]),
    enabledUsers: number(scaleRows[1]),
    administrators: number(scaleRows[2]),
    activeMembers: number(scaleRows[3]),
    apiDevelopers: scaleRows[4].length,
    minimaxConfiguredUsers: scaleRows[5].length,
    brainContributors: scaleRows[6].length,
    taskUsers: scaleRows[7].length,
    memoryUsers: scaleRows[8].length,
    totalTasks: number(scaleRows[9]),
    totalBrainUploads: number(scaleRows[10]),
    openFeedback: number(scaleRows[11]),
    activeReleaseChannels: number(scaleRows[12]),
    failedReleaseJobs: number(scaleRows[13]),
  };
  const period = {
    registrations: number(currentUsers.registrations),
    activeUsers: number(currentSessions.activeUsers),
    sessions: number(currentSessions.sessions),
    visitors: number(currentPages.visitors),
    pageViews: number(currentPages.events),
    downloads: number(currentDownloads.events),
    checkoutStarts: number(currentCheckouts.events),
    revenueFen: currentRevenueFen,
    paidOrders: currentPaidOrders,
    payers: currentPayerIds.size,
    tasks: number(currentTasks.tasks),
    taskUsers: number(currentTasks.users),
    brainUploads: number(currentUploads.brainUploads),
    brainUsers: number(currentUploads.users),
    subscriptions: number(currentSubscriptions.subscriptions),
    activeRate: percent(number(currentSessions.activeUsers), Math.max(1, scale.totalUsers)),
    paidConversionRate: percent(currentPayerIds.size, Math.max(1, number(currentSessions.activeUsers))),
    downloadConversionRate: percent(number(currentDownloads.events), Math.max(1, number(currentPages.visitors))),
    averageRevenuePerPayerFen: currentPayerIds.size > 0 ? rounded(currentRevenueFen / currentPayerIds.size, 0) : 0,
    averageRevenuePerActiveUserFen: number(currentSessions.activeUsers) > 0 ? rounded(currentRevenueFen / number(currentSessions.activeUsers), 0) : 0,
  };
  const comparisons = {
    registrations: change(period.registrations, number(previousUsers.registrations)),
    activeUsers: change(period.activeUsers, number(previousSessions.activeUsers)),
    visitors: change(period.visitors, number(previousPages.visitors)),
    pageViews: change(period.pageViews, number(previousPages.events)),
    downloads: change(period.downloads, number(previousDownloads.events)),
    revenue: change(currentRevenueFen, previousRevenueFen),
    paidOrders: change(currentPaidOrders, previousPaidOrders),
    tasks: change(period.tasks, number(previousTasks.tasks)),
    brainUploads: change(period.brainUploads, number(previousUploads.brainUploads)),
    subscriptions: change(period.subscriptions, number(previousSubscriptions.subscriptions)),
  };

  const insights = [];
  if (comparisons.registrations != null) insights.push({ tone: comparisons.registrations >= 0 ? "positive" : "attention", title: `用户增长${comparisons.registrations >= 0 ? "提升" : "回落"} ${Math.abs(comparisons.registrations)}%`, detail: `本周期新增 ${period.registrations} 个账号，活跃用户 ${period.activeUsers} 人。` });
  if (comparisons.revenue != null) insights.push({ tone: comparisons.revenue >= 0 ? "positive" : "attention", title: `已确认收入${comparisons.revenue >= 0 ? "增长" : "下降"} ${Math.abs(comparisons.revenue)}%`, detail: `本周期确认收入 ¥${(currentRevenueFen / 100).toFixed(2)}，共 ${currentPaidOrders} 笔已支付订单。` });
  if (pendingOrders) insights.push({ tone: "attention", title: `${pendingOrders} 笔订单仍待确认`, detail: `待支付或待人工审核金额 ¥${(pendingAmountFen / 100).toFixed(2)}，未计入已确认收入。` });
  insights.push({ tone: "accent", title: `MiniMax 配置覆盖 ${percent(scale.minimaxConfiguredUsers, Math.max(1, scale.totalUsers))}%`, detail: `${scale.minimaxConfiguredUsers} 位用户已配置 MiniMax，${scale.apiDevelopers} 位用户持有有效开发者 API Key。` });
  const brainBacklog = brainStatuses.filter((item) => ["queued_for_analysis", "analyzing", "uploading"].includes(item.status)).reduce((sum, item) => sum + number(item.count), 0);
  if (brainBacklog || scale.openFeedback) insights.push({ tone: brainBacklog > 10 || scale.openFeedback > 10 ? "attention" : "neutral", title: "服务队列需要持续关注", detail: `第二大脑待处理 ${brainBacklog} 份，未解决用户反馈 ${scale.openFeedback} 条。` });

  return {
    dataMode: "live",
    dataSources: ["MongoDB 用户与会话", "MongoDB 支付与订阅", "MongoDB 行为事件", "MongoDB 任务、附件与发版记录"],
    generatedAt: now,
    timezone: "Asia/Shanghai",
    days,
    range: { start: currentStart, end: nextDay, previousStart, previousEnd: currentStart },
    today,
    scale,
    period,
    comparisons,
    trend,
    acquisition: { trafficSources, devices, topPages },
    lifecycle: [
      { key: "registered", label: "新增注册", value: cohortIds.length },
      { key: "loggedIn", label: "完成登录", value: uniqueIds(cohortLoginIds).size },
      { key: "activated", label: "使用核心能力", value: activatedIds.size },
      { key: "checkout", label: "发起订单", value: uniqueIds(cohortCheckoutIds).size },
      { key: "paid", label: "完成付费", value: paidCohortIds.size },
    ],
    revenue: {
      confirmedFen: currentRevenueFen,
      pendingFen: pendingAmountFen,
      pendingOrders,
      kinds: [
        ...revenueKinds.map((row) => ({ kind: row._id || "other", amountFen: number(row.amountFen), orders: number(row.orders) })),
        ...(number(currentOffline.revenueFen) ? [{ kind: "offline_subscription", amountFen: number(currentOffline.revenueFen), orders: number(currentOffline.paidOrders) }] : []),
      ],
      providers: [
        ...revenueProviders.map((row) => ({ provider: row._id || "other", amountFen: number(row.amountFen), orders: number(row.orders) })),
        ...(number(currentOffline.revenueFen) ? [{ provider: "offline", amountFen: number(currentOffline.revenueFen), orders: number(currentOffline.paidOrders) }] : []),
      ],
      billingCycles: billingCycles.map((row) => ({ cycle: row._id || "other", amountFen: number(row.amountFen), orders: number(row.orders) })),
    },
    featureAdoption: [
      { key: "tasks", label: "智能体任务", users: scale.taskUsers, total: scale.totalTasks },
      { key: "brain", label: "第二大脑", users: scale.brainContributors, total: scale.totalBrainUploads },
      { key: "memory", label: "长期记忆", users: scale.memoryUsers, total: await memories.countDocuments({}) },
      { key: "api", label: "开放 API", users: scale.apiDevelopers, total: await apiKeys.countDocuments({ revokedAt: null }) },
      { key: "minimax", label: "MiniMax 配置", users: scale.minimaxConfiguredUsers, total: scale.minimaxConfiguredUsers },
    ],
    workflows,
    taskStatuses,
    brainStatuses,
    operations: { openFeedback: scale.openFeedback, brainBacklog, failedReleaseJobs: scale.failedReleaseJobs, activeReleaseChannels: scale.activeReleaseChannels },
    insights,
    trackedActiveUsers: currentActiveUserIds.length,
  };
}
