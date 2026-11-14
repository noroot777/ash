// 「看过哪些任务」跟服务端同步（lib/taskReadSync.ts）。每个模块实例算一个标签页，共用同一份 localStorage。
//  · 先发后到的旧回执（rev 小）整份不认（审查第 1 轮 F3）；
//  · 页面活着时另一个标签页换了人登录：攒着的记录送上去服务端 409、一条没记到新人头上，这一页整页重载；
//    回执里的账号对不上也一样（审查第 2 轮 F1）；
//  · 记录服务端还没拉回来时就看了一眼、随即刷新：那一眼当场落盘，重开以后照送（审查第 2 轮 F2）；
//  · 两个标签页各看各的、都没送出去：落盘不互相盖掉，任一页都能补送（同上）；
//  · 满额之后看一个很老的任务：留得住，不当场被裁掉（审查第 2 轮 F3）；
//  · 服务端已有新一轮 / 封顶 / 不存在：以服务端为准，不一直重送；拉失败了过一会儿自己再拉；
//  · 不带账号的老缓存：自用模式补送，多人模式丢掉，都只处理一次。
import assert from "node:assert/strict";

const storage = new Map();
const windowListeners = new Set();
let reloads = 0;
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, String(value));
      for (const listener of windowListeners) listener({ key, newValue: String(value) });
    },
    removeItem: (key) => storage.delete(key),
  },
  addEventListener: (type, listener) => { if (type === "storage") windowListeners.add(listener); },
  removeEventListener: (type, listener) => { if (type === "storage") windowListeners.delete(listener); },
  location: { reload: () => { reloads += 1; } },
};
const pendingOf = (who) => JSON.parse(storage.get(`ash:task-reads-v3:${who || "local"}:pending`) ?? "{}");
const MAX = 500;

