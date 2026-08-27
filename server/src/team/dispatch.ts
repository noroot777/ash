// 派活:调度者调 MCP 的 dispatch → 这里建 N 个执行者任务 + 一个内部组(+ 串行队列)。
//
// 内部组(groups.owner_task_id = 调度者 taskId)是为了白嫖现成的调度器:串行批次
// = serial 组 + queue(前一个 done 后自动起下一个)、并行批次 = parallel 组
// (MAX_PARALLEL 限流)、「停止全组」= 现成的组暂停。分组管理界面按 owner_task_id
// 过滤掉这些组 —— 它们是团队的内部结构,不该在用户的分组列表里露脸。
//
// 一个团队任务可以有多个内部组(先派一批串行、再派一批并行),所以每次 dispatch
// 都新建一个组,不复用。
import { eq } from "drizzle-orm";
import type { AgentType, Task, TeamConfig } from "@ash/shared";
import { TEAM_DEFAULTS } from "@ash/shared";
import { inheritExecutorOverrides, pickExecutor } from "@ash/shared/executors";
import { db } from "../db/index.js";
import { tasks, groups, queueItems } from "../db/schema.js";
import { id, now } from "../util.js";
import { runGroup } from "../scheduler.js";
import { TEAM_WORKER_PREAMBLE } from "./prompts.js";
import { createTasks } from "../task-store.js";
import { reopenAcceptedStage } from "../task-stage.js";
import { beginAccepting, endAccepting } from "../acceptance-lock.js";
import { executorScopeForOwner } from "../auth/owned-executors.js";

export interface DispatchSpec {
  body: string;
  title?: string;
  agentType?: AgentType;
  executorId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  reportBack?: boolean;
  useWorktree?: boolean;
  review?: boolean;
}

export interface DispatchResult {
  groupId: string;
  mode: "serial" | "parallel";
  tasks: Task[];
}

