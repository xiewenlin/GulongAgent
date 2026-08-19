import assert from "node:assert/strict";
import test from "node:test";
import { localizeErrorMessage } from "../../shared/error-messages.js";

test("browser and infrastructure errors are converted to Chinese", () => {
  assert.equal(localizeErrorMessage(new TypeError("Failed to fetch")), "网络连接失败，请检查网络后重试");
  assert.equal(localizeErrorMessage("only grant_type=authorization_code is supported"), "当前登录授权方式不受支持，请重新登录后再试");
  assert.equal(localizeErrorMessage("Internal Server Error"), "服务暂时不可用，请稍后重试");
  assert.equal(localizeErrorMessage("username must be 3-32 chars of [a-z0-9_.-] and not reserved"), "用户名暂不可用，请重新填写");
});

test("Chinese business messages stay intact and unknown English is never exposed", () => {
  assert.equal(localizeErrorMessage("该邮箱已经注册，请直接登录"), "该邮箱已经注册，请直接登录");
  assert.equal(localizeErrorMessage("Opaque vendor failure 938"), "请求失败，请稍后重试");
  assert.equal(/[A-Za-z]/.test(localizeErrorMessage("Opaque vendor failure 938")), false);
});

