import { mkdirSync, createWriteStream, appendFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type {
  DebateConfig,
  DebateSpeaker,
  SessionRole,
  TaskStatus,
} from "@harness/shared";
import { db } from "../db/index.js";
import { tasks, projects, sessions } from "../db/schema.js";
import { bus } from "../bus.js";
import { id, now } from "../util.js";
import { prepareWorkspace, commitWorktree } from "../git.js";
import { resolveExecutor } from "../executors/index.js";
import type { AgentExecutor } from "../executors/types.js";
import { RUNS_DIR } from "../paths.js";
import * as P from "./prompts.js";
import { waitForGate } from "./gates.js";

const RAISE_RE = /(^|\n)\s*\[可收敛\]/;
const running = new Set<string>();

async function setStatus(taskId: string, status: TaskStatus) {
  await db.update(tasks).set({ status, updatedAt: now() }).where(eq(tasks.id, taskId));
  bus.publish({ type: "task.status", taskId, status });
}

interface Turn {
  rowId: string;
  cliId: string;
  text: string;
  raised: boolean;
  exit: number;
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
}): Promise<Turn> {
  const { taskId, role, speaker, round, executor, prompt, cwd } = args;
  const handle = executor.run({ prompt, cwd, sessionId: args.resumeCliId || undefined });
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
    } else if (event.kind === "done") {
      exit = event.exitStatus;
    }
  }
  out.end();

  const raised = RAISE_RE.test(text);
  await db.update(sessions).set({ exitStatus: exit }).where(eq(sessions.id, rowId));
  // Persist the turn so a reloaded debate can rebuild its timeline (no live events).
  try {
    appendFileSync(
      join(runDir, "transcript.jsonl"),
      JSON.stringify({ round, speaker, text, raised }) + "\n",
    );
  } catch {
    /* best effort */
  }
  bus.publish({ type: "debate.progress", taskId, round, speaker, phase: "end", raisedHand: raised });
  return { rowId, cliId, text, raised, exit };
}

