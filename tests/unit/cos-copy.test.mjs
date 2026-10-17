import test from "node:test";
import assert from "node:assert/strict";
import { buildCopyParams, copyObject } from "../../server/cos.js";

const config = { bucket: "unit-test-1234567890", region: "ap-chengdu" };
const sourceKey = "capability-orders/test-only/outputs/source.flac";
const targetKey = "capability-orders/test-only/published/source-etag-hash.flac";
const sourceETag = '"0123456789abcdef0123456789abcdef"';
const params = (...args) => buildCopyParams(args.length > 0 ? args[0] : sourceKey, args.length > 1 ? args[1] : targetKey,
  { sourceETag: args.length > 2 ? args[2] : sourceETag, config });
const coded = (code) => (error) => error.code === code && error.status >= 400 && /[\u3400-\u9fff]/u.test(error.message);

test("private COS copy is conditional on the exact source ETag and preserves source metadata", () => {
  assert.deepEqual(params(), {
    Bucket: config.bucket, Region: config.region, Key: targetKey,
    CopySource: `${config.bucket}.cos.${config.region}.myqcloud.com/${sourceKey}`,
    CopySourceIfMatch: sourceETag, MetadataDirective: "Copy", ACL: "private",
  });
});

test("COS copy encodes the precise source object path, including Chinese, spaces and literal percent", () => {
  const source = "capability-orders/测试/成品 100%.flac";
  const result = params(source);
  assert.equal(result.CopySource, `${config.bucket}.cos.${config.region}.myqcloud.com/capability-orders/${encodeURIComponent("测试")}/${encodeURIComponent("成品 100%.flac")}`);
  assert.equal(result.Key, targetKey);
  assert.equal(result.CopySourceIfMatch, sourceETag);
});

test("COS copy rejects URLs, local paths, traversal, control bytes and ambiguous encoded separators", () => {
  for (const key of ["", null, undefined, " https://example.invalid/file", "https://example.invalid/file", "//example.invalid/file", "/absolute", "C:\\temp\\a.flac", "a\\b", "a/../b", "a/./b", "a//b", "a/%2e%2e/b", "a/%2f/b", "a/%5c/b", "a\r\nb", "a\0b", "a/ trailing ", "a/" , "a".repeat(1025)]) {
    assert.throws(() => params(key), coded("COS_COPY_KEY_INVALID"), String(key));
    assert.throws(() => params(sourceKey, key), coded("COS_COPY_KEY_INVALID"), String(key));
  }
  assert.throws(() => params(sourceKey, sourceKey), coded("COS_COPY_KEY_INVALID"));
});

test("COS copy requires nonempty safe exact ETag, not an unguarded server-side copy", () => {
  for (const etag of ["", null, undefined, "  ", " abc ", "abc\r\nInjected: yes", "a\0b", "a\x7fb", "x".repeat(257), "中文"]) {
    assert.throws(() => params(sourceKey, targetKey, etag), coded("COS_COPY_ETAG_REQUIRED"), String(etag));
  }
  assert.equal(params(sourceKey, targetKey, "abc-2").CopySourceIfMatch, "abc-2");
});

test("COS copy uses only configured bucket/region host and rejects configuration header injection", () => {
  for (const bad of [{ bucket: "evil.example.com/path", region: "ap-chengdu" }, { bucket: config.bucket, region: "ap-chengdu\r\n" }]) {
    assert.throws(() => buildCopyParams(sourceKey, targetKey, { sourceETag, config: bad }), coded("COS_COPY_CONFIGURATION_INVALID"));
  }
});

test("invalid copy input fails before constructing SDK client or accessing any credentials", async () => {
  await assert.rejects(copyObject("https://example.invalid/file", targetKey, { sourceETag }), coded("COS_COPY_KEY_INVALID"));
  await assert.rejects(copyObject(sourceKey, targetKey), coded("COS_COPY_ETAG_REQUIRED"));
});
