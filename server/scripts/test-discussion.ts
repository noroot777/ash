// 讨论（回复框里 @ 人来回几段）的服务端回归：server/src/discussion.ts + talk/segments.ts。
//
// 盯的是这一场**停在哪、交给谁、落成什么样**，不是措辞：
//   · 第一轮各写各的：那几段的提示词里没有别人的发言，第二轮起才带上；
//   · 到了轮数收，或者各方表态谈拢提前收；收完交给这条任务的执行器写合稿，合稿写完就结束——没有闸口；
//   · 三方轮流：被叫来的人先、这条任务的执行器最后；
//   · 「只说话不改文件」那一句进了每一方的每一段，合稿那段也有；
//   · 停下、某一方没交卷：这一场记成断了，断在哪写进记录（刷新读的就是它），可以再发起一场；
//   · 整场都是旁路回合：任务原来是什么状态、验收阶段是什么，说完还是什么；
//   · 讨论期间用户发的话排着（投递判定按「等」），说完才放；
//   · 审查辩论共用同一张表，它的读法不因此串进讨论（反之亦然）。
//
// 全程**一直占着回合**（同 test-free-review-dispute）：每一段都是 `continueWhenIdle` 起的，回合占着它就只
// 排队不起跑——测试隔离环境本来也禁止真起执行器。占的身份是 side：讨论的每一段都是旁路回合。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-discussion-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

