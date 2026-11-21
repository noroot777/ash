import assert from "node:assert/strict";
import { readPublicFeed } from "../desktop/macos/scripts/public-feed.mjs";

const calls = [];
const waits = [];
let responses = [];
const options = {
  async fetchImpl(url, request) {
    calls.push({ url, request });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, "unexpected extra feed request");
    return response;
  },
  async sleep(milliseconds) { waits.push(milliseconds); },
};
const read = () => readPublicFeed("o/feed", "navi/mac/app cast.xml", "release/test", options);

responses = [new Response("<rss>published feed</rss>")];
assert.deepEqual(await read(), { text: "<rss>published feed</rss>" });
assert.equal(calls[0].url, "https://raw.githubusercontent.com/o/feed/release%2Ftest/navi/mac/app%20cast.xml");
assert.equal(calls[0].request.cache, "no-store");
assert.equal(calls[0].request.headers, undefined, "no release or workflow credential is sent to raw content");
assert.ok(calls[0].request.signal instanceof AbortSignal);

responses = [new Response("not found", { status: 404 })];
assert.equal(await read(), null, "a not-yet-published Intel feed is absent, not a network error");
responses = [new Response("forbidden", { status: 403 })];
await assert.rejects(read(), /HTTP 403/);
assert.equal(responses.length, 0);

responses = [new Response("limited", { status: 429, headers: { "retry-after": "120" } }),
  new Response("busy", { status: 503 }), new Response("<rss>recovered</rss>")];
assert.equal((await read()).text, "<rss>recovered</rss>");
assert.deepEqual(waits, [10_000, 2000], "transient retries are bounded even for a long Retry-After");
waits.length = 0;
responses = [new TypeError("network unavailable"), new Response("ok")];
assert.equal((await read()).text, "ok");
assert.deepEqual(waits, [1000]);

responses = Array.from({ length: 3 }, () => new Response("still limited", { status: 429 }));
await assert.rejects(read(), /HTTP 429/);
assert.equal(responses.length, 0, "persistent rate limits fail after three requests, not an endless wait");
responses = Array.from({ length: 3 }, () => new TypeError("network unavailable"));
await assert.rejects(read(), /读取公开更新源失败.*network unavailable/);
assert.equal(responses.length, 0);
console.log("PASS: raw feed URL encoding, credential isolation, no-cache reads, missing feeds, bounded transient retries and fail-closed errors");