// Full /debate pipeline: blind opening (parallel) → serial rebuttal rounds
// (A-first) → consensus gate G1 → implement in worktree → code gate G2 → commit.
export async function runDebate(taskId: string): Promise<void> {
  if (running.has(taskId)) return;
  running.add(taskId);
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task || !task.debate) throw new Error("debate config missing");
    const cfg = JSON.parse(task.debate) as DebateConfig;
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) throw new Error("project not found");

    const exA = await resolveExecutor(cfg.debaterA);
    const exB = await resolveExecutor(cfg.debaterB);
    const cwd = project.repoPath; // discussion reads the repo; must not modify

    await setStatus(taskId, "running");

    // Round 1 — blind opening, parallel.
    const HARD_CAP = 50; // absolute safety cap, even when maxRounds is "不设限"
    let round = 1;
    const [a, b] = await Promise.all([
      runTurn({ taskId, role: "debaterA", speaker: "A", round, executor: exA, prompt: P.opening(cfg.topic, cwd), cwd }),
      runTurn({ taskId, role: "debaterB", speaker: "B", round, executor: exB, prompt: P.opening(cfg.topic, cwd), cwd }),
    ]);
    // If an agent failed to even run (e.g. CLI not found), stop now — don't loop.
    if (a.exit !== 0 || b.exit !== 0) return void (await setStatus(taskId, "failed"));
    const A = { rowId: a.rowId, cliId: a.cliId };
    const B = { rowId: b.rowId, cliId: b.cliId };
    let lastA = a.text,
      lastB = b.text,
      raisedA = a.raised,
      raisedB = b.raised;

    // Rounds 2+ — serial, A responds to B's latest, then B to A's latest.
    const cap = Math.min(cfg.maxRounds ?? HARD_CAP, HARD_CAP);
    while (!(raisedA && raisedB) && round < cap) {
      round++;
      const at = await runTurn({
        taskId, role: "debaterA", speaker: "A", round, executor: exA,
        prompt: P.rebuttal(lastB, round), cwd, rowId: A.rowId, resumeCliId: A.cliId,
      });
      if (at.exit !== 0) return void (await setStatus(taskId, "failed"));
      lastA = at.text;
      raisedA = at.raised;
      if (raisedA && raisedB) break;
      const bt = await runTurn({
        taskId, role: "debaterB", speaker: "B", round, executor: exB,
        prompt: P.rebuttal(lastA, round), cwd, rowId: B.rowId, resumeCliId: B.cliId,
      });
      if (bt.exit !== 0) return void (await setStatus(taskId, "failed"));
      lastB = bt.text;
      raisedB = bt.raised;
    }

    // A re-debate round driven by human feedback/question (used inside the gate loop).
    const reDebate = async (kind: "inject" | "ask", text: string) => {
      round++;
      const promptA = kind === "inject" ? P.injectFeedback(text, round) : P.question(text, round);
      const at = await runTurn({ taskId, role: "debaterA", speaker: "A", round, executor: exA, prompt: promptA, cwd, rowId: A.rowId, resumeCliId: A.cliId });
      lastA = at.text;
      raisedA = at.raised;
      const promptB = kind === "inject" ? P.injectFeedback(text, round) : P.question(text, round);
      const bt = await runTurn({ taskId, role: "debaterB", speaker: "B", round, executor: exB, prompt: promptB, cwd, rowId: B.rowId, resumeCliId: B.cliId });
      lastB = bt.text;
      raisedB = bt.raised;
    };

    // Gate G1 — consensus gate.
    let note = "";
    if (cfg.gateG1 === "on") {
      const res = await runGate(taskId, "G1", reDebate);
      if (!res.approved) return void (await setStatus(taskId, "canceled"));
      note = res.note;
    }

    // Implement stage — chosen side implements in an isolated worktree, resuming
    // its own debate session (so it retains full context).
    const side = cfg.implementer;
    const exImpl = side === "A" ? exA : exB;
    const implCliId = side === "A" ? A.cliId : B.cliId;
    const ws = await prepareWorkspace(project.repoPath, taskId, true);
    const consensus = `【辩手A 最终】\n${lastA}\n\n【辩手B 最终】\n${lastB}`;
    const it = await runTurn({
      taskId, role: "implementer", speaker: "impl", round: round + 1, executor: exImpl,
      prompt: P.implement(cfg.topic, consensus, note, ws.path), cwd: ws.path,
      resumeCliId: implCliId, branch: ws.branch,
    });

    // Gate G2 — code gate.
    if (cfg.gateG2 === "on") {
      const res = await runGate(taskId, "G2", async (kind, text) => {
        const prompt = kind === "inject" ? P.injectFeedback(text, round) : P.question(text, round);
        await runTurn({ taskId, role: "implementer", speaker: "impl", round: round + 1, executor: exImpl, prompt, cwd: ws.path, rowId: it.rowId, resumeCliId: it.cliId, branch: ws.branch });
      });
      if (!res.approved) return void (await setStatus(taskId, "canceled"));
    }

    if (ws.isWorktree) await commitWorktree(ws.path, `debate: ${task.title}`);
    await setStatus(taskId, "done");
  } catch (err) {
    bus.publish({
      type: "agent.event", taskId, sessionId: "", role: "debaterA",
      event: { kind: "error", message: String(err instanceof Error ? err.message : err) },
    });
    await setStatus(taskId, "failed");
  } finally {
    running.delete(taskId);
  }
}

// Open a HITL gate and act on the human's decision; loops on inject/ask.
async function runGate(
  taskId: string,
  gate: "G1" | "G2",
  reAction: (kind: "inject" | "ask", text: string) => Promise<void>,
): Promise<{ approved: boolean; note: string }> {
  while (true) {
    await setStatus(taskId, "awaiting_review");
    bus.publish({ type: "debate.gate", taskId, gate, open: true });
    const action = await waitForGate(taskId);
    bus.publish({ type: "debate.gate", taskId, gate, open: false });
    if (action.kind === "approve") {
      await setStatus(taskId, "running");
      return { approved: true, note: action.text ?? "" };
    }
    if (action.kind === "reject") return { approved: false, note: "" };
    await setStatus(taskId, "running");
    await reAction(action.kind, action.text);
  }
}
