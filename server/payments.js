import { createCipheriv, createDecipheriv, createSign, createVerify, randomBytes } from "node:crypto";

function configured(names) {
  return names.every((name) => Boolean(process.env[name]?.trim()));
}

function normalizePem(value) {
  return value?.replace(/\\n/g, "\n").trim();
}

export function paymentCapabilities() {
  const mode = process.env.PAYMENT_MODE === "live" ? "live" : "mock";
  return {
    mode,
    alipay: mode === "mock" || configured(["ALIPAY_APP_ID", "ALIPAY_PRIVATE_KEY", "ALIPAY_PUBLIC_KEY"]),
    wechat: mode === "mock" || configured([
      "WECHATPAY_APP_ID",
      "WECHATPAY_MCH_ID",
      "WECHATPAY_SERIAL_NO",
      "WECHATPAY_PRIVATE_KEY",
      "WECHATPAY_API_V3_KEY",
    ]),
    autoRenew: {
      alipay: Boolean(process.env.ALIPAY_AUTOPAY_PRODUCT_CODE),
      wechat: Boolean(process.env.WECHATPAY_AUTORENEW_APP_ID),
    },
  };
}

function canonicalParams(params) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== "" && key !== "sign")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

export function buildAlipayPagePayUrl({ orderNo, amountFen, subject }) {
  const gateway = process.env.ALIPAY_GATEWAY || "https://openapi.alipay.com/gateway.do";
  const params = {
    app_id: process.env.ALIPAY_APP_ID,
    method: "alipay.trade.page.pay",
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
    version: "1.0",
    notify_url: process.env.ALIPAY_NOTIFY_URL,
    return_url: process.env.ALIPAY_RETURN_URL,
    biz_content: JSON.stringify({
      out_trade_no: orderNo,
      product_code: "FAST_INSTANT_TRADE_PAY",
      total_amount: (amountFen / 100).toFixed(2),
      subject,
    }),
  };
  const signer = createSign("RSA-SHA256");
  signer.update(canonicalParams(params), "utf8");
  signer.end();
  params.sign = signer.sign(normalizePem(process.env.ALIPAY_PRIVATE_KEY), "base64");
  return `${gateway}?${new URLSearchParams(params).toString()}`;
}

export function verifyAlipayNotification(payload) {
  const verifier = createVerify("RSA-SHA256");
  const canonical = canonicalParams(
    Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "sign_type")),
  );
  verifier.update(canonical, "utf8");
  verifier.end();
  return verifier.verify(normalizePem(process.env.ALIPAY_PUBLIC_KEY), payload.sign, "base64");
}

function wechatAuthorization(method, path, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  const signature = signer.sign(normalizePem(process.env.WECHATPAY_PRIVATE_KEY), "base64");
  return `WECHATPAY2-SHA256-RSA2048 mchid=\"${process.env.WECHATPAY_MCH_ID}\",nonce_str=\"${nonce}\",signature=\"${signature}\",timestamp=\"${timestamp}\",serial_no=\"${process.env.WECHATPAY_SERIAL_NO}\"`;
}

export async function createWechatNativeOrder({ orderNo, amountFen, subject }) {
  const path = "/v3/pay/transactions/native";
  const payload = JSON.stringify({
    appid: process.env.WECHATPAY_APP_ID,
    mchid: process.env.WECHATPAY_MCH_ID,
    description: subject,
    out_trade_no: orderNo,
    notify_url: process.env.WECHATPAY_NOTIFY_URL,
    amount: { total: amountFen, currency: "CNY" },
  });
  const response = await fetch(`https://api.mch.weixin.qq.com${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: wechatAuthorization("POST", path, payload),
      "User-Agent": "GulongAgent/1.0",
    },
    body: payload,
  });
  const result = await response.json();
  if (!response.ok || !result.code_url) {
    throw new Error(result.message || "微信支付下单失败");
  }
  return result.code_url;
}

export function verifyWechatNotification(headers, rawBody) {
  const timestamp = headers.get("wechatpay-timestamp");
  const nonce = headers.get("wechatpay-nonce");
  const signature = headers.get("wechatpay-signature");
  if (!timestamp || !nonce || !signature) return false;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
  verifier.end();
  return verifier.verify(normalizePem(process.env.WECHATPAY_PLATFORM_CERT), signature, "base64");
}

export function decryptWechatResource(resource) {
  const key = Buffer.from(process.env.WECHATPAY_API_V3_KEY, "utf8");
  const ciphertext = Buffer.from(resource.ciphertext, "base64");
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(resource.nonce));
  decipher.setAuthTag(authTag);
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data));
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
}

export function createMockPaymentUrl(orderNo, provider, token = randomBytes(12).toString("base64url")) {
  return `/payment/mock?provider=${provider}&order=${orderNo}&token=${token}`;
}
