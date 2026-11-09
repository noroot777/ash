// 用户没答提问、直接发新消息时，那道提问要撤下（task-question-supersede.ts）。
// 钉住七件事：真人消息撤卡并告诉 agent；撤卡认执行器的输入回执（拒收、结果不明都不撤，迟到确认
// 收下才撤）；等回执期间重启、接管回来确认收下也要撤（撤卡记录在库里，不在进程回调里）；撤卡碰上
// 一次写库失败要自己重试，进程没了由开机扫描补做；哨兵这类后端代写的回合不撤；agent 在这一轮里
// 重新问了（题面一字不差也算）不能被误撤；归审查的提问不归这条路管。
// 跑:npm -w server run test:question-supersede
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { InputAcceptance, RunHandle, RunOpts } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-question-supersede-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.ASH_TURN_INPUT_ACK_MS = "200";
delete process.env.ASH_ALLOW_REAL_AGENT;

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { continueTask } = await import("../src/orchestrator.js");
const { replyToTask } = await import("../src/task-reply.js");
const { setTaskQuestion } = await import("../src/task-question.js");
const { armQuestionSupersede, honorQuestionSupersede, settleAdoptedQuestionSupersede, sweepQuestionSupersedes } = await import("../src/task-question-supersede.js");
const { isTurnClaimed } = await import("../src/runs.js");
const { bus } = await import("../src/bus.js");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
await ensureSchema();

const api = new Hono();
api.post("/tasks/:id/reply", (context) => replyToTask(context, context.req.param("id")));
const at = "2026-11-09T00:00:00.000Z";
const question = "请先在浏览器重新登录，登录好了回复「已登录」";
const NOTE = "那张问答卡已随之撤下";
const prompts: string[] = [];
const cleared: string[] = [];
const original = { run: ClaudeExecutor.prototype.run, runSteerable: ClaudeExecutor.prototype.runSteerable };
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const create = (taskId: string, extra: Partial<typeof tasks.$inferInsert> = {}) => db.insert(tasks).values({
  id: taskId, projectId: "project", title: taskId, body: "发布视频", agentType: "claude",
  mode: "single", status: "paused", useWorktree: false, autoTitle: false, question,
  createdAt: at, updatedAt: at, ...extra,
});

/** 下一轮执行器给出的输入回执；不设 = 不提供回执（按收下算）。 */
let nextReceipt: Promise<InputAcceptance> | undefined;

function captureRun(opts: RunOpts): RunHandle {
  prompts.push(opts.prompt);
  const inputAccepted = nextReceipt;
  nextReceipt = undefined;
  return {
    ...(inputAccepted ? { inputAccepted } : {}),
    sessionId: `fixture-${prompts.length}`,
    commandLine: "question supersede fixture",
    events: (async function* () {
      yield { kind: "text" as const, text: "fixture finished" };
      yield { kind: "done" as const, exitStatus: 0 };
    })(),
    kill() {},
  };
}

async function settled(taskId: string, before: number): Promise<string> {
  for (let attempt = 0; attempt < 500 && (prompts.length === before || isTurnClaimed(taskId)); attempt++) await delay(10);
  assert.equal(isTurnClaimed(taskId), false, "回合必须收口");
  assert.equal(prompts.length, before + 1, "必须恰好起跑一次");
  return prompts.at(-1)!;
}

