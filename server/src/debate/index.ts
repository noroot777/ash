import { mkdirSync, createWriteStream, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type {
  DebateConfig,
  DebateSpeaker,
  GateAction,
  SessionRole,
  TaskStatus,
} from "@harness/shared";
import { db } from "../db/index.js";
import { tasks, projects, sessions } from "../db/schema.js";
import { bus } from "../bus.js";
import { id, now } from "../util.js";
import { setTaskStatus } from "../status.js";
import { trackRun, untrackRun, isCanceling, takeCanceled, CanceledRun } from "../runs.js";
import { commitWorktree, ensureWorkdir, resolveWorkspace } from "../git.js";
import { resolveExecutor } from "../executors/index.js";
import type { AgentExecutor } from "../executors/types.js";
import { RUNS_DIR } from "../paths.js";
import * as P from "./prompts.js";
import { waitForGate } from "./gates.js";

const RAISE_RE = /(^|\n)\s*\[可收敛\]/;
const AGREE_RE = /与对方一致[：:]\s*是/; // self-declared agreement with the opponent's conclusion
const CONC_RE = /结论[：:]\s*(.+)/; // one-line final conclusion
const running = new Set<string>();

async function setStatus(taskId: string, status: TaskStatus) {
  await setTaskStatus(taskId, status);
}

// Persist + broadcast a human intervention (gate inject/ask) as a `user` turn so
// the /pair timeline shows when the user spoke. Best-effort transcript append;
// the live event drives the open page.
function recordUserTurn(taskId: string, round: number, text: string) {
  const at = now();
  try {
    appendFileSync(
      join(RUNS_DIR, taskId, "transcript.jsonl"),
      JSON.stringify({ round, speaker: "user", text, at }) + "\n",
    );
  } catch {
    /* best effort */
  }
  bus.publish({ type: "debate.user", taskId, round, text, at });
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

// Run one debater/implementer turn: stream events tagged with role+round, persist
// output + credential, detect the raise-hand marker.
async function runTurn(args: {
  taskId: string;
  role: SessionRole;
  speaker: DebateSpeaker;
  round: number;
  executor: AgentExecutor;
  prompt: string;
  cwd: string;
  rowId?: string; // reuse a debater's session row across turns
  resumeCliId?: string; // resume the CLI session
  branch?: string | null;
  // 收敛状态下限:进入本轮前该方已有的 raised/结论。提问(ask)轮辩手被要求不写
  // [可收敛],若它本轮没主动收敛就继承既有状态,避免一次澄清把已达成的共识打回。
  inherit?: { raised: boolean; agrees: boolean; conclusion?: string };
}): Promise<Turn> {
  const { taskId, role, speaker, round, executor, prompt, cwd } = args;
  // A stop requested between turns: don't even spawn the next one.
  if (isCanceling(taskId)) throw new CanceledRun();
  const handle = executor.run({ prompt, cwd, sessionId: args.resumeCliId || undefined });
  trackRun(taskId, handle);
  let cliId = handle.sessionId;

  const rowId = args.rowId ?? id();
  if (!args.rowId) {
    await db.insert(sessions).values({
      id: rowId,
      taskId,
      role,
      agentType: executor.type,
      executor: executor.label,
      target: "local",
      worktreePath: args.branch ? cwd : null,
      branch: args.branch ?? null,
      cwd,
      cliSessionId: cliId,
      resumeCommand: cliId ? executor.resumeCommand(cwd, cliId) : null,
      commandLine: handle.commandLine,
      startedAt: now(),
      exitStatus: null,
    });
  }

  bus.publish({ type: "debate.progress", taskId, round, speaker, phase: "start" });

  const runDir = join(RUNS_DIR, taskId);
  mkdirSync(runDir, { recursive: true });
  const out = createWriteStream(join(runDir, `${rowId}.md`), { flags: "a" });
  out.write(`\n\n### 第 ${round} 轮 · ${speaker}\n`);

  let text = "";
  let exit = 0;
  let errorMsg: string | undefined;
  try {
    for await (const event of handle.events) {
      bus.publish({ type: "agent.event", taskId, sessionId: rowId, role, event });
      if (event.kind === "session" && event.cliSessionId !== cliId) {
        cliId = event.cliSessionId;
        await db
          .update(sessions)
          .set({ cliSessionId: cliId, resumeCommand: executor.resumeCommand(cwd, cliId) })
          .where(eq(sessions.id, rowId));
      } else if (event.kind === "text") {
        text += event.text;
        out.write(event.text + "\n");
      } else if (event.kind === "thinking") {
        out.write("〔思考〕" + event.text + "\n");
      } else if (event.kind === "error") {
        errorMsg = event.message;
        out.write("✕ " + event.message + "\n");
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
  let conclusion = raised ? (text.match(CONC_RE)?.[1]?.trim().slice(0, 140) || undefined) : undefined;
  // 提问轮:辩手按 prompt 不写 [可收敛]。若它进入本轮前本就已收敛,一次澄清提问不该让它
  // "放下手"——继承既有收敛状态，否则 isConsensus 会被一次提问打回为"未达成一致"。
  if (args.inherit && !raised) {
    raised = args.inherit.raised;
    agrees = args.inherit.agrees;
    conclusion = args.inherit.conclusion;
  }
  // A debater turn that exits cleanly but says nothing is degenerate (e.g. a
  // resume that returned no text) — treat it as a failure so the debate stops
  // instead of feeding emptiness to the opponent. (Implementers may legitimately
  // produce only tool/file output, so this only applies to debaters.)
  const isDebater = role === "debaterA" || role === "debaterB";
  if (!errorMsg && exit === 0 && isDebater && !text.trim()) {
    errorMsg = `${executor.type} 本轮没有产出任何内容（空回复），可能是会话恢复异常`;
  }
  await db.update(sessions).set({ exitStatus: exit, endedAt: now() }).where(eq(sessions.id, rowId));
  // Persist the turn so a reloaded debate can rebuild its timeline (no live
  // events). Includes the error so a failed turn stays visibly failed on reload.
  try {
    appendFileSync(
      join(runDir, "transcript.jsonl"),
      JSON.stringify({ round, speaker, text, raised, agrees, conclusion, error: errorMsg }) + "\n",
    );
  } catch {
    /* best effort */
  }
  bus.publish({ type: "debate.progress", taskId, round, speaker, phase: "end", raisedHand: raised });
  // A manual stop killed this turn's subprocess → unwind to canceled (the top of
  // each entry point catches CanceledRun).
  if (isCanceling(taskId)) throw new CanceledRun();
  return { rowId, cliId, text, raised, agrees, conclusion, exit, error: errorMsg };
}

// A turn is unusable if the CLI errored, exited non-zero, or (for debaters)
// produced no content — the debate must stop, not proceed on a missing reply.
const failed = (t: Turn) => t.exit !== 0 || !!t.error;
const HARD_CAP = 50; // absolute safety cap, even when maxRounds is "不设限"

// Mutable debate state threaded through the pipeline so fresh-start and resume
// share one rebuttal loop / gate / implement tail (no duplicated logic).
interface Ctx {
  taskId: string;
  title: string;
  cfg: DebateConfig;
  project: typeof projects.$inferSelect;
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
}

function applyTurn(ctx: Ctx, sp: "A" | "B", t: Turn) {
  if (sp === "A") {
    ctx.A.cliId = t.cliId; ctx.lastA = t.text; ctx.raisedA = t.raised; ctx.agreesA = t.agrees; ctx.conclusionA = t.conclusion;
  } else {
    ctx.B.cliId = t.cliId; ctx.lastB = t.text; ctx.raisedB = t.raised; ctx.agreesB = t.agrees; ctx.conclusionB = t.conclusion;
  }
}

// 收敛判定：协作=双方都标"可收敛"即合并完成（无分歧概念）；辩论=双方都就绪且都自称与对方一致才算共识，否则是澄清后的分歧。
function isConsensus(ctx: Ctx): boolean {
  const both = ctx.raisedA && ctx.raisedB;
  return ctx.cfg.style === "collaborate" ? both : both && ctx.agreesA && ctx.agreesB;
}

async function loadBase(taskId: string) {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || !task.debate) throw new Error("debate config missing");
  const cfg = JSON.parse(task.debate) as DebateConfig;
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) throw new Error("project not found");
  const exA = await resolveExecutor(cfg.debaterA);
  const exB = await resolveExecutor(cfg.debaterB);
  // Discussion only reads; repo-less debates fall back to a scratch cwd (§4).
  const cwd = ensureWorkdir(project.repoPath, taskId);
  const cap = Math.min(cfg.maxRounds ?? HARD_CAP, HARD_CAP);
  return { task, title: task.title, cfg, project, exA, exB, cwd, cap };
}

// Full /debate pipeline: blind opening (parallel) → serial rebuttal rounds
// (A-first) → consensus gate G1 → implement in worktree → code gate G2 → commit.
export async function runDebate(taskId: string): Promise<void> {
  if (running.has(taskId)) return;
  running.add(taskId);
  try {
    const base = await loadBase(taskId);
    const { cfg, exA, exB, cwd } = base;
    await setStatus(taskId, "running");

    // Title the task from its topic (concurrent, non-blocking) like a single task.
    if (base.task.autoTitle) void genDebateTitle(taskId, cfg.topic, exA, cwd);

    // Round 1 — blind opening, parallel.
    const [a, b] = await Promise.all([
      runTurn({ taskId, role: "debaterA", speaker: "A", round: 1, executor: exA, prompt: P.opening(cfg.topic, cwd, cfg.style), cwd }),
      runTurn({ taskId, role: "debaterB", speaker: "B", round: 1, executor: exB, prompt: P.opening(cfg.topic, cwd, cfg.style), cwd }),
    ]);
    if (failed(a) || failed(b)) return void (await setStatus(taskId, "failed"));

    const ctx: Ctx = {
      taskId, title: base.title, cfg, project: base.project, exA, exB, cwd, cap: base.cap,
      A: { rowId: a.rowId, cliId: a.cliId }, B: { rowId: b.rowId, cliId: b.cliId }, round: 1,
      lastA: a.text, lastB: b.text, raisedA: a.raised, raisedB: b.raised,
      agreesA: a.agrees, agreesB: b.agrees, conclusionA: a.conclusion, conclusionB: b.conclusion,
    };
    if (!(await runRebuttalLoop(ctx))) return;
    await concludeOrImplement(ctx);
  } catch (err) {
    failDebate(taskId, err);
  } finally {
    running.delete(taskId);
  }
}

// Retry a FAILED debate by re-running only the failed (last) turn, then
// continuing — instead of re-running the whole debate. State is rebuilt from the
// persisted sessions + transcript; the failed turn is dropped from the transcript
// and re-run (resuming the same CLI session so context is retained).
export async function resumeDebate(taskId: string): Promise<void> {
  if (running.has(taskId)) return;
  running.add(taskId);
  try {
    const base = await loadBase(taskId);
    const { cfg, exA, exB, cwd } = base;

    const sess = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
    const latest = (role: string) =>
      sess.filter((s) => s.role === role).sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0];
    const sA = latest("debaterA");
    const sB = latest("debaterB");

    const tpath = join(RUNS_DIR, taskId, "transcript.jsonl");
    let rows: any[] = [];
    try { rows = readFileSync(tpath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
    if (!rows.length) { running.delete(taskId); return void runDebate(taskId); } // nothing to resume → fresh
    const failedTurn = rows[rows.length - 1];
    rows = rows.slice(0, -1); // drop the failed turn; it will be re-run
    writeFileSync(tpath, rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");

    const lastOf = (sp: string) => [...rows].reverse().find((r) => r.speaker === sp);
    const ra = lastOf("A");
    const rb = lastOf("B");
    const ctx: Ctx = {
      taskId, title: base.title, cfg, project: base.project, exA, exB, cwd, cap: base.cap,
      A: { rowId: sA?.id ?? id(), cliId: sA?.cliSessionId ?? "" },
      B: { rowId: sB?.id ?? id(), cliId: sB?.cliSessionId ?? "" },
      round: failedTurn.round,
      lastA: ra?.text ?? "", lastB: rb?.text ?? "",
      raisedA: ra?.raised ?? false, raisedB: rb?.raised ?? false,
      agreesA: ra?.agrees ?? false, agreesB: rb?.agrees ?? false,
      conclusionA: ra?.conclusion, conclusionB: rb?.conclusion,
    };
    await setStatus(taskId, "running");

    if (failedTurn.speaker === "impl") {
      // Implement-phase failure: the gate decision wasn't persisted, so re-run
      // implement with the configured side and finish (G2/commit/done).
      ctx.round = Math.max(1, failedTurn.round - 1); // implement ran at round+1
      await runImplement(ctx, { note: "", chosenSide: undefined });
      return;
    }

    // Debater-phase failure: re-run the failed turn(s) to complete its round,
    // then hand to the normal loop (which continues from the next round).
    const R = failedTurn.round;
    const sp = failedTurn.speaker as "A" | "B";
    const re = (s: "A" | "B", round: number) =>
      runTurn({
        taskId, role: s === "A" ? "debaterA" : "debaterB", speaker: s, round,
        executor: s === "A" ? exA : exB,
        prompt: round === 1 ? P.opening(cfg.topic, cwd, cfg.style) : P.rebuttal(s === "A" ? ctx.lastB : ctx.lastA, round, cfg.style),
        cwd, rowId: s === "A" ? ctx.A.rowId : ctx.B.rowId,
        resumeCliId: (s === "A" ? ctx.A.cliId : ctx.B.cliId) || undefined,
      });

    const t1 = await re(sp, R);
    if (failed(t1)) return void (await setStatus(taskId, "failed"));
    applyTurn(ctx, sp, t1);
    // If A failed mid-round, B of the same round still needs to run.
    if (R > 1 && sp === "A" && !(ctx.raisedA && ctx.raisedB)) {
      const t2 = await re("B", R);
      if (failed(t2)) return void (await setStatus(taskId, "failed"));
      applyTurn(ctx, "B", t2);
    }
    ctx.round = R;

    if (!(await runRebuttalLoop(ctx))) return;
    await concludeOrImplement(ctx);
  } catch (err) {
    failDebate(taskId, err);
  } finally {
    running.delete(taskId);
  }
}

function failDebate(taskId: string, err: unknown) {
  // A manual stop unwinds here as CanceledRun → settle as canceled, not failed.
  if (err instanceof CanceledRun) {
    takeCanceled(taskId);
    void setStatus(taskId, "canceled");
    return;
  }
  bus.publish({
    type: "agent.event", taskId, sessionId: "", role: "debaterA",
    event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
  });
  void setStatus(taskId, "failed");
}

// Auto-generate a short list-friendly title from the topic — the debate analog of
// a single task's auto-title. Runs concurrently with round 1 (it doesn't block the
// debate) and is best-effort: on any failure the provisional title simply stays.
async function genDebateTitle(taskId: string, topic: string, ex: AgentExecutor, cwd: string): Promise<void> {
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
    await db.update(tasks).set({ title: newTitle, autoTitle: false, updatedAt: now() }).where(eq(tasks.id, taskId));
    bus.publish({ type: "task.title", taskId, title: newTitle });
  } catch {
    /* best effort */
  }
}

// Resume a debate that is parked at a gate but whose in-memory gate was lost (the
// server restarted). Rebuilds state from the persisted transcript + sessions and
// applies the human's gate action, so the gate keeps working across restarts.
export async function resumeAtGate(taskId: string, action: GateAction): Promise<void> {
  if (running.has(taskId)) return; // a live debate is actually parked → resolveGate handled it
  running.add(taskId);
  try {
    const base = await loadBase(taskId);
    const sess = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
    const latest = (role: string) =>
      sess.filter((s) => s.role === role).sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0];
    const sA = latest("debaterA");
    const sB = latest("debaterB");
    const sImpl = latest("implementer");

    let rows: any[] = [];
    try { rows = readFileSync(join(RUNS_DIR, taskId, "transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
    const lastOf = (sp: string) => [...rows].reverse().find((r) => r.speaker === sp);
    const ra = lastOf("A");
    const rb = lastOf("B");
    const debateRounds = rows.filter((r) => r.speaker !== "impl").map((r) => r.round);
    const ctx: Ctx = {
      taskId, title: base.title, cfg: base.cfg, project: base.project, exA: base.exA, exB: base.exB, cwd: base.cwd, cap: base.cap,
      A: { rowId: sA?.id ?? id(), cliId: sA?.cliSessionId ?? "" },
      B: { rowId: sB?.id ?? id(), cliId: sB?.cliSessionId ?? "" },
      round: debateRounds.length ? Math.max(...debateRounds) : 1,
      lastA: ra?.text ?? "", lastB: rb?.text ?? "",
      raisedA: ra?.raised ?? false, raisedB: rb?.raised ?? false,
      agreesA: ra?.agrees ?? false, agreesB: rb?.agrees ?? false,
      conclusionA: ra?.conclusion, conclusionB: rb?.conclusion,
    };
    const hasImpl = rows.some((r) => r.speaker === "impl");
    await setStatus(taskId, "running");

    if (!hasImpl) {
      // G1 gate (辩论=收敛门 / 协作=方案门).
      if (action.kind === "reject") return void (await setStatus(taskId, "canceled"));
      if (base.cfg.style !== "collaborate") {
        // 辩论：仅讨论 —— 放行=结束(done)，注入/提问=再辩后再停。不实现。
        if (action.kind === "approve") return void (await setStatus(taskId, "done"));
        await reDebate(ctx, action.kind, action.text);
        await finishDiscussion(ctx);
        return;
      }
      // 协作：放行=按方案实现，注入/提问=再议后重开方案门。
      if (action.kind === "approve") return void (await runImplement(ctx, { note: action.text ?? "", chosenSide: action.side }));
      await reDebate(ctx, action.kind, action.text); // inject / ask
      await gateAndImplement(ctx); // re-park G1, then implement
      return;
    }

    // G2 (code gate). The implement turn already ran; the gate side wasn't
    // persisted, so use the configured implementer for any further runs.
    const side = base.cfg.implementer;
    const exImpl = side === "A" ? base.exA : base.exB;
    const ws = await resolveWorkspace(base.project.repoPath, taskId, true);
    if (action.kind === "reject") return void (await setStatus(taskId, "canceled"));
    if (action.kind !== "approve") {
      // inject / ask → re-run the implementer with the feedback, then re-park G2.
      recordUserTurn(taskId, ctx.round + 1, action.text);
      const prompt = action.kind === "inject" ? P.injectFeedback(action.text, ctx.round, base.cfg.style) : P.question(action.text, ctx.round, base.cfg.style);
      await runTurn({ taskId, role: "implementer", speaker: "impl", round: ctx.round + 1, executor: exImpl, prompt, cwd: ws.path, rowId: sImpl?.id, resumeCliId: sImpl?.cliSessionId ?? undefined, branch: ws.branch });
      const res = await runGate(taskId, "G2", async (k, t) => {
        recordUserTurn(taskId, ctx.round + 1, t);
        const p = k === "inject" ? P.injectFeedback(t, ctx.round, base.cfg.style) : P.question(t, ctx.round, base.cfg.style);
        await runTurn({ taskId, role: "implementer", speaker: "impl", round: ctx.round + 1, executor: exImpl, prompt: p, cwd: ws.path, rowId: sImpl?.id, resumeCliId: sImpl?.cliSessionId ?? undefined, branch: ws.branch });
      });
      if (!res.approved) return void (await setStatus(taskId, "canceled"));
    }
    if (ws.isWorktree) await commitWorktree(ws.path, `debate: ${ctx.title}`);
    await setStatus(taskId, "done");
  } catch (err) {
    failDebate(taskId, err);
  } finally {
    running.delete(taskId);
  }
}

// Serial rebuttal rounds (A-first). Returns false (and sets status=failed) if a
// turn is unusable; true when the loop ends normally (convergence or cap).
async function runRebuttalLoop(ctx: Ctx): Promise<boolean> {
  const { taskId, exA, exB, cwd } = ctx;
  while (!(ctx.raisedA && ctx.raisedB) && ctx.round < ctx.cap) {
    ctx.round++;
    const at = await runTurn({
      taskId, role: "debaterA", speaker: "A", round: ctx.round, executor: exA,
      prompt: P.rebuttal(ctx.lastB, ctx.round, ctx.cfg.style), cwd, rowId: ctx.A.rowId, resumeCliId: ctx.A.cliId || undefined,
    });
    if (failed(at)) { await setStatus(taskId, "failed"); return false; }
    applyTurn(ctx, "A", at);
    if (ctx.raisedA && ctx.raisedB) break;
    const bt = await runTurn({
      taskId, role: "debaterB", speaker: "B", round: ctx.round, executor: exB,
      prompt: P.rebuttal(ctx.lastA, ctx.round, ctx.cfg.style), cwd, rowId: ctx.B.rowId, resumeCliId: ctx.B.cliId || undefined,
    });
    if (failed(bt)) { await setStatus(taskId, "failed"); return false; }
    applyTurn(ctx, "B", bt);
  }
  return true;
}

// Human feedback/question → both debaters re-debate (used inside the gate loop
// and when resuming a gate after a restart).
async function reDebate(ctx: Ctx, kind: "inject" | "ask", text: string) {
  ctx.round++;
  recordUserTurn(ctx.taskId, ctx.round, text); // the human's words land in the timeline first
  const prompt = kind === "inject" ? P.injectFeedback(text, ctx.round, ctx.cfg.style) : P.question(text, ctx.round, ctx.cfg.style);
  // 提问=澄清,不该打回已达成的收敛/结论(继承既有状态);注入=回炉重议,允许双方改判(不继承)。
  const inhA = kind === "ask" ? { raised: ctx.raisedA, agrees: ctx.agreesA, conclusion: ctx.conclusionA } : undefined;
  const inhB = kind === "ask" ? { raised: ctx.raisedB, agrees: ctx.agreesB, conclusion: ctx.conclusionB } : undefined;
  const at = await runTurn({ taskId: ctx.taskId, role: "debaterA", speaker: "A", round: ctx.round, executor: ctx.exA, prompt, cwd: ctx.cwd, rowId: ctx.A.rowId, resumeCliId: ctx.A.cliId || undefined, inherit: inhA });
  applyTurn(ctx, "A", at);
  const bt = await runTurn({ taskId: ctx.taskId, role: "debaterB", speaker: "B", round: ctx.round, executor: ctx.exB, prompt, cwd: ctx.cwd, rowId: ctx.B.rowId, resumeCliId: ctx.B.cliId || undefined, inherit: inhB });
  applyTurn(ctx, "B", bt);
}

// Gate G1 → implement. Separated so resume can call runImplement directly.
async function gateAndImplement(ctx: Ctx): Promise<void> {
  const { taskId, cfg } = ctx;
  let note = "";
  let chosenSide: "A" | "B" | undefined;
  if (cfg.gateG1 === "on") {
    const res = await runGate(taskId, "G1", (k, t) => reDebate(ctx, k, t), () => ({
      consensus: isConsensus(ctx),
      conclusionA: ctx.conclusionA ?? null,
      conclusionB: ctx.conclusionB ?? null,
    }));
    if (!res.approved) return void (await setStatus(taskId, "canceled"));
    note = res.note;
    chosenSide = res.side;
  }
  await runImplement(ctx, { note, chosenSide });
}

// 辩论=仅讨论：收敛后到此即止，结论就是交付物（不实现、不审查、不建 worktree）。
// 收敛门(G1)开 → 让人读结论后放行(=结束)/打回(=取消)/注入·提问(=再辩)；关 → 直接 done。
async function finishDiscussion(ctx: Ctx): Promise<void> {
  const { taskId, cfg } = ctx;
  if (cfg.gateG1 === "on") {
    const res = await runGate(taskId, "G1", (k, t) => reDebate(ctx, k, t), () => ({
      consensus: isConsensus(ctx),
      conclusionA: ctx.conclusionA ?? null,
      conclusionB: ctx.conclusionB ?? null,
    }));
    if (!res.approved) return void (await setStatus(taskId, "canceled"));
  }
  await setStatus(taskId, "done"); // 讨论结束，结论即是产出
}

// 风格分流：协作→门→实现+审查；辩论→出结论即止。
async function concludeOrImplement(ctx: Ctx): Promise<void> {
  if (ctx.cfg.style === "collaborate") await gateAndImplement(ctx);
  else await finishDiscussion(ctx);
}

// Implement stage — chosen side implements in an isolated worktree, resuming its
// own debate session. Honest directive: never claims consensus when there wasn't.
async function runImplement(ctx: Ctx, opts: { note: string; chosenSide?: "A" | "B" }): Promise<void> {
  const { taskId, cfg, exA, exB } = ctx;
  const consensus = isConsensus(ctx);
  const collab = cfg.style === "collaborate";
  const side = opts.chosenSide ?? cfg.implementer; // human pick > config default
  const exImpl = side === "A" ? exA : exB;
  const implCliId = side === "A" ? ctx.A.cliId : ctx.B.cliId;
  const ws = await resolveWorkspace(ctx.project.repoPath, taskId, true);
  const nameA = collab ? "成员A" : "辩手A";
  const nameB = collab ? "成员B" : "辩手B";
  const finalDiscussion = `【${nameA} 最终】\n${ctx.lastA}\n\n【${nameB} 最终】\n${ctx.lastB}`;
  let directive: string;
  if (collab) {
    // 协作：实现一份合并出来的统一方案，不存在"选边"。
    const plan = ctx.conclusionA || ctx.conclusionB || "见上方双方讨论";
    directive = consensus
      ? `你们已合并出一份统一方案。请按该统一方案实现：${plan}。`
      : `请综合双方讨论，按你判断最完整的统一方案实现（由${side === "A" ? "成员A" : "成员B"}落地）。`;
  } else if (consensus) {
    directive = `双方已达成共识。请按共识结论实现：${ctx.conclusionA || ctx.conclusionB || "见上方讨论"}。`;
  } else {
    const who = side === "A" ? "辩手A" : "辩手B";
    const concl = (side === "A" ? ctx.conclusionA : ctx.conclusionB) || "见上方该方的最终发言";
    const by = opts.chosenSide ? "人类裁判已选择" : "双方未达成一致，按配置由实现方";
    directive = `双方未达成一致。${by}采用【${who}】的方案：${concl}。请据此实现，不要混入对方相反的结论。`;
  }
  if (opts.note) directive += `\n\n人类补充要求（必须遵循）：${opts.note}`;
  const it = await runTurn({
    taskId, role: "implementer", speaker: "impl", round: ctx.round + 1, executor: exImpl,
    prompt: P.implement(cfg.topic, finalDiscussion, directive, ws.path), cwd: ws.path,
    resumeCliId: implCliId || undefined, branch: ws.branch,
  });
  if (failed(it)) return void (await setStatus(taskId, "failed"));

  // Code review by the OTHER debater (the non-implementer side) — it inspects the
  // implementer's diff in the worktree and reports issues / approves. Resumes its
  // own debate session so it reviews against the plan it argued. Best-effort: a
  // failed review doesn't block (the human still gates at G2).
  const reviewerSide = side === "A" ? "B" : "A";
  const exRev = reviewerSide === "A" ? exA : exB;
  const rev = reviewerSide === "A" ? ctx.A : ctx.B;
  await runTurn({
    taskId, role: "reviewer", speaker: "review", round: ctx.round + 2, executor: exRev,
    prompt: P.review(cfg.topic, ws.path), cwd: ws.path,
    rowId: rev.rowId, resumeCliId: rev.cliId || undefined, branch: ws.branch,
  });

  if (cfg.gateG2 === "on") {
    const res = await runGate(taskId, "G2", async (kind, text) => {
      recordUserTurn(taskId, ctx.round + 1, text);
      const prompt = kind === "inject" ? P.injectFeedback(text, ctx.round, cfg.style) : P.question(text, ctx.round, cfg.style);
      await runTurn({ taskId, role: "implementer", speaker: "impl", round: ctx.round + 1, executor: exImpl, prompt, cwd: ws.path, rowId: it.rowId, resumeCliId: it.cliId, branch: ws.branch });
    });
    if (!res.approved) return void (await setStatus(taskId, "canceled"));
  }

  if (ws.isWorktree) await commitWorktree(ws.path, `debate: ${ctx.title}`);
  await setStatus(taskId, "done");
}

// Open a HITL gate and act on the human's decision; loops on inject/ask. The
// optional getInfo() supplies the current consensus + both conclusions so the
// gate UI can show "已达成共识" vs "分歧待裁决" and offer a side pick (re-evaluated
// each loop in case a re-debate changed things).
async function runGate(
  taskId: string,
  gate: "G1" | "G2",
  reAction: (kind: "inject" | "ask", text: string) => Promise<void>,
  getInfo?: () => { consensus: boolean; conclusionA: string | null; conclusionB: string | null },
): Promise<{ approved: boolean; note: string; side?: "A" | "B" }> {
  while (true) {
    await setStatus(taskId, "awaiting_review");
    const info = getInfo?.();
    bus.publish({
      type: "debate.gate", taskId, gate, open: true,
      consensus: info?.consensus, conclusionA: info?.conclusionA, conclusionB: info?.conclusionB,
    });
    const action = await waitForGate(taskId);
    bus.publish({ type: "debate.gate", taskId, gate, open: false });
    if (action.kind === "approve") {
      await setStatus(taskId, "running");
      return { approved: true, note: action.text ?? "", side: action.side };
    }
    if (action.kind === "reject") return { approved: false, note: "" };
    await setStatus(taskId, "running");
    await reAction(action.kind, action.text);
  }
}
