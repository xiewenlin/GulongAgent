// A generic HTTP 404 is not evidence that this exact private COS object is
// absent. Never issue a second PUT or destructive completion on unknown state.
export function isDefiniteMissingCosObject(error) {
  const headers = error?.headers || error?.error?.headers || {};
  const header = name => String(Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] || "");
  const code = error?.error?.Code || error?.code;
  const directEmptyCosHead = (!code || code === "Error") && Boolean(header("x-cos-request-id"));
  return Number(error?.statusCode ?? error?.status) === 404 && (code === "NoSuchKey" || directEmptyCosHead)
    && header("x-cos-delete-marker").toLowerCase() !== "true";
}
