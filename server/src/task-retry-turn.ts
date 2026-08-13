// 「重跑上一回合」：上一回合非正常结束、但任务**仍停在终态**（done/paused…）时的重试入口。
//
// 为什么不能只靠 `/tasks/:id/retry`：那条要求 `status === "failed"`。可续聊回合崩了是不改
// 任务状态的（`single-run.ts` 的 followUpFrom 分支只写一句「续聊回合异常结束(退出码 N),
// 任务状态保持「已完成」不变」），自由工作流的自动修复回合同理。于是「一句话没跑成」的
// 任务停在 done，整个界面没有任何一个能重来的按钮 —— 用户只能自己把那句话重打一遍。
//
// 语义是**重跑上一回合**，不是「重跑整个任务」：
// - 上一回合是真人/后端代写的一句话（续聊、审查打回）→ 把**同一句话**重新投给同一个 CLI
//   会话。不用 RESUME_PROMPT 续跑，是因为回合可能死在 CLI 起来之前（图一的 503 no available
//   account 就是），那时 CLI 侧压根没收到过这句话，只说「继续」等于把指令弄丢了。代价是
//   agent 有可能看见同一句话两遍 —— 宁可重一遍，也不能丢。
// - 上一回合是系统续跑 / 首跑（会话里最后一段不是 user）→ 退回 `resumeOrRunTask`，跟
//   「运行/重试」走同一条路。
// - 审查旁路回合（reviewer 会话或库里挂着 reviewing run）→ 同样退回 `resumeOrRunTask`，
//   它会带回 reviewer 身份与路由，不能在这里另拼一套。
import { open, stat } from "node:fs/promises";
import type { ConvSeg } from "@harness/shared";
import { parseSessionOutput } from "@harness/shared";
import { parseAttachmentText } from "@harness/shared/attachments";
import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { isAcceptingTask } from "./acceptance-lock.js";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { freeReviewResumeOptions } from "./free-workflow.js";
import { continueTask } from "./orchestrator.js";
import { claimTurn, releaseTurn } from "./runs.js";
import { resumeOrRunTask } from "./task-resume.js";
import { readableRunPath, sessionTranscriptPath } from "./transcript.js";

// 分档往回读会话正文，理由同 `task-follow-up.ts`：正文是一路追加的 Markdown，可能几 MB，
// 而要找的那一段就在末尾附近；agent 一条回复动辄几十 KB，固定尾巴长度不够用。
const TAIL_STEPS = [64 * 1024, 1024 * 1024, 32 * 1024 * 1024];

async function readTail(path: string, bytes: number): Promise<{ text: string; whole: boolean }> {
  const info = await stat(path);
  const handle = await open(path, "r");
  try {
    const length = Math.min(info.size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const text = buffer.toString("utf8");
    const whole = length >= info.size;
    // 从中间切进去时第一行多半是半截字（还可能劈开一个 UTF-8 字符），丢掉；要的是**最后**
    // 一段，它离切口最远，永远完整。
    return { text: whole ? text : text.slice(text.indexOf("\n") + 1), whole };
  } finally {
    await handle.close();
  }
}

type NonAgentSeg = Exclude<ConvSeg, { kind: "agent" }>;

// 一段会话正文里**最后一个非 agent 段**：它就是「上一回合的输入」。是 user 段才可能重投；
// 是 system 段（系统续跑提示）说明上一回合本来就是续跑，重投没有意义。
export function lastInputOf(out: string): NonAgentSeg | null {
  return [...parseSessionOutput(out)].reverse().find((seg): seg is NonAgentSeg => seg.kind !== "agent") ?? null;
}

async function lastInputSeg(path: string): Promise<NonAgentSeg | null> {
  for (const step of TAIL_STEPS) {
    const { text, whole } = await readTail(path, step);
    const hit = lastInputOf(text);
    if (hit || whole) return hit;
  }
  return null;
}

export function mountTaskRetryTurnRoutes(api: Hono): void {
  api.post("/tasks/:id/retry-turn", async (c) => {
    const taskId = c.req.param("id");
    const body = await c.req.json<{ sessionId?: string }>().catch(() => ({} as { sessionId?: string }));
    const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!r) return c.json({ error: "not found" }, 404);
    if (r.archived) return c.json({ error: "任务已归档，先取消归档再重试", archived: true }, 409);
    // 只做单飞任务：duet 有自己的 gate 语义、团队调度台是常驻会话，两边的「上一回合」
    // 都不是这里这套 user/agent 交替的形状，硬套只会把它们的状态机搅乱。
    if (r.mode !== "single") {
      return c.json({ error: "只有单飞任务支持重跑上一回合", mode: r.mode }, 409);
    }
    const latest = (await db.select().from(sessions).where(eq(sessions.taskId, taskId))
      .orderBy(desc(sessions.startedAt))).at(0);
    if (!latest) return c.json({ error: "任务还没跑过，没有可重跑的回合" }, 409);
    // 前端按钮挂在某一条会话的尾栏上；带上 sessionId 就是在说「我要重跑的是**我看到的
    // 那一条**」。它不是最新会话就说明中间又跑过一轮，页面是旧的 —— 拒绝而不是照跑。
    if (body.sessionId && body.sessionId !== latest.id) {
      return c.json({ error: "页面上的会话不是最新一次，刷新后再试", sessionId: latest.id }, 409);
    }
    if (latest.exitStatus === 0 || latest.exitStatus == null) {
      return c.json({ error: "上一回合不是异常结束，不需要重跑", exitStatus: latest.exitStatus }, 409);
    }
    // 同 /run、/retry：原子占位，并发只有一个能 202；占位后镜像检查验收锁，否则下游撞上
    // 验收锁静默 return，202 就成了谎报。
    if (!claimTurn(taskId, "single")) {
      return c.json({ error: "任务回合正在进行，结束后再重试", status: r.status }, 409);
    }
    if (isAcceptingTask(taskId)) {
      releaseTurn(taskId);
      return c.json({ error: "任务正在验收（含发布尾段），结束后再重试", status: r.status }, 409);
    }

    const reviewerRoute = await freeReviewResumeOptions(taskId);
    const seg = reviewerRoute || latest.role !== "single"
      ? null
      : await lastInputSeg(readableRunPath(sessionTranscriptPath(taskId, latest.id))).catch(() => null);
    if (seg?.kind === "user") {
      const { body: text, paths } = parseAttachmentText(seg.text);
      const trimmed = text.trim();
      if (trimmed || paths.length) {
        void continueTask(taskId, trimmed, {
          attachments: paths,
          // 后端代写的那句（审查打回等）重投时仍标 by:"system"：作者没变，重来一次不该
          // 把机器的话记成我说的。
          byBackend: !!seg.bySystem,
          turnHeld: true,
        });
        return c.json({ started: true, mode: "resend" }, 202);
      }
    }
    void resumeOrRunTask(taskId, { reason: "retry", turnHeld: true });
    return c.json({ started: true, mode: "resume" }, 202);
  });
}
