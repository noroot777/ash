// 删掉一整场讨论（discussion-delete.ts）与讨论背景副本跟着删除走（discussion-background.ts）的回归。
//
// 要钉住的是「删完之后哪个 agent 都读不到这一场」，不只是界面上那两块没了：
//   ① 各会话 .md 里属于这一场的段（各段与合稿的回合、写明是这一场的旁注和提醒）换成墓碑；讨论前后的话、
//      讨论期间借着讨论回合落盘的别的事的旁注（哨兵结束、没带讨论身份的提醒）、讨论之后的旁注一个不动；trace 按回合摘；
//   ② 讨论记录（那一行和各段）、讨论自己的目录都没了；之后那场讨论截下的背景副本里也不剩这一场；
//   ③ 每一条持有 CLI 会话的会话行都挂上「下一轮重建上下文」；
//   ④ 还在说、任务在跑都拒，路由是真人专属；
//   ⑤ 删一条普通消息：各场讨论的背景副本里那一段同样换成墓碑；副本对不上正文就整份删掉；讨论进行中不让删。
// 跑:npm -w server run test:discussion-delete
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionSpans, segmentFingerprint } from "@ash/shared/session-output";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-discussion-delete-"));
process.env.ASH_DB = join(stage, "ash.db");
requireTmpDb("test-discussion-delete");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const ok = (m: string) => console.log("   ✓ " + m);

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { freeReviewDebates, freeReviewDebateTurns, projects, sessions, tasks } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { sessionTracePath, sessionTranscriptPath, TURN_SENTINEL } = await import("../src/transcript.js");
  const { deleteDiscussion, segmentOfDiscussion } = await import("../src/discussion-delete.js");
  const { dirOf, mirrorDeletions } = await import("../src/discussion-background.js");
  const { deleteConversationSegments, RedactRefusal } = await import("../src/conversation-redact.js");
  const { isHumanOnlyPath } = await import("../src/auth/personal-gate.js");
  const { claimNonTurn } = await import("../src/runs.js");
  await ensureSchema();

  const line = (turn: Record<string, unknown>) => `${TURN_SENTINEL}${JSON.stringify(turn)}`;
  const T = (minute: number) => `2026-11-17T01:${String(minute).padStart(2, "0")}:00.000Z`;
  const resume = (agent: string, seq: number, turn: string) =>
    line({ t: "system", agent, text: "〔系统〕继续（从中断处）", resume: { reason: "run", side: true }, at: turn, seq, turnStartedAt: turn });
  const agentHead = (seq: number, turn: string, at: string) => line({ t: "agent", seq, turnStartedAt: turn, at });
  const end = (seq: number, turn: string, at: string) => line({ t: "agentEnd", at, seq, turnStartedAt: turn });
  const aside = (agent: string, text: string, at: string, seq: number, turn: string | null, notice: Record<string, unknown>) =>
    line({ t: "system", agent, text, aside: true, notice, at, seq, turnStartedAt: turn });
  const talkNotice = (id: string, phase: string) => ({ kind: "discussion", discussionId: id, phase });

  // 讨论 A：01:10 开始、01:20 收口。codex 说第 1 段（01:11 的回合），claude 说第 2 段（01:13）、写合稿（01:16）。
  const HOST = [
    line({ t: "user", agent: "claude", text: "先把 A 方案改了", at: T(1), seq: 1, turnStartedAt: T(1) }),
    agentHead(2, T(1), T(2)), "A 方案改完了。", end(3, T(1), T(3)),
    resume("claude", 4, T(13)),
    agentHead(5, T(13), T(14)), "SECRET 第二段发言的交代", end(6, T(13), T(15)),
    line({ t: "user", agent: "claude", by: "system", text: "【讨论说完了 · 写合稿】SECRET 合稿提示", at: T(16), seq: 7, turnStartedAt: T(16) }),
    agentHead(8, T(16), T(17)), "SECRET 合稿正文", end(9, T(16), T(18)),
    // 讨论之后才写的旁注：挂着最后一个回合（合稿）的身份，但落在收口之后 —— 不归这一场。
    aside("claude", "已预约审查", T(25), 10, T(16), { kind: "review.reserved" }),
    line({ t: "user", agent: "claude", text: "接着做 B 方案", at: T(30), seq: 11, turnStartedAt: T(30) }),
    agentHead(12, T(30), T(31)), "B 方案开工。", end(13, T(30), T(32)),
    "",
  ].join("\n");
  const GUEST = [
    aside("codex", "开始讨论：claude 和 codex，1 轮。", T(10), 1, null, talkNotice("talkA", "start")),
    aside("codex", "讨论第 1/2 段：轮到 codex。", T(10), 2, null, talkNotice("talkA", "segment")),
    resume("codex", 3, T(11)),
    agentHead(4, T(11), T(11)), "SECRET codex 第一段的交代", end(5, T(11), T(12)),
    aside("codex", "讨论结束：claude 和 codex 谈了 2 段，没谈拢。", T(15), 6, T(11), talkNotice("talkA", "end")),
    // 写明是这一场的提醒（合稿没写完那一句）：跟着这一场走。
    aside("codex", "SECRET 合稿没写完。讨论的记录都在", T(19), 7, T(11), { kind: "alert", discussionId: "talkA" }),
    // 讨论期间别的事借这条会话落盘的旁注：时刻在起止之间、挂着讨论回合的身份，但不是讨论的 —— 不动。
    aside("codex", "哨兵结束：构建，退出码 0。", T(12), 9, T(11), { kind: "monitor.finished", monitorId: "m1", description: "构建" }),
    aside("codex", "预约的审查没能起跑", T(14), 10, T(11), { kind: "alert" }),
    // 另一场讨论的旁注：不动。
    aside("codex", "开始讨论：codex 和 claude，1 轮。", T(40), 8, null, talkNotice("talkB", "start")),
    "",
  ].join("\n");
  const trace = (rows: [string, string, string][]) => rows.map(([at, turn, kind]) =>
    JSON.stringify({ at, turnStartedAt: turn, event: kind === "text" ? { kind, text: `t-${turn}` } : { kind } })).join("\n") + "\n";
  const HOST_TRACE = trace([
    [T(2), T(1), "text"], [T(13), T(13), "run"], [T(14), T(13), "text"], [T(17), T(16), "toolUse"], [T(31), T(30), "text"],
  ]);

  const at = T(0);
  await db.insert(projects).values({ id: "p", name: "p", repoPath: stage, createdAt: at });
  async function seed() {
    for (const table of [tasks, sessions, freeReviewDebates, freeReviewDebateTurns]) await db.delete(table);
    rmSync(join(stage, "runs"), { recursive: true, force: true });
    await db.insert(tasks).values({ id: "t", projectId: "p", title: "t", body: "b", mode: "single", status: "done", agentType: "claude", workflowMode: "free", createdAt: at, updatedAt: at });
    for (const [id, agentType, raw, traceRaw] of [["host", "claude", HOST, HOST_TRACE], ["guest", "codex", GUEST, null]] as const) {
      await db.insert(sessions).values({ id, taskId: "t", role: "single", agentType, executor: agentType, startedAt: at, cliSessionId: `cli-${id}` });
      mkdirSync(join(stage, "runs", "t"), { recursive: true });
      writeFileSync(sessionTranscriptPath("t", id), raw);
      if (traceRaw) writeFileSync(sessionTracePath("t", id), traceRaw);
    }
    // 讨论 A 的目录（背景副本 + 发言记录），讨论 B 在 A 之后开、它截下的背景里有 A 的那几段。
    const dirA = dirOf("t", "talkA");
    mkdirSync(join(dirA, "background"), { recursive: true });
    writeFileSync(join(dirA, "spoken-before-2.md"), "SECRET codex 第一段");
    const copyB = join(dirOf("t", "talkB"), "background", "claude-host.md");
    mkdirSync(join(dirOf("t", "talkB"), "background"), { recursive: true });
    writeFileSync(copyB, HOST);
    const talk = (id: string, startedAt: string, finishedAt: string | null, status: string, background: unknown[]) => ({
      id, kind: "discussion", roundId: "", runId: "", round: 0, taskId: "t", status, exchanges: 1, currentSeq: 2,
      topic: `SECRET 题目 ${id}`, participants: "[]", attachments: "[]", background: JSON.stringify(background),
      startedAt, updatedAt: finishedAt ?? startedAt, finishedAt,
    });
    await db.insert(freeReviewDebates).values([
      talk("talkA", T(10), T(20), "finished", []),
      talk("talkB", T(40), T(45), "finished", [{ agentType: "claude", role: "single", sessionId: "host", path: copyB }]),
    ]);
    await db.insert(freeReviewDebateTurns).values([
      { id: "a1", debateId: "talkA", seq: 1, side: "codex", statement: "SECRET 发言", status: "done", startedAt: T(10) },
      { id: "b1", debateId: "talkB", seq: 1, side: "codex", statement: "B 的发言", status: "done", startedAt: T(40) },
    ]);
    return { copyB };
  }
  const live = (raw: string) => parseSessionSpans(raw).filter((span) => !span.seg.deleted).map((span) => span.seg.text);

  // ── ① 哪些段归这一场（纯函数）──────────────────────────────────────────────
  {
    const span = { from: Date.parse(T(10)), to: Date.parse(T(20)) };
    const hostIn = parseSessionSpans(HOST).map((item) => segmentOfDiscussion(item.seg, "talkA", span));
    const guestIn = parseSessionSpans(GUEST).map((item) => segmentOfDiscussion(item.seg, "talkA", span));
    assert.deepEqual(parseSessionSpans(HOST).filter((_, i) => hostIn[i]).map((item) => item.seg.text),
      ["〔系统〕继续（从中断处）", "SECRET 第二段发言的交代", "【讨论说完了 · 写合稿】SECRET 合稿提示", "SECRET 合稿正文"],
      "主会话里只认起止之间起跑的回合");
    assert.deepEqual(parseSessionSpans(GUEST).filter((_, i) => guestIn[i]).map((item) => item.seg.text), [
      "开始讨论：claude 和 codex，1 轮。", "讨论第 1/2 段：轮到 codex。", "〔系统〕继续（从中断处）", "SECRET codex 第一段的交代",
      "讨论结束：claude 和 codex 谈了 2 段，没谈拢。", "SECRET 合稿没写完。讨论的记录都在",
    ], "被叫来那方：写明是这一场的旁注和提醒、那一段回合；另一场的、借讨论回合落盘的别的事都不认");
    ok("归属：回合按起跑时刻，旁注只认写明的讨论身份");
  }

  // ── ②③ 删一整场 ────────────────────────────────────────────────────────────
  {
    const { copyB } = await seed();
    assert.deepEqual(await deleteDiscussion("t", "talkA"), { deleted: true });
    const host = readFileSync(sessionTranscriptPath("t", "host"), "utf8");
    const guest = readFileSync(sessionTranscriptPath("t", "guest"), "utf8");
    for (const raw of [host, guest, readFileSync(sessionTracePath("t", "host"), "utf8"), readFileSync(copyB, "utf8")]) {
      assert.ok(!raw.includes("SECRET") && !raw.includes(`t-${T(13)}`) && !raw.includes("toolUse"), `这一场一个字不剩：\n${raw}`);
    }
    assert.deepEqual(live(host), ["先把 A 方案改了", "A 方案改完了。", "已预约审查", "接着做 B 方案", "B 方案开工。"], "讨论前后的话和之后的旁注都还在");
    assert.equal(parseSessionSpans(host).length, parseSessionSpans(HOST).length, "段落序号不动（墓碑占位）");
    assert.deepEqual(live(guest), ["哨兵结束：构建，退出码 0。", "预约的审查没能起跑", "开始讨论：codex 和 claude，1 轮。"],
      "被叫来那方只剩另一场的旁注和讨论期间别的事的旁注");
    const traceAfter = readFileSync(sessionTracePath("t", "host"), "utf8");
    assert.ok(traceAfter.includes(`t-${T(1)}`) && traceAfter.includes(`t-${T(30)}`) && traceAfter.includes('"run"'), "trace 只摘讨论那几个回合（run 留着记账）");
    assert.equal(existsSync(dirOf("t", "talkA")), false, "讨论自己的目录删掉了");
    assert.equal((await db.select().from(freeReviewDebates).where(eq(freeReviewDebates.id, "talkA"))).length, 0, "讨论记录删掉了");
    assert.equal((await db.select().from(freeReviewDebateTurns).where(eq(freeReviewDebateTurns.debateId, "talkA"))).length, 0, "各段删掉了");
    assert.equal((await db.select().from(freeReviewDebates).where(eq(freeReviewDebates.id, "talkB"))).length, 1, "另一场不动");
    const rows = await db.select().from(sessions).where(eq(sessions.taskId, "t"));
    assert.ok(rows.every((row) => row.contextRebuildAt), "每条会话下一轮都重建上下文");
    await assert.rejects(() => deleteDiscussion("t", "talkA"), (error: unknown) => error instanceof RedactRefusal && error.status === 404, "删过的再删是 404");
    ok("整场删掉：正文、trace、记录、目录、之后那场的背景副本都不剩，下一轮重建");
  }

  // ── ④ 拒绝的几种 ───────────────────────────────────────────────────────────
  {
    await seed();
    const refused = (status: number, needle: string) => (error: unknown) =>
      error instanceof RedactRefusal && error.status === status && error.message.includes(needle);
    await db.update(freeReviewDebates).set({ status: "synthesizing" }).where(eq(freeReviewDebates.id, "talkA"));
    await assert.rejects(() => deleteDiscussion("t", "talkA"), refused(409, "还在进行"), "写合稿时不让删");
    await db.update(freeReviewDebates).set({ status: "finished" }).where(eq(freeReviewDebates.id, "talkA"));
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "t"));
    await assert.rejects(() => deleteDiscussion("t", "talkA"), refused(409, "正在运行"), "任务在跑不让删");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "t"));
    const release = claimNonTurn("t", "side");
    assert.ok(release);
    await assert.rejects(() => deleteDiscussion("t", "talkA"), refused(409, "正在运行"), "回合锁被占不让删");
    release();
    assert.equal(readFileSync(sessionTranscriptPath("t", "host"), "utf8"), HOST, "被拒时一个字没动");
    assert.ok(isHumanOnlyPath("/api/tasks/t/discussions/talkA/delete"), "删讨论只有真人按得动");
    ok("还在说、任务在跑、回合被占都拒，路由真人专属");
  }

  // ── ⑤ 删一条普通消息，讨论背景副本跟着抹 ───────────────────────────────────
  {
    const { copyB } = await seed();
    const spans = parseSessionSpans(HOST);
    const index = spans.findIndex((span) => span.seg.text === "先把 A 方案改了");
    await deleteConversationSegments("host", [{ index, fingerprint: segmentFingerprint(spans[index]!.seg) }]);
    const copy = readFileSync(copyB, "utf8");
    assert.ok(!copy.includes("先把 A 方案改了"), "背景副本里那一句也没了");
    assert.equal(copy.split("\n")[0], readFileSync(sessionTranscriptPath("t", "host"), "utf8").split("\n")[0], "换成和正文同一行墓碑");
    assert.ok(copy.includes("A 方案改完了。"), "别的段不动");

    // 副本对不上正文（种类不一致）：整份删掉，不留删不干净的。
    assert.equal(statSync(copyB).mode & 0o777, 0o444, "换过的副本照旧只读");
    rmSync(copyB);
    writeFileSync(copyB, GUEST);
    const after = parseSessionSpans(readFileSync(sessionTranscriptPath("t", "host"), "utf8"));
    const next = after.findIndex((span) => span.seg.text === "A 方案改完了。");
    await deleteConversationSegments("host", [{ index: next, fingerprint: segmentFingerprint(after[next]!.seg) }]);
    assert.equal(existsSync(copyB), false, "对不上的副本整份删掉");
    assert.equal(mirrorDeletions(HOST + HOST, HOST), null, "副本比正文还长也算对不上");

    await db.update(freeReviewDebates).set({ status: "running" }).where(eq(freeReviewDebates.id, "talkB"));
    const fresh = parseSessionSpans(readFileSync(sessionTranscriptPath("t", "host"), "utf8"));
    const last = fresh.findIndex((span) => span.seg.text === "B 方案开工。");
    await assert.rejects(() => deleteConversationSegments("host", [{ index: last, fingerprint: segmentFingerprint(fresh[last]!.seg) }]),
      (error: unknown) => error instanceof RedactRefusal && error.status === 409 && error.message.includes("讨论还在进行"), "讨论进行中不让删消息");
    ok("删消息：背景副本同步换墓碑，对不上整份删，讨论进行中不让删");
  }
} catch (error) {
  failure = error;
} finally {
  releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log("test-discussion-delete: all passed");
