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

  // ② 已经收口却找不到文件：那是丢了，不能伪装成「它没说过话」。
  const ended = await get("/sessions/s-ended/output");
  assert.equal(ended.status, 500, "已收口会话的 transcript 丢了必须报出来，不能回 200 空正文");
  assert.match(ended.text, /unreadable/);
  assert.equal((await get("/sessions/s-ended/trace")).status, 500, "trace 丢了同样要报");

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

  console.log("会话正文/轨迹读取失败语义验证通过");
} finally {
  for (const path of locked) chmodSync(path, 0o600);
  rmSync(stage, { recursive: true, force: true });
}
