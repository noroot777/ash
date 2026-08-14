// 「重跑上一回合」：上一回合非正常结束、但任务**仍停在终态**时的重试入口。
//
// 为什么不能只靠 `/tasks/:id/retry`：那条要求 `status === "failed"`。可续聊回合崩了是不改
// 任务状态的（`single-run.ts` 的 followUpFrom 分支只写一句「续聊回合异常结束(退出码 N),
// 任务状态保持「已完成」不变」），自由工作流的自动修复回合、审查回合同理。于是「一句话
// 没跑成」的任务停在 done，整个界面没有任何一个能重来的按钮 —— 用户只能自己重打一遍。
//
// 语义是**重跑上一回合**，不是「重跑整个任务」，按上一回合是谁跑的分两条路：
// - 普通回合（role=single、非旁路）→ 把上一句话重投给**同一条会话**（下称 turn 档）。
//   不用 RESUME_PROMPT 续跑，是因为回合可能死在 CLI 起来之前（503 no available account
//   就是），那时 CLI 侧压根没收到过这句话，只说「继续」等于把指令弄丢了。代价是 agent
//   有可能看见同一句话两遍 —— 宁可重一遍，也不能丢。
// - 自由工作流的审查回合（role=reviewer）→ 把**崩掉的那一轮审查**重新拉起来（review
//   档，见 free-review-round.ts 的 reopenFailedFreeReview）。用户在界面上看到的就是那条
//   审查会话，重试语义只能是「同一位审查者接着把这一轮跑完」；这里另拼一套普通回合，
//   跑的是实现 agent，等于把审查按钮接到了别人身上（第 2 轮审查 finding 1）。
//
// 「同一条会话」是这条路的**硬要求**，不是锦上添花：`resumeOrRunTask` 按任务自身的
// agentType 挑实现会话，@召唤别的执行器续聊、就地验证的验证者，跑的都不是那一条。所以
// 重投一律按崩掉那条会话自己记下的 profile（`sessions.executor_id` + 那一轮生效的
// 模型/思考强度）路由，并用 `resumeSessionId` 钉死续哪一行。
//
// 三个「看起来像崩了、其实不是」的形状必须挡在门外，判据都在库里，不靠猜：
// ① 手动停止/暂停 → CLI 吃 SIGTERM 后按 signal 写非零退出码，跟崩溃一模一样，认
//    `sessions.stopped_as`（finding 2）；
// ② 旁路回合（就地验证、`/compact` 这类原生命令）→ 认 `sessions.side_turn`，它们各有
//    自己的重来入口，重投会顶着同一个轮号另跑一段普通回合（finding 6）；
// ③ 就地验证轮还挂着（`verifyRound` 非空 = 那一轮没 concludeRound）→ 同上。
import { open, stat } from "node:fs/promises";
import type { AgentType, ConvSeg } from "@harness/shared";
import { parseSessionOutput } from "@harness/shared";
import { parseAttachmentText } from "@harness/shared/attachments";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { isAcceptingTask } from "./acceptance-lock.js";
import { db } from "./db/index.js";
import { groups, sessions, tasks } from "./db/schema.js";
import { freeReviewRetryBlocker, latestRun, reopenFailedFreeReview, roundOf } from "./free-review-round.js";
import { continueTask } from "./orchestrator.js";
import { queueBlockers } from "./queues.js";
import { claimTurn, releaseTurn } from "./runs.js";
import { RESUME_PROMPT } from "./run-prompts.js";
import { resumeOrRunTask } from "./task-resume.js";
import { appendTaskTimeline } from "./task-timeline.js";
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
  question?: string | null;
  resumePrompt?: string | null;
  workflowMode?: string | null;
};

export type RetryTurnSession = {
  id: string;
  role: string;
  turnStartedAt: string | null;
  startedAt: string;
  exitStatus: number | null;
  stoppedAs?: string | null;
  sideTurn?: boolean;
};

/** 判据的全部输入：任务、最新会话，加上三样只有查库才知道的事实。 */
export type RetryTurnFacts = {
  task: RetryTurnTask;
  latest: RetryTurnSession | null;
  wantedSessionId?: string;
  /** 同队列排在前面、还没完成的任务。 */
  blockedBy?: string[];
  /** 所在分组被暂停（`scheduler.ts` 同样拒绝拉起暂停组的成员）。 */
  groupPaused?: boolean;
  /** 审查档专用：这条审查链能不能重跑（`freeReviewRetryBlocker` 的结论）。 */
  reviewBlocker?: string | null;
};

