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
        db.collection("users").createIndex(
          { chandlerUserId: 1 },
          { unique: true, sparse: true, name: "uniq_chandler_user" },
        ),
        db.collection("users").createIndex(
          { releaseChannelId: 1, createdAt: -1 },
          { name: "users_by_release_channel" },
        ),
        db.collection("sessions").createIndex(
          { tokenHash: 1 },
          { unique: true, name: "uniq_session_token" },
        ),
        db.collection("sessions").createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "ttl_sessions" },
        ),
        db.collection("sessions").createIndex(
          { lastSeenAt: -1, userId: 1 },
          { name: "sessions_activity" },
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
        db.collection("payments").createIndex(
          { status: 1, paidAt: -1, updatedAt: -1 },
          { name: "payments_analytics" },
        ),
        db.collection("payments").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "payments_by_owner_and_date" },
        ),
        db.collection("tasks").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "tasks_by_owner" },
        ),
        db.collection("tasks").createIndex(
          { createdAt: -1, workflowId: 1, status: 1 },
          { name: "tasks_analytics" },
        ),
        db.collection("feedback").createIndex(
          { createdAt: -1 },
          { name: "feedback_recent" },
        ),
        db.collection("feedback").createIndex(
          { status: 1, updatedAt: -1, createdAt: -1 },
          { name: "feedback_by_status" },
        ),
        db.collection("feedbackResponseUploads").createIndex(
          { feedbackId: 1, status: 1, createdAt: -1 },
          { name: "feedback_response_uploads" },
        ),
        db.collection("uploads").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "uploads_by_owner" },
        ),
        db.collection("uploads").createIndex(
          { kind: 1, createdAt: -1, originalName: 1 },
          { name: "uploads_admin_search" },
        ),
        db.collection("partners").createIndex(
          { sort: 1, createdAt: -1 },
          { name: "partners_public_order" },
        ),
        db.collection("releaseChannels").createIndex(
          { groupId: 1 },
          { unique: true, name: "uniq_release_group" },
        ),
        db.collection("releaseChannels").createIndex(
          { enabled: 1, isDefault: 1, sort: 1 },
          { name: "release_channel_download" },
        ),
        db.collection("releaseAssignments").createIndex(
          { chandlerUserId: 1 },
          { unique: true, name: "uniq_release_assignment_user" },
        ),
        db.collection("releaseAssignments").createIndex(
          { groupId: 1, updatedAt: -1 },
          { name: "release_assignments_by_group" },
        ),
        db.collection("releaseJobs").createIndex(
          { status: 1, createdAt: 1 },
          { name: "release_job_queue" },
        ),
        db.collection("releaseUploads").createIndex(
          { channelId: 1, status: 1, expiresAt: 1 },
          { name: "release_manual_uploads" },
        ),
        db.collection("offlinePayments").createIndex(
          { orderNo: 1 },
          { unique: true, name: "uniq_offline_payment_order" },
        ),
        db.collection("offlinePayments").createIndex(
          { desktopRequestId: 1 },
          { unique: true, sparse: true, name: "uniq_offline_payment_desktop_request" },
        ),
        db.collection("offlinePayments").createIndex(
          { status: 1, reviewedAt: -1, updatedAt: -1 },
          { name: "offline_payments_analytics" },
        ),
        db.collection("offlinePayments").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "offline_payments_by_owner_and_date" },
        ),
        db.collection("offlinePaymentReviewEvents").createIndex(
          { orderId: 1 },
          { unique: true, name: "uniq_offline_payment_review_order" },
        ),
        db.collection("offlinePaymentReviewEvents").createIndex(
          { status: 1, availableAt: 1, createdAt: 1 },
          { name: "offline_payment_review_queue" },
        ),
        db.collection("offlinePaymentReviewWorkers").createIndex(
          { workerId: 1 },
          { unique: true, name: "uniq_offline_payment_review_worker" },
        ),
        db.collection("offlinePaymentReviewWorkers").createIndex(
          { ownerId: 1, enabled: 1, updatedAt: -1 },
          { name: "offline_payment_review_workers_by_admin" },
        ),
        db.collection("notifications").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "notifications_by_owner" },
        ),
        db.collection("notifications").createIndex(
          { ownerId: 1, readAt: 1, createdAt: -1 },
          { name: "notifications_unread" },
        ),
        db.collection("workerTasks").createIndex(
          { status: 1, createdAt: -1 },
          { name: "worker_tasks_market" },
        ),
        db.collection("workerTasks").createIndex(
          { publisherId: 1, createdAt: -1 },
          { name: "worker_tasks_by_publisher" },
        ),
        db.collection("workerTasks").createIndex(
          { contractorId: 1, updatedAt: -1 },
          { name: "worker_tasks_by_contractor" },
        ),
        db.collection("workerTasks").createIndex(
          { assignmentType: 1, designatedAssigneeId: 1, status: 1, createdAt: -1 },
          { name: "worker_tasks_by_assignment" },
        ),
        db.collection("workerTasks").createIndex(
          { paymentStatus: 1, paymentSubmittedAt: 1 },
          { name: "worker_task_payment_review" },
        ),
        db.collection("workerTaskUploads").createIndex(
          { taskId: 1, section: 1, status: 1, createdAt: 1 },
          { name: "worker_task_assets" },
        ),
        db.collection("workerTaskUploads").createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "ttl_worker_task_uploads" },
        ),
        db.collection("workerEarnings").createIndex(
          { taskId: 1, kind: 1 },
          { unique: true, name: "uniq_worker_task_earning" },
        ),
        db.collection("workerEarnings").createIndex(
          { ownerId: 1, availableAt: -1 },
          { name: "worker_earnings_by_owner" },
        ),
        db.collection("workerWorkflows").createIndex(
          { fingerprint: 1 },
          { unique: true, name: "uniq_worker_workflow_fingerprint" },
        ),
        db.collection("workerWorkflowRevenueLedger").createIndex(
          { workflowId: 1, reference: 1 },
          { unique: true, name: "uniq_worker_workflow_revenue" },
        ),
        db.collection("workerContactPayments").createIndex(
          { taskId: 1, requesterId: 1, targetId: 1 },
          { unique: true, name: "uniq_worker_contact_unlock" },
        ),
        db.collection("workerContactPayments").createIndex(
          { status: 1, submittedAt: 1, reviewedAt: -1 },
          { name: "worker_contact_payment_review" },
        ),
        db.collection("workerContactAccessAudits").createIndex(
          { requesterId: 1, createdAt: -1 },
          { name: "worker_contact_access_audits_by_requester" },
        ),
        db.collection("avatarUploads").createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "ttl_avatar_uploads" },
        ),
        db.collection("pricingVersions").createIndex(
          { skuId: 1, effectiveAt: -1, status: 1 },
          { name: "pricing_versions_by_sku" },
        ),
        db.collection("pricingVersions").createIndex(
          { billingInterval: 1, effectiveAt: -1, status: 1 },
          { name: "pricing_versions_by_cycle" },
        ),
        db.collection("pricingVersions").createIndex(
          { chandlerPriceId: 1 },
          { unique: true, sparse: true, name: "uniq_chandler_price_version" },
        ),
        db.collection("subscriptions").createIndex(
          { status: 1, currentPeriodEnd: 1 },
          { name: "subscriptions_active" },
        ),
        db.collection("subscriptionPeriodAudits").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "subscription_period_audits_by_user" },
        ),
        db.collection("analyticsEvents").createIndex(
          { eventType: 1, createdAt: -1 },
          { name: "analytics_events_by_type" },
        ),
        db.collection("analyticsEvents").createIndex(
          { visitorId: 1, createdAt: -1 },
          { name: "analytics_events_by_visitor" },
        ),
        db.collection("userConfigurations").createIndex(
          { ownerId: 1, provider: 1 },
          { unique: true, name: "uniq_user_provider_configuration" },
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
