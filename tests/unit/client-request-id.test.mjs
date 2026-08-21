import assert from "node:assert/strict";
import test from "node:test";
import { createClientRequestId } from "../../src/api.js";

test("client request IDs work when HTTP browsers do not expose crypto.randomUUID", () => {
  let cursor = 0;
  const cryptoWithoutRandomUuid = {
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = (cursor + index) & 0xff;
      cursor += bytes.length;
      return bytes;
    },
  };
  const first = createClientRequestId(cryptoWithoutRandomUuid);
  const second = createClientRequestId(cryptoWithoutRandomUuid);
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(first, second);
});

test("client request IDs prefer the browser native UUID implementation", () => {
  assert.equal(createClientRequestId({ randomUUID: () => "native-secure-uuid" }), "native-secure-uuid");
});
