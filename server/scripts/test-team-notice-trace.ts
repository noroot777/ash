// 常驻调度台**自发开的那一轮**里,上游重试提示归谁。
//
// 起因(2026-10-21 第 1 轮审查 F1)。这些提示从前走 `kind:"system"` 旁注,而旁注是回合收口
// 之后才补落盘的,于是整串糊在会话结尾;改成走 trace 之后它们排在发生的那一步下面 —— 但
// 团队这条链上还差一道:补开回合的判据(「这是不是这一轮的产出」)把提示排除了,trace 的
// 写入口却照收。结果是**同一轮里每条提示各拿一个 now() 当回合起点**,刷新重建时它们认不回
// 真正那一轮,被重建成正文下面一颗空回复 —— 正是用户最初要治的那个位置。
//
// 所以判据只能架在落盘的 trace 上:自发那一轮的提示、恢复后的正文、后面的工具调用,必须
// 共用**同一个** turnStartedAt,而且不能是上一轮那个。
//
// 跑:npm -w server run test:team-resilience(串在最后)
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  root, db, dbClient, ensureSchema, projects, at, ok, runLead,
} from "./team-lead-resilience-fixture.js";

const RETRY_1 = "上游返回 504 server_error，正在重试（第 1/10 次，等 0.5 秒）";
const RETRY_2 = "上游返回 502 server_error，正在重试（第 2/10 次，等 1.1 秒）";
const WAITING = "已经等上游 5 分钟没有响应，本回合仍在等待中";
const pause = () => new Promise((done) => setTimeout(done, 4));

try {
  await ensureSchema();
  await db.insert(projects).values({ id: "project", name: "team-notice-trace", repoPath: root, createdAt: at });

  const run = await runLead("self-turn-notices", {
    cliSessionId: "thread-notice",
    script: async function* () {
      yield { kind: "text", text: "第一轮:活我干完了,后台监控还挂着。" };
      yield { kind: "turnEnd" }; // 回合收口 → 待命,turnStart 清空
      // 哨兵叫醒了 CLI,它自发开新一轮。第一条输出就是上游在重试 —— 请求已经在飞了。
      // 每条之间隔几毫秒:坏掉的那版给每条提示各取一次 now(),同毫秒里取到的是同一个
      // 字符串,「散成了几个起点」那条断言就会撞巧蒙过去。
      await pause();
      yield { kind: "error", message: RETRY_1, level: "notice", affectsTurn: false };
      await pause();
      yield { kind: "error", message: WAITING, level: "notice", affectsTurn: false };
      await pause();
      yield { kind: "error", message: RETRY_2, level: "notice", affectsTurn: false };
      await pause();
      yield { kind: "text", text: "上游恢复了,接着说。" };
      await pause();
      yield { kind: "tool", name: "Bash", detail: JSON.stringify({ command: "npm test" }) };
      yield { kind: "turnEnd" };
      yield { kind: "done", exitStatus: 0 };
    },
  });

  const entries = run.trace.split("\n").filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { turnStartedAt: string; event: { kind: string; message?: string; level?: string } });

  // 第一轮那条正文的起点是 fixture 开台时那个 `at`;自发那一轮的起点由 beginTurn 现取。
  const firstTurn = entries.filter((entry) => entry.turnStartedAt === at);
  assert.ok(firstTurn.length >= 1, "第一轮的正文没落 trace,这份用例的前提就不成立");

  const selfTurn = entries.filter((entry) => entry.turnStartedAt !== at);
  const starts = [...new Set(selfTurn.map((entry) => entry.turnStartedAt))];
  assert.deepEqual(
    starts.length,
    1,
    `自发那一轮的 trace 散成了多个回合起点 —— 提示会被重建成正文下面一颗空回复（F1）,实际:${JSON.stringify(starts)}`,
  );
  assert.deepEqual(
    selfTurn.map((entry) => `${entry.event.kind}:${entry.event.level ?? ""}`),
    // 头一条 run 是 beginTurn 自己落的那笔执行器参数(model / effort),它天生拿着正确的起点。
    ["run:", "error:notice", "error:notice", "error:notice", "text:", "tool:"],
    `自发那一轮的 trace 不是「三条提示 → 正文 → 工具」,实际:${JSON.stringify(selfTurn.map((e) => e.event))}`,
  );
  ok("自发回合里的提示与它之后的正文/工具共用同一个回合起点");

  // 提示仍然只走 trace:一次重试成功的回合,.md 里一个字都不该多出来（这是用户最初的诉求）。
  assert.ok(!run.md.includes(RETRY_1), "重试提示又回到了 .md —— 刷新后它会堆在会话结尾");
  assert.ok(!run.md.includes(WAITING), "等待心跳又回到了 .md");
  assert.ok(!run.md.includes("执行诊断"), "一次可恢复的重试把这一轮画上了红色诊断块");
  assert.equal((await run.task()).status, "idle", "重试提示把一次健康回合的收尾判坏了");
  ok("提示只走 trace:.md 不多一个字,回合照常落待命");

  console.log("test:team-notice-trace ok");
} finally {
  try {
    dbClient.close();
  } catch { /* 已经关了 */ }
  rmSync(root, { recursive: true, force: true });
}
