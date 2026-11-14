// 系统续跑那条记录（「〔系统〕继续（从中断处）」）带着缘由：是谁让它接着跑的（@ash/shared/system-resume）。
// 钉住三件事：每种缘由各起一次续跑，落盘的记录和直播发出的事件都带着对应的缘由（原文不变）；旁路回合起的
// 续跑另标 side；读老记录（没有缘由字段、缘由形状不对）不出错，按老记录读。
// 跑:npm -w server run test:system-resume
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RESUME_REASONS, type SystemResume } from "@ash/shared/system-resume";
import { LEGACY_SYS_MARKER } from "@ash/shared";
import { parseSessionOutput } from "@ash/shared/session-output";
import type { RunHandle, RunOpts } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-system-resume-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.ASH_TURN_INPUT_ACK_MS = "200";
delete process.env.ASH_ALLOW_REAL_AGENT;

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { continueTask } = await import("../src/orchestrator.js");
const { isTurnClaimed } = await import("../src/runs.js");
const { bus } = await import("../src/bus.js");
const { SYS_MARKER } = await import("../src/run-prompts.js");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
await ensureSchema();

const at = "2026-11-13T12:25:00.000Z";
let runs = 0;
const original = { run: ClaudeExecutor.prototype.run, runSteerable: ClaudeExecutor.prototype.runSteerable };
function captureRun(_opts: RunOpts): RunHandle {
  runs += 1;
  return {
    sessionId: `fixture-${runs}`,
    commandLine: "system resume fixture",
    events: (async function* () {
      yield { kind: "text" as const, text: "接着跑完了。" };
      yield { kind: "done" as const, exitStatus: 0 };
    })(),
    kill() {},
  };
}

const live: Array<{ taskId: string; text: string; resume?: SystemResume }> = [];
const unsubscribe = bus.subscribe((event) => {
  if (event.type === "agent.event" && event.event.kind === "system") {
    live.push({ taskId: event.taskId, text: event.event.text, ...(event.event.resume ? { resume: event.event.resume } : {}) });
  }
});

function sessionText(taskId: string): string {
  const dir = join(process.env.ASH_RUNS_DIR!, taskId);
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
  } catch { return ""; }
}

/** 这个任务落盘的会话里，所有〔系统〕续跑记录（按会话文件读回、走与界面同一份解析）。 */
function persistedResumes(taskId: string) {
  return parseSessionOutput(sessionText(taskId)).filter((seg) => seg.kind === "system" && seg.text === SYS_MARKER);
}

async function resumeOnce(taskId: string, opts: Parameters<typeof continueTask>[2]) {
  await db.insert(tasks).values({
    id: taskId, projectId: "project", title: taskId, body: "改按钮", agentType: "claude",
    mode: "single", status: "paused", useWorktree: false, autoTitle: false, createdAt: at, updatedAt: at,
  });
  const before = runs;
  const started = await continueTask(taskId, "继续", opts);
  assert.equal(started, true, `${taskId}：续跑没起来`);
  // 旁路回合不占单飞那把锁，光看锁会在会话还没落盘时就放行：等到这一轮的正文落进会话。
  const written = () => sessionText(taskId).includes("接着跑完了。");
  for (let attempt = 0; attempt < 500 && (runs === before || isTurnClaimed(taskId) || !written()); attempt++) await delay(10);
  assert.equal(isTurnClaimed(taskId), false, `${taskId}：回合必须收口`);
  assert.ok(written(), `${taskId}：这一轮的正文没落进会话`);
}

try {
  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  await db.insert(projects).values({ id: "project", name: "system resume", repoPath: root, createdAt: at });
  ClaudeExecutor.prototype.run = captureRun;
  ClaudeExecutor.prototype.runSteerable = captureRun;
  assert.equal(SYS_MARKER, LEGACY_SYS_MARKER, "原文不变：审查段的起止与刷新去重都还认这句");

  // ① 每种缘由各起一次：落盘和直播两路都带着它。
  for (const reason of RESUME_REASONS) {
    const taskId = `resume-${reason}`;
    await resumeOnce(taskId, { system: reason });
    const stored = persistedResumes(taskId);
    assert.equal(stored.length, 1, `${reason}：落盘应有恰好一条续跑记录`);
    assert.deepEqual(stored[0]!.kind === "system" ? stored[0]!.resume : null, { reason }, `${reason}：落盘记录没带缘由`);
    const sent = live.filter((event) => event.taskId === taskId && event.text === SYS_MARKER);
    assert.equal(sent.length, 1, `${reason}：直播应发出恰好一条续跑事件`);
    assert.deepEqual(sent[0]!.resume, { reason }, `${reason}：直播事件没带缘由`);
  }

  // ② 旁路回合（审查、辩论那一段）起的续跑另标 side：展示端不在回合头上说它。
  await resumeOnce("resume-side", { system: "run", sideTurn: true });
  const side = persistedResumes("resume-side");
  assert.deepEqual(side[0]!.kind === "system" ? side[0]!.resume : null, { reason: "run", side: true });
  assert.deepEqual(live.find((event) => event.taskId === "resume-side")?.resume, { reason: "run", side: true });

  // ③ 真人回复不是系统续跑：不写这条记录。
  await resumeOnce("reply", {});
  assert.equal(persistedResumes("reply").length, 0);
  assert.equal(live.some((event) => event.taskId === "reply" && event.text === SYS_MARKER), false);

  // ④ 老记录：没有缘由字段、缘由形状不对、更老的整行原文 —— 都读得出来，按老记录读（没有 resume）。
  const legacy = parseSessionOutput([
    `\x1e${JSON.stringify({ t: "system", agent: "claude", text: SYS_MARKER, at })}`,
    "第一回合。",
    `\x1e${JSON.stringify({ t: "system", agent: "claude", text: SYS_MARKER, resume: { reason: "nope" }, at })}`,
    "第二回合。",
    `\x1e${JSON.stringify({ t: "system", agent: "claude", text: SYS_MARKER, resume: "queue", at })}`,
    "第三回合。",
    SYS_MARKER,
    "第四回合。",
  ].join("\n"));
  const legacyResumes = legacy.filter((seg) => seg.kind === "system");
  assert.equal(legacyResumes.length, 4);
  for (const seg of legacyResumes) {
    assert.equal(seg.text, SYS_MARKER);
    assert.equal(seg.kind === "system" && "resume" in seg, false, "老记录不该凭空长出缘由");
  }
  assert.equal(legacy.filter((seg) => seg.kind === "agent").length, 4);

  console.log("system resume records carry who resumed the turn, on disk and live; legacy records still parse: passed");
} finally {
  unsubscribe();
  ClaudeExecutor.prototype.run = original.run;
  ClaudeExecutor.prototype.runSteerable = original.runSteerable;
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
