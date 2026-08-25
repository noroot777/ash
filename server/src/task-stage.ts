import type { TaskStage } from "@ash/shared";
import { isTaskStage, STAGE_LABELS, STAGE_ORDER } from "@ash/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

export async function setTaskStage(
  taskId: string,
  stage: TaskStage,
  currentTurn?: { token: string | null },
): Promise<{ updatedAt: string; timelineRecorded: boolean } | null> {
  const updatedAt = now();
  const where = currentTurn
    ? and(
        eq(tasks.id, taskId),
        eq(tasks.status, "running"),
        currentTurn.token === null
          ? isNull(tasks.activeTurnToken)
          : eq(tasks.activeTurnToken, currentTurn.token),
      )
    : eq(tasks.id, taskId);
  const updated = await db.update(tasks).set({ stage, updatedAt }).where(where).returning({ id: tasks.id });
  if (!updated.length) return null;
  bus.publish({ type: "task.stage", taskId, stage, updatedAt });
  const timelineRecorded = await appendTaskTimeline(taskId, `验收阶段更新：${STAGE_LABELS[stage]}（${stage}）`);
  return { updatedAt, timelineRecorded };
}

/**
 * 把验收阶段清回「进行中」并广播。
 *
 * 两个调用方：已验收任务被重新唤醒（下面那个），以及**中途人工关口放行**（一条线上写了
 * 不止一道「等我点头」时，前面那几道点完只是放行，任务得从「待验收」回到进行中，不然
 * 它会一直挂着一句「待验收」而线其实已经往下走了）。广播一步都不能省，否则列表分组
 * 要等下次全量拉取才动。
 */
export async function clearTaskStage(taskId: string, note: string): Promise<void> {
  const updatedAt = now();
  await db.update(tasks).set({ stage: null, updatedAt }).where(eq(tasks.id, taskId));
  bus.publish({ type: "task.stage", taskId, stage: null, updatedAt });
  await appendTaskTimeline(taskId, note);
}

// 已翻篇的任务又被唤醒 —— 用户发来真人消息、或调度者接着派活 —— 就把 stage 清回
// null,列表把它从「已验收」挪回「进行中」;干完再验收一次即可翻篇。
//
// **accepted 和 merged 都要清**:merged 是「已经合进去了、只差最后落个验收章」,同样是
// 上一版的结论。留着它的后果不只是显示不准 —— `enterHumanGate` 见到 merged 会**静默
// 跳过**「等我点头」那道关口(review.ts),于是新一版改动一路走到底、连问都不问用户一句。
// accepted 只代表上一版产物已经验收,不能覆盖验收后的新增改动;这条规则对
// single/team/duet 一致。
// 走内部更新而不是 POST /tasks/:id/stage:那道 mode==="team" 的 409 是挡 **agent 自报**
// 的外部协议入口(调度台没有实现/验证语义),挡的不是这条内部规则;广播必须保留,
// 否则前端分组要等下次全量拉取才动。
//
// **返回摘掉的完整快照**（没摘则 null）：摘牌发生在回合最前面，那时还不知道这一轮
// 会不会真产出改动。stage 之外，合并快照三列与尾段进度也一起摘——它们同属上一验收
// 生命周期。调用方要能在结算时发现「白摘了」并**整套**原样挂回（见 turn-baseline.ts
// 与下面的 restoreTaskStage）；只挂回 stage 会留下「界面显示已验收、结构化快照却空了」
// 的组合，下一次验收会按当时 checkout 重新解析目标（审查实测：同一任务被合进两个分支）。
export type AcceptedSnapshot = {
  target: string | null;
  base: string | null;
  merge: string | null;
  tailPending: boolean;
  /** 尾段逐站进度（step id 清单）；缺省 = 旧版基线，按空清单恢复。 */
  tailDone?: string[];
};
export type ReopenedAcceptance = { stage: "accepted" | "merged"; snapshot: AcceptedSnapshot };

