import COS from "cos-nodejs-sdk-v5";
import { ConfigurationError } from "./db.js";

const DEFAULT_BUCKET = "gulong-1259744534";
const DEFAULT_REGION = "ap-chengdu";
const DEFAULT_DOMAIN = "gulong-1259744534.cos.ap-chengdu.myqcloud.com";

let client;
let browserUploadCorsPromise;

const OFFICIAL_BROWSER_ORIGINS = [
  "https://www.sologle.com",
  "https://sologle.com",
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigurationError(`腾讯云 COS 尚未配置 ${name}`);
  return value;
}

export function cosConfig() {
  return {
    bucket: process.env.COS_BUCKET?.trim() || DEFAULT_BUCKET,
    region: process.env.COS_REGION?.trim() || DEFAULT_REGION,
    domain: process.env.COS_DOMAIN?.trim() || DEFAULT_DOMAIN,
    configured: Boolean(process.env.TENCENT_SECRET_ID?.trim() && process.env.TENCENT_SECRET_KEY?.trim()),
  };
}

function getClient() {
  if (!client) {
    client = new COS({
      SecretId: required("TENCENT_SECRET_ID"),
      SecretKey: required("TENCENT_SECRET_KEY"),
      Protocol: "https:",
    });
  }
  return client;
}

function objectParams(key) {
  const config = cosConfig();
  return { Bucket: config.bucket, Region: config.region, Key: key };
}

function bucketParams() {
  const config = cosConfig();
  return { Bucket: config.bucket, Region: config.region };
}

function ruleValues(rule, singular) {
  const value = rule?.[`${singular}s`] ?? rule?.[singular] ?? [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

export function browserUploadCorsRule(origins = OFFICIAL_BROWSER_ORIGINS) {
  return {
    AllowedOrigin: [...new Set(origins.map(String).filter(Boolean))],
    AllowedMethod: ["PUT", "POST", "GET", "HEAD"],
    AllowedHeader: ["*"],
    ExposeHeader: ["ETag", "x-cos-request-id"],
    MaxAgeSeconds: 600,
  };
}

export function browserUploadCorsReady(rules, origins = OFFICIAL_BROWSER_ORIGINS) {
  return origins.every((origin) => (rules || []).some((rule) => {
    const allowedOrigins = ruleValues(rule, "AllowedOrigin");
    const allowedMethods = ruleValues(rule, "AllowedMethod").map((method) => method.toUpperCase());
    const allowedHeaders = ruleValues(rule, "AllowedHeader").map((header) => header.toLowerCase());
    return (allowedOrigins.includes(origin) || allowedOrigins.includes("*"))
      && allowedMethods.includes("PUT")
      && (allowedHeaders.includes("*") || allowedHeaders.includes("content-type"));
  }));
}

export async function ensureBrowserUploadCors() {
  if (!browserUploadCorsPromise) {
    browserUploadCorsPromise = (async () => {
      const cos = getClient();
      let configuredOrigin;
      try {
        configuredOrigin = new URL(process.env.APP_ORIGIN?.trim()).origin;
      } catch {
        configuredOrigin = undefined;
      }
      const origins = [...new Set([
        ...OFFICIAL_BROWSER_ORIGINS,
        ...(configuredOrigin?.startsWith("https://") ? [configuredOrigin] : []),
      ])];
      const current = await cos.getBucketCors(bucketParams());
      const rules = Array.isArray(current?.CORSRules) ? current.CORSRules : [];
      if (browserUploadCorsReady(rules, origins)) return { changed: false, origins };
      await cos.putBucketCors({
        ...bucketParams(),
        CORSRules: [...rules, browserUploadCorsRule(origins)],
        ResponseVary: "true",
      });
      return { changed: true, origins };
    })().catch((error) => {
      browserUploadCorsPromise = undefined;
      throw error;
    });
  }
  return browserUploadCorsPromise;
}

export function createPresignedPutUrl(key, { expires = 20 * 60, headers } = {}) {
  const cos = getClient();
  return cos.getObjectUrl({
    ...objectParams(key),
    Method: "PUT",
    Sign: true,
    Expires: expires,
    Headers: headers,
    Protocol: "https:",
  });
}

export function createPresignedDownloadUrl(key, {
  expires = 15 * 60,
  filename,
} = {}) {
  const query = filename
    ? { "response-content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` }
    : undefined;
  return getClient().getObjectUrl({
    ...objectParams(key),
    Method: "GET",
    Sign: true,
    Expires: expires,
    Query: query,
    Protocol: "https:",
  });
}

export async function headObject(key) {
  return getClient().headObject(objectParams(key));
}

export async function deleteObject(key) {
  if (!key) return;
  await getClient().deleteObject(objectParams(key));
}

export async function putObject(key, body, contentType) {
  return getClient().putObject({
    ...objectParams(key),
    Body: body,
    ContentType: contentType,
  });
}

export function sanitizeFilename(value, fallback = "file.bin") {
  const normalized = String(value || fallback)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return normalized || fallback;
}
