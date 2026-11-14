// 「看过哪些任务」跟服务端同步（lib/taskReadSync.ts）：
//  · 本机 localStorage 里的老记录第一次连上时补送上去（不然换成服务端那份的第一天，桌面上也要满屏亮一遍）；
//  · 服务端已有的以它为准，不把本机的老记录再推回去（哪怕本机记的时刻更晚：那是这台设备自己的钟）；
//  · 服务端按它的钟改写了「看的时刻」之后，不能来回推个没完；
//  · 别的设备看了一眼（task.reads），本页跟着熄。
import assert from "node:assert/strict";

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
};
const STORAGE_KEY = "ash:task-read-state-v1";
storage.set(STORAGE_KEY, JSON.stringify({
  legacy: { event: "done:legacy", readAt: 100 },
  stale: { event: "done:1", readAt: Date.now() },
}));

// 服务端：语义照 server/src/task-reads.ts —— 后到的算数，看的时刻按它自己的钟记（这里比本页慢一小时）。
const serverClockLag = 3_600_000;
const server = new Map([["stale", { event: "done:2", readAt: 500 }]]);
const puts = [];
const serverReads = () => Object.fromEntries(server);
globalThis.fetch = async (path, init = {}) => {
  assert.equal(path, "/api/task-reads");
  if (init.method === "PUT") {
    const { reads } = JSON.parse(init.body);
    puts.push(reads);
    for (const [taskId, entry] of Object.entries(reads)) server.set(taskId, { event: entry.event, readAt: Date.now() - serverClockLag });
    queueMicrotask(() => emit({ type: "task.reads", ownerUserId: null }));
  }
  return new Response(JSON.stringify({ reads: serverReads() }), { status: 200, headers: { "content-type": "application/json" } });
};

let source = null;
globalThis.EventSource = class {
  constructor() { source = this; }
  close() {}
};
const emit = (event) => source?.onmessage?.({ data: JSON.stringify(event) });
const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms));

const { getTaskReads, subscribeTaskReads, updateTaskReads } = await import("../src/lib/taskReadSync.ts");

assert.equal(getTaskReads().legacy?.event, "done:legacy", "服务端那份回来之前先照本机缓存画");
let notified = 0;
const stop = subscribeTaskReads(() => { notified += 1; });
await settle();

assert.ok(server.get("legacy"), "本机的老记录补送上去了");
assert.equal(server.get("stale").event, "done:2", "服务端更新的那份没被本机的老记录盖掉");
assert.equal(getTaskReads().stale.event, "done:2", "本页换成服务端那份");
assert.ok(!puts.some((batch) => batch.stale), "比服务端旧的那条不往上推");
assert.ok(notified > 0, "副本变了要通知画面");

// 本页看了一眼：攒一下送上去；服务端按它的钟改写了时刻，再拉回来不能又推一遍。
const before = puts.length;
updateTaskReads((current) => ({ ...current, fresh: { event: "done:fresh", readAt: Date.now() } }));
assert.equal(getTaskReads().fresh.event, "done:fresh", "本页立刻熄，不等服务端");
await settle(1_500);
assert.equal(server.get("fresh")?.event, "done:fresh");
assert.equal(puts.length, before + 1, `只送一次，不来回推：${JSON.stringify(puts.slice(before))}`);
assert.equal(JSON.parse(storage.get(STORAGE_KEY)).fresh?.event, "done:fresh", "缓存跟着写");

// 什么都没变的更新不发请求。
updateTaskReads((current) => ({ ...current }));
await settle();
assert.equal(puts.length, before + 1, "没变就不送");

// 另一台设备看了一眼。
server.set("elsewhere", { event: "done:9", readAt: Date.now() - serverClockLag });
emit({ type: "task.reads", ownerUserId: null });
await settle(100);
assert.equal(getTaskReads().elsewhere?.event, "done:9", "别的设备看过的，本页跟着熄");

stop();
console.log("test-task-read-sync: all assertions passed");
