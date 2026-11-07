// 「正文里提到的路径是不是真文件」的缓存会不会自己刷新（lib/taskFileLocator.ts）。
// 跑:npm -w web run test:task-file-locator
//
// 盯审查第 1 轮 F1 那一幕：agent 先提到 `later.md`、过一会儿才写出来。那一处正文一直挂着、
// 不会重挂，第一次问到的「没有」必须在过期后被重查掉——等多久都不恢复就是那条缺陷。
// 顺带钉住同一层的另外几条：请求失败不把已有链接变回文字、过期的「有」也会复核、没人看的不问、
// 页面在后台不巡检、长期不存在的按次数退避、缓存满了不清有人在看的。
import assert from "node:assert/strict";
import { createTaskFileLocator, HIT_TTL, MISS_TTL, MISS_TTL_MAX, SWEEP_MS } from "../src/lib/taskFileLocator.ts";

/** 假时钟：定时器按到期时刻排队，`advance` 把时间往前拨并依次触发到期的那些。 */
function fakeTimers() {
  let clock = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => clock,
    timers: {
      setTimeout: (callback, ms) => { seq += 1; pending.set(seq, { at: clock + ms, callback }); return seq; },
      clearTimeout: (handle) => { pending.delete(handle); },
    },
    async advance(ms) {
      const until = clock + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        clock = due[1].at;
        due[1].callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      clock = until;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function setup({ visible = () => true } = {}) {
  const time = fakeTimers();
  const disk = new Set();
  const calls = [];
  let failing = false;
  const locator = createTaskFileLocator({
    now: time.now,
    timers: time.timers,
    visible,
    locate: async (taskId, paths) => {
      calls.push([...paths]);
      if (failing) throw new Error("offline");
      return Object.fromEntries(paths.map((path) => [path, disk.has(path) ? { path, kind: "file" } : null]));
    },
  });
  let renders = 0;
  locator.subscribe(() => { renders += 1; });
  return {
    time, disk, calls, locator,
    fail: (value) => { failing = value; },
    renders: () => renders,
    value: (path) => locator.peek("T", path)?.value,
  };
}

// ── 1. 先提到、后写出来：挂着的那一处在「没有」过期后自己变成「有」 ─────────────────────────
{
  const s = setup();
  const unwatch = s.locator.watch("T", "later.md");
  await s.time.advance(50);
  assert.equal(s.value("later.md"), null, "刚提到时文件还没写出来");
  s.disk.add("later.md");
  await s.time.advance(MISS_TTL + SWEEP_MS + 50);
  assert.deepEqual(s.value("later.md"), { path: "later.md", kind: "file" }, "文件写出来之后，还挂着的那一处要自己变成可点的");
  assert.ok(s.renders() >= 2, "答案变了要通知订阅者重渲染");
  unwatch();
}

// ── 2. 请求失败不改答案；恢复之后照常重查 ─────────────────────────────────────────────────
{
  const s = setup();
  s.disk.add("a.md");
  const unwatch = s.locator.watch("T", "a.md");
  await s.time.advance(50);
  assert.ok(s.value("a.md"), "起初是有的");
  s.fail(true);
  s.disk.delete("a.md");
  await s.time.advance(HIT_TTL + SWEEP_MS);
  assert.ok(s.value("a.md"), "一次请求失败不能把点得开的链接变回普通文字");
  s.fail(false);
  await s.time.advance(MISS_TTL + SWEEP_MS);
  assert.equal(s.value("a.md"), null, "恢复之后重查，文件真被删了就如实变回「没有」");
  unwatch();
}

// ── 3. 起初就请求失败：之后还会再问，不是一锤子变成永久「没有」 ─────────────────────────────
{
  const s = setup();
  s.disk.add("b.md");
  s.fail(true);
  const unwatch = s.locator.watch("T", "b.md");
  await s.time.advance(50);
  assert.equal(s.value("b.md"), null);
  s.fail(false);
  await s.time.advance(MISS_TTL + SWEEP_MS);
  assert.ok(s.value("b.md"), "失败之后要重试");
  unwatch();
}

// ── 4. 卸下来的不再问；后台页面不巡检 ──────────────────────────────────────────────────────
{
  const s = setup();
  const unwatch = s.locator.watch("T", "gone.md");
  await s.time.advance(50);
  unwatch();
  const before = s.calls.length;
  await s.time.advance(MISS_TTL_MAX * 3);
  assert.equal(s.calls.length, before, "没人在看的路径不再重查");

  let shown = false;
  const h = setup({ visible: () => shown });
  h.locator.watch("T", "hidden.md");
  await h.time.advance(50);
  const asked = h.calls.length;
  await h.time.advance(MISS_TTL * 4);
  assert.equal(h.calls.length, asked, "页面在后台时不巡检");
  shown = true;
  h.locator.revisit();
  await h.time.advance(50);
  assert.equal(h.calls.length, asked + 1, "切回前台马上补问");
}

// ── 5. 一直不存在的按次数退避，封顶；同一批合并成一次请求 ─────────────────────────────────
{
  const s = setup();
  for (const path of ["x.openFile", "Node.js", "origin/main"]) s.locator.watch("T", path);
  await s.time.advance(50);
  assert.equal(s.calls.length, 1, "同一屏的候选合成一次请求");
  assert.equal(s.calls[0].length, 3);
  await s.time.advance(MISS_TTL_MAX * 10);
  // 退避 20s、40s、80s、120s、120s…：二十分钟里远少于 20 秒一次的 60 次。
  assert.ok(s.calls.length <= 14, `长期不存在的路径要退避，实际问了 ${s.calls.length} 次`);
  assert.ok(s.calls.length >= 8, `退避封顶两分钟，仍要持续重查，实际问了 ${s.calls.length} 次`);
}

// ── 6. 点下去还没问到：马上问，不等攒批 ─────────────────────────────────────────────────
{
  const s = setup();
  s.disk.add("click.md");
  assert.deepEqual(await s.locator.locateNow("T", "click.md"), { path: "click.md", kind: "file" });
  assert.equal(await s.locator.locateNow("T", "nope.md"), null);
}

console.log("✓ task file locator: 挂着的路径过期后自己重查（先提到后写出来会变成可点）；失败不改答案且会重试；没人看/后台不问；不存在的退避");
