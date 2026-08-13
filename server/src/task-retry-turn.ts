// 「重跑上一回合」：上一回合非正常结束、但任务**仍停在 done**时的重试入口。
//
// 为什么不能只靠 `/tasks/:id/retry`：那条要求 `status === "failed"`。可续聊回合崩了是不改
// 任务状态的（`single-run.ts` 的 followUpFrom 分支只写一句「续聊回合异常结束(退出码 N),
// 任务状态保持「已完成」不变」），自由工作流的自动修复回合同理。于是「一句话没跑成」的
// 任务停在 done，整个界面没有任何一个能重来的按钮 —— 用户只能自己把那句话重打一遍。
//
// 语义是**重跑上一回合**，不是「重跑整个任务」：
// - 上一回合是真人/后端代写的一句话（续聊、审查打回）→ 把**同一句话**重新投给**同一条会
//   话**。不用 RESUME_PROMPT 续跑，是因为回合可能死在 CLI 起来之前（图一的 503 no available
//   account 就是），那时 CLI 侧压根没收到过这句话，只说「继续」等于把指令弄丢了。代价是
//   agent 有可能看见同一句话两遍 —— 宁可重一遍，也不能丢。
// - 上一回合是系统续跑 / 首跑（会话里最后一段不是 user）→ 退回 `resumeOrRunTask`，跟
//   「运行/重试」走同一条路。
//
// 「同一条会话」是这条路的**硬要求**，不是锦上添花：`resumeOrRunTask` 按任务自身的
// agentType 挑实现会话，@召唤别的执行器续聊、就地验证的验证者，跑的都不是那一条。所以
// ① 崩的是 reviewer 会话就直接拒（自由审查链自己会重派，这里另拼一套只会跑错人）、
// ② 验证轮还挂着（`verifyRound` 非空 = 那一轮没 concludeRound）也直接拒、
// ③ 重投时按崩掉那条会话自己的执行器路由，口径与 `/answer` 相同。
import { open, stat } from "node:fs/promises";
import type { AgentType, ConvSeg } from "@harness/shared";
import { parseSessionOutput } from "@harness/shared";
import { parseAttachmentText } from "@harness/shared/attachments";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { isAcceptingTask } from "./acceptance-lock.js";
import { db } from "./db/index.js";
import { agents, sessions, tasks } from "./db/schema.js";
import { continueTask } from "./orchestrator.js";
import { queueBlockers } from "./queues.js";
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

export type RetryTurnTask = {
  archived: boolean;
  mode: string;
  status: string;
  verifyRound: number | null;
};

export type RetryTurnSession = {
  id: string;
  role: string;
  turnStartedAt: string | null;
  startedAt: string;
  exitStatus: number | null;
};

// 会话行**跨回合复用**：恢复一条旧 CLI 会话只更新 `turnStartedAt`，`startedAt` 停在它第一
// 次被创建的时刻。所以「最新会话」只能按最近一次回合排，按 `startedAt` 排会把「先建后用」
// 的会话永远判成旧的（口径同 `task-question.ts` 的 askingAgentFor）。
export function latestSessionOf<T extends RetryTurnSession>(rows: T[]): T | null {
  const turnAt = (row: RetryTurnSession) => row.turnStartedAt ?? row.startedAt;
  return [...rows].sort((left, right) => turnAt(left).localeCompare(turnAt(right))).at(-1) ?? null;
}

