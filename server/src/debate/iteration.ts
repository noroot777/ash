import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { Task } from "@harness/shared";
import { normalizeDebateConfig } from "@harness/shared";
import { isTeamSettled } from "@harness/shared/team";
import { db } from "../db/index.js";
import { sessions, tasks } from "../db/schema.js";
import { RUNS_DIR } from "../paths.js";
import { createTasks, enrichTasks } from "../task-store.js";
import { sessionTranscriptPath } from "../transcript.js";
import { id, now } from "../util.js";
import { join } from "node:path";

type DebateEntry = {
  type?: string;
  speaker?: string;
  raised?: boolean;
  agrees?: boolean;
  consensus?: boolean;
  conclusion?: string;
  conclusionA?: string | null;
  conclusionB?: string | null;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function debateEntries(taskId: string): Promise<DebateEntry[]> {
  try {
    const raw = await readFile(join(RUNS_DIR, taskId, "transcript.jsonl"), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === "object" ? [parsed as DebateEntry] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function conclusionLines(entries: DebateEntry[]): string[] {
  const verdict = [...entries].reverse().find((entry) =>
    entry.type === "debate.gate"
      && (entry.consensus !== undefined || entry.conclusionA != null || entry.conclusionB != null));
  const lastA = [...entries].reverse().find((entry) => entry.speaker === "A");
  const lastB = [...entries].reverse().find((entry) => entry.speaker === "B");
  const a = nonEmpty(verdict?.conclusionA) ?? nonEmpty(lastA?.conclusion);
  const b = nonEmpty(verdict?.conclusionB) ?? nonEmpty(lastB?.conclusion);
  const consensus = verdict?.consensus
    ?? !!(lastA?.raised && lastB?.raised && lastA?.agrees && lastB?.agrees);

  if (consensus && a && b && a === b) return [`共识结论：${a}`];
  const lines = consensus
    ? ["上一轮记录为已达成共识；双方留下的结论如下："]
    : ["上一轮未记录为双方达成共识；请把以下分歧也纳入复盘："];
  if (a) lines.push(`- 辩手 A：${a}`);
  if (b) lines.push(`- 辩手 B：${b}`);
  if (!a && !b) lines.push("（上一轮没有可提取的结论文本，请结合原辩题与执行记录复盘。）");
  return lines;
}

export function buildIterationBody(args: {
  originalDebate: Task;
  team: Task;
  transcriptPath: string;
  conclusions: string[];
}): string {
  const cfg = normalizeDebateConfig(args.originalDebate.debate);
  const originalTopic = cfg.topic.trim() || args.originalDebate.body.trim() || args.originalDebate.title;
  return [
    "这是一次执行后的复盘辩论。两位辩手必须先阅读团队执行记录，再评估方案，不要只复述上一轮观点。",
    "",
    "## 原辩题",
    `原辩论标题：${args.originalDebate.title}`,
    originalTopic,
    "",
    "## 上轮共识结论",
    ...args.conclusions,
    "",
    "## 团队执行记录（辩论前必读）",
    `执行团队：${args.team.title}`,
    `调度台完整转写：\`${args.transcriptPath}\``,
    "请先用 Read 完整读完这份 Markdown；它是团队实际执行过程、验证结果与暴露问题的事实来源。",
    "",
    "## 本轮辩论目标",
    "围绕实际执行结果重新判断：执行暴露了什么新问题、原方案哪些假设被证实或推翻、下一步应该怎么迭代。",
    "结论必须给出具体、可执行、可验证的下一步；如果现有证据不足，要明确还需验证什么。",
    "",
    `来源团队任务 ID：${args.team.id}`,
    `上轮辩论任务 ID：${args.originalDebate.id}`,
  ].join("\n");
}

export function mountDebateIterationRoutes(api: Hono): void {
  api.post("/tasks/:id/team/iterate-debate", async (c) => {
    const teamId = c.req.param("id");
    const teamRow = (await db.select().from(tasks).where(eq(tasks.id, teamId))).at(0);
    if (!teamRow) return c.json({ error: "团队任务不存在" }, 404);
    if (teamRow.mode !== "team") return c.json({ error: "只有团队任务可以发起再辩一轮" }, 409);
    if (!teamRow.originTaskId) return c.json({ error: "该团队没有来源辩论，不能沿用上一轮配置" }, 409);

    const originalRow = (await db.select().from(tasks).where(eq(tasks.id, teamRow.originTaskId))).at(0);
    if (!originalRow || originalRow.mode !== "debate" || !originalRow.debate) {
      return c.json({ error: "来源任务不是有效辩论，不能发起再辩一轮" }, 409);
    }
    if (originalRow.projectId !== teamRow.projectId) {
      return c.json({ error: "来源辩论与团队不在同一项目，拒绝跨项目续辩" }, 409);
    }

    const workerRows = await db.select().from(tasks).where(eq(tasks.parentId, teamId));
    const workers = await enrichTasks(workerRows);
    if (!isTeamSettled(teamRow.status === "running", workers)) {
      return c.json({ error: "团队尚未收工，请等调度者与执行者都停下来后再辩" }, 409);
    }

    // Idempotent under double-click/network retry: one settled team has exactly
    // one next debate in the iteration chain.
    const existingRow = (await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.originTaskId, teamId), eq(tasks.mode, "debate"))))
      .at(0);
    if (existingRow) return c.json((await enrichTasks([existingRow]))[0]);

    const leadSession = (await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.taskId, teamId), eq(sessions.role, "lead")))
      .orderBy(desc(sessions.startedAt)))
      .at(0);
    if (!leadSession) return c.json({ error: "团队尚无调度台执行记录，不能开始复盘辩论" }, 409);
    const transcriptPath = sessionTranscriptPath(teamId, leadSession.id);
    if (!existsSync(transcriptPath)) {
      return c.json({ error: "调度台执行记录尚未落盘，请稍后重试" }, 409);
    }

    const [originalDebate, team] = await enrichTasks([originalRow, teamRow]);
    const body = buildIterationBody({
      originalDebate: originalDebate!,
      team: team!,
      transcriptPath,
      conclusions: conclusionLines(await debateEntries(originalRow.id)),
    });
    const ts = now();
    const debateId = id();
    const [created] = await createTasks([{
      id: debateId,
      projectId: teamRow.projectId,
      groupId: null,
      parentId: null,
      title: `${originalRow.title} · 再辩一轮`.slice(0, 30),
      body,
      mode: "debate",
      status: "backlog",
      priority: originalRow.priority,
      labels: originalRow.labels,
      dependsOn: "[]",
      resumeDependsOn: "[]",
      agentType: null,
      executorId: null,
      autoTitle: true,
      // Keep the original debate knobs byte-for-byte (debater profiles, round
      // cap, gate policy, and original topic). runDebate uses this task's body
      // as the effective topic, so the iteration brief reaches both debaters.
      debate: originalRow.debate,
      team: null,
      scheduleId: null,
      createdAt: ts,
      updatedAt: ts,
      useWorktree: originalRow.useWorktree,
      worktreeBase: originalRow.worktreeBase,
      originTaskId: teamId,
    }]);
    return c.json(created!, 201);
  });
}
