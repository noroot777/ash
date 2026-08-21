import { mkdirSync, createWriteStream, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { normalizeDuetConfig } from "@ash/shared/duet";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { DuetConfig, DuetConsensusBy, DuetSpeaker, GateAction, SessionRole, TaskStatus, TurnTraceEvent } from "@ash/shared";
import { db } from "../db/index.js";
import { tasks, projects, sessions } from "../db/schema.js";
import { bus } from "../bus.js";
import { id, now } from "../util.js";
import { setTaskStatus } from "../status.js";
import { trackRun, untrackRun, isCanceling, takeCanceled, CanceledRun, claimTurn, reclaimTurn, releaseTurn } from "../runs.js";
import { isAcceptingTask } from "../acceptance-lock.js";
import { reopenAcceptedStage } from "../task-stage.js";
import { taskWorkspace } from "../task-workspace.js";
import { resolveExecutorFor } from "../executors/index.js";
import type { AgentExecutor } from "../executors/types.js";
import { RUNS_DIR } from "../paths.js";
import { recordSessionUsageEvent, setSessionContext } from "../usage.js";
import * as P from "./prompts.js";
import { waitForGate } from "./gates.js";
import { gateUserMessage } from "./user-message.js";
import { canSettleDuet as canSettle, duetConsensusBy as consensusBy, isDuetConsensus as isConsensus } from "./settlement.js";
import { withGlobalBrowserPolicy } from "../browser-verification-policy.js";
import { recordGateEvent, recordTurnStart, recordUserTurn } from "./timeline.js";

const RAISE_RE = /(^|\n)\s*\[可收敛\]/;
const AGREE_RE = /与对方一致[：:]\s*是/; // self-declared agreement with the opponent's conclusion
const CONC_RE = /结论[：:]\s*(.+)/; // one-line final conclusion

// duet 的所有权与 single 共用 runs.ts 那把单飞锁。这里原来是个模块内的 `running`
// Set:调用方看不见它,于是 /run、/fire、/retry、scheduler 都能声称「已启动」而第二次
// 调用在函数入口静默返回(审查实测:双并发 retry 双双 202);验收锁也挡不住 duet,验收
// 正在合并/清理 worktree 时 loadBase/taskWorkspace 还能与它并发跑。
//   turnHeld  = 入口在最后一个 await 之后已原子占位(并已镜像检查过验收锁),这里接管;
//   自己占    = 占不到 → 确有回合在跑;占到后再镜像检查验收锁,撞上就退位。
// 返回是否取得所有权:false = 一步都没跑,调用方据此回 409 / 不消费调度班次。
function acquireDuetTurn(taskId: string, turnHeld?: boolean): boolean {
  if (turnHeld) { reclaimTurn(taskId, "duet"); return true; }
  if (!claimTurn(taskId, "duet")) return false;
  if (isAcceptingTask(taskId)) { releaseTurn(taskId); return false; }
  return true;
}

async function setStatus(taskId: string, status: TaskStatus) {
  await setTaskStatus(taskId, status);
}

/**
 * 复用同一条 session 行接着跑下一轮时,必须跟着刷新的那几列。
 *
 * duet 每一轮都按当前 profile 重新解析执行器,而门禁可以等很久 —— 这期间 profile 可能
 * 被改到另一台机器上、worktree 可能被删后重建。这几列合起来正是「复制到终端接着聊」
 * 那条命令的全部依据(读取端 `resumeCommandFor` 每次按它们重算):漏掉 target 会给出一条
 * 在本机跑的错命令,漏掉 cwd 会给出一条 `cd` 到不存在目录的命令(第 2 轮审查 finding 6)。
 * 单独拎出来是为了让「哪些列会随轮次变」有一个能被测试钉住的地方。
 */
export function reusedSessionPatch(executor: AgentExecutor, cwd: string, commandLine: string, cliSessionId: string) {
  return {
    commandLine,
    executor: executor.label,
    cwd,
    // CLI 还没报出 session_id 时这三样都算不出来,那就一列都不碰 —— 写一条缺了 id 的
    // 恢复命令,比留着上一轮那条更糟。
    ...(cliSessionId ? executor.resumeFields(cwd, cliSessionId) : {}),
  };
}

interface Turn {
  rowId: string;
  cliId: string;
  text: string;
  raised: boolean;
  agrees: boolean; // self-declared "我的最终结论与对方一致" (only meaningful when raised)
  conclusion?: string; // self-declared one-line 结论 (for the gate display)
  exit: number;
  error?: string;
}

// Run one voice turn: stream events tagged with role+round, persist output +
// credential, and detect the raise-hand marker.
async function runTurn(args: {
  taskId: string;
  role: SessionRole;
  speaker: DuetSpeaker;
  round: number;
  executor: AgentExecutor;
  prompt: string;
  cwd: string;
  rowId?: string; // reuse a voice's session row across turns
  resumeCliId?: string; // resume the CLI session
  branch?: string | null;
  // 收敛状态下限:进入本轮前该方已有的 raised/结论。提问(ask)轮讨论者被要求不写
  // [可收敛],若它本轮没主动收敛就继承既有状态,避免一次澄清把已达成的共识打回。
  inherit?: { raised: boolean; agrees: boolean; conclusion?: string };
  // 附加进 transcript 行的元数据(如合稿轮的 stop 标签),读取端靠它区分
  // 「已收敛的共同方案」与「未共识的决策文档」。
  extra?: Record<string, unknown>;
}): Promise<Turn> {
  const { taskId, role, speaker, round, executor, prompt, cwd } = args;
  // A stop requested between turns: don't even spawn the next one.
  if (isCanceling(taskId)) throw new CanceledRun();
  const turnStart = now();
  const handle = executor.run({
    prompt: withGlobalBrowserPolicy(prompt, args.resumeCliId ? "reminder" : "full"),
    cwd,
    sessionId: args.resumeCliId || undefined,
  });
  trackRun(taskId, handle);
  let cliId = handle.sessionId;

  const rowId = args.rowId ?? id();
  if (!args.rowId) {
    await db.insert(sessions).values({
      id: rowId,
      taskId,
      role,
      agentType: executor.type,
      // 开新行和复用旧行共用同一份「随执行器/工作目录走」的列,免得两条分支各写各的、
      // 时间一长只有一边跟得上(finding 6 就是这么来的)。
      ...reusedSessionPatch(executor, cwd, handle.commandLine, cliId),
      worktreePath: args.branch ? cwd : null,
      branch: args.branch ?? null,
      cliSessionId: cliId,
      startedAt: turnStart,
      turnStartedAt: turnStart,
      activeMs: 0,
      exitStatus: null,
    });
  } else {
    // Resuming the same session row for a new turn (e.g. after a gate the
    // user took a while to resolve): stamp this turn's start and clear the prior
    // end, so the gate wait is excluded from execution time.
    await db
      .update(sessions)
      .set({ turnStartedAt: turnStart, endedAt: null, ...reusedSessionPatch(executor, cwd, handle.commandLine, cliId) })
      .where(eq(sessions.id, rowId));
  }

  recordTurnStart({ type: "duet.progress", taskId, round, speaker, phase: "start", startedAt: turnStart });

  const runDir = join(RUNS_DIR, taskId);
  mkdirSync(runDir, { recursive: true });
  const out = createWriteStream(join(runDir, `${rowId}.md`), { flags: "a" });
  out.write(`\n\n### 第 ${round} 轮 · ${speaker}\n`);

  let text = "";
  let exit = 0;
  let errorMsg: string | undefined;
  // 本回合的执行过程,随回合一起落盘(见 TurnTraceEvent):刷新后时间线才展得开。
  const trace: TurnTraceEvent[] = [];
  const TRACE_CAP = 200;
  try {
    for await (const event of handle.events) {
      const emittedEvent = event.kind === "usage"
        ? await recordSessionUsageEvent(rowId, event, executor.type, cliId)
        : event;
      bus.publish({ type: "agent.event", taskId, sessionId: rowId, role, event: emittedEvent });
      if (event.kind === "session" && event.cliSessionId !== cliId) {
        cliId = event.cliSessionId;
        await db
          .update(sessions)
          .set({ cliSessionId: cliId, ...executor.resumeFields(cwd, cliId) })
          .where(eq(sessions.id, rowId));
      } else if (event.kind === "text") {
        text += event.text;
        out.write(event.text + "\n");
      } else if (event.kind === "tool") {
        if (trace.length < TRACE_CAP) trace.push({ kind: "tool", label: event.name, detail: event.detail });
      } else if (event.kind === "thinking") {
        if (trace.length < TRACE_CAP) trace.push({ kind: "thinking", label: "思考过程", detail: event.text });
        out.write("〔思考〕" + event.text + "\n");
      } else if (event.kind === "error") {
        errorMsg = event.message;
        out.write("✕ " + event.message + "\n");
      } else if (event.kind === "context") {
        await setSessionContext(rowId, event.context);
      } else if (event.kind === "done") {
        exit = event.exitStatus;
      }
    }
  } finally {
    untrackRun(taskId, handle);
  }
  out.end();

  let raised = RAISE_RE.test(text);
  let agrees = raised && AGREE_RE.test(text);
  let conclusion = text.match(CONC_RE)?.[1]?.trim().slice(0, 140) || undefined;
  // 提问轮:讨论者按 prompt 不写 [可收敛]。若它进入本轮前本就已收敛,一次澄清提问不该让它
  // "放下手"——继承既有收敛状态，否则 isConsensus 会被一次提问打回为"未达成一致"。
  if (args.inherit && !raised) {
    raised = args.inherit.raised;
    agrees = args.inherit.agrees;
    conclusion = args.inherit.conclusion;
  }
  // A voice turn that exits cleanly but says nothing is degenerate (e.g. a
  // resume that returned no text) — treat it as a failure so the duet stops
  // instead of feeding emptiness to the opponent.
  const isVoice = role === "voiceA" || role === "voiceB";
  if (!errorMsg && exit === 0 && isVoice && !text.trim()) {
    errorMsg = `${executor.type} 本轮没有产出任何内容（空回复），可能是会话恢复异常`;
  }
  const endIso = now();
  const durationMs = Math.max(0, Date.parse(endIso) - Date.parse(turnStart));
  await db
    .update(sessions)
    .set({ exitStatus: exit, endedAt: endIso, activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${durationMs}` })
    .where(eq(sessions.id, rowId));
  // Persist the turn so a reloaded duet can rebuild its timeline (no live
  // events). Includes the error so a failed turn stays visibly failed on reload.
  try {
    appendFileSync(
      join(runDir, "transcript.jsonl"),
      JSON.stringify({ ...args.extra, round, speaker, text, raised, agrees, conclusion, error: errorMsg, startedAt: turnStart, at: endIso, durationMs, events: trace }) + "\n",
    );
  } catch {
    /* best effort */
  }
  bus.publish({ type: "duet.progress", taskId, round, speaker, phase: "end", raisedHand: raised, at: endIso, startedAt: turnStart, durationMs });
  // A manual stop killed this turn's subprocess → unwind to canceled (the top of
  // each entry point catches CanceledRun).
  if (isCanceling(taskId)) throw new CanceledRun();
  return { rowId, cliId, text, raised, agrees, conclusion, exit, error: errorMsg };
}

// A turn is unusable if the CLI errored, exited non-zero, or (for voices)
// produced no content — the duet must stop, not proceed on a missing reply.
const failed = (t: Turn) => t.exit !== 0 || !!t.error;
const HARD_CAP = 50; // absolute safety cap, even when maxRounds is "不设限"

// Mutable duet state threaded through the pipeline so fresh-start and resume
// share one rebuttal loop and consensus gate.
interface Ctx {
  taskId: string;
  cfg: DuetConfig;
  exA: AgentExecutor;
  exB: AgentExecutor;
  cwd: string;
  cap: number;
  A: { rowId: string; cliId: string };
  B: { rowId: string; cliId: string };
  round: number;
  lastA: string;
  lastB: string;
  raisedA: boolean;
  raisedB: boolean;
  agreesA: boolean;
  agreesB: boolean;
  conclusionA?: string;
  conclusionB?: string;
  // 最近一次合稿(synthesis)对应的发言轮次;null=还没合过稿。方案是否过时的判据:
  // planRound < 最后一个 A/B 发言轮(ctx.round)。
  planRound: number | null;
  // 用户最近一次 gate 介入(inject/提问)的原文。合稿由 A 的会话执行,定向提问 B 时
  // A 没见过问题原文,只看 B 的回答会不知所云 —— 合稿 prompt 把它一并附上。
  lastUserNote?: { text: string; target?: "A" | "B" };
}

function applyTurn(ctx: Ctx, sp: "A" | "B", t: Turn) {
  if (sp === "A") {
    ctx.A.cliId = t.cliId; ctx.lastA = t.text; ctx.raisedA = t.raised; ctx.agreesA = t.agrees; ctx.conclusionA = t.conclusion;
  } else {
    ctx.B.cliId = t.cliId; ctx.lastB = t.text; ctx.raisedB = t.raised; ctx.agreesB = t.agrees; ctx.conclusionB = t.conclusion;
  }
}

// transcript 重建时找最近一次成功合稿的轮次(speaker "synthesis" 且无 error)。
function lastPlanRound(rows: any[]): number | null {
  const plan = [...rows].reverse().find((r) => r.speaker === "synthesis" && !r.error && typeof r.round === "number");
  return plan ? plan.round : null;
}

// transcript 重建时找用户最近一次 gate 介入(inject/提问)的原文,喂给合稿。
function lastUserNoteOf(rows: any[]): { text: string; target?: "A" | "B" } | undefined {
  const note = [...rows].reverse().find((r) => r.speaker === "user" && typeof r.text === "string" && r.text.trim());
  return note ? { text: note.text, target: note.target === "A" || note.target === "B" ? note.target : undefined } : undefined;
}

// 某一轮是否是 gate 介入轮:同 round 的最后一条 user 行。kind 旧行没存 —— 按
// 「有 target 即定向提问,否则按 inject」推断(inject 双方回炉,是更保守的一档)。
export function gateRoundOf(
  rows: { speaker?: string; round?: number; text?: string; target?: string; kind?: string }[],
  round: number,
): { kind: "inject" | "ask"; text: string; target?: "A" | "B" } | null {
  const note = [...rows].reverse().find((r) => r.speaker === "user" && r.round === round && typeof r.text === "string" && r.text.trim());
  if (!note) return null;
  const target = note.target === "A" || note.target === "B" ? note.target : undefined;
  const kind = note.kind === "ask" || note.kind === "inject" ? note.kind : target ? "ask" : "inject";
  return { kind, text: note.text!, target };
}

// 收敛后的合稿轮:resume 讨论者 A 的会话(整场上下文都在),把讨论成果整理成一份
// 共同方案文档,作为 /duet 的正式产出——gate 上两行 140 字的结论只够扫一眼,拍板
// 与交接执行需要的是全文。inject/提问回炉后方案会过时,进 gate 前按 planRound
// 判据重新合稿。失败降级:讨论本身已收敛,合稿失败不该把整场打成 failed——
// transcript 里已留错误行(时间线可见),照常走 gate/done。
async function synthesizePlan(ctx: Ctx): Promise<void> {
  if (ctx.planRound != null && ctx.planRound >= ctx.round) return; // 方案没过时
  const stop: P.SynthesizeStop = isConsensus(ctx)
    ? "consensus"
    : canSettle(ctx)
      ? "agreedToStop"
      : ctx.round >= ctx.cap
        ? "roundCap"
        : "midway";
  try {
    const t = await runTurn({
      taskId: ctx.taskId, role: "voiceA", speaker: "synthesis", round: ctx.round,
      executor: ctx.exA,
      // 停止原因要如实告知合稿者并落盘:双方举手但结论不同 ≠ 轮数耗尽;
      // 回炉后刚更新一轮、还没到轮数上限也没重新收敛 = midway(先开门给用户看)。
      prompt: P.synthesize({ stop, opponentLatest: ctx.lastB, userNote: ctx.lastUserNote }),
      extra: { stop },
      cwd: ctx.cwd,
      rowId: ctx.A.rowId, resumeCliId: ctx.A.cliId || undefined,
    });
    ctx.A.cliId = t.cliId;
    if (!failed(t)) ctx.planRound = ctx.round;
  } catch (err) {
    if (err instanceof CanceledRun) throw err; // 手动停止照常结算 canceled
    /* 合稿失败降级:错误行已落 transcript,不拦收敛 */
  }
}

async function loadBase(taskId: string) {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || !task.duet) throw new Error("duet config missing");
  const storedCfg = normalizeDuetConfig(JSON.parse(task.duet));
  const origin = task.originTaskId
    ? (await db.select().from(tasks).where(eq(tasks.id, task.originTaskId))).at(0)
    : null;
  // Derived duets carry their source-aware brief in task.body. Directly-created
  // duets preserve the legacy cfg.topic semantics even if an API caller also
  // happened to provide a body.
  const derivedBody = origin ? task.body.trim() : "";
  const cfg = derivedBody ? { ...storedCfg, topic: derivedBody } : storedCfg;
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) throw new Error("project not found");
  // 每个讨论者各自的模型/强度；没设才退回任务级（派生讨论会带着来源任务的设置）。
  const exA = await resolveExecutorFor({
    executorId: cfg.voiceAExecutorId,
    type: cfg.voiceA,
    model: cfg.voiceAModel || task.model,
    reasoningEffort: cfg.voiceAReasoningEffort || task.reasoningEffort,
  });
  const exB = await resolveExecutorFor({
    executorId: cfg.voiceBExecutorId,
    type: cfg.voiceB,
    model: cfg.voiceBModel || task.model,
    reasoningEffort: cfg.voiceBReasoningEffort || task.reasoningEffort,
  });
  // Discussion only reads, but still honors the task's worktree/base so a
  // source-derived duet sees the source task's branch. Repo-less projects keep
  // the existing scratch fallback through taskWorkspace.
  const cwd = (await taskWorkspace(task, project.repoPath)).path;
  const cap = Math.min(cfg.maxRounds ?? HARD_CAP, HARD_CAP);
  return { task, cfg, exA, exB, cwd, cap };
}

// Full /duet pipeline: blind opening (parallel) → serial rebuttal rounds
// (A-first) → optional consensus gate G1 → conclusion.
export async function runDuet(taskId: string, opts: { turnHeld?: boolean } = {}): Promise<boolean> {
  if (!acquireDuetTurn(taskId, opts.turnHeld)) return false;
  try {
    const base = await loadBase(taskId);
    const { cfg, exA, exB, cwd } = base;
    await setStatus(taskId, "running");
    // 与 single 的 fresh run 对齐:已验收任务被重跑(Cron 到点 / fire),旧「已验收」
    // 牌子当场摘掉——新一版讨论不能躲在旧牌子下继续。
    await reopenAcceptedStage(taskId);

    // Title the task from its topic (concurrent, non-blocking) like a single task.
    if (base.task.autoTitle) void genDuetTitle(taskId, cfg.topic, exA, cwd);

    // Round 1 — blind opening, parallel.
    const [a, b] = await Promise.all([
      runTurn({ taskId, role: "voiceA", speaker: "A", round: 1, executor: exA, prompt: P.opening(cfg.topic, cwd), cwd }),
      runTurn({ taskId, role: "voiceB", speaker: "B", round: 1, executor: exB, prompt: P.opening(cfg.topic, cwd), cwd }),
    ]);
    if (failed(a) || failed(b)) { await setStatus(taskId, "failed"); return true; }

    const ctx: Ctx = {
      taskId, cfg, exA, exB, cwd, cap: base.cap,
      A: { rowId: a.rowId, cliId: a.cliId }, B: { rowId: b.rowId, cliId: b.cliId }, round: 1,
      lastA: a.text, lastB: b.text, raisedA: a.raised, raisedB: b.raised,
      agreesA: a.agrees, agreesB: b.agrees, conclusionA: a.conclusion, conclusionB: b.conclusion,
      planRound: null,
    };
    if (!(await runRebuttalLoop(ctx))) return true;
    await finishDiscussion(ctx);
  } catch (err) {
    failDuet(taskId, err);
  } finally {
    releaseTurn(taskId);
  }
  return true; // 取得所有权并跑完了(成败已落进任务状态),对调用方就是「真的启动过」
}

// Retry a FAILED duet by re-running only the failed (last) turn, then
// continuing — instead of re-running the whole duet. State is rebuilt from the
// persisted sessions + transcript; the failed turn is dropped from the transcript
// and re-run (resuming the same CLI session so context is retained).
export async function resumeDuet(taskId: string, opts: { turnHeld?: boolean } = {}): Promise<boolean> {
  if (!acquireDuetTurn(taskId, opts.turnHeld)) return false;
  // 交棒给 runDuet 时由它释放:两边都释放会把**下一次**运行占的锁误删。
  let handedOff = false;
  try {
    const base = await loadBase(taskId);
    const { cfg, exA, exB, cwd } = base;

    const sess = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
    const latest = (role: string) =>
      sess.filter((s) => s.role === role).sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0];
    const sA = latest("voiceA");
    const sB = latest("voiceB");

    const tpath = join(RUNS_DIR, taskId, "transcript.jsonl");
    let rows: any[] = [];
    try { rows = readFileSync(tpath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
    const failedIndex = rows.findLastIndex((row) =>
      !row.type && ["A", "B", "impl", "review"].includes(row.speaker));
    if (failedIndex < 0) { handedOff = true; void runDuet(taskId, { turnHeld: true }); return true; } // no completed turn → fresh
    const failedTurn = rows[failedIndex];
    rows.splice(failedIndex, 1); // drop the failed turn; it will be re-run
    writeFileSync(tpath, rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");

    const lastOf = (sp: string) => [...rows].reverse().find((r) => !r.type && r.speaker === sp);
    const ra = lastOf("A");
    const rb = lastOf("B");
    const ctx: Ctx = {
      taskId, cfg, exA, exB, cwd, cap: base.cap,
      A: { rowId: sA?.id ?? id(), cliId: sA?.cliSessionId ?? "" },
      B: { rowId: sB?.id ?? id(), cliId: sB?.cliSessionId ?? "" },
      round: failedTurn.round,
      lastA: ra?.text ?? "", lastB: rb?.text ?? "",
      raisedA: ra?.raised ?? false, raisedB: rb?.raised ?? false,
      agreesA: ra?.agrees ?? false, agreesB: rb?.agrees ?? false,
      conclusionA: ra?.conclusion, conclusionB: rb?.conclusion,
      planRound: lastPlanRound(rows),
      lastUserNote: lastUserNoteOf(rows),
    };
    await setStatus(taskId, "running");

    if (failedTurn.speaker !== "A" && failedTurn.speaker !== "B") {
      // A retired code-writing turn failed. The discussion itself is already a
      // valid /duet result, so retrying the historical task now settles it there.
      await setStatus(taskId, "done");
      return true;
    }

    // Voice-phase failure: re-run the failed turn(s) to complete its round,
    // then hand to the normal loop (which continues from the next round).
    const R = failedTurn.round;
    const sp = failedTurn.speaker as "A" | "B";
    // 失败的这一轮如果是 gate 介入轮(同 round 有 user 行),重跑必须**重放用户的
    // 原话**(inject 回炉 / ask 提问),不能退回普通 evolve —— 否则重试后任务是继续
    // 了,用户的意见/问题/附件却被丢了。kind 落盘于 recordUserTurn;旧行没有 kind,
    // 按「有 target 即定向提问」推断,否则按 inject(双方回炉,更保守)。
    const gateNote = gateRoundOf(rows, R);
    const re = (s: "A" | "B", round: number) => {
      const isGateRound = round === R && !!gateNote;
      const inheritOf = (side: "A" | "B") => (side === "A"
        ? { raised: ctx.raisedA, agrees: ctx.agreesA, conclusion: ctx.conclusionA }
        : { raised: ctx.raisedB, agrees: ctx.agreesB, conclusion: ctx.conclusionB });
      return runTurn({
        taskId, role: s === "A" ? "voiceA" : "voiceB", speaker: s, round,
        executor: s === "A" ? exA : exB,
        prompt: isGateRound
          ? (gateNote!.kind === "inject" ? P.injectFeedback(gateNote!.text, round) : P.question(gateNote!.text, round))
          : round === 1 ? P.opening(cfg.topic, cwd) : P.evolve(s === "A" ? ctx.lastB : ctx.lastA, round),
        cwd, rowId: s === "A" ? ctx.A.rowId : ctx.B.rowId,
        resumeCliId: (s === "A" ? ctx.A.cliId : ctx.B.cliId) || undefined,
        // 与 reDiscuss 同语义:提问=澄清,继承既有收敛状态;注入=回炉,允许改判。
        inherit: isGateRound && gateNote!.kind === "ask" ? inheritOf(s) : undefined,
      });
    };

    const t1 = await re(sp, R);
    if (failed(t1)) { await setStatus(taskId, "failed"); return true; }
    applyTurn(ctx, sp, t1);
    // A failed mid-round → B of the same round may still need to run. 补跑口径与
    // reDiscuss 对齐:inject/双向 ask 双方都要跑(不看 canSettle);定向介入只跑
    // 目标方;普通 evolve 轮维持「A 已收敛就不再叫 B」。
    const needB = R > 1 && sp === "A"
      && (gateNote ? !gateNote.target : !canSettle(ctx));
    if (needB) {
      const t2 = await re("B", R);
      if (failed(t2)) { await setStatus(taskId, "failed"); return true; }
      applyTurn(ctx, "B", t2);
    }
    ctx.round = R;

    if (!(await runRebuttalLoop(ctx))) return true;
    await finishDiscussion(ctx);
  } catch (err) {
    failDuet(taskId, err);
  } finally {
    if (!handedOff) releaseTurn(taskId);
  }
  return true;
}

function failDuet(taskId: string, err: unknown) {
  // A manual stop unwinds here as CanceledRun → settle as canceled, not failed.
  if (err instanceof CanceledRun) {
    takeCanceled(taskId);
    void setStatus(taskId, "canceled");
    return;
  }
  bus.publish({
    type: "agent.event", taskId, sessionId: "", role: "voiceA",
    event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
  });
  void setStatus(taskId, "failed");
}

// Auto-generate a short list-friendly title from the topic — the duet analog of
// a single task's auto-title. Runs concurrently with round 1 (it doesn't block the
// duet) and is best-effort: on any failure the provisional title simply stays.
async function genDuetTitle(taskId: string, topic: string, ex: AgentExecutor, cwd: string): Promise<void> {
  try {
    const handle = ex.run({ prompt: P.title(topic), cwd });
    let text = "";
    for await (const event of handle.events) {
      if (event.kind === "text") text += event.text;
    }
    const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    const newTitle = line.replace(/^标题[:：]\s*/, "").replace(/[`*"「」]/g, "").trim().slice(0, 20);
    if (!newTitle) return;
    // Don't clobber a title the user edited in the meantime.
    const cur = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!cur?.autoTitle) return;
    const updatedAt = now();
    await db.update(tasks).set({ title: newTitle, autoTitle: false, updatedAt }).where(eq(tasks.id, taskId));
    bus.publish({ type: "task.title", taskId, title: newTitle, updatedAt });
  } catch {
    /* best effort */
  }
}

// Resume a duet that is parked at a gate but whose in-memory gate was lost (the
// server restarted). Rebuilds state from the persisted transcript + sessions and
// applies the human's gate action, so the gate keeps working across restarts.
export async function resumeAtGate(taskId: string, action: GateAction, opts: { turnHeld?: boolean } = {}): Promise<boolean> {
  // 占不到 = 确有回合在跑(活着的 duet 停在闸口时也占着这把锁,那种情况 resolveGate
  // 已经就地处理了,根本走不到这儿)。
  if (!acquireDuetTurn(taskId, opts.turnHeld)) return false;
  try {
    const base = await loadBase(taskId);
    const sess = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
    const latest = (role: string) =>
      sess.filter((s) => s.role === role).sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0];
    const sA = latest("voiceA");
    const sB = latest("voiceB");

    let rows: any[] = [];
    try { rows = readFileSync(join(RUNS_DIR, taskId, "transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
    const lastOf = (sp: string) => [...rows].reverse().find((r) => !r.type && r.speaker === sp);
    const ra = lastOf("A");
    const rb = lastOf("B");
    const duetRounds = rows.filter((r) => r.speaker === "A" || r.speaker === "B").map((r) => r.round);
    const ctx: Ctx = {
      taskId, cfg: base.cfg, exA: base.exA, exB: base.exB, cwd: base.cwd, cap: base.cap,
      A: { rowId: sA?.id ?? id(), cliId: sA?.cliSessionId ?? "" },
      B: { rowId: sB?.id ?? id(), cliId: sB?.cliSessionId ?? "" },
      round: duetRounds.length ? Math.max(...duetRounds) : 1,
      lastA: ra?.text ?? "", lastB: rb?.text ?? "",
      raisedA: ra?.raised ?? false, raisedB: rb?.raised ?? false,
      agreesA: ra?.agrees ?? false, agreesB: rb?.agrees ?? false,
      conclusionA: ra?.conclusion, conclusionB: rb?.conclusion,
      planRound: lastPlanRound(rows),
      lastUserNote: lastUserNoteOf(rows),
    };
    recordGateEvent({ type: "duet.gate", taskId, gate: "G1", open: false });
    await setStatus(taskId, "running");

    if (action.kind === "reject") { await setStatus(taskId, "canceled"); return true; }
    if (action.kind === "approve") { await setStatus(taskId, "done"); return true; }
    await reDiscuss(ctx, action.kind, action.text, action.kind === "ask" ? action.target : undefined, action.attachments);
    await finishDiscussion(ctx);
  } catch (err) {
    failDuet(taskId, err);
  } finally {
    releaseTurn(taskId);
  }
  return true;
}

// Serial rebuttal rounds (A-first). Returns false (and sets status=failed) if a
// turn is unusable; true when the loop ends normally (convergence or cap).
async function runRebuttalLoop(ctx: Ctx): Promise<boolean> {
  const { taskId, exA, exB, cwd } = ctx;
  while (!canSettle(ctx) && ctx.round < ctx.cap) {
    ctx.round++;
    const at = await runTurn({
      taskId, role: "voiceA", speaker: "A", round: ctx.round, executor: exA,
      prompt: P.evolve(ctx.lastB, ctx.round), cwd, rowId: ctx.A.rowId, resumeCliId: ctx.A.cliId || undefined,
    });
    if (failed(at)) { await setStatus(taskId, "failed"); return false; }
    applyTurn(ctx, "A", at);
    if (canSettle(ctx)) break;
    const bt = await runTurn({
      taskId, role: "voiceB", speaker: "B", round: ctx.round, executor: exB,
      prompt: P.evolve(ctx.lastA, ctx.round), cwd, rowId: ctx.B.rowId, resumeCliId: ctx.B.cliId || undefined,
    });
    if (failed(bt)) { await setStatus(taskId, "failed"); return false; }
    applyTurn(ctx, "B", bt);
  }
  return true;
}

// Human feedback/question → both voices reconsider (used inside the gate loop and
// when resuming a gate after a restart). `target` (ask only) directs the question
// at a single voice: only that side runs, the other keeps its state untouched
// (so a directed clarification can't knock the opponent off an already-raised
// hand). inject always re-runs BOTH — 回炉 means both reconsider.
async function reDiscuss(ctx: Ctx, kind: "inject" | "ask", text: string, target?: "A" | "B", attachments?: string[]) {
  ctx.round++;
  const tgt = kind === "ask" ? target : undefined; // inject ignores target
  // 附件(截图/文件)跟着人的这句话走:时间线上的气泡和讨论者拿到的 prompt 都带上它们,
  // 讨论者按路径自己 Read。成稿单点在 gateUserMessage。
  const message = gateUserMessage(text, attachments);
  recordUserTurn(ctx.taskId, ctx.round, message, kind, tgt); // the human's words land in the timeline first
  const prompt = kind === "inject" ? P.injectFeedback(message, ctx.round) : P.question(message, ctx.round);
  // 提问=澄清,不该打回已达成的收敛/结论(继承既有状态);注入=回炉重议,允许双方改判(不继承)。
  const inhA = kind === "ask" ? { raised: ctx.raisedA, agrees: ctx.agreesA, conclusion: ctx.conclusionA } : undefined;
  const inhB = kind === "ask" ? { raised: ctx.raisedB, agrees: ctx.agreesB, conclusion: ctx.conclusionB } : undefined;
  // 回炉轮跟正常轮一样要有失败检查:失败的回合文本是空的/错的,吞下去会让任务
  // 带着垃圾状态继续合稿、重开 gate,甚至被批准完成。抛出去由外层 failDuet 落
  // failed(错误行已在 transcript,用户可重试)。
  if (tgt !== "B") {
    const at = await runTurn({ taskId: ctx.taskId, role: "voiceA", speaker: "A", round: ctx.round, executor: ctx.exA, prompt, cwd: ctx.cwd, rowId: ctx.A.rowId, resumeCliId: ctx.A.cliId || undefined, inherit: inhA });
    if (failed(at)) throw new Error(`讨论者 A 在回炉轮失败${at.error ? `：${at.error}` : ""}`);
    applyTurn(ctx, "A", at);
  }
  if (tgt !== "A") {
    const bt = await runTurn({ taskId: ctx.taskId, role: "voiceB", speaker: "B", round: ctx.round, executor: ctx.exB, prompt, cwd: ctx.cwd, rowId: ctx.B.rowId, resumeCliId: ctx.B.cliId || undefined, inherit: inhB });
    if (failed(bt)) throw new Error(`讨论者 B 在回炉轮失败${bt.error ? `：${bt.error}` : ""}`);
    applyTurn(ctx, "B", bt);
  }
  ctx.lastUserNote = { text: message, target: tgt };
}

// /duet is discussion-only: after convergence a synthesis turn writes the joint
// plan, and that document is the output.
// 收敛门(G1)开 → 让人读方案后放行(=结束)/打回(=取消)/注入·提问(=再讨论)；关 → 直接 done。
async function finishDiscussion(ctx: Ctx): Promise<void> {
  const { taskId, cfg } = ctx;
  await synthesizePlan(ctx); // 先合稿再开门:gate 上用户拍板的依据就是这份方案
  if (cfg.gateG1 === "on") {
    const approved = await runGate(taskId, async (k, t, target, files) => {
      await reDiscuss(ctx, k, t, target, files);
      await synthesizePlan(ctx); // 回炉/澄清后方案已过时,重新合稿再开门
    }, () => ({
      consensus: isConsensus(ctx),
      consensusBy: consensusBy(ctx),
      conclusionA: ctx.conclusionA ?? null,
      conclusionB: ctx.conclusionB ?? null,
    }));
    if (!approved) return void (await setStatus(taskId, "canceled"));
  }
  await setStatus(taskId, "done"); // 讨论结束,共同方案(合稿)即是产出
}

// Open a HITL gate and act on the human's decision; loops on inject/ask. The
// optional getInfo() supplies the current consensus + both conclusions so the
// gate UI can show "已达成共识" vs "分歧待裁决" (re-evaluated each loop in case a
// re-discussion changed things).
async function runGate(
  taskId: string,
  reAction: (kind: "inject" | "ask", text: string, target?: "A" | "B", attachments?: string[]) => Promise<void>,
  getInfo?: () => { consensus: boolean; consensusBy?: DuetConsensusBy; conclusionA: string | null; conclusionB: string | null },
): Promise<boolean> {
  while (true) {
    await setStatus(taskId, "awaiting_review");
    const info = getInfo?.();
    recordGateEvent({
      type: "duet.gate", taskId, gate: "G1", open: true,
      consensus: info?.consensus, consensusBy: info?.consensusBy, conclusionA: info?.conclusionA, conclusionB: info?.conclusionB,
    });
    const action = await waitForGate(taskId);
    recordGateEvent({ type: "duet.gate", taskId, gate: "G1", open: false });
    if (action.kind === "approve") {
      await setStatus(taskId, "running");
      return true;
    }
    if (action.kind === "reject") return false;
    await setStatus(taskId, "running");
    await reAction(action.kind, action.text, action.kind === "ask" ? action.target : undefined, action.attachments);
  }
}
