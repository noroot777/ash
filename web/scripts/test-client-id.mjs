import assert from "node:assert/strict";
import { createClientId } from "../src/lib/clientId.ts";

const nativeId = createClientId({
  randomUUID: () => "native-id",
  getRandomValues: () => { throw new Error("randomUUID should win"); },
});
assert.equal(nativeId, "native-id", "浏览器支持 randomUUID 时应直接使用");

const generatedId = createClientId({
  getRandomValues: (bytes) => {
    bytes.fill(0);
    return bytes;
  },
});
assert.equal(generatedId, "00000000-0000-4000-8000-000000000000", "局域网 HTTP 下应由 getRandomValues 生成 UUID");

const firstFallback = createClientId(null);
const secondFallback = createClientId(null);
assert.notEqual(firstFallback, secondFallback, "极旧环境没有 Web Crypto 时仍需生成不同的本地 ID");

console.log("client id compatibility ok");
