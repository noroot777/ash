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
// 自用模式下这两条一律不成立 —— 那条路走宿主订阅,行为与本功能上线前逐字节一致。
import { eq, isNull } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { MULTI_USER_CLI_BLOCKED, MULTI_USER_NO_PROVIDER_HINT } from "@ash/shared/multiuser";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { cliSpec } from "../executors/catalog/index.js";
import { isMultiUser } from "./mode.js";

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
}): Promise<string | null> {
  if (!(await isMultiUser())) return null;
  if (!cliSupportsRelay(input.agentType)) return MULTI_USER_CLI_BLOCKED(input.agentType);
  if (input.executorId) {
    const row = (await db.select().from(agents).where(eq(agents.id, input.executorId))).at(0);
    // 执行器行没了 → 交给既有的「按类型默认执行器降级」去处理,这里不抢着报错。
    if (row) return row.providerId ? null : MULTI_USER_NO_PROVIDER_HINT;
  }
  const fallback = (await db.select().from(agents).where(eq(agents.type, input.agentType)))
    .find((a) => a.isDefault) ?? null;
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
