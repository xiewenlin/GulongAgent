export const BIRTHDAY_ARTWORK_PROMPT = "Create a soft, joyful birthday celebration backdrop with delicate watercolor balloons, tiny confetti, ribbons and subtle stars around the edges. Warm ivory and pastel peach, mint, lavender, pale yellow palette, airy paper texture, calm bright center with generous empty space for sticky notes. Landscape composition. Decorative illustration only: no text, no letters, no numbers, no logos, no people, no personal information.";
export const BIRTHDAY_ARTWORK_REQUEST = Object.freeze({ prompt: BIRTHDAY_ARTWORK_PROMPT, images: [], size: "1536x1024", messages: [] });
export const BIRTHDAY_ARTWORK_TERMINAL = new Set(["completed", "failed", "cancelled", "rejected"]);
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,160}$/;
const TASK_ID = /^[a-f0-9]{24}$/i;

export function birthdayArtworkStorageKey(ownerId, wallId) {
  return `gulong-birthday-artwork-v1:${encodeURIComponent(ownerId)}:wall:${encodeURIComponent(wallId)}`;
}

// Only recovery identifiers are retained. Generated images and account tokens
// never enter local storage or a public wall record.
export function readBirthdayArtworkRecord(raw, ownerId, wallId) {
  if (!raw) return null;
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("绘图订单恢复记录无法读取，请勿重复下单；请联系管理员核对原订单。"); }
  if (value?.version !== 1 || value.ownerId !== ownerId || !wallId || value.wallId !== wallId || value.prompt !== BIRTHDAY_ARTWORK_PROMPT || !REQUEST_ID.test(value.quoteReq || "") || !REQUEST_ID.test(value.taskReq || "")
      || (value.quoteId && !TASK_ID.test(value.quoteId)) || (value.taskId && !TASK_ID.test(value.taskId))
      || typeof value.submitted !== "boolean" || (value.submitted && !value.quoteId)
      || (value.status && !["quoted", "submitting", "queued", "claimed", "processing", ...BIRTHDAY_ARTWORK_TERMINAL].includes(value.status))) {
    throw new Error("绘图订单恢复记录不完整，请勿重复下单；请联系管理员核对原订单。");
  }
  return {
    version: 1, ownerId, wallId, prompt: value.prompt, quoteReq: value.quoteReq, taskReq: value.taskReq,
    quoteId: value.quoteId || null, taskId: value.taskId || null,
    submitted: value.submitted, status: value.status || null,
  };
}

export function birthdayArtworkCanStartNew(record) {
  return !record || BIRTHDAY_ARTWORK_TERMINAL.has(record.status);
}

// POST /tasks checks the owner/requestId task before either of these exact
// errors. Other conflicts (including QUOTE_ALREADY_USED) may name a real order.
export function birthdayArtworkDefiniteNoOrder(error) {
  return error?.status === 409 && ["QUOTE_EXPIRED", "QUOTE_AUTHORIZATION_CHANGED"].includes(error.code);
}

export function birthdayArtworkNodeReady(result) {
  const model = result?.models?.find((item) => item.id === "longtu");
  return model?.available === true && model.availability?.status === "ready" && Number(model.availability.compatibleNodeCount) > 0;
}

export function birthdayArtworkPrice(quote) {
  const amount = quote?.chargedMilliYuan;
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("无法确认本次绘图金额，请稍后重试。");
  return amount === 0 ? "本次免费" : `¥${(amount / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function birthdayArtworkImage(task) {
  if (task?.status !== "completed") return null;
  const dataUrl = task.result?.images?.[0]?.dataUrl;
  if (typeof dataUrl !== "string" || dataUrl.length > 3_400_000 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) {
    throw new Error("绘图已完成，但图片结果暂时无法读取，请刷新原订单，避免重复下单。");
  }
  return dataUrl;
}