let failure: unknown = null;
try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  const { freeReviewDebateTurns, freeReviewDebates, freeReviewRounds, freeReviewRuns, projects, scheduledMessages, tasks } =
    await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { claimTurn } = await import("../src/runs.js");
  const {
    discussionHolds, discussionViews, reconcileDiscussions, segmentPromptFor, segmentTurnOptions,
    settleDiscussionTurn, startDiscussion, submitDiscussionStatement,
  } = await import("../src/discussion.js");
  const { discussionSynthesisPrompt } = await import("../src/discussion-prompts.js");
  const { activeTalkOf, speakingTurnOf } = await import("../src/talk/segments.js");
  const { activeDebateOf, debatesOfRound, startFreeReviewDebate } = await import("../src/free-review-debate.js");
  const { afterSettlement } = await import("../src/settle-status.js");
  const { freeWorkflowState } = await import("../src/free-workflow.js");
  const { deliveryVerdictOf } = await import("../src/pending-delivery-facts.js");
  const { discussionAgreed, speakingOrder } = await import("@ash/shared/discussion");

  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "discussion", repoPath: root, createdAt: at });

  /** 一条跑过的普通任务（主执行器 claude），回合一直占着（side）。 */
  async function seedTask(id: string, patch: Partial<typeof tasks.$inferInsert> = {}) {
    await createTasks([{
      id, projectId: "p", title: id, body: "把幽灵回合锁的处理方案定下来", mode: "single", status: "done",
      agentType: "claude", autoTitle: false, workflowMode: "free", useWorktree: false,
      createdAt: at, updatedAt: at, ...patch,
    }]);
    assert.equal(claimTurn(id, "side"), true);
  }
  const rejects = async (fn: () => Promise<unknown>, needle: string, message: string) => {
    await assert.rejects(fn, (error: Error) => {
      assert.ok(error.message.includes(needle), `${message}（实际：${error.message}）`);
      return true;
    }, message);
  };
  const talkOf = async (taskId: string) => (await activeTalkOf(taskId, "discussion", ["running", "synthesizing"]))!;
  const say = (taskId: string, summary: string, agreed?: boolean) =>
    submitDiscussionStatement(taskId, { summary, statement: `${summary}——展开说：依据、代价和取舍。`, agreed });
  const SPEAK_ONLY = "不要改动任何文件、不要提交、不要跑会改变状态的命令";

  // ── 纯规则：谁先说、什么算谈拢 ──
  assert.deepEqual(speakingOrder([{ host: true, id: "claude" }, { host: false, id: "codex" }]).map((item) => item.id),
    ["codex", "claude"], "被叫来的人先说，这条任务的执行器最后：被叫的人读到的对话正好停在发起那一刻");
  const done = (seq: number, agreed: boolean | null) => ({ seq, agreed, status: "done" });
  assert.equal(discussionAgreed([done(1, null), done(2, null)], 2), false, "第一轮各写各的，谈不上一致");
  assert.equal(discussionAgreed([done(1, null), done(2, null), done(3, true)], 2), true,
    "两方时一方确认和对方最新的一致就收（对方最新的那段就是它刚认同的）");
  assert.equal(discussionAgreed([done(1, null), done(2, null), done(3, null), done(4, true)], 3), false,
    "三方时一段表态不够：还有一方的最新说法没人认过");
  assert.equal(discussionAgreed([done(1, null), done(2, null), done(3, null), done(4, true), done(5, true)], 3), true,
    "三方连着两段表态才算谈拢");
  assert.equal(discussionAgreed([done(1, null), done(2, null), done(3, true), done(4, false)], 2), false,
    "最新那段没表态就不算：谈拢看的是此刻");

  // ── ① 两方 2 轮：发起、第一轮各写各的、谈拢提前结束、合稿、回到原样 ──
  await seedTask("t-two", { stage: "awaiting_acceptance" });
  await rejects(() => startDiscussion("t-two", { topic: "选哪条路", rounds: 2, guests: [{ agentType: "claude" }] }),
    "就是这条任务自己的执行器", "@ 自己的执行器不能讨论：一种执行器在一条任务里只有一条会话");
  await rejects(() => startDiscussion("t-two", { topic: "  ", rounds: 2, guests: [{ agentType: "codex" }] }),
    "先写下要讨论什么", "空话题不收");
  await rejects(() => startDiscussion("t-two", { topic: "x", rounds: 5, guests: [{ agentType: "codex" }] }),
    "来回几轮", "轮数只有四档");
  const first = await startDiscussion("t-two", {
    topic: "幽灵回合锁走哪条路？", rounds: 2,
    guests: [{ agentType: "codex", executorId: "codex-x", model: "gpt-test", reasoningEffort: "high" }],
  });
  assert.equal(await discussionHolds("t-two"), true, "开了就占着这条任务的回合");
  let talk = await talkOf("t-two");
  assert.equal(talk.id, first.discussionId);
  assert.equal(talk.kind, "discussion");
  assert.equal((await speakingTurnOf(talk))?.side, "codex", "第 1 段轮到被叫来的人");

  const seg1 = await segmentPromptFor("t-two", talk, (await speakingTurnOf(talk))!);
  assert.equal(seg1.speaker.agentType, "codex");
  assert.match(seg1.prompt, /幽灵回合锁走哪条路？/, "每一段都带着用户发起时写的那句话");
  assert.match(seg1.prompt, /各写各的/, "第一轮明说各写各的");
  assert.ok(seg1.prompt.includes(SPEAK_ONLY), "只说话不改文件那一句送到了被叫来的人");
  const guestOptions = segmentTurnOptions(seg1.speaker, true, ["shot.png"]);
  assert.equal(guestOptions.sideTurn, true, "每一段都是旁路回合：任务状态与验收阶段原样不动");
  assert.equal((guestOptions as { agent?: string }).agent, "codex", "被叫来的人按它被叫时的那一套跑");
  assert.equal((guestOptions as { executorId?: string }).executorId, "codex-x");
  assert.deepEqual((guestOptions as { attachments?: string[] }).attachments, ["shot.png"], "第一轮带上用户附的图");

  const r1 = await say("t-two", "codex：让收尾每一步自己带时限", true);
  assert.equal(r1.blind, true);
  assert.equal(r1.agreed, null, "第一轮的表态不算数（还没看过别人的）");
  assert.equal(r1.agreedIgnored, true, "传了也要明说被忽略");
  await rejects(() => say("t-two", "再交一次"), "已经交过卷了", "一段只认第一次交卷");
  // 结算走真入口：讨论排在审查那一路之前收。
  await afterSettlement("t-two", "done", false, true, "single");
  talk = await talkOf("t-two");
  const turn2 = (await speakingTurnOf(talk))!;
  assert.equal(turn2.seq, 2);
  assert.equal(turn2.side, "claude", "第 2 段轮到这条任务的执行器");
  const seg2 = await segmentPromptFor("t-two", talk, turn2);
  assert.ok(!seg2.prompt.includes("让收尾每一步自己带时限"),
    "第一轮互相看不到：主执行器第一段的提示词里不许有 codex 第一段的发言");
  assert.ok(seg2.prompt.includes(SPEAK_ONLY), "只说话不改文件那一句送到了主执行器");
  const hostOptions = segmentTurnOptions(seg2.speaker, true, []);
  assert.equal((hostOptions as { agent?: string }).agent, undefined, "主执行器续任务自己的会话，不带 agent");
  assert.equal(hostOptions.sideTurn, true);

  await say("t-two", "claude：也不赞成手动放开，卡住时留一条提示");
  await settleDiscussionTurn("t-two", true, "single");
  talk = await talkOf("t-two");
  const turn3 = (await speakingTurnOf(talk))!;
  assert.equal(turn3.side, "codex", "第二轮还是被叫来的人先");
  const seg3 = await segmentPromptFor("t-two", talk, turn3);
  assert.ok(seg3.prompt.includes("也不赞成手动放开"), "第二轮起带上别人上一段之后说的");
  assert.ok(!seg3.prompt.includes("让收尾每一步自己带时限——"), "自己说过的不再重发（它自己的会话里有）");
  assert.ok(seg3.prompt.includes("agreed=true"), "第二轮起告诉它怎么表态谈拢");

  await say("t-two", "codex：补一条先修那处泄漏，谈拢了", true);
  await settleDiscussionTurn("t-two", true, "single");
  talk = await talkOf("t-two");
  assert.equal(talk.status, "synthesizing", "谈拢了就提前收（2 轮本该说 4 段，这里第 3 段收）");
  assert.equal(talk.outcome, "agreed");
  assert.equal(await discussionHolds("t-two"), true, "写合稿时还占着回合：用户的话等合稿写完再发");
  assert.equal(await settleDiscussionTurn("t-two", true, "reviewer"), false, "审查者回合不归讨论");
  // 合稿那一回合收尾 = 这一场结束，没有「等你拍板」那一步。
  assert.equal(await settleDiscussionTurn("t-two", true, "single"), true);
  const finished = (await discussionViews("t-two")).at(0)!;
  assert.equal(finished.status, "finished", "合稿写完就结束：没有闸口");
  assert.equal(finished.note, null);
  assert.equal(finished.turns.length, 3);
  assert.deepEqual(finished.turns.map((item) => item.speaker), ["codex", "claude", "codex"]);
  assert.equal(finished.turns.at(-1)?.agreed, true);
  assert.equal(finished.rounds, 2);
  assert.equal(await discussionHolds("t-two"), false, "结束后回合还给任务");
  const after = (await db.select().from(tasks).where(eq(tasks.id, "t-two"))).at(0)!;
  assert.equal(after.status, "done", "讨论完任务还是原来的状态");
  assert.equal(after.stage, "awaiting_acceptance", "验收阶段原样不动");
  assert.equal((await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.taskId, "t-two"))).length, 0,
    "讨论不算一轮审查");

  // 合稿交给这条任务的执行器、带上它没见过的最后那段，写明结论 + 分歧，并且同样只说话。
  const synthesis = discussionSynthesisPrompt({
    taskId: "t-two", topic: "幽灵回合锁走哪条路？", order: finished.participants, rounds: 2, agreed: false, segments: 4,
    previous: [{ seq: 4, speaker: "codex", statement: "时限按步骤分开定" }],
  });
  assert.match(synthesis, /还没有谈拢/, "没谈拢如实写");
  assert.match(synthesis, /时限按步骤分开定/, "带上主执行器还没见过的那段");
  assert.match(synthesis, /还留着的分歧/);
  assert.match(synthesis, /不改文件/);

  // ── ② 到了轮数就收：1 轮 = 各写一段 ──
  await seedTask("t-one");
  await startDiscussion("t-one", { topic: "要不要拆文件", rounds: 1, guests: [{ agentType: "codex" }] });
  await say("t-one", "codex：拆");
  await settleDiscussionTurn("t-one", true, "single");
  await say("t-one", "claude：拆，按职责", true);
  await settleDiscussionTurn("t-one", true, "single");
  talk = await talkOf("t-one");
  assert.equal(talk.status, "synthesizing", "说满轮数就收");
  assert.equal(talk.outcome, "rounds", "第一轮的表态不算，这一场是「到了轮数」不是「谈拢了」");

  // ── ③ 三方轮流 ──
  await seedTask("t-three");
  await startDiscussion("t-three", { topic: "三方", rounds: 2, guests: [{ agentType: "codex" }, { agentType: "gemini" }] });
  const speakers: string[] = [];
  for (let seq = 1; seq <= 6; seq++) {
    const current = await talkOf("t-three");
    if (current.status !== "running") break;
    speakers.push((await speakingTurnOf(current))!.side);
    const prompt = (await segmentPromptFor("t-three", current, (await speakingTurnOf(current))!)).prompt;
    assert.ok(prompt.includes(SPEAK_ONLY), `第 ${seq} 段的提示词里有「只说话不改文件」`);
    await say("t-three", `第 ${seq} 段`, seq === 4);
    await settleDiscussionTurn("t-three", true, "single");
  }
  assert.deepEqual(speakers, ["codex", "gemini", "claude", "codex", "gemini", "claude"],
    "三方按被叫来的人先、主执行器最后轮流；一段表态不够三方提前收");
  assert.equal((await talkOf("t-three")).outcome, "rounds");
  await rejects(() => startDiscussion("t-three", { topic: "四方", rounds: 1, guests: [{ agentType: "codex" }, { agentType: "gemini" }, { agentType: "grok" }] }),
    "最多再叫", "最多三方");

  // ── ④ 停下：如实记下断在哪，刷新（重读）后还在，可以再发起 ──
  await seedTask("t-stop");
  await startDiscussion("t-stop", { topic: "停", rounds: 2, guests: [{ agentType: "codex" }] });
  await say("t-stop", "codex：第一段");
  await settleDiscussionTurn("t-stop", true, "single");
  await settleDiscussionTurn("t-stop", false, "single");
  const stopped = (await discussionViews("t-stop")).at(0)!;
  assert.equal(stopped.status, "failed", "按了停止，这一场就停，不接着让下一位说");
  assert.match(stopped.note ?? "", /claude 第 2 段被停下/, "断在哪一段、谁那一段，落进记录（气泡读它）");
  assert.equal(stopped.turns.at(-1)?.status, "error", "没说完的那段记成 error，不留 speaking 让气泡一直转");
  assert.equal(await discussionHolds("t-stop"), false, "断了就把回合还给任务");
  const again = await startDiscussion("t-stop", { topic: "再来", rounds: 1, guests: [{ agentType: "codex" }] });
  assert.notEqual(again.discussionId, stopped.id, "能重新发起：是新的一场，旧记录照留");
  assert.equal((await discussionViews("t-stop")).length, 2);

  // ── ⑤ 没交卷：某一方没能发言 ──
  await seedTask("t-silent");
  await startDiscussion("t-silent", { topic: "沉默", rounds: 2, guests: [{ agentType: "codex" }] });
  await settleDiscussionTurn("t-silent", true, "single");
  const silent = (await discussionViews("t-silent")).at(0)!;
  assert.equal(silent.status, "failed");
  assert.match(silent.note ?? "", /codex 第 1 段说完没有交卷/);

  // ── ⑥ 只有 side 回合交得了卷 ──
  await createTasks([{
    id: "t-role", projectId: "p", title: "t-role", body: "b", mode: "single", status: "done",
    agentType: "claude", autoTitle: false, workflowMode: "free", useWorktree: false, createdAt: at, updatedAt: at,
  }]);
  assert.equal(claimTurn("t-role", "single"), true);
  await startDiscussion("t-role", { topic: "身份", rounds: 1, guests: [{ agentType: "codex" }] });
  await rejects(() => say("t-role", "冒名"), "只有它这一段的回合能交卷", "普通回合交不了讨论的一段");

  // ── ⑦ 门禁：在跑、在等答复、在辩论 / 讨论时都开不了；讨论期间别的也等着 ──
  await seedTask("t-busy", { status: "running" });
  await rejects(() => startDiscussion("t-busy", { topic: "x", rounds: 1, guests: [{ agentType: "codex" }] }),
    "任务正在跑", "任务在跑时不开讨论");
  await seedTask("t-ask", { status: "paused", question: "选哪个？" });
  await rejects(() => startDiscussion("t-ask", { topic: "x", rounds: 1, guests: [{ agentType: "codex" }] }),
    "等着答复", "在等答复时不开");
  await rejects(() => startDiscussion("t-role", { topic: "x", rounds: 1, guests: [{ agentType: "codex" }] }),
    "已经在讨论了", "一条任务同时只有一场");
  // 讨论期间不许开辩论（辩论跟讨论同一张表，辩论那一路也不许把讨论读成辩论）。
  const runId = "t-role-run";
  await db.insert(freeReviewRuns).values({
    id: runId, taskId: "t-role", reviewerId: "r", reviewerName: "审查者", agentType: "codex", checkMode: "logic",
    retryLimit: 1, currentRound: 1, status: "stopped", createdAt: at, updatedAt: at, finishedAt: at,
  });
  await db.insert(freeReviewRounds).values({
    id: `${runId}-round`, runId, round: 1, status: "failed", conclusion: "verify_failed", reportMarkdown: "r",
    startedAt: at, endedAt: at, disputeReason: "不认", disputeAt: at,
  });
  assert.equal(await activeDebateOf("t-role"), null, "讨论不会被当成正在进行的辩论");
  await rejects(() => startFreeReviewDebate("t-role", { exchanges: 1 }), "正在讨论", "讨论期间不开辩论");
  assert.deepEqual(await debatesOfRound(`${runId}-round`), [], "辩论的读法不串进讨论");

  // 讨论期间用户发的话排着：投递判定按「等」，说完才放。
  await db.insert(scheduledMessages).values({
    id: "m-held", taskId: "t-role", text: "我补一句", mode: "queued", status: "pending", sendAt: at, createdAt: at,
  });
  const message = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, "m-held"))).at(0)!;
  const role = (await db.select().from(tasks).where(eq(tasks.id, "t-role"))).at(0)!;
  const held = await deliveryVerdictOf({ ...message, afterEndedAt: null } as never, role, new Date());
  assert.equal(held.verdict.action, "wait", "讨论期间用户发的话不送：插进两段之间会被当成讨论的一段");
  assert.equal(held.facts.discussing, true);

  // ── ⑧ 状态快照带上讨论（会话里的气泡、「审议」格都读它）──
  const state = await freeWorkflowState("t-two");
  assert.equal(state.discussions.length, 1, "只有讨论没有审查的任务，快照里照样有它");
  assert.equal(state.discussions[0]?.topic, "幽灵回合锁走哪条路？");
  assert.equal(state.discussions[0]?.participants.find((item) => !item.host)?.model, "gpt-test");
  assert.equal(state.reviews.length, 0);

  // ── ⑨ 重启对账：没有回合在跑的讨论收掉，用户排着的话才放得出去 ──
  await createTasks([{
    id: "t-orphan", projectId: "p", title: "t-orphan", body: "b", mode: "single", status: "done",
    agentType: "claude", autoTitle: false, workflowMode: "free", useWorktree: false, createdAt: at, updatedAt: at,
  }]);
  const participants = JSON.stringify([
    { agentType: "codex", executorId: null, model: null, reasoningEffort: null, host: false },
    { agentType: "claude", executorId: null, model: null, reasoningEffort: null, host: true },
  ]);
  await db.insert(freeReviewDebates).values([
    { id: "orphan-a", kind: "discussion", roundId: "", runId: "", round: 0, taskId: "t-orphan", status: "running",
      exchanges: 1, currentSeq: 1, topic: "a", participants, startedAt: at, updatedAt: at },
  ]);
  await db.insert(freeReviewDebateTurns).values({
    id: "orphan-a-1", debateId: "orphan-a", seq: 1, side: "codex", statement: null, status: "speaking", startedAt: at,
  });
  await reconcileDiscussions();
  const orphan = (await discussionViews("t-orphan")).at(0)!;
  assert.equal(orphan.status, "failed", "进程死在两段之间的讨论要收掉，否则这条任务的话永远排着");
  assert.match(orphan.note ?? "", /服务重启/);
  assert.equal((await discussionViews("t-role")).at(0)?.status, "running", "回合还占着的不碰");
  await db.update(freeReviewDebates).set({ status: "synthesizing" }).where(eq(freeReviewDebates.id, "orphan-a"));
  await reconcileDiscussions();
  const synthesizing = (await discussionViews("t-orphan")).at(0)!;
  assert.equal(synthesizing.status, "finished", "合稿没写完也收：讨论本身已经说完了");
  assert.match(synthesizing.note ?? "", /合稿还没写完/);

  console.log("discussion ok");
} catch (error) {
  failure = error;
} finally {
  await releaseTmpDb().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
process.exit(0);