/** 重试落在哪条路上，由**上一回合自己的身份**决定。 */
export type RetryTurnKind = "turn" | "review";

export function retryTurnKindOf(latest: RetryTurnSession): RetryTurnKind {
  return latest.role === "reviewer" ? "review" : "turn";
}

// 会话行**跨回合复用**：恢复一条旧 CLI 会话只更新 `turnStartedAt`，`startedAt` 停在它第一
// 次被创建的时刻。所以「最新会话」只能按最近一次回合排，按 `startedAt` 排会把「先建后用」
// 的会话永远判成旧的（口径同 `task-question.ts` 的 askingAgentFor）。
export function latestSessionOf<T extends RetryTurnSession>(rows: T[]): T | null {
  const turnAt = (row: RetryTurnSession) => row.turnStartedAt ?? row.startedAt;
  return [...rows].sort((left, right) => turnAt(left).localeCompare(turnAt(right))).at(-1) ?? null;
}

// 能不能重跑。纯函数：路由只负责取数据、占回合锁，判据全在这里，好钉测试。
// 返回 null = 放行；否则是要原样回给前端的那句拒绝理由。
export function retryTurnRejection(facts: RetryTurnFacts): { error: string; detail?: Record<string, unknown> } | null {
  const { task, latest } = facts;
  if (task.archived) return { error: "任务已归档，先取消归档再重试", detail: { archived: true } };
  // 只做单飞任务：duet 有自己的 gate 语义、团队调度台是常驻会话，两边的「上一回合」
  // 都不是这里这套 user/agent 交替的形状，硬套只会把它们的状态机搅乱。
  if (task.mode !== "single") return { error: "只有单飞任务支持重跑上一回合", detail: { mode: task.mode } };
  if (!latest) return { error: "任务还没跑过，没有可重跑的回合" };
  // 前端按钮挂在某一条会话的尾栏上；带上 sessionId 就是在说「我要重跑的是**我看到的
  // 那一条**」。它不是最新会话就说明中间又跑过一轮，页面是旧的 —— 拒绝而不是照跑。
  if (facts.wantedSessionId && facts.wantedSessionId !== latest.id) {
    return { error: "页面上的会话不是最新一次，刷新后再试", detail: { sessionId: latest.id } };
  }
  if (task.status === "running" || task.status === "queued") {
    return { error: "任务正在运行或排队，结束后再重试", detail: { status: task.status } };
  }
  // 遗留的提问 / 检查点续跑指令必须先处理：它们各自有入口（答复、继续），而且这两个
  // 字段在结算与对账里都被当成「这条链在等答复」的正常态，带着它们重投会让等待中的那
  // 条链收不了尾（口径同 startFreeReview）。
  if (task.question) return { error: "任务正在等你答复，先回答再决定要不要重跑", detail: { question: true } };
  if (task.resumePrompt) return { error: "任务挂着待续跑指令，先让它继续，不必重跑上一回合", detail: { resumePrompt: true } };
  // 验证轮的轮次号还挂着 = 那一轮就地验证没出结论。它是旁路回合，重投等于顶着同一个轮号
  // 另跑一段普通回合（判据同 `/verify` 与 `task-accept-guard.ts`）。
  if (task.verifyRound !== null) {
    return { error: `第 ${task.verifyRound} 轮就地验证还没出结论，等它结束再重试`, detail: { verifyRound: task.verifyRound } };
  }
  // **主动停止/暂停也会留下非零退出码**（多数 CLI 吃 SIGTERM 后按 signal 写 exitStatus=1）。
  // 那不是崩溃，重投等于把用户刚亲手停下的那句话再跑一遍；界面上这种状态给的是「运行」。
  if (latest.stoppedAs) {
    return { error: "上一回合是你手动停止的，不是异常结束；要继续请用运行", detail: { stoppedAs: latest.stoppedAs } };
  }
  if (latest.exitStatus === 0 || latest.exitStatus == null) {
    return { error: "上一回合不是异常结束，不需要重跑", detail: { exitStatus: latest.exitStatus } };
  }
  if (facts.groupPaused) return { error: "所在分组已暂停，先恢复分组再重试", detail: { groupPaused: true } };
  // 同 /run：串行队列里排在前面的还没完，这一颗就不该抢跑。少了这道闸，队尾任务上的
  // 重试按钮就成了插队入口。
  if (facts.blockedBy?.length) {
    return { error: "队列前面还有未完成的任务，先把它们处理完或把本任务移出队列", detail: { blockedBy: facts.blockedBy } };
  }
  if (retryTurnKindOf(latest) === "review") {
    if (task.workflowMode !== "free") {
      return { error: "上一回合是审查旁路会话，重跑它请走审查那条路", detail: { role: latest.role } };
    }
    if (facts.reviewBlocker) return { error: facts.reviewBlocker, detail: { role: latest.role } };
    return null;
  }
  // 剩下的只放行普通实现回合：lead/voiceA/voiceB 这些身份连「上一回合」的形状都不同。
  if (latest.role !== "single") {
    return { error: "上一回合是旁路会话，这里重跑不了", detail: { role: latest.role } };
  }
  // 旁路回合（就地验证、`/compact` 这类 CLI 原生命令）用的是任务当前的默认配置重投，
  // 跑的根本不是那一轮的验证者；它们各有自己的重来入口。
  if (latest.sideTurn) {
    return { error: "上一回合是验证/命令旁路回合，请从它自己的入口重来", detail: { sideTurn: true } };
  }
  if (task.status !== "done") {
    return { error: "只有停在「已完成」的任务才谈得上重跑上一回合", detail: { status: task.status } };
  }
  return null;
}

