// 起跑失败的回合，用户到底能看见什么。
//
// 现场：在一个已验收的任务里发一句话 → worktree 建不出来 / 执行器解析不过 → `/reply`
// 已经回了 202，而错误只走一条 sessionId 为空串的 SSE 事件，落不进任何一条对话，刷新
// 即消失。用户侧就是「显示已发送，然后没反应」（实测任务 gsppwUacwZnn）。
//
// 这里钉三件事，每一件都属于「后端做对了但用户看不见」那一类，靠通读发现不了：
//   1. spawn 之前失败 → 会话里必须留下一条持久可见的说明，且把没送达的原文还给用户
//   2. 原文要跟正常投递**同一份**：带附件的消息不能只还文字，附件路径得在里面
//   3. 这条说明要落到**被 @ 的那位**的会话上，而不是任务里最新的那条会话
//
// 跑：npm -w server run test:turn-visibility
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-turn-visibility-"));
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");

const { ensureSchema, db } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { continueTask } = await import("../src/orchestrator.js");

await ensureSchema();
const stamp = new Date().toISOString();
await db.insert(projects).values({
  id: "p1", name: "turn visibility", repoPath: join(root, "repo"), apiKeys: null, workflowId: null, createdAt: stamp,
});

const baseTask = {
  projectId: "p1", groupId: null, parentId: null, body: "test", mode: "single", status: "done",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
  executorId: null, model: null, reasoningEffort: null, autoTitle: false,
  duet: null, team: null, reportBack: false, scheduleId: null,
  createdAt: stamp, updatedAt: stamp,
  useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "preset",
};
const baseSession = {
  taskId: "", role: "single", executor: "codex", executorId: null,
  turnModel: null, turnReasoningEffort: null, executorFingerprint: null,
  sideTurn: false, stoppedAs: null, target: "local", worktreePath: null, branch: null,
  cliSessionId: null, commandLine: null, activeMs: 0, exitStatus: null, agentOffset: 0,
};

// 会话正文文件是**写第一条内容时才建**的：文件根本不存在，就是「这条会话里什么都没
// 落下」，跟落了别的内容一样要能断言，所以缺文件按空串读。
const transcript = (taskId: string, sessionId: string) => {
  try {
    return readFileSync(join(root, "runs", taskId, `${sessionId}.md`), "utf8");
  } catch {
    return "";
  }
};

// 起跑前失败的最省事触发法：给执行器一个它不认识的思考强度。解析在 spawn 之前，
// 于是走的正是「这句话一个字都没送出去」那条路（真 spawn 会被隔离环境的守卫挡下）。
const FAILING = { reasoningEffort: "ultra-fake-effort" };

// ── ① 附件消息失败时，附件引用不能丢 ────────────────────────────────────────
// 正常投递拼的是 userText + attachmentsPrompt(attachments)；失败气泡只还 userText 的话，
// 「文字 + 图」的续聊会退回成一句没有图的话，纯附件的那条更是退成空气。
{
  await db.insert(tasks).values([{ ...baseTask, id: "t-attachment", title: "attachment" }]);
  await db.insert(sessions).values([{
    ...baseSession, id: "s-only", taskId: "t-attachment", agentType: "codex",
    cwd: root, startedAt: stamp, turnStartedAt: stamp,
  }]);

  const delivered = await continueTask("t-attachment", "看下这张图", {
    agent: "codex", attachments: ["/tmp/uploaded-image.png"], ...FAILING,
  });
  assert.equal(delivered, true, "这一回合确实由本次调用接管了（错误已落到时间线上）");

  const md = transcript("t-attachment", "s-only");
  assert.match(md, /这一轮没能起跑/, "失败原因必须落进会话，不能只发一条刷新即消失的事件");
  assert.match(md, /没有送达/, "要明说这句话没送到 agent 手里");
  assert.match(md, /看下这张图/, "原文要还给用户");
  assert.match(md, /uploaded-image\.png/, "附件路径同样要还回去，否则等于把附件吞了");
}

// ── ② 说明要写进被 @ 的那位的会话 ──────────────────────────────────────────
// appendTaskTimeline 默认挑 startedAt 最新的会话。任务里有多位智能体时，用户 @codex
// 却在 claude 的时间线里看见一条不属于它的失败，被 @ 的那边一片空白 —— 跟没说一样。
{
  const older = "2026-01-01T00:00:00.000Z";
  const newer = "2026-02-01T00:00:00.000Z";
  await db.insert(tasks).values([{ ...baseTask, id: "t-multi", title: "multi agent" }]);
  await db.insert(sessions).values([
    { ...baseSession, id: "s-codex-old", taskId: "t-multi", agentType: "codex", cwd: root, startedAt: older, turnStartedAt: older },
    { ...baseSession, id: "s-claude-new", taskId: "t-multi", agentType: "claude", executor: "claude", cwd: root, startedAt: newer, turnStartedAt: newer },
  ]);

  await continueTask("t-multi", "hi codex", { agent: "codex", ...FAILING });

  assert.match(transcript("t-multi", "s-codex-old"), /这一轮没能起跑/, "要落到被 @ 的那位的会话上");
  assert.doesNotMatch(transcript("t-multi", "s-claude-new"), /这一轮没能起跑/, "别人的时间线里不该冒出不属于它的失败");
}

// ── ③ 指名续某条会话时，认那一条 ────────────────────────────────────────────
// 「重跑上一回合」传 resumeSessionId，它的硬要求就是落回崩掉的那一条。
{
  const older = "2026-03-01T00:00:00.000Z";
  const newer = "2026-04-01T00:00:00.000Z";
  await db.insert(tasks).values([{ ...baseTask, id: "t-resume", title: "resume by id" }]);
  await db.insert(sessions).values([
    { ...baseSession, id: "s-target", taskId: "t-resume", agentType: "codex", cwd: root, startedAt: older, turnStartedAt: older },
    { ...baseSession, id: "s-latest", taskId: "t-resume", agentType: "codex", cwd: root, startedAt: newer, turnStartedAt: newer },
  ]);

  await continueTask("t-resume", "再来一次", { agent: "codex", resumeSessionId: "s-target", ...FAILING });

  assert.match(transcript("t-resume", "s-target"), /这一轮没能起跑/, "指名的那条会话才是目标");
  assert.doesNotMatch(transcript("t-resume", "s-latest"), /这一轮没能起跑/, "不该顺手写进最新那条");
}

// ── ④ 系统发起的续跑不提「你刚发的消息」 ────────────────────────────────────
// 那一轮的字不是用户打的，还给他一段他没说过的话只会更让人困惑。
{
  await db.insert(tasks).values([{ ...baseTask, id: "t-system", title: "system continue" }]);
  await db.insert(sessions).values([{
    ...baseSession, id: "s-sys", taskId: "t-system", agentType: "codex",
    cwd: root, startedAt: stamp, turnStartedAt: stamp,
  }]);

  await continueTask("t-system", "继续", { agent: "codex", system: true, ...FAILING });

  const md = transcript("t-system", "s-sys");
  assert.match(md, /这一轮没能起跑/, "系统续跑失败同样要留痕");
  assert.doesNotMatch(md, /你刚发的这条消息/, "不是用户发的，就别说是他发的");
}

console.log("✓ 起跑失败留下持久可见的说明，并把没送达的原文（含附件）还给用户");
console.log("✓ 说明落在被 @ / 被指名的那条会话上，不写进别人的时间线");
