// 多人模式的派发闸(§八「宿主机 CLI 订阅在多人模式下彻底抹去」)。
//
// 抹去宿主订阅之后,一个执行器要能跑起来,必须两件事同时成立:
//  ① 它的 CLI **接了供应商注入(relay)** —— 否则没有任何途径把用户自己的 key 送进去,
//     它只会去找宿主机的登录态,而那正是被隔离掉的东西。
//  ② 它**挂了供应商** —— 接了 relay 但没配 key,结果一样跑不起来。
//
// ① 的判据挂在「catalog 里有没有 relay 实现」上,**不写死名单**(计划明确要求):
// 将来某个 CLI 接上 relay,它自动解禁,这里一行都不用改。
//
// **整道闸只在隔离档下成立**:实例选了「共用宿主机 CLI」(§八之二)时宿主登录态就是
// 大家在用的那份,没挂供应商恰恰是常态,这里必须整条穿透 —— 判据统一问
// `isHostCliIsolated()`,不是 `isMultiUser()`。自用模式下同样一律不成立,行为与本
// 功能上线前逐字节一致。
import { eq, isNull } from "drizzle-orm";
import type { AgentType, ExecutorDowngradeItem, ExecutorSlot } from "@ash/shared";
import { MULTI_USER_CLI_BLOCKED, MULTI_USER_NO_PROVIDER_HINT } from "@ash/shared/multiuser";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { cliSpec } from "../executors/catalog/index.js";
import { isHostCliIsolated, isMultiUser } from "./mode.js";

/** 这个 CLI 接了供应商注入吗。 */
export function cliSupportsRelay(type: string): boolean {
  try {
    return !!cliSpec(type as AgentType).exec.relay;
  } catch {
    return false; // 不在目录里的类型(老库遗留)一律当作不支持
  }
}

/**
 * 同步版判据:回一句拒绝理由,或 null 表示可派发。
 * **不查库**,所以能直接用在列表接口的 map 里给每一行打标。
 */
export function dispatchBlockReason(type: string, providerId: string | null): string | null {
  if (!cliSupportsRelay(type)) return MULTI_USER_CLI_BLOCKED(type);
  if (!providerId) return MULTI_USER_NO_PROVIDER_HINT;
  return null;
}

/**
 * 真正起跑前的那道闸。返回拒绝理由或 null。
 * `executorId` 为空表示「按类型默认执行器降级」,那条路同样要过闸 —— 否则删掉
 * 执行器就成了绕过它的方法。
 */
export async function dispatchRejection(input: {
  agentType: string;
  executorId?: string | null;
  /** 这一轮按谁的执行器跑;不传 = 不收窄(自用模式或还没接这一层的调用点)。 */
  owner?: string | null;
}): Promise<string | null> {
  if (!(await isHostCliIsolated())) return null;
  if (!cliSupportsRelay(input.agentType)) return MULTI_USER_CLI_BLOCKED(input.agentType);
  if (input.executorId) {
    const row = (await db.select().from(agents).where(eq(agents.id, input.executorId))).at(0);
    // 执行器行没了、或者它是别人的 → 交给既有的「按本人默认执行器降级」去处理,
    // 这里不抢着报错:那条路才是 §八 说的降级,报错会把它变成硬失败。
    if (row && (input.owner === undefined || row.ownerUserId === input.owner)) {
      return row.providerId ? null : MULTI_USER_NO_PROVIDER_HINT;
    }
  }
  // 兜底那条也必须按人收窄:不收窄的话,别人的默认执行器会替我把这道闸放过去,
  // 而真正起跑时解析到的是**我自己**那条(可能压根没挂供应商)。
  const fallback = (await db.select().from(agents).where(eq(agents.type, input.agentType)))
    .find((a) => a.isDefault && (input.owner === undefined || a.ownerUserId === input.owner)) ?? null;
  if (!fallback) return MULTI_USER_NO_PROVIDER_HINT;
  return fallback.providerId ? null : MULTI_USER_NO_PROVIDER_HINT;
}

/**
 * 「同一类型至多一个默认执行器」在多人模式下是**每人各自**的一个默认。
 * 清标记时按归属收窄,否则设自己的默认会把别人的设置一起改掉。
 */
