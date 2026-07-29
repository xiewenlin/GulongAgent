import COS from "cos-nodejs-sdk-v5";
import { ConfigurationError } from "./db.js";

const DEFAULT_BUCKET = "gulong-1259744534";
const DEFAULT_REGION = "ap-chengdu";
const DEFAULT_DOMAIN = "gulong-1259744534.cos.ap-chengdu.myqcloud.com";

let client;

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

export function createPresignedPutUrl(key, { expires = 20 * 60 } = {}) {
  const cos = getClient();
  return cos.getObjectUrl({
    ...objectParams(key),
    Method: "PUT",
    Sign: true,
    Expires: expires,
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

