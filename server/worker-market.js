import { createHash } from "node:crypto";

export const WORKER_TASK_STATUSES = [
  "draft",
  "awaiting_payment",
  "pending_payment_review",
  "payment_rejected",
  "open",
  "in_progress",
  "submitted",
  "accepted",
  "cancelled",
];

export const WORKER_ASSET_SECTIONS = ["input", "output", "delivery"];

export const WORKER_ASSET_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/x-7z-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

export const WORKER_MAX_ASSET_BYTES = 200 * 1024 * 1024;
export const WORKER_MAX_ASSETS_PER_SECTION = 10;

export function workerTaskFinancials(budgetFen) {
  const budget = Math.max(0, Math.trunc(Number(budgetFen) || 0));
  const contractorIncomeFen = Math.floor(budget * 0.8);
  return {
    budgetFen: budget,
    contractorIncomeFen,
    platformServiceFeeFen: budget - contractorIncomeFen,
    contractorShareBps: 8000,
    platformShareBps: 2000,
  };
}

export function workerWorkflowRevenue({ grossFen, costFen = 0, taxFen = 0 }) {
  const gross = Math.max(0, Math.trunc(Number(grossFen) || 0));
  const cost = Math.max(0, Math.trunc(Number(costFen) || 0));
  const tax = Math.max(0, Math.trunc(Number(taxFen) || 0));
  const netProfitFen = Math.max(0, gross - cost - tax);
  const publisherShareFen = Math.floor(netProfitFen * 0.3);
  const contractorShareFen = Math.floor(netProfitFen * 0.3);
  return {
    grossFen: gross,
    costFen: cost,
    taxFen: tax,
    netProfitFen,
    publisherShareFen,
    contractorShareFen,
    platformShareFen: netProfitFen - publisherShareFen - contractorShareFen,
    rule: {
      base: "net_after_cost_and_tax",
      publisherShareBps: 3000,
      contractorShareBps: 3000,
      platformShareBps: 4000,
    },
  };
}

export function workerTaskFingerprint(inputDescription, outputDescription, exampleDescription = "") {
  const normalize = (value) => String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256")
    .update([inputDescription, outputDescription, exampleDescription].map(normalize).join("\n---\n"))
    .digest("hex");
}

export function workerAssetInput(body = {}) {
  const section = WORKER_ASSET_SECTIONS.includes(body.section) ? body.section : null;
  const contentType = String(body.contentType || "application/octet-stream").trim().toLowerCase() || "application/octet-stream";
  const bytes = Number(body.bytes);
  if (!section || !WORKER_ASSET_CONTENT_TYPES.has(contentType) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > WORKER_MAX_ASSET_BYTES) return null;
  return { section, contentType, bytes };
}

export function workerTaskTitle(inputDescription) {
  const firstLine = String(inputDescription || "").trim().split(/\r?\n/)[0].trim();
  return firstLine.length > 42 ? `${firstLine.slice(0, 42)}…` : firstLine;
}
