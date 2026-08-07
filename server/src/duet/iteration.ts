import { existsSync } from "node:fs";
import { normalizeDuetConfig } from "@harness/shared/duet";
import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { Task } from "@harness/shared";
import { isTeamSettled } from "@harness/shared/team";
import { db } from "../db/index.js";
import { sessions, tasks } from "../db/schema.js";
import { RUNS_DIR } from "../paths.js";
import { createTasks, enrichTasks } from "../task-store.js";
import { sessionTranscriptPath } from "../transcript.js";
import { id, now } from "../util.js";
import { join } from "node:path";
import { duetConsensusBy } from "./settlement.js";

type DuetEntry = {
  type?: string;
  speaker?: string;
  round?: number;
  text?: string;
  error?: string;
  raised?: boolean;
  agrees?: boolean;
  consensus?: boolean;
  consensusBy?: "both" | "A" | "B";
  conclusion?: string;
  conclusionA?: string | null;
  conclusionB?: string | null;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function duetEntries(taskId: string): Promise<DuetEntry[]> {
  try {
    const raw = await readFile(join(RUNS_DIR, taskId, "transcript.jsonl"), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === "object" ? [parsed as DuetEntry] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function consensusBy(lastA?: DuetEntry, lastB?: DuetEntry): DuetEntry["consensusBy"] {
  if (!lastA && !lastB) return undefined;
  return duetConsensusBy({
    raisedA: !!lastA?.raised,
    raisedB: !!lastB?.raised,
    agreesA: !!lastA?.agrees,
    agreesB: !!lastB?.agrees,
  });
}

export function conclusionLines(entries: DuetEntry[]): string[] {
  // 收敛后的合稿(共同方案)是上一轮的正式产出,有它就引用全文;两行一句话的
  // 结论只是没有合稿的老讨论的降级。**过时的合稿不作数**:回炉/澄清后重新合稿
  // 失败时,留在 transcript 里的还是反馈前的旧方案,把它标成正式产出会把用户
  // 已推翻的版本重新扶正 —— 判据是合稿轮次不早于最后一次活动轮次。**用户介入
  // 也算活动**:意见先落盘、讨论者还没跑完就中断的场景里,A/B 轮次没变,但旧
  // 方案已被那条意见推翻。
  const lastVoiceRound = entries.reduce(
    (max, entry) => (!entry.type && (entry.speaker === "A" || entry.speaker === "B" || entry.speaker === "user") && typeof entry.round === "number" ? Math.max(max, entry.round) : max),
    0,
  );
  const plan = [...entries].reverse().find((entry) =>
    entry.speaker === "synthesis" && !entry.error && nonEmpty(entry.text)
      && typeof entry.round === "number" && entry.round >= lastVoiceRound);
  if (plan) return ["上一轮讨论收敛后的共同方案如下：", "", plan.text!.trim()];
  const verdict = [...entries].reverse().find((entry) =>
    (entry.type === "duet.gate" || entry.type === "debate.gate")
      && (entry.consensus !== undefined || entry.conclusionA != null || entry.conclusionB != null));
  const lastA = [...entries].reverse().find((entry) => entry.speaker === "A");
  const lastB = [...entries].reverse().find((entry) => entry.speaker === "B");
  const a = nonEmpty(verdict?.conclusionA) ?? nonEmpty(lastA?.conclusion);
  const b = nonEmpty(verdict?.conclusionB) ?? nonEmpty(lastB?.conclusion);
  const by = verdict?.consensusBy ?? (verdict?.consensus ? "both" : consensusBy(lastA, lastB));
  const consensus = verdict?.consensus
    ?? !!by;

  if (consensus && a && b && a === b) return [`共识结论：${a}`];
  const lines = consensus
    ? [by === "both" ? "上一轮记录为双方确认共识；双方留下的结论如下：" : "上一轮由单方声明与对方一致后收敛；双方留下的结论如下："]
    : ["上一轮未记录为双方达成共识；请把以下分歧也纳入复盘："];
  if (a) lines.push(`- 讨论者 A：${a}`);
  if (b) lines.push(`- 讨论者 B：${b}`);
  if (!a && !b) lines.push("（上一轮没有可提取的结论文本，请结合原议题与执行记录复盘。）");
  return lines;
}

export function buildIterationBody(args: {
  originalDuet: Task;
  team: Task;
  transcriptPath: string;
  conclusions: string[];
}): string {
  const cfg = normalizeDuetConfig(args.originalDuet.duet);
  const originalTopic = cfg.topic.trim() || args.originalDuet.body.trim() || args.originalDuet.title;
  return [
    "这是一次执行后的复盘讨论。两位讨论者必须先阅读团队执行记录，再评估方案，不要只复述上一轮观点。",
    "",
    "## 原议题",
    `原讨论标题：${args.originalDuet.title}`,
    originalTopic,
    "",
    "## 上轮讨论产出",
    ...args.conclusions,
    "",
    "## 团队执行记录（讨论前必读）",
    `执行团队：${args.team.title}`,
    `调度台完整转写：\`${args.transcriptPath}\``,
    "请先用 Read 完整读完这份 Markdown；它是团队实际执行过程、验证结果与暴露问题的事实来源。",
    "",
    "## 本轮讨论目标",
    "围绕实际执行结果重新判断：执行暴露了什么新问题、原方案哪些假设被证实或推翻、下一步应该怎么迭代。",
    "共同方案必须给出具体、可执行、可验证的下一步；如果现有证据不足，要明确还需验证什么。",
    "",
    `来源团队任务 ID：${args.team.id}`,
    `上轮讨论任务 ID：${args.originalDuet.id}`,
  ].join("\n");
}

export function mountDuetIterationRoutes(api: Hono): void {
  api.post("/tasks/:id/team/iterate-duet", async (c) => {
    const teamId = c.req.param("id");
    const teamRow = (await db.select().from(tasks).where(eq(tasks.id, teamId))).at(0);
    if (!teamRow) return c.json({ error: "团队任务不存在" }, 404);
    if (teamRow.mode !== "team") return c.json({ error: "只有团队任务可以发起再讨论一轮" }, 409);
    if (!teamRow.originTaskId) return c.json({ error: "该团队没有来源讨论，不能沿用上一轮配置" }, 409);

    const originalRow = (await db.select().from(tasks).where(eq(tasks.id, teamRow.originTaskId))).at(0);
    if (!originalRow || originalRow.mode !== "duet" || !originalRow.duet) {
      return c.json({ error: "来源任务不是有效讨论，不能发起再讨论一轮" }, 409);
    }
    if (originalRow.projectId !== teamRow.projectId) {
      return c.json({ error: "来源讨论与团队不在同一项目，拒绝跨项目续讨论" }, 409);
    }

    const workerRows = await db.select().from(tasks).where(eq(tasks.parentId, teamId));
    const workers = await enrichTasks(workerRows);
    if (!isTeamSettled(teamRow.status === "running", workers)) {
      return c.json({ error: "团队尚未收工，请等调度者与执行者都停下来后再讨论" }, 409);
    }

    // Idempotent under double-click/network retry: one settled team has exactly
    // one next duet in the iteration chain.
    const existingRow = (await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.originTaskId, teamId), eq(tasks.mode, "duet"))))
      .at(0);
    if (existingRow) return c.json((await enrichTasks([existingRow]))[0]);

    const leadSession = (await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.taskId, teamId), eq(sessions.role, "lead")))
      .orderBy(desc(sessions.startedAt)))
      .at(0);
    if (!leadSession) return c.json({ error: "团队尚无调度台执行记录，不能开始复盘讨论" }, 409);
    const transcriptPath = sessionTranscriptPath(teamId, leadSession.id);
    if (!existsSync(transcriptPath)) {
      return c.json({ error: "调度台执行记录尚未落盘，请稍后重试" }, 409);
    }

    const [originalDuet, team] = await enrichTasks([originalRow, teamRow]);
    const body = buildIterationBody({
      originalDuet: originalDuet!,
      team: team!,
      transcriptPath,
      conclusions: conclusionLines(await duetEntries(originalRow.id)),
    });
    const ts = now();
    const duetId = id();
    const [created] = await createTasks([{
      id: duetId,
      projectId: teamRow.projectId,
      groupId: null,
      parentId: null,
      title: `${originalRow.title} · 再讨论一轮`.slice(0, 30),
      body,
      mode: "duet",
      status: "backlog",
      priority: originalRow.priority,
      labels: originalRow.labels,
      dependsOn: "[]",
      resumeDependsOn: "[]",
      agentType: null,
      executorId: null,
      model: originalRow.model,
      reasoningEffort: originalRow.reasoningEffort,
      autoTitle: true,
      // Keep the original duet knobs byte-for-byte (voice profiles, round
      // cap, gate policy, and original topic). runDuet uses this task's body
      // as the effective topic, so the iteration brief reaches both voices.
      duet: originalRow.duet,
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
