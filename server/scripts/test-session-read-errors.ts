// transcript / trace 读不出来的时候，路由到底说什么。
//
// 这条测试盯的是一件具体的事：以前 `sessionOutputText()` 把 readFile 的**所有**异常
// 吞成空字符串，路由照样回 200。于是权限错、I/O 错、已经收口的会话 transcript 丢了，
// 在前端眼里跟「这条会话还没说话」一模一样 —— 它据此判定正文已读全，放开问答历史的
// 去重门禁，把匹配不上的记录整屏补出来（自由工作流第 2 轮审查）。
//
// 两种语义必须分开钉住：
//   ① 还在跑、还没落第一笔的会话 → 200 空正文（合法的空）
//   ② 已经收口却读不出来，或者文件在但读失败 → 5xx（前端得能看见）
//   ③ trace 缺文件**不算故障**：它是后加的功能，历史会话本来就没有（第 3 轮审查）
//
// 跑法：npm -w server run test:session-read-errors
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { requireTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-session-read-"));
process.env.ASH_DB ||= join(stage, "session-read.db");
process.env.ASH_RUNS_DIR ||= join(stage, "runs");
requireTmpDb("test-session-read-errors");

const { db, ensureSchema } = await import("../src/db/index.js");
const { sessions } = await import("../src/db/schema.js");
const { mountTaskSessionRoutes } = await import("../src/task-session-routes.js");
const { sessionTracePath, sessionTranscriptPath } = await import("../src/transcript.js");

await ensureSchema();

const taskId = "t-read";
const at = "2026-09-20T01:00:00.000Z";
const row = (id: string, endedAt: string | null) => ({
  id, taskId, role: "main", agentType: "claude", executor: "claude@local",
  status: endedAt ? "done" : "running", startedAt: at, endedAt,
});
await db.insert(sessions).values([
  row("s-running", null),      // 刚起跑，还没落第一笔
  row("s-ended", at),          // 已经收口，文件却不在
  row("s-unreadable", null),   // 文件在，读不动
] as never);

const api = new Hono();
mountTaskSessionRoutes(api);
const app = new Hono();
app.route("/api", api);
const get = async (path: string) => {
  const res = await app.fetch(new Request(`http://127.0.0.1:4317/api${path}`));
  return { status: res.status, text: await res.text() };
};

mkdirSync(join(process.env.ASH_RUNS_DIR!, taskId), { recursive: true });
let locked: string[] = [];
try {
  // ① 还没落第一笔：空正文是这条会话此刻的真相，200 就对了。
  assert.deepEqual(await get("/sessions/s-running/output"), { status: 200, text: "" }, "新会话还没写 transcript 是合法的空");
  assert.deepEqual(await get("/sessions/s-running/trace"), { status: 200, text: "[]" }, "trace 同理");

  // ② 已经收口却找不到正文：那是丢了，不能伪装成「它没说过话」。
  const ended = await get("/sessions/s-ended/output");
  assert.equal(ended.status, 500, "已收口会话的 transcript 丢了必须报出来，不能回 200 空正文");
  assert.match(ended.text, /unreadable/);

  // ②′ trace 走的是**另一条**判据：它 2026-08-01 才加（bd8ed749 / de2c9893），此前跑完的
  // 会话本来就没这个文件 —— 真实库里 992/1924 条已收口会话缺 .trace.jsonl。判成故障的话，
  // 前端 traceError 会把整页的「派生新任务」入口静默关掉（第 3 轮审查）。
  assert.deepEqual(await get("/sessions/s-ended/trace"), { status: 200, text: "[]" }, "历史会话没有 trace 是常态，不是故障");

  // ③ 文件在、读不动（权限）：跟丢了一样是故障，与会话有没有收口无关。
  for (const path of [sessionTranscriptPath(taskId, "s-unreadable"), sessionTracePath(taskId, "s-unreadable")]) {
    writeFileSync(path, "正文\n");
    chmodSync(path, 0o000);
    locked.push(path);
  }
  if (process.getuid?.() === 0) {
    console.log("以 root 跑，跳过权限那一档（root 读得动任何文件）");
  } else {
    assert.equal((await get("/sessions/s-unreadable/output")).status, 500, "读不动的 transcript 不许静默变成空");
    assert.equal((await get("/sessions/s-unreadable/trace")).status, 500, "读不动的 trace 不许静默变成空");
  }

  // ④ 会话行本身不存在仍然是 404，没被上面的分支带歪。
  assert.equal((await get("/sessions/s-nope/output")).status, 404);

  // ⑤ **文件在、内容坏了。** parseSessionTrace 对每一行都容错，所以一份整体损坏的
  // trace 以前会被解释成「这条会话什么都没干」并回 200 []：页面既看不到执行过程，
  // 也收不到任何警告，派生入口照样挂着（第 4 轮审查）。
  const good = JSON.stringify({
    at: "2026-09-20T01:00:01.000Z", turnStartedAt: at, event: { kind: "text", text: "说了一句" },
  });
  const corrupt = async (id: string, raw: string) => {
    writeFileSync(sessionTracePath(taskId, id), raw);
    return get(`/sessions/${id}/trace`);
  };
  assert.equal((await corrupt("s-ended", "not-json\n{乱码}\n")).status, 500, "整份坏掉的 trace 不许当成空 trace");
  assert.equal((await corrupt("s-ended", `${good}\nnot-json\n`)).status, 500, "写完的坏行夹在中间，同样是坏了");
  assert.equal((await corrupt("s-ended", `${good}\n{"at":1}\n`)).status, 500, "行能 JSON 解析但字段不合法，也是坏行");

  // ⑥ 末行半截是另一回事：agent 正在落那一笔。还在跑就照常给已读到的部分，
  // 收了口还残着半行才算被截断。
  const half = `${good}\n{"at":"2026-09-20T01:00:02.000Z","turnSta`;
  const running = await corrupt("s-running", half);
  assert.equal(running.status, 200, "还在跑的会话，末行写了一半不算故障");
  assert.equal(JSON.parse(running.text).length, 1, "半截那行丢掉，此前合法的条目要留住");
  assert.equal((await corrupt("s-ended", half)).status, 500, "收口之后还残着半行，说明文件断了");
  assert.deepEqual(await corrupt("s-ended", `${good}\n`), { status: 200, text: `[${good}]` }, "干净的 trace 照常读出来");

  console.log("会话正文/轨迹读取失败语义验证通过");
} finally {
  for (const path of locked) chmodSync(path, 0o600);
  rmSync(stage, { recursive: true, force: true });
}
