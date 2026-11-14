// 「看过哪些任务」跟服务端同步（lib/taskReadSync.ts）。每一段用一份新的模块实例，等于重开一次页面。
//  · 先发后到的旧 GET 回执回滚不了已经记下的新一轮（审查第 1 轮 F3）；
//  · 断网时看过、还没送到就刷新：重开后从缓存里比出来照样补送（F4）；
//  · 换了账号：上一个人的缓存不显示、不送；不带账号的老缓存只有自用模式才补送（F2）；
//  · 断网前那批旧一轮补送上去，服务端已有新一轮：以服务端为准、不再重送（F1 的前端那半）；
//  · 任务没了 / 被裁掉的不一直重送；拉失败了过一会儿自己再拉；
//  · 本机看的那几眼按账号写进缓存，服务端按它的钟回的东西不会引来来回推。
import assert from "node:assert/strict";

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
};
const cacheOf = (who) => JSON.parse(storage.get(`ash:task-reads-v2:${who || "local"}`) ?? "{}");

// 服务端：语义照 server/src/task-reads.ts —— round 只进不退、按任务此刻的轮次封顶、不存在的列进 rejected。
const server = {
  owner: "",
  byOwner: new Map(),
  tasks: new Map(),
  puts: [],
  gets: 0,
  failGets: 0,
  failPuts: false,
  hold: null,
  reads(who = server.owner) {
    if (!server.byOwner.has(who)) server.byOwner.set(who, new Map());
    return server.byOwner.get(who);
  },
};
const snapshotOf = () => ({ owner: server.owner, reads: Object.fromEntries(server.reads()) });
const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (path, init = {}) => {
  assert.equal(path, "/api/task-reads");
  if (init.method === "PUT") {
    if (server.failPuts) throw new TypeError("network down");
    const { reads } = JSON.parse(init.body);
    server.puts.push({ owner: server.owner, reads });
    const rejected = [];
    for (const [taskId, entry] of Object.entries(reads)) {
      const actual = server.tasks.get(taskId);
      if (actual === undefined) { rejected.push(taskId); continue; }
      const round = Math.min(entry.round, actual);
      const current = server.reads().get(taskId);
      if (!current || round >= current.round) server.reads().set(taskId, { event: entry.event, round });
    }
    return reply({ ...snapshotOf(), rejected });
  }
  server.gets += 1;
  if (server.failGets > 0) { server.failGets -= 1; throw new TypeError("network down"); }
  const body = snapshotOf(); // 回执按请求那一刻算
  if (server.hold) {
    const gate = server.hold;
    server.hold = null;
    await gate;
  }
  return reply(body);
};

let source = null;
globalThis.EventSource = class { constructor() { source = this; } close() {} };
const emit = (event) => source?.onmessage?.({ data: JSON.stringify(event) });
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));
let instance = 0;
async function openPage() {
  const sync = await import(`../src/lib/taskReadSync.ts?page=${instance += 1}`);
  const stop = sync.subscribeTaskReads(() => {});
  await settle(50);
  return { ...sync, stop };
}

// ── 先发后到的旧 GET 回执 ────────────────────────────────────────────────────
{
  server.tasks.set("one", 200);
  server.reads().set("one", { event: "done:old", round: 100 });
  const page = await openPage();
  assert.equal(page.getTaskReads().one.event, "done:old");
  let release;
  server.hold = new Promise((resolve) => { release = resolve; });
  emit({ type: "task.reads", ownerUserId: null }); // 这一发拿到旧的那份，回执被扣住
  await settle(20);
  server.reads().set("one", { event: "done:new", round: 200 }); // 另一台设备看了新一轮
  emit({ type: "task.reads", ownerUserId: null });
  await settle(50);
  assert.equal(page.getTaskReads().one.event, "done:new", "新的那份先到");
  release();
  await settle(50);
  assert.equal(page.getTaskReads().one.event, "done:new", "旧回执晚到也回滚不了");
  page.stop();
}

// ── 断网前那批补送上去，服务端已有新一轮 ──────────────────────────────────────────
{
  server.tasks.set("three", 500);
  server.reads().set("three", { event: "done:three-new", round: 500 });
  storage.set("ash:task-reads-v2:local", JSON.stringify({ ...cacheOf(""), three: { event: "done:three-old", round: 400 } }));
  const page = await openPage();
  await settle();
  assert.equal(page.getTaskReads().three.event, "done:three-new", "以服务端的新一轮为准");
  assert.ok(!server.puts.some((put) => put.reads.three), "旧一轮不往上送");
  page.stop();
}