// 能不能重跑。纯函数：路由只负责取数据、占回合锁，判据全在这里，好钉测试。
// 返回 null = 放行；否则是要原样回给前端的那句拒绝理由。
export function retryTurnRejection(
  task: RetryTurnTask,
  latest: RetryTurnSession | null,
  wantedSessionId?: string,
): { error: string; detail?: Record<string, unknown> } | null {
  if (task.archived) return { error: "任务已归档，先取消归档再重试", detail: { archived: true } };
  // 只做单飞任务：duet 有自己的 gate 语义、团队调度台是常驻会话，两边的「上一回合」
  // 都不是这里这套 user/agent 交替的形状，硬套只会把它们的状态机搅乱。
  if (task.mode !== "single") return { error: "只有单飞任务支持重跑上一回合", detail: { mode: task.mode } };
  // 白名单只留 done。**主动停止/暂停也会留下非零退出码**（多数 CLI 吃 SIGTERM 后按 signal
  // 写 exitStatus=1，`single-run.ts` 再按 stopped 把任务正常落成 canceled/paused），那不是
  // 崩溃，界面上头部给的是「运行」而不是「重试」。failed 也不归这里 —— 头部那颗「重试」
  // 认的就是它，同一件事不开第二个入口。
  if (task.status !== "done") {
    return { error: "只有停在「已完成」的任务才谈得上重跑上一回合", detail: { status: task.status } };
  }
  // 验证轮的轮次号还挂着 = 那一轮就地验证没出结论。它是旁路回合，重投等于顶着同一个轮号
  // 另跑一段普通回合（判据同 `/verify` 与 `task-accept-guard.ts`）。
  if (task.verifyRound !== null) {
    return { error: `第 ${task.verifyRound} 轮就地验证还没出结论，等它结束再重试`, detail: { verifyRound: task.verifyRound } };
  }
  if (!latest) return { error: "任务还没跑过，没有可重跑的回合" };
  // 前端按钮挂在某一条会话的尾栏上；带上 sessionId 就是在说「我要重跑的是**我看到的
  // 那一条**」。它不是最新会话就说明中间又跑过一轮，页面是旧的 —— 拒绝而不是照跑。
  if (wantedSessionId && wantedSessionId !== latest.id) {
    return { error: "页面上的会话不是最新一次，刷新后再试", detail: { sessionId: latest.id } };
  }
  // 审查会话崩了归自由审查链自己管（它有 reviewer 身份、证据目录和轮次），这里既拿不回
  // 那套上下文，也不该替它决定重派。
  if (latest.role !== "single") {
    return { error: "上一回合是审查/验证旁路会话，重跑它请走审查那条路", detail: { role: latest.role } };
  }
  if (latest.exitStatus === 0 || latest.exitStatus == null) {
    return { error: "上一回合不是异常结束，不需要重跑", detail: { exitStatus: latest.exitStatus } };
  }
  return null;
}

export function mountTaskRetryTurnRoutes(api: Hono): void {
  api.post("/tasks/:id/retry-turn", async (c) => {
    const taskId = c.req.param("id");
    const body = await c.req.json<{ sessionId?: string }>().catch(() => ({} as { sessionId?: string }));
    const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!r) return c.json({ error: "not found" }, 404);
    const rows = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
    const latest = latestSessionOf(rows);
    const rejection = retryTurnRejection(r, latest, body.sessionId);
    if (rejection || !latest) {
      return c.json({ error: rejection?.error ?? "任务还没跑过，没有可重跑的回合", ...rejection?.detail }, 409);
    }
    // 同 /run：串行队列里排在前面的还没完，这一颗就不该抢跑。少了这道闸，队尾任务上的
    // 重试按钮就成了插队入口。
    const blockedBy = await queueBlockers(taskId);
    if (blockedBy.length) {
      return c.json({ error: "队列前面还有未完成的任务，先把它们处理完或把本任务移出队列", blockedBy }, 409);
    }
    // 同 /run、/retry：原子占位，并发只有一个能 202；占位后镜像检查验收锁，否则下游撞上
    // 验收锁静默 return，202 就成了谎报。
    if (!claimTurn(taskId, "single")) {
      return c.json({ error: "任务回合正在进行，结束后再重试", status: r.status }, 409);
    }
    // 占位之后的每一条出路都必须交接或释放这把锁：漏一条就是「500 一次、之后永远 409，
    // 只能重启服务」。所以 handed 只在**真正把 turnHeld 交给下游**的那一刻才置位。
    let handed = false;
    try {
      if (isAcceptingTask(taskId)) {
        return c.json({ error: "任务正在验收（含发布尾段），结束后再重试", status: r.status }, 409);
      }
      const seg = await lastInputSeg(readableRunPath(sessionTranscriptPath(taskId, latest.id))).catch(() => null);
      if (seg?.kind === "user") {
        const { body: text, paths } = parseAttachmentText(seg.text);
        const trimmed = text.trim();
        if (trimmed || paths.length) {
          // 崩掉的那一回合可能跑在**被召唤来的**执行器上（@codex 续聊），它跟任务常设的
          // agentType 不是一个人。按会话自己的身份路由，重投才落回同一条会话。口径同
          // `/answer`：只在类型不同时才带 agent —— 带上 agent 会让这一回合变成「召唤」，
          // 连带清掉任务自己的 model/effort。
          const summon = latest.agentType === r.agentType
            ? {}
            : {
              agent: latest.agentType as AgentType,
              executorId: (await db.select().from(agents).where(eq(agents.name, latest.executor))).at(0)?.id ?? null,
              model: null,
              reasoningEffort: null,
            };
          handed = true;
          void continueTask(taskId, trimmed, {
            ...summon,
            attachments: paths,
            // 后端代写的那句（审查打回等）重投时仍标 by:"system"：作者没变，重来一次不该
            // 把机器的话记成我说的。
            byBackend: !!seg.bySystem,
            turnHeld: true,
          });
          return c.json({ started: true, mode: "resend" }, 202);
        }
      }
      handed = true;
      void resumeOrRunTask(taskId, { reason: "retry", turnHeld: true });
      return c.json({ started: true, mode: "resume" }, 202);
    } finally {
      if (!handed) releaseTurn(taskId);
    }
  });
}