export async function dispatchWorkers(
  leadTaskId: string,
  specs: DispatchSpec[],
  opts: { mode?: "serial" | "parallel"; run?: boolean; batchName?: string } = {},
): Promise<DispatchResult> {
  if (!specs.length) throw new Error("tasks 不能为空");
  const lead = (await db.select().from(tasks).where(eq(tasks.id, leadTaskId))).at(0);
  if (!lead) throw new Error("调度者任务不存在");
  if (lead.mode !== "team") throw new Error("只有团队任务(mode:\"team\")能派活");
  if (lead.archived) throw new Error("团队已归档,不能再派活");
  // 派活与验收共用同一把任务级互斥(acceptance-lock),**占位而不是只查一次**:只查
  // isAcceptingTask 是 TOCTOU——检查通过后的任何 await 间隙里验收都可能开始,dispatch
  // 照样建 child 并摘牌(审查实测 20/20 交错复现)。占住之后:验收先开始→这里占不到,
  // 拒;派活先开始→验收侧 beginAccepting 失败,按 acceptance_in_progress 409。派活期间
  // 挂出去的执行者(runGroup)启动后,验收由 acceptanceGuard 的 busyChild 拦。
  if (!beginAccepting(leadTaskId)) throw new Error("团队正在验收(含发布尾段),结束后再派活");
  try {
  const cfg: TeamConfig = lead.team ? JSON.parse(lead.team) : TEAM_DEFAULTS;
  const mode = opts.mode ?? (specs.length > 1 ? "serial" : "parallel");
  // 派活是 agent 路径(lead 调 MCP),没有 HTTP actor —— 但有明确的归属人:派出去的活
  // 按 §八 用调度者那个人的执行器与 key 跑。所以 scope 按 lead 的 ownerUserId 建,
  // 别人的 executorId 在这里等同于不存在(第 3 轮审查 P1:lead 在 body 里填别人的 id,
  // 连 id、名字带 owner 快照一起落进了自己的子任务)。
  const scope = await executorScopeForOwner(lead.ownerUserId);
  // 团队默认执行者 —— 既是「没指定就用它」的兜底，也是 cfg.workerModel /
  // cfg.workerReasoningEffort 这两个默认覆盖所属的执行器。
  const workerDefault = { executorId: scope.keep(cfg.workerExecutorId), agentType: cfg.worker };
  const typeOf = (eid: string) => scope.typeOf(eid);
  // 每个执行者任务的「执行器 profile + 类型」。只有**同一次调用里显式给出的**两者冲突才算用户自相矛盾;
  // 单给 agentType 是「这个执行者换类型」,此时不能硬套团队默认 profile(类型对不上),按类型默认执行器走。
  const picks = specs.map((s, i) => {
    const executorId = scope.keep(s.executorId);
    const t = typeOf(executorId ?? "");
    if (t && s.agentType && t !== s.agentType) {
      throw new Error(`tasks[${i}].executorId 属于 ${t},但 agentType 是 ${s.agentType}`);
    }
    return pickExecutor({
      executorId,
      agentType: s.agentType,
      fallback: workerDefault,
      typeOf,
    });
  });

  const ts = now();
  const groupId = id();
  const batch = (await db.select({ id: groups.id }).from(groups).where(eq(groups.ownerTaskId, leadTaskId))).length + 1;
  const leadOwner = lead.ownerUserId;
  await db.insert(groups).values({
    id: groupId,
    projectId: lead.projectId,
    name: opts.batchName?.trim() || `${lead.title || "团队"} · 第 ${batch} 批`,
    mode,
    paused: false,
    ownerTaskId: leadTaskId,
    createdAt: ts,
  });

  const firstLine = (body: string) =>
    body.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 30) ?? "";
  const base = Date.parse(ts);
  const rows = specs.map((s, i) => {
    const explicitTitle = (s.title ?? "").trim();
    const at = new Date(base + i).toISOString(); // 递增时间戳,列表排序稳定
    const pick = picks[i];
    const overrides = inheritExecutorOverrides({
      from: workerDefault,
      to: pick,
      model: s.model,
      reasoningEffort: s.reasoningEffort,
      defaultModel: cfg.workerModel,
      defaultReasoningEffort: cfg.workerReasoningEffort,
    });
    return {
      id: id(),
      projectId: lead.projectId,
      groupId,
      parentId: leadTaskId,
      title: explicitTitle || firstLine(s.body) || `执行者 ${i + 1}`,
      body: s.body,
      mode: "single",
      status: "backlog",
      reviewOf: null as string | null,
      reviewRound: null as number | null,
      // Old TeamConfig rows omit review; omission deliberately means enabled.
      reviewRequested: typeof s.review === "boolean" ? s.review : cfg.review !== false,
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      agentType: pick.agentType,
      executorId: pick.executorId,
      model: overrides.model,
      reasoningEffort: overrides.reasoningEffort,
      autoTitle: false, // 调度者派活时给的标题就是标题,不让执行者自己改名
      duet: null as string | null,
      team: null as string | null,
      reportBack: s.reportBack ?? false,
      scheduleId: null as string | null,
      createdAt: at,
      updatedAt: at,
      // 刻意不跟随全局默认：false = 继承调度台的共享目录(可能就是团队
      // worktree)；true = 执行者自己再开一层隔离，具体解析统一在 taskWorkspace。
      useWorktree: s.useWorktree ?? false,
      worktreeBase: null as string | null,
      // 派生任务继承父任务的归属(§八):执行者用调度者那个人的执行器与 key 跑。
      ownerUserId: leadOwner,
    };
  });
  // serial 批次串成 A→B→C:头一个 done 后 advanceQueueFromTask 自动起下一个。
  const queueId = mode === "serial" && rows.length > 1 ? id() : null;
  const created = await createTasks(rows, queueId
    ? async () => {
        await db.insert(queueItems).values(
          rows.map((r, i) => ({ taskId: r.id, queueId, position: i, createdAt: ts })),
        );
      }
    : undefined);

  // 调度者又派活了 = 这支队伍重新开工:已验收的团队 stage 清回「进行中」。
  // 执行者唤醒调度者后它自己派活,这条路不经过用户消息,所以要单独钩一下。
  await reopenAcceptedStage(leadTaskId);

  if (opts.run !== false) void runGroup(groupId);
  return { groupId, mode, tasks: created };
  } finally {
    endAccepting(leadTaskId);
  }
}

// 执行者的前言:只在 fresh run 时拼到 body 前面(不写进 tasks.body —— body 是调度者
// 给的需求正文,用户在界面上看到的就该是那份)。非团队执行者返回空串。
export async function workerPreambleFor(task: { id: string; parentId: string | null; reviewOf?: string | null }): Promise<string> {
  if (task.reviewOf) return "";
  if (!task.parentId) return "";
  const lead = (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, task.parentId))).at(0);
  return lead?.mode === "team" ? TEAM_WORKER_PREAMBLE(task.id) : "";
}