export async function clearDefaultFor(type: string, ownerUserId: string | null): Promise<void> {
  const rows = await db
    .select({ id: agents.id, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(eq(agents.type, type));
  for (const row of rows) {
    if (row.ownerUserId !== ownerUserId) continue;
    await db.update(agents).set({ isDefault: false }).where(eq(agents.id, row.id));
  }
  // 自用模式(归属全是 null)时上面那层判断退化成「全清」,与原行为一致。
  if (ownerUserId === null) {
    await db.update(agents).set({ isDefault: false }).where(isNull(agents.ownerUserId));
  }
}

/**
 * 解析执行器时要不要按人收窄。
 * 自用模式回 `{}`(不带 owner 键)—— `ExecutorResolveOpts.owner` 的语义是
 * 「不传 = 不收窄」,所以这条路与本功能上线前逐字节一致。
 */
export async function executorOwnerScope(
  ownerUserId: string | null,
): Promise<{ owner?: string | null }> {
  if (!(await isMultiUser())) return {};
  return { owner: ownerUserId };
}

/**
 * 把一次跨人降级如实记进任务时间线。§八 要求「弹窗显式确认」——弹窗那一半在前端
 * (拿 `GET /tasks/:id/executor-preflight` 的结果),这里补的是**事后可查**的那一半:
 * 用户点了确认之后,一个月后翻记录仍看得出这一轮换过执行器。
 */
export async function noteExecutorDowngrade(
  taskId: string,
  from: { name: string; type: string },
  toName: string,
): Promise<void> {
  const { appendTaskTimeline } = await import("../task-timeline.js");
  await appendTaskTimeline(
    taskId,
    `执行器已降级：原执行器「${from.name}」(${from.type})属于别人，本轮改用你的「${toName}」。`,
  );
}

/**
 * 「我现在动这个任务,会不会被换掉执行器」——弹窗那一半的数据源(§八)。
 *
 * 判据跟真正起跑时 `pickProfile` 用的是同一条:任务身上钉着的执行器行**不是我的**
 * (别人的私有资源、或者已经被删),那一轮就会落到我自己的默认执行器上。这里只读、
 * 不写,前端在点「回复 / 重跑 / 派审」之前先问一次。
 *
 * **一个任务身上不止一格执行器**:duet 把两位讨论者存在 `tasks.duet` 里、team 把三个
 * 角色存在 `tasks.team` 里,两者顶层 `executorId` 都是空的 —— 只读顶层那一格,这两种
 * 任务永远被预检成「无需确认」,而它们一样会静默换人(第 6 轮审查 P1 报的是 duet;
 * team 是同一个洞,顺手一起堵上,别等下一轮再报一次)。所以返回的是**列表**:哪几格
 * 会被换、各自换成什么。
 *
 * 空数组 = 不会换,前端不弹。
 */
export async function executorDowngradePreflight(
  taskId: string,
  actingUserId: string | null,
): Promise<ExecutorDowngradeItem[]> {
  if (!(await isMultiUser())) return [];
  const { tasks, users } = await import("../db/schema.js");
  const task = (await db
    .select({
      executorId: tasks.executorId, agentType: tasks.agentType,
      mode: tasks.mode, duet: tasks.duet, team: tasks.team,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  if (!task) return [];

  // 这个任务真正会用到的几格。duet 只看两位讨论者:它的顶层 executorId 不参与运行。
  const slots: { slot: ExecutorSlot; executorId: string | null; agentType: string | null }[] = [];
  const parse = (json: string | null): Record<string, string | null> => {
    try { return json ? (JSON.parse(json) as Record<string, string | null>) : {}; } catch { return {}; }
  };
  if (task.mode === "duet") {
    const cfg = parse(task.duet);
    slots.push({ slot: "voiceA", executorId: cfg.voiceAExecutorId ?? null, agentType: cfg.voiceA ?? null });
    slots.push({ slot: "voiceB", executorId: cfg.voiceBExecutorId ?? null, agentType: cfg.voiceB ?? null });
  } else if (task.mode === "team") {
    const cfg = parse(task.team);
    slots.push({ slot: "lead", executorId: cfg.leadExecutorId ?? null, agentType: cfg.lead ?? null });
    slots.push({ slot: "worker", executorId: cfg.workerExecutorId ?? null, agentType: cfg.worker ?? null });
    slots.push({ slot: "reviewer", executorId: cfg.reviewerExecutorId ?? null, agentType: cfg.reviewerAgentType ?? null });
  } else {
    slots.push({ slot: "task", executorId: task.executorId, agentType: task.agentType });
  }

  const nameOf = async (userId: string | null): Promise<string | null> =>
    userId ? (await db.select({ name: users.name }).from(users).where(eq(users.id, userId))).at(0)?.name ?? null : null;

  const out: ExecutorDowngradeItem[] = [];
  for (const s of slots) {
    // 这一格压根没钉执行器 → 本来走的就是「我的默认」,没什么可确认的。
    if (!s.executorId) continue;
    const row = (await db.select().from(agents).where(eq(agents.id, s.executorId))).at(0);
    // 行还在、而且就是我的 → 照原样跑。
    if (row && row.ownerUserId === actingUserId) continue;
    const type = row?.type ?? s.agentType ?? "claude";
    const mine = (await db.select().from(agents).where(eq(agents.type, type)))
      .find((a) => a.isDefault && a.ownerUserId === actingUserId) ?? null;
    out.push({
      slot: s.slot,
      // 执行器行被删干净时名字已经无从查起,如实说「已删除」而不是编一个。
      fromName: row?.name ?? "（已删除的执行器）",
      fromType: type,
      fromOwner: await nameOf(row?.ownerUserId ?? null),
      toName: mine?.name ?? null,
    });
  }
  return out;
}
