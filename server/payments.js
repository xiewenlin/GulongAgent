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
    wechat: mode === "mock" || configured([
      "WECHATPAY_APP_ID",
      "WECHATPAY_MCH_ID",
      "WECHATPAY_SERIAL_NO",
      "WECHATPAY_PRIVATE_KEY",
      "WECHATPAY_API_V3_KEY",
    ]),
    autoRenew: {
      wechat: false,
    },
  };
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