/**
 * 只读探一眼：这个任务身上挂着的验收牌子与合并快照（没有则 null），**不做任何改写**。
 *
 * 与 `commitReopenAcceptedStage` 配对成 write-ahead 顺序：调用方先把这份快照持久化
 * （turn-baseline），**然后**才执行清空——两步之间任何一处崩溃，磁盘上都有完整快照可供
 * 结算挂回；反过来先清后存，崩在中间快照就永久丢了（审查实测：尾段进度被抹掉，
 * 崩溃补跑凭据不可恢复）。
 */
export async function peekAcceptedStage(taskId: string): Promise<ReopenedAcceptance | null> {
  const t = (await db.select({
    stage: tasks.stage,
    target: tasks.acceptedTargetBranch,
    base: tasks.acceptedBaseCommit,
    merge: tasks.acceptedMergeCommit,
    tailPending: tasks.acceptedTailPending,
    tailDone: tasks.acceptedTailDone,
  }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!t || (t.stage !== "accepted" && t.stage !== "merged")) return null;
  let tailDone: string[] = [];
  try { tailDone = JSON.parse(t.tailDone ?? "[]") as string[]; } catch { /* 按空清单 */ }
  return {
    stage: t.stage,
    snapshot: { target: t.target, base: t.base, merge: t.merge, tailPending: t.tailPending, tailDone },
  };
}

/** write-ahead 的第二步：真正执行摘牌（清 stage + 合并快照 + 尾段进度）并广播。 */
export async function commitReopenAcceptedStage(taskId: string): Promise<void> {
  await clearAcceptedSnapshot(taskId);
  await clearTaskStage(taskId, "任务又被唤醒，验收阶段清回进行中（完成后重新验收即可再次翻篇）");
}

/**
 * 摘牌里「合并快照」那一半：只清三列 + 尾段进度，不动 stage、不写时间线。
 * 给 continueTask 的 write-ahead 路径用——stage 那一半由 turn-baseline 的清账摘下并广播，
 * 这里只收掉同生命周期的快照。留着的话，「本周期已锁定目标」的判定（task-accept 的
 * pre-merge 持久化）会把新验收错误冻结到旧目标，崩溃重试还会复用旧区间。
 */
export async function clearAcceptedSnapshot(taskId: string): Promise<void> {
  // 上一周期的合并事实在 git 历史与时间线里都有。
  await db.update(tasks).set({
    acceptedTargetBranch: null, acceptedBaseCommit: null, acceptedMergeCommit: null,
    acceptedTailPending: false, acceptedTailDone: "[]", updatedAt: now(),
  }).where(eq(tasks.id, taskId));
}

/** peek + commit 的组合（没有 write-ahead 需求的调用方用，如团队派活）。 */
export async function reopenAcceptedStage(taskId: string): Promise<ReopenedAcceptance | null> {
  const peeked = await peekAcceptedStage(taskId);
  if (peeked) await commitReopenAcceptedStage(taskId);
  return peeked;
}

/**
 * 把 `reopenAcceptedStage` 摘掉的牌子**连同合并快照**原样挂回去，与 clearTaskStage 对称
 * （同样自带 note 和广播）。用在「这一轮结算下来工作目录一个字节没变」——用户只是问了
 * 句话，摘牌是白摘的。
 *
 * **只在牌子位还空着时放回**：这一轮 agent 自己上报过新阶段（report_stage）的话，那是更
 * 新的结论，不能被一张旧牌子盖掉。
 */
export async function restoreTaskStage(
  taskId: string,
  stage: TaskStage,
  note: string,
  snapshot?: AcceptedSnapshot | null,
): Promise<boolean> {
  const t = (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!t || t.stage) return false;
  const updatedAt = now();
  await db.update(tasks).set({
    stage,
    ...(snapshot ? {
      acceptedTargetBranch: snapshot.target,
      acceptedBaseCommit: snapshot.base,
      acceptedMergeCommit: snapshot.merge,
      acceptedTailPending: snapshot.tailPending,
      acceptedTailDone: JSON.stringify(snapshot.tailDone ?? []),
    } : {}),
    updatedAt,
  }).where(eq(tasks.id, taskId));
  bus.publish({ type: "task.stage", taskId, stage, updatedAt });
  await appendTaskTimeline(taskId, note);
  return true;
}

export function mountTaskStageRoutes(api: Hono): void {
  api.post("/tasks/:id/stage", async (c) => {
    const taskId = c.req.param("id");
    const body = await c.req
      .json<{ stage?: unknown }>()
      .catch(() => ({}) as { stage?: unknown });
    if (!isTaskStage(body.stage)) {
      return c.json({ error: `stage 非法，只能是：${STAGE_ORDER.join(" | ")}` }, 400);
    }

    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    // 团队调度台是常驻协调角色，没有「实现/验证/验收」语义。验证阶段现在由被验任务
    // 在自己的验证回合里上报（存量的独立审查任务仍给被审对象上报）；服务端保留兼容
    // 入口，不硬封普通任务调用。
    if (task.mode === "team") {
      return c.json({ error: "团队调度台不适用验收阶段，请在被验任务的验证回合里上报", mode: task.mode }, 409);
    }
    if (task.archived) return c.json({ error: "归档任务不能再上报验收阶段" }, 409);
    // 接力出去的任务不能再流转验收阶段:它在本机只是历史存档,阶段变化应发生在对端。
    const handedOff = handoffBlockReason(task.handoff);
    if (handedOff) return c.json({ error: handedOff, handoff: true }, 409);
    const stageToken = c.req.header("x-ash-turn-token");
    if (task.status === "running" && task.activeTurnToken && stageToken !== task.activeTurnToken) {
      return c.json({
        error: stageToken
          ? "验收阶段来自已结束的回合，已拒绝写入当前会话"
          : "MCP 未携带当前回合身份（执行器可能过滤了 ASH_TURN_TOKEN），验收阶段已拒绝写入",
      }, 409);
    }

    try {
      const { reportFreeReviewConclusion } = await import("./free-workflow.js");
      const freeReview = await reportFreeReviewConclusion(taskId, body.stage);
      if (freeReview) {
        return c.json({ reported: true, taskId, stage: body.stage, freeReview, timelineRecorded: false });
      }
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
    if (task.workflowMode === "free") {
      return c.json({ error: "自由工作流不使用起手式 stage；请按需派审或预览，完成后从验收页验收" }, 409);
    }

    // 已验收/已合并的任务不再接受 agent 自报阶段。这是**上一版产物的终局**,而 stage 是
    // 单值字段:一次 report_stage 就把 accepted 覆盖成 verified/implemented,验收事实无处
    // 可查(审查实测:preset 任务验收后 agent 报一次 verified,列表就从「已验收」掉回去)。
    // 正道是先让任务被真人唤醒 —— 那条路会走 `reopenAcceptedStage` 把牌子连同合并快照
    // 整套摘下来存好,新一版干完再验收一次;摘牌之后 stage 为空,这道拦截自然放行。
    if (task.stage === "accepted" || task.stage === "merged") {
      return c.json(
        { error: "任务已验收，验收结论不能被上报的阶段覆盖；如需继续改动，先在会话里发消息唤醒它", stage: task.stage },
        409,
      );
    }

    const result = await setTaskStage(
      taskId,
      body.stage,
      task.status === "running" ? { token: task.activeTurnToken } : undefined,
    );
    if (!result) return c.json({ error: "当前回合已经结束或已被引导，验收阶段未写入" }, 409);
    const { updatedAt, timelineRecorded } = result;
    return c.json({ reported: true, taskId, stage: body.stage, updatedAt, timelineRecorded });
  });
}
