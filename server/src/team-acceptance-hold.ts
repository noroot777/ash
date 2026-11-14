// 团队验收期间冻住这一队：调度台和它的共享执行者（不开独立 worktree 的那些 —— 跟调度台共用一个工作目录、
// 成果算进成果版本、验收时一起盖章的那一批，见 task-result-version.ts isSharedTeamWorker）。团队有自己的 worktree 时，
// 下一轮会落进这个目录的其余任务（审查任务等，task-workspace.ts workspaceParticipants）一并占住：验收要合的就是这个目录。
// 团队原地干活（项目目录）时不扩：那时验收不合并，项目里别的原地任务改不了团队这一版成果，冻住它们只会平白挡人。
//
// 为什么非冻不可：验收进门时核过「没人在飞、成果还是卡上那一版」，之后到合并、盖章之间隔着一串 await（自动
// 提交、门禁判定、合并、停预览、发布尾段）。验收互斥原来只锁调度台自己，执行者在那段时间里照样能起跑、改共享
// 目录，验收就把一版谁都没看过的成果合了进去（第 2 轮审查实测）。查是观察式的，多查几次关不掉这个窗口 —— 所以
// 用起跑同一把回合锁占住全队（turn-lock.ts ACCEPT_HOLD_ROLE），直到验收连同尾段结束。占着它，执行者起不了新的
// 一轮，改状态、删除、归档、写工作区也被各自的守卫挡回；验收自己的守卫和自动提交认得这份占位（holdMembers）。
//
// 调度台的回合不走那把锁（常驻会话），由投递口挡：写进它 stdin 的那一刻（team/lead-delivery.ts）和离线开台之前
// （team/session.ts deliver）都先问 heldForAcceptance。它自己的 CLI 起的回合 ash 挡不住（team/session-consumer.ts
// 「CLI 自己开的新一轮」），所以占住时记下这一版成果，之后每道守卫和盖章之前各核一次（holdDrift），变了就不验收。
//
// 成员集合在验收期间也不能长：建任务落库那一下、派活全程都占着「加成员」的位（team-admission.ts → acceptance-lock.ts
// beginAdmitting），跟验收互斥。所以占位时读到的那一批就是验收全程的那一批；盖章再在同一个事务里核一次没有多出来的
// 共享执行者（review-acceptance.ts commitAcceptanceStage）。
//
// 释放时排空「等这一轮跑完」的交接（被挡下的续跑、投递随即补上），再补推验收期间留在托盘里的消息、把调度台
// 投递口拒收下来的执行者汇报送进去（team/session.ts resumeLeadAfterAcceptance）。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { taskFileRoot } from "./file-browser.js";
import { repoKey } from "./git.js";
import { claimAcceptanceHold } from "./runs.js";
import { workspaceParticipants } from "./task-workspace.js";
import { isSharedTeamWorker, resultVersionOf } from "./task-result-version.js";

/** members = 占到的那几位；scope = 想占的全部（占不到的此刻有回合在跑，验收守卫据此拒绝）。 */
type Hold = { members: Set<string>; scope: ReadonlySet<string>; version: string | null; releases: (() => void)[] };
const holds = new Map<string, Hold>();
const NONE: ReadonlySet<string> = new Set();

/**
 * 占住这个团队（不是团队调度台就什么都不做）。占不到的是此刻真有回合在跑的那几位：不在这里拒，验收守卫照常
 * 看得见它们并拒绝验收（task-accept-guard.ts）。返回释放函数，调用方在验收（含尾段）结束的同一个 finally 里调。
 */
export async function holdTeamForAcceptance(taskId: string): Promise<() => void> {
  const lead = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!lead || lead.mode !== "team" || lead.parentId) return () => {};
  const workers = (await db.select({ id: tasks.id, useWorktree: tasks.useWorktree }).from(tasks).where(eq(tasks.parentId, taskId)))
    .filter(isSharedTeamWorker);
  // 自己的 worktree = 这个目录不是它所属仓库的主检出（原地干活时两者是同一个目录）。
  const root = await taskFileRoot(taskId);
  const own = !!root?.repo && repoKey(root.path) !== repoKey(root.repo);
  const peers = own ? await workspaceParticipants(lead, root!.path) : [];
  const scope = new Set([taskId, ...workers.map((worker) => worker.id), ...peers.map((peer) => peer.id)]);
  const { held, release } = claimAcceptanceHold([...scope]);
  const hold: Hold = { members: new Set(held), scope, version: null, releases: [release] };
  holds.set(taskId, hold);
  let released = false;
  const releaseAll = () => {
    if (released) return;
    released = true;
    if (holds.get(taskId) === hold) holds.delete(taskId);
    for (const release of hold.releases) release();
    void afterHold(taskId);
  };
  try {
    // 占住之后才记：从这一刻起，能改这一版成果的只剩调度台 CLI 自己起的回合（见文件头）。
    hold.version = await resultVersionOf(lead);
  } catch (error) {
    releaseAll();
    throw error;
  }
  return releaseAll;
}

/**
 * 把占位那一刻没占到的补占上。占不到的未必是有回合在跑：也可能是别的短暂占用者（源码管理写操作在仓库锁里
 * 占着全部共用者），它一放手，这一位就谁都没冻着，之后照样起得了跑。所以每道验收守卫之前补一次（task-accept-guard.ts）：
 * 补上了就冻住；还占不到的，守卫照「回合锁被别人占着」拒绝。
 */
export function topUpHold(taskId: string): void {
  const hold = holds.get(taskId);
  if (!hold) return;
  const missing = [...hold.scope].filter((id) => !hold.members.has(id));
  if (!missing.length) return;
  const { held, release } = claimAcceptanceHold(missing);
  for (const id of held) hold.members.add(id);
  hold.releases.push(release);
}

/** 这次团队验收占着的那几位（守卫据此不把自己的占位当成「有回合在飞」）。没在验收就是空的。 */
export function holdMembers(taskId: string): ReadonlySet<string> {
  return holds.get(taskId)?.members ?? NONE;
}

/** 这次团队验收想占住的全部（调度台、共享执行者、团队 worktree 里其余的共用者）。没在验收就是空的。 */
export function holdScope(taskId: string): ReadonlySet<string> {
  return holds.get(taskId)?.scope ?? NONE;
}

/** 占住之后团队的成果变了没有：变了回一句给人看的原因，没变（或没在占）回 null。 */
export async function holdDrift(taskId: string): Promise<string | null> {
  const hold = holds.get(taskId);
  if (!hold?.version) return null;
  const lead = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!lead || await resultVersionOf(lead) === hold.version) return null;
  return "验收途中团队又跑出了新的结果（多半是调度台自己起了一轮），这一次没有验收：看过最新的再验收";
}

// 占着的那几位一放锁，各自的待发送就由放锁那一刻的扫描补送（turn-release.ts），这里只管调度台。
async function afterHold(leadId: string): Promise<void> {
  // 动态 import：这条链路会回头读任务/回合状态、再绕回验收这边，静态引会成环（同 acceptance-lock.ts）。
  try {
    const { resumeLeadAfterAcceptance } = await import("./team/session.js");
    await resumeLeadAfterAcceptance(leadId);
  } catch (error) {
    console.error(`[ash] 团队验收结束后补送消息失败 task=${leadId}:`, error);
  }
}
