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
  root, db, dbClient, ensureSchema, projects, sessions, eq, at, ok, runLead,
  haltTeam, seedTeamTask, startLead, teamIsLive,
} from "./team-lead-resilience-fixture.js";
import { failedTurnNotices, sessionWaiting } from "../src/session-waiting.js";
import { readRecentTraceEntries } from "../src/transcript.js";

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

  // ── 答完待命的那一台,手机上不该还挂着「正在重试」(第 3 轮审查 F1) ──────────────
  // 常驻调度台每一轮健康收尾都会写 endedAt,而进程还在跑,exitStatus 合法地仍是 null。
  // 上一版把「endedAt 有值且退出码不是 0」当成失败现场,于是这台一转待命,整轮的重试提示
  // 就在手机回答下面重新挂出来 —— 而且不是闪一帧,会一直留到进程退出或下一轮开始。
  const idleSess = "sess-idle-notice";
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await runLead("idle-notice", {
    cliSessionId: "thread-idle-notice",
    script: async function* () {
      yield { kind: "tool", name: "Bash", detail: JSON.stringify({ command: "npm test" }) };
      await pause();
      yield { kind: "error", message: RETRY_1, level: "notice", affectsTurn: false };
      await pause();
      yield { kind: "text", text: "上游已经恢复,正在继续回答。" };
      yield { kind: "turnEnd" };
      await gate; // 回合收口了、进程还活着 —— 这就是 F1 的现场
      yield { kind: "done", exitStatus: 0 };
    },
    whileLive: async () => {
      const deadline = Date.now() + 10_000;
      let row: Awaited<ReturnType<typeof readIdle>> = undefined;
      const readIdle = async () => (await db.select().from(sessions).where(eq(sessions.id, idleSess))).at(0);
      while (Date.now() < deadline) {
        row = await readIdle();
        if (row?.endedAt) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      try {
        assert.ok(row?.endedAt, "这一轮没能收口,这份用例的前提不成立");
        assert.equal(row.exitStatus, null, "要的就是「回合收口了、进程还在跑」那一刻");
        assert.deepEqual(
          sessionWaiting(idleSess, row.turnStartedAt),
          [],
          "恢复正文和回合收口都没能把内存里那条等待状态撤掉",
        );
        assert.deepEqual(
          failedTurnNotices(await readRecentTraceEntries(row.taskId, idleSess), row),
          [],
          "一台答完待命的调度台被当成失败现场,整轮提示在手机上重新挂了出来(F1)",
        );
      } finally {
        release?.();
      }
    },
  });
  ok("健康待命的调度台:等待状态已撤,失败现场也不回放");

  const until = async (what: string, cond: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), `等不到:${what}`);
  };

  // ── 点了「停止全组」之后,悬着的提示不是失败现场(第 4 轮审查 F1) ───────────────
  // 受控停止与「进程自己崩了」在退出码上一模一样(CLI 吃 SIGTERM 后按 signal 写非零),所以
  // 「这一轮是怎么结束的」必须自己落一列。单飞早就为此落了 stoppedAs(single-run.ts),团队这
  // 条收尾路从前只写退出码 —— 用户按下停止,还悬着的那几条提示就被当成失败现场重新挂回手机上。
  const haltSess = "sess-halt-notice";
  let releaseHalt: (() => void) | null = null;
  const haltGate = new Promise<void>((resolve) => { releaseHalt = resolve; });
  const halted = await runLead("halt-notice", {
    cliSessionId: "thread-halt-notice",
    script: async function* () {
      yield { kind: "tool", name: "Bash", detail: JSON.stringify({ command: "npm test" }) };
      await pause();
      yield { kind: "error", message: RETRY_1, level: "notice", affectsTurn: false };
      await haltGate; // 用户这会儿点了「停止全组」:请求还在飞,这条提示就这么悬着
      yield { kind: "done", exitStatus: 1 }; // CLI 吃 SIGTERM:非零退出码,跟崩溃一模一样
    },
    whileLive: async (taskId) => {
      try {
        await until("提示进消费链", () => sessionWaiting(haltSess).length === 1);
        await haltTeam(taskId);
      } finally {
        releaseHalt?.();
      }
    },
  });
  const haltRow = await halted.session();
  assert.equal(haltRow.exitStatus, 1, "这份用例要的就是「被停之后留下非零退出码」那一刻");
  assert.ok(haltRow.stoppedAs, "团队收尾只写了退出码,没把「这一轮是被停的」落进会话行(F1)");
  assert.deepEqual(
    failedTurnNotices(await readRecentTraceEntries(haltRow.taskId, haltSess), haltRow),
    [],
    "点了停止全组,悬着的提示被当成失败现场回放到手机上(F1)",
  );
  assert.deepEqual(sessionWaiting(haltSess), [], "进程都收掉了,内存里那条等待状态还挂着");
  ok("受控停止:会话行记下停止事实,窄出口一条都不回放");

  // ── 换台之后,旧台迟到的输出动不了新台的等待状态(第 4 轮审查 F2) ──────────────
  // 工作目录被抽走那条路**复用同一行会话**:旧台摘牌、新台接着写同一个 .md,而旧台的事件流
  // 还在吐。上一版的等待表只按会话编号共享,于是旧台迟到的一条正文、一次回合收口、一次收尾,
  // 都会把新台刚置上的等待状态删掉 —— 手机上那句「正在重试」凭空消失,而新台明明还在等。
  const handTask = "task-handover";
  const handSess = "sess-handover";
  await seedTeamTask(handTask);
  const deferred = () => {
    let fire: () => void = () => {};
    const waited = new Promise<void>((resolve) => { fire = resolve; });
    return { waited, fire: () => fire() };
  };
  const oldSpeaks = deferred(); // 旧台迟到的那几条:等新台接管并挂上等待之后才放
  const oldDrained = deferred(); // 旧台的事件全被消费完了(紧接着就是它的收尾)
  const newFinishes = deferred();
  await startLead({
    taskId: handTask,
    sessId: handSess,
    cliSessionId: "thread-handover-old",
    events: (async function* () {
      yield { kind: "error", message: RETRY_1, level: "notice", affectsTurn: false };
      await oldSpeaks.waited;
      yield { kind: "text", text: "旧台迟到的半句话" }; // 坏掉的那版:这一条就把新台的等待撤了
      yield { kind: "turnEnd" }; // 这一条也会(它是团队链唯一的回合边界)
      yield { kind: "done", exitStatus: 1 };
      oldDrained.fire();
    })(),
  });
  await until("旧台那条提示进消费链", () => sessionWaiting(handSess).some((n) => n.text === RETRY_1));
  await startLead({
    taskId: handTask,
    sessId: handSess,
    cliSessionId: "thread-handover-new",
    reuse: true, // openLead 的 resuming 分支:同一行会话换一台进程接着写
    events: (async function* () {
      yield { kind: "error", message: WAITING, level: "notice", affectsTurn: false };
      await newFinishes.waited;
      yield { kind: "turnEnd" };
      yield { kind: "done", exitStatus: 0 };
    })(),
  });
  await until("新台挂上自己的等待", () => sessionWaiting(handSess).some((n) => n.text === WAITING));
  // 摘牌那一瞬旧台手上那份就作废了(retireLead),此刻代表这条会话的只有新台这一条。
  assert.deepEqual(
    sessionWaiting(handSess).map((n) => n.text),
    [WAITING],
    "换台之后两台的提示混在同一条会话上了",
  );
  oldSpeaks.fire();
  await oldDrained.waited;
  assert.deepEqual(
    sessionWaiting(handSess).map((n) => n.text),
    [WAITING],
    "旧台迟到的正文/回合收口把新台的等待状态删掉了(F2)",
  );
  await new Promise((r) => setTimeout(r, 150)); // 留给旧台那段 closeLead
  assert.deepEqual(
    sessionWaiting(handSess).map((n) => n.text),
    [WAITING],
    "旧台的收尾把新台的等待状态删掉了(F2)",
  );
  newFinishes.fire();
  await until("新台收完台", () => !teamIsLive(handTask));
  ok("换台:旧台迟到的输出与收尾都动不了新台的等待状态");

  console.log("test:team-notice-trace ok");
} finally {
  try {
    dbClient.close();
  } catch { /* 已经关了 */ }
  rmSync(root, { recursive: true, force: true });
}