type TaskRow = typeof tasks.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

/** 一次性把判据要的东西全查出来。任务不存在返回 null。 */
async function readFacts(
  taskId: string,
  wantedSessionId?: string,
): Promise<{ task: TaskRow; latest: SessionRow | null; facts: RetryTurnFacts } | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return null;
  const latest = latestSessionOf(await db.select().from(sessions).where(eq(sessions.taskId, taskId)));
  const group = task.groupId
    ? (await db.select({ paused: groups.paused }).from(groups).where(eq(groups.id, task.groupId))).at(0)
    : undefined;
  // 审查链的判据只在真的是审查会话时才查（多两条 SQL 换不来任何东西）。
  let reviewBlocker: string | null = null;
  if (latest && retryTurnKindOf(latest) === "review" && task.workflowMode === "free") {
    const run = await latestRun(taskId);
    reviewBlocker = freeReviewRetryBlocker(run, run ? await roundOf(run) : null);
  }
  return {
    task,
    latest: latest ?? null,
    facts: {
      task,
      latest: latest ?? null,
      wantedSessionId,
      blockedBy: await queueBlockers(taskId),
      groupPaused: !!group?.paused,
      reviewBlocker,
    },
  };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function mountTaskRetryTurnRoutes(api: Hono): void {
  api.post("/tasks/:id/retry-turn", async (c) => {
    const taskId = c.req.param("id");
    const body = await c.req.json<{ sessionId?: string }>().catch(() => ({} as { sessionId?: string }));
    const first = await readFacts(taskId, body.sessionId);
    if (!first) return c.json({ error: "not found" }, 404);
    const rejection = retryTurnRejection(first.facts);
    if (rejection) return c.json({ error: rejection.error, ...rejection.detail }, 409);
    const kind = retryTurnKindOf(first.latest!);
    // 同 /run、/retry：原子占位，并发只有一个能 202。占位身份跟着分支走 —— 审查重跑此刻
    // 还没有审查回合，冒充 reviewer 会让迟到的结论上报被当成本回合的（见
    // reportFreeReviewConclusion 的 turnRole 校验）。
    if (!claimTurn(taskId, kind === "review" ? "dispatch" : "single")) {
      return c.json({ error: "任务回合正在进行，结束后再重试", status: first.task.status }, 409);
    }
    // 占位之后的每一条出路都必须交接或释放这把锁：漏一条就是「500 一次、之后永远 409，
    // 只能重启服务」。所以 handed 只在**真正把 turnHeld 交给下游**的那一刻才置位。
    let handed = false;
    try {
      // 占位后镜像检查验收锁，否则下游撞上验收锁静默 return，202 就成了谎报。
      if (isAcceptingTask(taskId)) {
        return c.json({ error: "任务正在验收（含发布尾段），结束后再重试", status: first.task.status }, 409);
      }
      // ── 占位后权威重查（口径同 review.ts）──
      // 上面那一遍是在**没有任何互斥**的情况下读的：从读完到 claimTurn 之间隔着好几个
      // await，归档、取消、入队、验收随便哪个都能在这中间落库，而占位只挡得住「另一个
      // 回合」，挡不住这些不占 turn 的写操作。实测 20/20：并发归档 + 重试双双成功，任务
      // 落在 archived=true 且 running（第 2 轮审查 finding 3）。所以判据整套重跑一遍，
      // 拒绝走 finally 释放。
      const fresh = await readFacts(taskId, body.sessionId);
      const again = fresh ? retryTurnRejection(fresh.facts) : { error: "任务已被删除", detail: undefined };
      if (!fresh || again) {
        return c.json({ error: again?.error ?? "任务已被删除", ...(again?.detail ?? {}) }, 409);
      }
      const { task, latest } = fresh as { task: TaskRow; latest: SessionRow };
      // 分支在占位前后必须是同一个：占位身份是按它选的，变了就等于按错的身份占了锁。
      if (retryTurnKindOf(latest) !== kind) {
        return c.json({ error: "上一回合在这中间变了，刷新后再试", sessionId: latest.id }, 409);
      }

      // 交接必须**有人接住错误**：`void continueTask(...)` 在下游接管这把锁之前抛错（它
      // 开头还有一次 DB 读）时，锁会永远留在我们名下 —— 之后这个任务的每一次运行都 409，
      // 只能重启服务，而 202 已经发出去了，用户以为跑起来了（finding 4）。
      const handoff = (work: Promise<boolean | void>, what: string): void => {
        handed = true;
        void work.then(
          async (delivered) => {
            // continueTask 返回 false = 一个字都没送出去，且它自己已经把锁还了。
            if (delivered === false) await appendTaskTimeline(taskId, `${what}未能启动：回合被其它执行抢占，请再试一次。`);
          },
          async (error) => {
            // 只有下游接管之前抛错才会到这（接管之后它自己 try/finally 兜底），锁还是
            // 我们占的那把，必须还回去。
            releaseTurn(taskId);
            await appendTaskTimeline(taskId, `${what}启动失败：${errorText(error)}；可以再试一次。`);
          },
        );
      };

      if (kind === "review") {
        // 我们占着 turn 调用（holdTurn 交给这里做）：审查投递在 continueWhenIdle 里排队，
        // finally 释放这把锁之后才真正开跑，和派审同一条路。
        try {
          await reopenFailedFreeReview(taskId, { resumeSessionId: latest.id });
        } catch (error) {
          return c.json({ error: errorText(error) }, 409);
        }
        return c.json({ started: true, mode: "review" }, 202);
      }

      // 崩掉的那一回合可能跑在**被召唤来的**执行器上（@codex 续聊），也可能任务的配置在
      // 这之后被改过。会话行记着那一轮真正生效的 profile 主键与模型/思考强度，按它整套
      // 重放；`agents.name` 反查是错的 —— 名字非唯一、可改，重名时会选中另一位（finding 5）。
      // 老会话行没有这三列（null）：只能退回按类型走默认 profile，与旧行为一致。
      const route = latest.executorId
        ? {
          agent: latest.agentType as AgentType,
          executorId: latest.executorId,
          model: latest.turnModel,
          reasoningEffort: latest.turnReasoningEffort,
        }
        : latest.agentType === task.agentType
          ? {}
          : { agent: latest.agentType as AgentType, model: null, reasoningEffort: null };
      const seg = await lastInputSeg(readableRunPath(sessionTranscriptPath(taskId, latest.id))).catch(() => null);
      if (seg?.kind === "user") {
        const { body: text, paths } = parseAttachmentText(seg.text);
        const trimmed = text.trim();
        if (trimmed || paths.length) {
          handoff(continueTask(taskId, trimmed, {
            ...route,
            attachments: paths,
            // 后端代写的那句（审查打回等）重投时仍标 by:"system"：作者没变，重来一次不该
            // 把机器的话记成我说的。
            byBackend: !!seg.bySystem,
            resumeSessionId: latest.id,
            turnHeld: true,
          }), "重跑上一回合");
          return c.json({ started: true, mode: "resend" }, 202);
        }
      }
      // 上一回合是系统续跑（会话里最后一段不是 user）：没有可重投的原话，改用续跑提示。
      // 会话行记着 profile 时仍旧钉死那一条会话；老行退回 `resumeOrRunTask`（它按任务的
      // agentType 挑会话，跟界面头部那颗「运行」同一条路）。
      handoff(
        latest.executorId
          ? continueTask(taskId, RESUME_PROMPT, { ...route, system: "retry", resumeSessionId: latest.id, turnHeld: true })
          : resumeOrRunTask(taskId, { reason: "retry", turnHeld: true }),
        "重跑上一回合",
      );
      return c.json({ started: true, mode: "resume" }, 202);
    } finally {
      if (!handed) releaseTurn(taskId);
    }
  });
}