// 服务端：语义照 server/src/task-reads.ts —— 账号对不上 409；round 只进不退、按任务轮次封顶；不存在的列进
// rejected；每写一次 rev 加一；满额按最近看到裁。
let clock = 0;
const server = {
  cookie: "", // 这个浏览器此刻登录的是谁
  owners: new Map(),
  tasks: new Map(),
  puts: [],
  failGets: 0,
  failPuts: false,
  hold: null,
  of(who = server.cookie) {
    if (!server.owners.has(who)) server.owners.set(who, { rev: 0, reads: new Map() });
    return server.owners.get(who);
  },
};
const snapshotOf = (who = server.cookie) => {
  const { rev, reads } = server.of(who);
  return { owner: who, rev, reads: Object.fromEntries([...reads].map(([id, { event, round }]) => [id, { event, round }])) };
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (path, init = {}) => {
  assert.equal(path, "/api/task-reads");
  if (init.method === "PUT") {
    if (server.failPuts) throw new TypeError("network down");
    const body = JSON.parse(init.body);
    if (body.owner !== server.cookie) return reply({ error: "账号对不上", owner: server.cookie }, 409);
    server.puts.push({ owner: server.cookie, reads: body.reads });
    const mine = server.of();
    const rejected = [];
    for (const [taskId, entry] of Object.entries(body.reads)) {
      const actual = server.tasks.get(taskId);
      if (actual === undefined) { rejected.push(taskId); continue; }
      const round = Math.min(entry.round, actual);
      const current = mine.reads.get(taskId);
      if (!current || round >= current.round) mine.reads.set(taskId, { event: entry.event, round, readAt: clock += 1 });
    }
    const kept = [...mine.reads].sort((a, b) => b[1].readAt - a[1].readAt).slice(0, MAX);
    mine.reads = new Map(kept);
    mine.rev += 1;
    return reply({ ...snapshotOf(), rejected });
  }
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
const putsFor = (taskId) => server.puts.filter((put) => put.reads[taskId]).length;
let instance = 0;
/** 开一个标签页：登录关口确认是 who（AuthGate），然后侧栏开始订阅。 */
async function openPage(who = server.cookie, { wait = 50 } = {}) {
  const sync = await import(`../src/lib/taskReadSync.ts?page=${instance += 1}`);
  sync.bindTaskReadsOwner(who);
  const stop = sync.subscribeTaskReads(() => {});
  await settle(wait);
  return { ...sync, stop };
}
const look = (page, taskId, round) => page.updateTaskReads((current) => ({ ...current, [taskId]: { event: `done:${taskId}:${round}`, round } }));

// ── 先发后到的旧回执 ────────────────────────────────────────────────────────
{
  server.tasks.set("one", 200);
  server.of("").reads.set("one", { event: "done:old", round: 100, readAt: clock += 1 });
  const page = await openPage("");
  assert.equal(page.getTaskReads().one.event, "done:old");
  let release;
  server.hold = new Promise((resolve) => { release = resolve; });
  emit({ type: "task.reads", ownerUserId: null }); // 这一发拿到旧的那份，回执被扣住
  await settle(20);
  server.of("").reads.set("one", { event: "done:new", round: 200, readAt: clock += 1 }); // 另一台设备看了新一轮
  server.of("").rev += 1;
  emit({ type: "task.reads", ownerUserId: null });
  await settle(50);
  assert.equal(page.getTaskReads().one.event, "done:new", "新的那份先到");
  release();
  await settle(50);
  assert.equal(page.getTaskReads().one.event, "done:new", "旧回执晚到也回滚不了");
  page.stop();
}

// ── 服务端已有新一轮 / 封顶 / 不存在：不一直重送 ───────────────────────────────────
{
  server.tasks.set("capped", 600);
  server.tasks.set("three", 500);
  server.of("").reads.set("three", { event: "done:three-new", round: 500, readAt: clock += 1 });
  server.of("").rev += 1;
  const page = await openPage("");
  look(page, "three", 400); // 停在旧数据上的页面看了旧一轮
  look(page, "gone", 700);
  look(page, "capped", 9_999);
  await settle(1_500);
  assert.equal(putsFor("three"), 0, "旧一轮不往上送");
  assert.equal(page.getTaskReads().three.event, "done:three-new", "以服务端的新一轮为准");
  assert.equal(putsFor("gone"), 1, "不存在的只送一次");
  assert.equal(page.getTaskReads().gone, undefined, "不存在的任务从这一页去掉");
  assert.equal(page.getTaskReads().capped.round, 600, "封顶以后以服务端那份为准");
  emit({ type: "task.reads", ownerUserId: null });
  await settle();
  assert.equal(putsFor("capped") + putsFor("gone"), 2, "再拉一遍也不重送");
  assert.deepEqual(pendingOf(""), {}, "都表过态了，待送的清空");
  page.stop();
}

// ── 拉失败了过一会儿自己再拉 ────────────────────────────────────────────────────
{
  const page = await openPage("");
  server.of("").reads.set("four", { event: "done:four", round: 800, readAt: clock += 1 });
  server.of("").rev += 1;
  server.failGets = 1;
  emit({ type: "task.reads", ownerUserId: null });
  await settle(200);
  assert.equal(page.getTaskReads().four, undefined, "这一发没拉到");
  await settle(5_500);
  assert.equal(page.getTaskReads().four?.event, "done:four", "过一会儿自己补拉上了");
  page.stop();
}

// ── 满额之后看一个很老的任务 ──────────────────────────────────────────────────────
{
  for (let i = 0; i < MAX; i += 1) {
    server.tasks.set(`m${i}`, 10_000 + i);
    server.of("").reads.set(`m${i}`, { event: `done:m${i}`, round: 10_000 + i, readAt: clock += 1 });
  }
  server.of("").rev += 1;
  server.tasks.set("ancient", 1);
  const page = await openPage("");
  look(page, "ancient", 1);
  assert.ok(page.getTaskReads().ancient, "看过当场就熄，不被裁掉");
  await settle();
  assert.ok(server.of("").reads.get("ancient"), "送上去也留得住");
  assert.ok(page.getTaskReads().ancient, "拉回来还在");
  page.stop();
}

// ── 记录还没拉回来就看了一眼、随即刷新 ──────────────────────────────────────────────
{
  server.tasks.set("early", 900);
  let release;
  server.hold = new Promise((resolve) => { release = resolve; });
  const page = await openPage("", { wait: 20 }); // GET 卡着
  look(page, "early", 900);
  assert.equal(pendingOf("").early?.round, 900, "那一眼当场落盘，不等服务端");
  page.stop();
  server.failPuts = true; // 它没来得及送就被关掉了
  await settle();
  release();
  server.failPuts = false;
  const reopened = await openPage("");
  await settle();
  assert.equal(server.of("").reads.get("early")?.round, 900, "重开以后照送");
  assert.ok(reopened.getTaskReads().early, "也没被服务端的旧值盖回去");
  reopened.stop();
}

// ── 两个标签页各看各的、都没送出去 ────────────────────────────────────────────────
{
  server.tasks.set("tab-a", 1_000);
  server.tasks.set("tab-b", 1_000);
  server.failPuts = true;
  const a = await openPage("");
  const b = await openPage("");
  look(a, "tab-a", 1_000);
  look(b, "tab-b", 1_000);
  assert.ok(pendingOf("")["tab-a"] && pendingOf("")["tab-b"], "落盘不互相盖掉");
  assert.ok(a.getTaskReads()["tab-b"], "另一页看的这一页也跟着熄");
  a.stop();
  b.stop();
  server.failPuts = false;
  const c = await openPage("");
  await settle();
  assert.ok(server.of("").reads.get("tab-a") && server.of("").reads.get("tab-b"), "哪一页重开都能把两边的都补送上去");
  c.stop();
  await settle(5_500); // 等 a、b 的失败重试都过去，别搅了下面几段
}

// ── 页面活着时另一个标签页换了人登录 ────────────────────────────────────────────────
{
  server.cookie = "alice";
  server.tasks.set("alice-task", 1_100);
  const page = await openPage("alice");
  server.failPuts = true;
  look(page, "alice-task", 1_100); // 断网时 alice 看了一眼
  await settle();
  server.cookie = "bob"; // 另一个标签页退出 alice、登录 bob
  server.failPuts = false;
  const reloadsBefore = reloads;
  await settle(5_500); // 生产重试把那一批送上去
  assert.equal(server.of("bob").reads.get("alice-task"), undefined, "alice 看的没记到 bob 头上");
  assert.equal(reloads, reloadsBefore + 1, "这一页整页重载");
  assert.equal(pendingOf("alice")["alice-task"]?.round, 1_100, "那一眼留在 alice 名下，她回来照送");
  page.stop();

  // 回执里的账号对不上也一样（GET 先发现的）。
  server.cookie = "alice";
  const other = await openPage("alice");
  server.cookie = "bob";
  emit({ type: "task.reads", ownerUserId: "alice" });
  await settle(100);
  assert.equal(reloads, reloadsBefore + 2, "GET 回执说现在是 bob：整页重载");
  other.stop();

  // alice 回来登录：留着的那一眼送上去。
  server.cookie = "alice";
  const back = await openPage("alice");
  await settle();
  assert.equal(server.of("alice").reads.get("alice-task")?.round, 1_100);
  back.stop();
}

// ── 不带账号的老缓存 ─────────────────────────────────────────────────────────────
{
  storage.set("ash:task-read-state-v1", JSON.stringify({ "alice-task": { event: "done:2026-11-13T00:00:00.000Z:", readAt: 1 } }));
  server.cookie = "bob";
  const bob = await openPage("bob");
  await settle();
  assert.equal(server.of("bob").reads.get("alice-task"), undefined, "多人模式下认不出是谁的：不送");
  assert.equal(storage.get("ash:task-read-state-v1"), undefined, "只处理一次");
  bob.stop();

  const at = "2026-11-13T00:00:01.000Z";
  storage.set("ash:task-read-state-v1", JSON.stringify({ six: { event: `done:2026-11-13T00:00:00.000Z:${at}`, readAt: 1 } }));
  server.tasks.set("six", Date.parse(at));
  server.cookie = "";
  const single = await openPage("");
  await settle();
  assert.equal(server.of("").reads.get("six")?.round, Date.parse(at), "自用模式：补送上去（round 从 event 里的时刻还原）");
  single.stop();
}

console.log("test-task-read-sync: all assertions passed");
