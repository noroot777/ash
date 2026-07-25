// 派活:指挥者调 MCP 的 dispatch → 这里建 N 个工人任务 + 一个内部组(+ 串行队列)。
//
// 内部组(groups.owner_task_id = 指挥者 taskId)是为了白嫖现成的调度器:串行批次
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
import { tasks, groups, queueItems } from "../db/schema.js";
import { id, now } from "../util.js";
import { runGroup } from "../scheduler.js";
import { TEAM_WORKER_PREAMBLE } from "./prompts.js";

export interface DispatchSpec {
  body: string;
  title?: string;
  agentType?: AgentType;
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
  if (!lead) throw new Error("指挥者任务不存在");
  if (lead.mode !== "team") throw new Error("只有团队任务(mode:\"team\")能派活");
  if (lead.archived) throw new Error("团队已归档,不能再派活");
  const cfg: TeamConfig = lead.team ? JSON.parse(lead.team) : TEAM_DEFAULTS;
  const mode = opts.mode ?? (specs.length > 1 ? "serial" : "parallel");

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
    return {
      id: id(),
      projectId: lead.projectId,
      groupId,
      parentId: leadTaskId,
      title: explicitTitle || firstLine(s.body) || `工人 ${i + 1}`,
      body: s.body,
      mode: "single",
      status: "backlog",
      priority: lead.priority,
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      agentType: (s.agentType ?? cfg.worker) as AgentType | null,
      autoTitle: false, // 指挥者派活时给的标题就是标题,不让工人自己改名
      debate: null as string | null,
      team: null as string | null,
      reportBack: s.reportBack ?? false,
      scheduleId: null as string | null,
      createdAt: at,
      updatedAt: at,
      // 团队默认同目录干活(用户明确要求);确实要隔离时逐个工人 opt-in。
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

// 工人的前言:只在 fresh run 时拼到 body 前面(不写进 tasks.body —— body 是指挥者
// 给的需求正文,用户在界面上看到的就该是那份)。非团队工人返回空串。
export async function workerPreambleFor(task: { id: string; parentId: string | null }): Promise<string> {
  if (!task.parentId) return "";
  const lead = (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, task.parentId))).at(0);
  return lead?.mode === "team" ? TEAM_WORKER_PREAMBLE(task.id) : "";
}
