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
import type { AgentType, TeamConfig } from "@harness/shared";
import { TEAM_DEFAULTS } from "@harness/shared";
import { db } from "../db/index.js";
import { tasks, groups, queueItems, agents } from "../db/schema.js";
import { id, now } from "../util.js";
import { runGroup } from "../scheduler.js";
import { TEAM_WORKER_PREAMBLE } from "./prompts.js";

export interface DispatchSpec {
  body: string;
  title?: string;
  agentType?: AgentType;
  executorId?: string | null;
  reportBack?: boolean;
  useWorktree?: boolean;
}

export interface DispatchResult {
  groupId: string;
  mode: "serial" | "parallel";
  tasks: (typeof tasks.$inferSelect)[];
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
  const cfg: TeamConfig = lead.team ? JSON.parse(lead.team) : TEAM_DEFAULTS;
  const mode = opts.mode ?? (specs.length > 1 ? "serial" : "parallel");
  const profileTypes = new Map(
    (await db.select({ id: agents.id, type: agents.type }).from(agents)).map((a) => [a.id, a.type as AgentType] as const),
  );
  // 每个执行者任务的「执行器 profile + 类型」。只有**同一次调用里显式给出的**两者冲突才算用户自相矛盾;
  // 单给 agentType 是「这个执行者换类型」,此时不能硬套团队默认 profile(类型对不上),按类型默认执行器走。
  const picks = specs.map((s, i): { executorId: string | null; agentType: AgentType } => {
    const ownType = s.agentType ?? null;
    if (s.executorId) {
      const t = profileTypes.get(s.executorId);
      if (t && ownType && t !== ownType) {
        throw new Error(`tasks[${i}].executorId 属于 ${t},但 agentType 是 ${ownType}`);
      }
      return { executorId: s.executorId, agentType: (ownType ?? t ?? cfg.worker) as AgentType };
    }
    if (s.executorId === null) return { executorId: null, agentType: (ownType ?? cfg.worker) as AgentType };
    const inherited = cfg.workerExecutorId ?? null;
    const inheritedType = inherited ? profileTypes.get(inherited) : undefined;
    if (ownType) {
      return { executorId: inheritedType === ownType ? inherited : null, agentType: ownType };
    }
    return { executorId: inherited, agentType: (inheritedType ?? cfg.worker) as AgentType };
  });

  const ts = now();
  const groupId = id();
  const batch = (await db.select({ id: groups.id }).from(groups).where(eq(groups.ownerTaskId, leadTaskId))).length + 1;
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
    return {
      id: id(),
      projectId: lead.projectId,
      groupId,
      parentId: leadTaskId,
      title: explicitTitle || firstLine(s.body) || `执行者 ${i + 1}`,
      body: s.body,
      mode: "single",
      status: "backlog",
      priority: lead.priority,
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      agentType: pick.agentType as AgentType | null,
      executorId: pick.executorId,
      autoTitle: false, // 调度者派活时给的标题就是标题,不让执行者自己改名
      debate: null as string | null,
      team: null as string | null,
      reportBack: s.reportBack ?? false,
      scheduleId: null as string | null,
      createdAt: at,
      updatedAt: at,
      // 团队默认同目录干活(用户明确要求);确实要隔离时逐个执行者 opt-in。
      useWorktree: s.useWorktree ?? false,
      worktreeBase: null as string | null,
    };
  });
  await db.insert(tasks).values(rows);

  // serial 批次串成 A→B→C:头一个 done 后 advanceQueueFromTask 自动起下一个。
  if (mode === "serial" && rows.length > 1) {
    const queueId = id(); // 一批一个 queue(整批共用同一个 id,顺序就是数组顺序)
    await db.insert(queueItems).values(
      rows.map((r, i) => ({ taskId: r.id, queueId, position: i, createdAt: ts })),
    );
  }

  if (opts.run !== false) void runGroup(groupId);
  return { groupId, mode, tasks: rows as unknown as (typeof tasks.$inferSelect)[] };
}

// 执行者的前言:只在 fresh run 时拼到 body 前面(不写进 tasks.body —— body 是调度者
// 给的需求正文,用户在界面上看到的就该是那份)。非团队执行者返回空串。
export async function workerPreambleFor(task: { id: string; parentId: string | null }): Promise<string> {
  if (!task.parentId) return "";
  const lead = (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, task.parentId))).at(0);
  return lead?.mode === "team" ? TEAM_WORKER_PREAMBLE(task.id) : "";
}