// ── 任务没了 / round 被封顶 / 被裁掉：不一直重送 ──────────────────────────────────
{
  server.tasks.set("capped", 600);
  const page = await openPage();
  const before = server.puts.length;
  page.updateTaskReads((current) => ({
    ...current,
    gone: { event: "done:gone", round: 700 },
    capped: { event: "done:capped", round: 9_999 },
  }));
  await settle(1_500);
  assert.equal(server.puts.length, before + 1, `只送一次：${JSON.stringify(server.puts.slice(before))}`);
  assert.equal(page.getTaskReads().gone, undefined, "不存在的任务从副本里去掉");
  assert.equal(page.getTaskReads().capped.round, 600, "封顶以后以服务端那份为准");
  emit({ type: "task.reads", ownerUserId: null });
  await settle();
  assert.equal(server.puts.length, before + 1, "再拉一遍也不重送");
  page.stop();
}

// ── 拉失败了过一会儿自己再拉 ────────────────────────────────────────────────────
{
  const page = await openPage();
  server.reads().set("four", { event: "done:four", round: 800 });
  server.tasks.set("four", 800);
  server.failGets = 1;
  emit({ type: "task.reads", ownerUserId: null });
  await settle(200);
  assert.equal(page.getTaskReads().four, undefined, "这一发没拉到");
  await settle(5_500);
  assert.equal(page.getTaskReads().four?.event, "done:four", "过一会儿自己补拉上了");
  page.stop();
}

// ── 换了账号 / 不带账号的老缓存 ─────────────────────────────────────────────────
{
  // 甲在这个浏览器里看过 one；退出，乙登录。
  server.owner = "alice";
  const alice = await openPage();
  alice.updateTaskReads((current) => ({ ...current, five: { event: "done:five", round: 900 } }));
  server.tasks.set("five", 900);
  await settle();
  assert.equal(server.reads("alice").get("five")?.event, "done:five");
  alice.stop();
  // 不带账号的老缓存（进库之前写的），多人模式下认不出是谁的。
  storage.set("ash:task-read-state-v1", JSON.stringify({ one: { event: "done:2026-11-13T00:00:00.000Z:", readAt: 1 } }));
  server.owner = "bob";
  server.tasks.set("seven", 300);
  const bobSync = await import(`../src/lib/taskReadSync.ts?page=${instance += 1}`);
  assert.equal(bobSync.getTaskReads().five?.event, "done:five", "首屏先照上次那个账号的缓存画（只看不送）");
  bobSync.updateTaskReads((current) => ({ ...current, seven: { event: "done:seven", round: 300 } })); // 账号确认前就看了一眼
  const bob = { ...bobSync, stop: bobSync.subscribeTaskReads(() => {}) };
  await settle();
  assert.equal(bob.getTaskReads().five, undefined, "甲看过的不算乙看过");
  assert.equal(server.reads("bob").get("five"), undefined, "也不记到乙头上");
  assert.equal(server.reads("bob").get("one"), undefined, "多人模式下老缓存不补送");
  assert.equal(server.reads("bob").get("seven")?.event, "done:seven", "确认前看的那一眼记到乙名下、照送");
  assert.equal(bob.getTaskReads().seven?.event, "done:seven");
  assert.equal(server.reads("alice").get("seven"), undefined, "不记到甲头上");
  assert.equal(storage.get("ash:task-read-state-v1"), undefined, "老缓存只处理一次");
  bob.stop();

  // 自用模式：老缓存就是这个人的，补送上去（round 从 event 里的时刻还原）。
  storage.set("ash:task-read-state-v1", JSON.stringify({ six: { event: "done:2026-11-13T00:00:00.000Z:2026-11-13T00:00:01.000Z", readAt: 1 } }));
  server.tasks.set("six", Date.parse("2026-11-13T00:00:01.000Z"));
  server.owner = "";
  const single = await openPage();
  await settle();
  assert.deepEqual(server.reads("").get("six"), { event: "done:2026-11-13T00:00:00.000Z:2026-11-13T00:00:01.000Z", round: Date.parse("2026-11-13T00:00:01.000Z") });
  single.stop();
}

// ── 断网时看过、还没送到就刷新（放在最后：旧页面的重试定时器还活着，别搅了前面几段的计数） ─────────
{
  server.owner = "";
  server.tasks.set("two", 300);
  server.reads("").set("two", { event: "done:two-old", round: 100 });
  const page = await openPage();
  server.failPuts = true;
  page.updateTaskReads((current) => ({ ...current, two: { event: "done:two-new", round: 300 } }));
  assert.equal(cacheOf("").two.event, "done:two-new", "看过的那一眼先落缓存");
  await settle();
  assert.equal(server.reads("").get("two").event, "done:two-old", "断网，没送上去");
  page.stop();
  server.failPuts = false;
  const reopened = await openPage(); // 刷新：内存里的东西全没了，只剩缓存
  await settle();
  assert.equal(server.reads("").get("two").event, "done:two-new", "重开以后从缓存里比出来、补送上去了");
  assert.equal(reopened.getTaskReads().two.event, "done:two-new", "也没被服务端的旧值盖回去");
  reopened.stop();
}

console.log("test-task-read-sync: all assertions passed");