async function reply(taskId: string, text: string): Promise<string> {
  const before = prompts.length;
  const response = await api.request(`/tasks/${taskId}/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
  });
  assert.equal(response.status, 202, await response.text());
  return settled(taskId, before);
}

const unsubscribe = bus.subscribe((event) => {
  if (event.type === "task.question" && event.question === null) cleared.push(event.taskId);
});

try {
  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  await db.insert(projects).values({ id: "project", name: "question supersede", repoPath: root, createdAt: at });
  ClaudeExecutor.prototype.run = captureRun;
  ClaudeExecutor.prototype.runSteerable = captureRun;

  // ① 停在检查点又挂着提问（现场 YfT8Z8tzV5-c）：用户发来别的话 —— 卡撤下、检查点与 paused 照旧。
  await create("checkpoint", { resumePrompt: "等用户下一条指令" });
  const checkpointPrompt = await reply("checkpoint", "25 号不用管了，先把封面的问题改了");
  assert.ok(checkpointPrompt.includes(NOTE), "agent 要知道卡已撤、还需要拍板就得重新问");
  assert.ok(checkpointPrompt.includes(question.slice(0, 20)), "提示里带上被撤的是哪一问");
  const checkpoint = await row("checkpoint");
  assert.equal(checkpoint.question, null, "真人消息之后旧提问不能再挂着");
  assert.equal(checkpoint.status, "paused", "检查点续聊照旧回到 paused");
  assert.equal(checkpoint.resumePrompt, "等用户下一条指令", "撤的只是提问，检查点不动");
  assert.ok(cleared.includes("checkpoint"), "前端靠 task.question 事件收卡");

  // ② 只挂着提问：用户的话就是这一轮的执行输入，旧提问同样撤下。
  await create("plain");
  assert.ok((await reply("plain", "先别管这个，回答我另一个问题")).includes(NOTE));
  assert.equal((await row("plain")).question, null);

  // ③ 输入回执说了算：协议明确拒收、或者一直没有定论，这句话就不算送到，提问留着等答复。
  await create("refused");
  nextReceipt = Promise.resolve("refused");
  await reply("refused", "先别管这个");
  assert.equal((await row("refused")).question, question, "拒收的消息不能撤掉提问");
  await create("unknown");
  nextReceipt = new Promise<InputAcceptance>(() => {});
  await reply("unknown", "先别管这个");
  assert.equal((await row("unknown")).question, question, "结果不明时提问留着");
  // 有界等待超时之后回执才落定成「收下了」：那时再撤。
  await create("late");
  let accept!: (fact: InputAcceptance) => void;
  nextReceipt = new Promise<InputAcceptance>((resolve) => { accept = resolve; });
  await reply("late", "先别管这个");
  assert.equal((await row("late")).question, question, "回执还没到时不撤");
  accept("accepted");
  for (let attempt = 0; attempt < 200 && (await row("late")).question !== null; attempt++) await delay(10);
  assert.equal((await row("late")).question, null, "迟到确认收下后撤卡");

  // ④ 哨兵事件这类后端代写的回合不是用户在说话：提问原样留着，也不提撤卡。
  await create("monitor", { resumePrompt: "等哨兵" });
  const before = prompts.length;
  await continueTask("monitor", "【哨兵事件】构建结束", { byBackend: true });
  const monitorPrompt = await settled("monitor", before);
  assert.equal(monitorPrompt.includes(NOTE), false);
  assert.equal((await row("monitor")).question, question, "后端代写的回合不撤提问");

  // ⑤ 起跑前登记之后 agent 又问了一次（题面一字不差）：占位换了，不许当成旧的那一问撤掉。
  await create("reasked", { status: "running" });
  await setTaskQuestion({ taskId: "reasked", question });
  assert.equal(await armQuestionSupersede(await row("reasked"), "turn-1", { sideTurn: false }), question, "普通提问可以被撤");
  await setTaskQuestion({ taskId: "reasked", question });
  await honorQuestionSupersede("reasked", "turn-1");
  assert.equal((await row("reasked")).question, question, "这一轮重新问的不能被误撤");
  assert.equal((await row("reasked")).waitOwnership?.questionSupersede, undefined, "兑现过的记录了结掉");
  await armQuestionSupersede(await row("reasked"), "turn-2", { sideTurn: false });
  await honorQuestionSupersede("reasked", "turn-1");
  assert.equal((await row("reasked")).question, question, "别的回合的确认不兑现这一轮的记录");
  await honorQuestionSupersede("reasked", "turn-2");
  assert.equal((await row("reasked")).question, null, "同一次占位照常撤下");

  // ⑥ 等回执期间服务重启：原进程里的回调没了，记录还在库里。接管入口拿到「收下了」就按它撤，
  // 拒收不撤；接回的不是登记的那一轮（令牌对不上）也不撤。
  for (const [id, fact, token, kept] of [
    ["adopt-accepted", "accepted", "adopt-turn", false],
    ["adopt-refused", "refused", "adopt-turn", true],
    ["adopt-other-turn", "accepted", "another-turn", true],
  ] as const) {
    await create(id, { status: "running", activeTurnToken: "adopt-turn" });
    await armQuestionSupersede(await row(id), "adopt-turn", { sideTurn: false });
    await settleAdoptedQuestionSupersede(id, token, Promise.resolve(fact));
    assert.equal((await row(id)).question, kept ? question : null, `${id}: 接管后按库里的记录兑现`);
  }
  await create("adopt-no-receipt", { status: "running" });
  await armQuestionSupersede(await row("adopt-no-receipt"), "adopt-turn", { sideTurn: false });
  await settleAdoptedQuestionSupersede("adopt-no-receipt", "adopt-turn", undefined);
  assert.equal((await row("adopt-no-receipt")).question, null, "没有回执能力的执行器按收下算");

  // ⑦ 确认收下后撤卡那一笔写库失败一次（之后恢复）：不许只记日志了事，退避后自己补撤。
  await create("transient", { status: "running" });
  await armQuestionSupersede(await row("transient"), "t-turn", { sideTurn: false });
  const transaction = db.transaction.bind(db);
  let injected = 0;
  db.transaction = ((...args: Parameters<typeof db.transaction>) => {
    if (!injected++) return Promise.reject(new Error("SQLITE_BUSY: injected once"));
    return transaction(...args);
  }) as typeof db.transaction;
  try {
    await honorQuestionSupersede("transient", "t-turn");
  } finally {
    db.transaction = transaction;
  }
  assert.equal((await row("transient")).question, question, "失败的那一次没撤成");
  for (let attempt = 0; attempt < 300 && (await row("transient")).question !== null; attempt++) await delay(10);
  assert.equal((await row("transient")).question, null, "退避之后自己补撤");
  assert.equal((await row("transient")).waitOwnership?.questionSupersede, undefined, "补撤成功即了结记录");

  // ⑧ 上一个进程已记下「收下了」却没来得及撤：开机扫描补做；没确认收下的记录不动。
  await create("swept");
  await armQuestionSupersede(await row("swept"), "s-turn", { sideTurn: false });
  const armed = (await row("swept")).waitOwnership!;
  await db.update(tasks).set({ waitOwnership: { ...armed, questionSupersede: { ...armed.questionSupersede!, accepted: true } } })
    .where(eq(tasks.id, "swept"));
  await create("unconfirmed");
  await armQuestionSupersede(await row("unconfirmed"), "u-turn", { sideTurn: false });
  await sweepQuestionSupersedes();
  assert.equal((await row("swept")).question, null, "开机补撤确认收下过的那一笔");
  assert.equal((await row("unconfirmed")).question, question, "没确认收下的不撤");

  // ⑨ 归审查的提问由审查链收口；旁路回合也不碰。
  await create("review", {
    waitOwnership: { question: { occupancy: "review-q", origin: { kind: "review", directory: join(root, "review"), generation: "g1" },
      text: question, options: null, items: null } },
  });
  assert.equal(await armQuestionSupersede(await row("review"), "turn-r", { sideTurn: false }), null, "审查的提问不归这条路撤");
  await create("side");
  assert.equal(await armQuestionSupersede(await row("side"), "turn-s", { sideTurn: true }), null, "旁路回合维持原状");

  console.log("user messages supersede the pending question only once input is accepted (also after restart adoption, transient failure and startup sweep); backend turns, re-asks and review questions keep it: passed");
} finally {
  unsubscribe();
  ClaudeExecutor.prototype.run = original.run;
  ClaudeExecutor.prototype.runSteerable = original.runSteerable;
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
