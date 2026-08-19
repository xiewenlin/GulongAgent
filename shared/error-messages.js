const CHINESE_TEXT = /[\u3400-\u9fff]/;

const ERROR_TRANSLATIONS = [
  [/username.*(3\s*[-–]\s*32|chars?|reserved)|invalid username|username.+not allowed/i, "用户名暂不可用，请重新填写"],
  [/failed to fetch|network\s*error|network request failed|load failed|fetch failed|econnreset|econnrefused|enotfound|socket hang up/i, "网络连接失败，请检查网络后重试"],
  [/timeout|timed out|etimedout|abort(?:ed|error)?/i, "请求超时，请稍后重试"],
  [/only grant_type\s*=\s*authorization_code is supported/i, "当前登录授权方式不受支持，请重新登录后再试"],
  [/unauthori[sz]ed|authentication required|invalid (?:access )?token|token (?:is )?(?:invalid|expired)|jwt expired|not authenticated/i, "登录已失效，请重新登录"],
  [/forbidden|permission denied|access denied|insufficient permissions?|not permitted/i, "当前账号没有执行该操作的权限"],
  [/too many requests|rate limit|throttl/i, "操作过于频繁，请稍后重试"],
  [/payload too large|request entity too large|file too large|content length exceeded/i, "提交的文件或内容过大，请缩小后重试"],
  [/duplicate|already exists|conflict|unique constraint|e11000/i, "相同的记录已经存在，请勿重复提交"],
  [/weak password|password.+(?:characters?|chars?|uppercase|lowercase|digit|symbol)|invalid password/i, "密码不符合账号服务要求，请重新填写"],
  [/validation(?: error| failed)?|invalid request|bad request|malformed json|invalid input|unprocessable/i, "提交内容不正确，请检查后重试"],
  [/not found|does not exist|no such/i, "请求的内容不存在或已经被删除"],
  [/service unavailable|temporarily unavailable|internal server error|bad gateway|gateway timeout|upstream error/i, "服务暂时不可用，请稍后重试"],
  [/database|mongodb|mongo server|connection pool/i, "数据服务暂时不可用，请稍后重试"],
  [/object storage|cos.+(?:error|failed)|upload failed|download failed/i, "文件存储服务暂时不可用，请稍后重试"],
  [/payment failed|payment error|order failed|refund failed/i, "支付服务暂时不可用，请稍后重试"],
  [/pearapi|model.+(?:unavailable|unsupported|not found)|inference failed/i, "远程模型服务暂时不可用，请稍后重试"],
  [/unexpected token|json.+(?:parse|syntax)|syntaxerror/i, "服务返回的数据格式不正确，请稍后重试"],
];

function errorText(value) {
  if (value instanceof Error) return String(value.message || "").trim();
  if (value && typeof value === "object" && "message" in value) return String(value.message || "").trim();
  return String(value || "").trim();
}

/**
 * Converts third-party, browser and infrastructure errors into safe Chinese
 * messages. Existing Chinese business messages are preserved verbatim.
 */
export function localizeErrorMessage(value, fallback = "请求失败，请稍后重试") {
  const text = errorText(value);
  if (!text) return fallback;
  const translated = ERROR_TRANSLATIONS.find(([pattern]) => pattern.test(text));
  if (translated) return translated[1];
  if (CHINESE_TEXT.test(text)) return text;
  return fallback;
}
