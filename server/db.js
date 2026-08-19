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
          { merchantOrderNo: 1 },
          {
            unique: true,
            partialFilterExpression: { merchantOrderNo: { $type: "string" } },
            name: "uniq_payment_merchant_order",
          },
        ),
        db.collection("payments").createIndex(
          { desktopRequestId: 1 },
          {
            unique: true,
            partialFilterExpression: { desktopRequestId: { $type: "string" } },
            name: "uniq_payment_desktop_request",
          },
        ),
        db.collection("payments").createIndex(
          { status: 1, paidAt: -1, updatedAt: -1 },
          { name: "payments_analytics" },
        ),
        db.collection("payments").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "payments_by_owner_and_date" },
        ),
        db.collection("payments").createIndex(
          { taskId: 1 },
          { unique: true, partialFilterExpression: { kind: "worker_task" }, name: "uniq_worker_task_online_payment" },
        ),
        db.collection("wallets").createIndex(
          { ownerId: 1 },
          { unique: true, name: "uniq_wallet_owner" },
        ),
        db.collection("platformCredentials").createIndex(
          { provider: 1 },
          { unique: true, name: "uniq_platform_credential_provider" },
        ),
        db.collection("agentUsage").createIndex(
          { requestId: 1 },
          { unique: true, name: "uniq_agent_usage_request" },
        ),
        db.collection("agentUsage").createIndex(
          { ownerId: 1, status: 1, createdAt: -1 },
          { name: "agent_usage_by_owner_and_date" },
        ),
        db.collection("agentMessages").createIndex(
          { ownerId: 1, conversationId: 1, createdAt: 1 },
          { name: "agent_messages_by_conversation" },
        ),
        db.collection("agentWorkflows").createIndex(
          { ownerId: 1, operationId: 1 },
          { unique: true, name: "uniq_agent_workflow_operation" },
        ),
        db.collection("agentWorkflows").createIndex(
          { createdAt: 1 },
          { expireAfterSeconds: 7 * 24 * 60 * 60, name: "ttl_agent_workflows" },
        ),
        db.collection("agentMediaJobs").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "agent_media_by_owner" },
        ),
        db.collection("agentMediaJobs").createIndex(
          { ownerId: 1, idempotencyKey: 1 },
          { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } }, name: "uniq_agent_media_idempotency" },
        ),
        db.collection("agentMediaJobs").createIndex(
          { status: 1, nextPollAt: 1 },
          { name: "agent_media_polling" },
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
        db.collection("notifications").createIndex(
          { ownerId: 1, type: 1, reminderDate: 1 },
          { unique: true, partialFilterExpression: { reminderDate: { $type: "string" } }, name: "uniq_daily_subscription_reminder" },
        ),
        db.collection("publicWorkflows").createIndex(
          { systemKey: 1 },
          { unique: true, sparse: true, name: "uniq_public_workflow_system_key" },
        ),
        db.collection("publicWorkflows").createIndex(
          { status: 1, sort: 1, createdAt: -1 },
          { name: "public_workflows_listing" },
        ),
        db.collection("publicWorkflowTombstones").createIndex(
          { deletedAt: -1 },
          { name: "public_workflow_tombstones_by_date" },
        ),
        db.collection("workflowImageUploads").createIndex(
          { expiresAt: 1 },
          { expireAfterSeconds: 0, name: "ttl_workflow_image_uploads" },
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
        db.collection("walletCreditLedger").createIndex(
          { creditKey: 1 },
          { unique: true, name: "uniq_wallet_credit_ledger" },
        ),
        db.collection("walletCreditLedger").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "wallet_credit_ledger_by_owner" },
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
        db.collection("activationCodes").createIndex(
          { codeHash: 1 },
          { unique: true, name: "uniq_activation_code_hash" },
        ),
        db.collection("activationCodes").createIndex(
          { status: 1, createdAt: -1 },
          { name: "activation_codes_by_status" },
        ),
        db.collection("activationCodes").createIndex(
          { deviceId: 1, product: 1 },
          {
            unique: true,
            partialFilterExpression: { deviceId: { $type: "string" } },
            name: "uniq_activation_device_product",
          },
        ),
        db.collection("nodeAccountBindings").createIndex(
          { tokenHash: 1 },
          { unique: true, partialFilterExpression: { tokenHash: { $type: "string" } }, name: "uniq_node_account_binding_token" },
        ),
        db.collection("nodeAccountBindings").createIndex(
          { activationLicenseId: 1, nodeId: 1 },
          { unique: true, name: "uniq_activation_node_binding" },
        ),
        db.collection("nodeAccountBindings").createIndex(
          { userId: 1, status: 1, lastSeenAt: -1 },
          { name: "node_bindings_by_user_presence" },
        ),
        db.collection("nodeAccountBindings").createIndex(
          { status: 1, lastSeenAt: -1 },
          { name: "h3_nodes_by_presence" },
        ),
        db.collection("nodeAccountBindingAudits").createIndex(
          { bindingId: 1, createdAt: -1 },
          { name: "node_binding_audit_history" },
        ),
        db.collection("h3SharedTasks").createIndex(
          { orderNo: 1 },
          { unique: true, name: "uniq_h3_order_no" },
        ),
        db.collection("h3SharedTasks").createIndex(
          { idempotencyKey: 1 },
          { unique: true, name: "uniq_h3_idempotency_key" },
        ),
        db.collection("h3SharedTasks").createIndex(
          { status: 1, createdAt: 1 },
          { name: "h3_claim_queue" },
        ),
        db.collection("h3SharedTasks").createIndex(
          { status: 1, model: 1, createdAt: 1 },
          { name: "h3_claim_queue_fifo" },
        ),
        db.collection("h3SharedTasks").createIndex(
          { "claimedByNode.bindingId": 1, status: 1, claimLeaseUntil: 1 },
          { name: "h3_active_tasks_by_binding" },
        ),
        db.collection("h3SharedTasks").createIndex(
          { requesterUserId: 1, createdAt: -1 },
          { name: "h3_tasks_by_requester" },
        ),
        db.collection("h3SharedTasks").createIndex(
          { assigneeUserId: 1, completedAt: -1 },
          { name: "h3_tasks_by_assignee" },
        ),
        db.collection("h3SharedTasks").createIndex(
          { assigneeUserId: 1, "executedByNode.nodeId": 1, completedAt: -1 },
          { name: "h3_earnings_by_assignee_node" },
        ),
        db.collection("h3TaskCallbacks").createIndex(
          { eventKey: 1 },
          { unique: true, name: "uniq_h3_callback_event" },
        ),
        db.collection("h3TaskCallbacks").createIndex(
          { taskId: 1, createdAt: 1 },
          { name: "h3_callbacks_by_task" },
        ),
        db.collection("h3OutputUploads").createIndex(
          { grantId: 1 },
          { unique: true, name: "uniq_h3_output_upload_grant" },
        ),
        db.collection("h3OutputUploads").createIndex(
          { objectKey: 1 },
          { unique: true, name: "uniq_h3_output_object" },
        ),
        db.collection("h3OutputUploads").createIndex(
          { taskId: 1, status: 1, createdAt: -1 },
          { name: "h3_output_uploads_by_task" },
        ),
        db.collection("h3AssetUploads").createIndex(
          { objectKey: 1 },
          { unique: true, name: "uniq_h3_asset_object" },
        ),
        db.collection("h3AssetUploads").createIndex(
          { ownerId: 1, status: 1, createdAt: -1 },
          { name: "h3_assets_by_owner" },
        ),
        db.collection("h3WalletLedger").createIndex(
          { ledgerKey: 1 },
          { unique: true, name: "uniq_h3_wallet_ledger" },
        ),
        db.collection("h3WalletLedger").createIndex(
          { ownerId: 1, createdAt: -1 },
          { name: "h3_wallet_ledger_by_owner" },
        ),
        db.collection("h3WalletLedger").createIndex(
          { ownerId: 1, kind: 1, status: 1, settledAt: 1 },
          { name: "h3_node_earnings_summary" },
        ),
        db.collection("h3TaskAudits").createIndex(
          { taskId: 1, createdAt: 1 },
          { name: "h3_task_audit_history" },
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
