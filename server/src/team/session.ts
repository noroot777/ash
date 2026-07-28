// ── 常驻调度台(§Team)────────────────────────────────────────────────────────
// 一个 mode:"team" 的任务 = 一个不退的 CLI 进程(claude,stream-json 双向)。
// 三种入站消息汇到同一根管子(进程 stdin):用户插话、执行者汇报、执行者提问。
// 于是旧编排组的三个毛病一起消失:30s tick 延迟、continueTask 单飞锁丢消息、
// 「协调者顶着一次性任务状态机反复 done→running」。
//
// ── Step 0 实测结论(claude 2.1.185,别再试一遍)─────────────────────────────
// ①常驻可行:一个进程连吃多条 stream-json user 消息,session_id 全程同一个,
//   stdin 关掉才退出(exit 0)。
// ②**回合进行中写进 stdin 的消息会被排队**,要等当前回合结束才处理(实测:第
//   3.0s 注入 → 回合 8.4s 结束 → 12.4s 才反应)。所以光靠 stdin 做不出 codex
//   那种「当场转向」。
// ③但 `control_request {subtype:"interrupt"}` 走 stdin **有效**:立刻回
//   control_response success,当前回合以 result subtype=error_during_execution
//   收尾(会话里留一条 [Request interrupted by user]),会话存活,下一条消息照常
//   跑,进程最后 exit 0。→ 用户插话 = interrupt + send,手感就是原生 steering。
// ④`--resume <sid>` 配 --input-format stream-json 能接回同一会话且上下文完整,
//   所以空闲回收进程是安全的。
// 由 ②③ 定下两条投递策略:
//   • 用户插话 → 先 interrupt 再送(要的就是立刻转向),时间线记一条「已打断」。
//   • 执行者汇报/提问 → 不打断(它手上的活更重要);忙就缓冲,回合结束合并成
//     一条送 —— 天然聚合,N 个执行者只花一次模型调用。
import { mkdirSync, createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { AgentEvent, AgentType, TeamConfig } from "@harness/shared";
import { TEAM_DEFAULTS } from "@harness/shared";
import { db } from "../db/index.js";
import { tasks, projects, sessions, groups } from "../db/schema.js";
import { bus } from "../bus.js";
import { id, now, attachmentsPrompt } from "../util.js";
import { setTaskStatus } from "../status.js";
import { trackRun, untrackRun, takeStopped, stopTask } from "../runs.js";
import { pauseGroup } from "../scheduler.js";
import { taskWorkspace } from "../task-workspace.js";
import { resolveExecutorFor } from "../executors/index.js";
import type { ResidentHandle } from "../executors/types.js";
import { RUNS_DIR } from "../paths.js";
import { writeTurn, writeTurnEnd, writeRunError } from "../transcript.js";
import { LEAD_PREAMBLE, LEAD_NUDGE, LEAD_RESUMED } from "./prompts.js";

// 空闲多久回收进程(0/负数 = 永不回收)。测试用 HARNESS_TEAM_IDLE_MS=5000。
const IDLE_MS = Number(process.env.HARNESS_TEAM_IDLE_MS ?? 30 * 60_000);
// close() 之后还赖着不走的宽限,超时硬杀。
const CLOSE_GRACE_MS = 10_000;

const INTERRUPT_NOTE = "〔系统〕已打断调度者当前回合,插入你的新指令";
const HALT_NOTE = "〔系统〕你按了「停止全组」:调度台进程与所有在跑的执行者都已停止,执行者可从中断处恢复。再说一句话就能把调度者接回同一会话。";
const RECYCLE_NOTE = (min: number) =>
  `〔系统〕调度台空闲超过 ${min} 分钟,进程已回收(待命)。你或执行者再说话时会自动接回同一会话,上下文不丢。`;

type Kind = "user" | "inbound" | "start";

interface Lead {
  taskId: string;
  sessId: string; // harness 会话行 id,同时是 .md 文件名
  cliSessionId: string;
  agentType: AgentType;
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  cwd: string;
  handle: ResidentHandle;
  out: WriteStream;
  busy: boolean;
  turnStart: string | null;
  pending: string[]; // 回合进行中攒下的执行者消息,turnEnd 时合并成一条送
  idleTimer: NodeJS.Timeout | null;
  closing: "recycle" | "halt" | null;
}

const leads = new Map<string, Lead>();
const opening = new Map<string, Promise<Lead>>();

export function teamIsLive(taskId: string): boolean {
  return leads.has(taskId) || opening.has(taskId);
}

// 用户插话(continueTask 顶部分流过来)。
export async function deliverToLead(
  taskId: string,
  text: string,
  opts: { attachments?: string[] } = {},
): Promise<void> {
  await deliver(taskId, text + attachmentsPrompt(opts.attachments), "user");
}

// 执行者汇报/提问,以及 harness 自己的唤醒语(inbox.ts 用)。
export async function sendInbound(taskId: string, text: string): Promise<void> {
  await deliver(taskId, text, "inbound");
}

// 开台:第一次运行装前言+目标;已有历史会话则 --resume 接回(用 LEAD_NUDGE
// 当唤醒语);已经在线就只当一次唤醒,绝不开第二个进程。
export async function startTeam(taskId: string): Promise<void> {
  if (teamIsLive(taskId)) return deliver(taskId, LEAD_NUDGE, "inbound");
  await deliver(taskId, "", "start");
}

// 「停止全组」:调度台进程 + 所有执行者一起停。执行者走分组暂停(落 paused,占住
// 队列位置,恢复分组时从原会话续跑);调度台落 idle(待命,会话留着)。
export async function haltTeam(taskId: string): Promise<void> {
  const lead = leads.get(taskId);
  if (lead) {
    lead.closing = "halt";
    recordSystemTurn(lead, HALT_NOTE);
  }
  stopTask(taskId); // 常驻 handle 已 trackRun → killChild 三层击杀
  const owned = await db.select().from(groups).where(eq(groups.ownerTaskId, taskId));
  for (const g of owned) await pauseGroup(g.id);
  if (!lead) await setTaskStatus(taskId, "idle");
}

// ── 投递 ────────────────────────────────────────────────────────────────────
async function deliver(taskId: string, text: string, kind: Kind): Promise<void> {
  let lead = leads.get(taskId);
  if (!lead) {
    const inflight = opening.get(taskId);
    if (!inflight) {
      await open(taskId, text, kind); // 本条消息就是首条消息,开台时一起送进去
      return;
    }
    lead = await inflight; // 别开第二个进程:等它开完,这条按普通消息送
  }
  push(lead, text, kind);
}

function open(taskId: string, text: string, kind: Kind): Promise<Lead> {
  const p = openLead(taskId, text, kind).finally(() => opening.delete(taskId));
  opening.set(taskId, p);
  return p;
}

function push(lead: Lead, text: string, kind: Kind): void {
  if (!text.trim()) return;
  clearIdle(lead);
  if (kind === "user") {
    // 见头注 ②③:不打断的话用户要干等一整个回合,那就不是 steering 了。
    if (lead.busy) {
      lead.handle.interrupt();
      recordSystemTurn(lead, INTERRUPT_NOTE);
    }
    // 你→ 的插话只写 .md(实时由客户端乐观显示),跟单任务 reply 一致。
    writeTurn(lead.out, { t: "user", agent: lead.agentType, text }, now());
    lead.handle.send(text);
    void beginTurn(lead);
    return;
  }
  if (lead.busy) {
    lead.pending.push(text); // 回合结束再合并成一条,省一轮模型调用
    return;
  }
  recordSystemTurn(lead, text);
  lead.handle.send(text);
  void beginTurn(lead);
}

// ── 开台 / 接回 ─────────────────────────────────────────────────────────────
async function openLead(taskId: string, rawText: string, kind: Kind): Promise<Lead> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("task not found");
  if (task.mode !== "team") throw new Error("不是团队任务");
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) throw new Error("project not found");
  const cfg: TeamConfig = task.team ? JSON.parse(task.team) : TEAM_DEFAULTS;
  const ex = await resolveExecutorFor({
    executorId: cfg.leadExecutorId,
    type: cfg.lead,
    model: task.model || cfg.leadModel,
    reasoningEffort: task.reasoningEffort || cfg.leadReasoningEffort,
  });
  const openResident = ex.openResident?.bind(ex);
  if (!openResident) throw new Error(`执行器 ${ex.label} 不支持常驻会话,不能当团队调度者`);

  // 默认仍在项目目录；显式 opt-in 时复用普通任务的 worktree 创建/复用路径。
  // 默认执行者会通过 taskWorkspace 继承这里得到的同一个目录。
  const ws = await taskWorkspace(task, project.repoPath);
  // 上一段常驻会话:同一个 CLI 会话可以 --resume 接回,.md 也接着往下写。
  const prev = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
    .filter((s) => s.role === "lead" && s.cliSessionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .at(0);
  const resuming = !!prev?.cliSessionId;
  const objective = task.body?.trim() || task.title;
  const text = kind === "start" && resuming ? LEAD_NUDGE : rawText;
  // 接回:上下文都在 CLI 会话里,只补一句「你被中断过」。全新开台:前言 + 目标
  // (哪怕这次是被一条消息带起来的,前言也必须有 —— 否则它不知道自己是调度者)。
  const message = resuming
    ? LEAD_RESUMED + text
    : LEAD_PREAMBLE(taskId, cfg.worker) + objective + (text ? `\n\n【新消息】${text}` : "");

  const turnStart = now();
  const sessId = resuming ? prev!.id : id();
  const runDir = join(RUNS_DIR, taskId);
  mkdirSync(runDir, { recursive: true });
  const handle = openResident({ prompt: message, cwd: ws.path, sessionId: prev?.cliSessionId ?? undefined });
  trackRun(taskId, handle);

  const cliSessionId = prev?.cliSessionId ?? handle.sessionId;
  if (resuming) {
    await db
      .update(sessions)
      .set({ turnStartedAt: turnStart, endedAt: null, exitStatus: null, commandLine: handle.commandLine })
      .where(eq(sessions.id, sessId));
  } else {
    await db.insert(sessions).values({
      id: sessId,
      taskId,
      role: "lead",
      agentType: cfg.lead,
      executor: ex.label,
      target: "local",
      worktreePath: ws.isWorktree ? ws.path : null,
      branch: ws.branch,
      cwd: ws.path,
      cliSessionId,
      resumeCommand: ex.resumeCommand(ws.path, cliSessionId),
      relayEnv: ex.relayEnvHint ?? null,
      commandLine: handle.commandLine,
      startedAt: turnStart,
      turnStartedAt: turnStart,
      activeMs: 0,
      exitStatus: null,
    });
  }

  const lead: Lead = {
    taskId,
    sessId,
    cliSessionId,
    agentType: cfg.lead,
    executorId: cfg.leadExecutorId ?? null,
    model: task.model || cfg.leadModel || null,
    reasoningEffort: task.reasoningEffort || cfg.leadReasoningEffort || null,
    cwd: ws.path,
    handle,
    out: createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" }),
    busy: false,
    turnStart: null,
    pending: [],
    idleTimer: null,
    closing: null,
  };
  leads.set(taskId, lead);
  // 接回时把带我们回来的那条消息记进时间线(全新开台的首条消息是「运行的
  // prompt」,跟单任务一样不记 turn)。
  if (resuming) {
    if (kind === "user") writeTurn(lead.out, { t: "user", agent: lead.agentType, text }, turnStart);
    else recordSystemTurn(lead, text, turnStart);
  }
  void beginTurn(lead, turnStart);
  void consume(lead).catch((err) => console.error(`[harness] team consume(${taskId}) failed:`, err));
  return lead;
}

// ── 事件消费 ────────────────────────────────────────────────────────────────
async function consume(lead: Lead): Promise<void> {
  let exitStatus = 0;
  for await (const event of lead.handle.events) {
    if (event.kind === "turnEnd") {
      await endTurn(lead);
      continue;
    }
    if (event.kind === "session") {
      if (event.cliSessionId !== lead.cliSessionId) {
        lead.cliSessionId = event.cliSessionId;
        const ex = await resolveExecutorFor({
          executorId: lead.executorId,
          type: lead.agentType,
          model: lead.model,
          reasoningEffort: lead.reasoningEffort,
        });
        await db
          .update(sessions)
          .set({ cliSessionId: event.cliSessionId, resumeCommand: ex.resumeCommand(lead.cwd, event.cliSessionId) })
          .where(eq(sessions.id, lead.sessId));
      }
      publish(lead, event);
      continue;
    }
    if (event.kind === "text" || event.kind === "thinking") lead.out.write(event.text);
    else if (event.kind === "error") writeRunError(lead.out, event.message);
    if (event.kind === "done") exitStatus = event.exitStatus;
    publish(lead, event);
  }
  await closeLead(lead, exitStatus);
}

function publish(lead: Lead, event: AgentEvent): void {
  bus.publish({
    type: "agent.event",
    taskId: lead.taskId,
    sessionId: lead.sessId,
    role: "lead",
    agentType: lead.agentType,
    event,
  });
}

// 入站消息(执行者汇报/提问、系统提示)记成 system turn:实时走 system 事件、
// 刷新走 .md 的哨兵行,两边长得一样。
function recordSystemTurn(lead: Lead, text: string, at = now()): void {
  writeTurn(lead.out, { t: "system", agent: lead.agentType, text }, at);
  publish(lead, { kind: "system", text });
}

async function beginTurn(lead: Lead, at = now()): Promise<void> {
  lead.busy = true;
  lead.turnStart = at;
  await db.update(sessions).set({ turnStartedAt: at, endedAt: null }).where(eq(sessions.id, lead.sessId));
  await setTaskStatus(lead.taskId, "running");
}

// 一个回合说完了(进程还活着)。有攒下的执行者消息就立刻合并成一条继续跑,
// 否则落 idle(待命)并起空闲回收计时。
async function endTurn(lead: Lead): Promise<void> {
  const endIso = now();
  const spent = lead.turnStart ? Math.max(0, Date.parse(endIso) - Date.parse(lead.turnStart)) : 0;
  lead.busy = false;
  lead.turnStart = null;
  await db
    .update(sessions)
    .set({ endedAt: endIso, activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${spent}` })
    .where(eq(sessions.id, lead.sessId));
  writeTurnEnd(lead.out, endIso);
  if (lead.pending.length) {
    const merged = lead.pending.join("\n\n---\n\n");
    lead.pending = [];
    recordSystemTurn(lead, merged);
    lead.handle.send(merged);
    await beginTurn(lead);
    return;
  }
  await setTaskStatus(lead.taskId, "idle");
  armIdle(lead);
}

async function closeLead(lead: Lead, exitStatus: number): Promise<void> {
  clearIdle(lead);
  takeStopped(lead.taskId); // 消费停止标记:团队不走 settleTaskStatus,别漏给下一次
  untrackRun(lead.taskId, lead.handle);
  leads.delete(lead.taskId);
  const endIso = now();
  const spent = lead.turnStart ? Math.max(0, Date.parse(endIso) - Date.parse(lead.turnStart)) : 0;
  await db
    .update(sessions)
    .set({ exitStatus, endedAt: endIso, activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${spent}` })
    .where(eq(sessions.id, lead.sessId));
  if (lead.closing === "recycle") {
    recordSystemTurn(lead, RECYCLE_NOTE(Math.round(IDLE_MS / 60_000)));
  } else if (!lead.closing && exitStatus !== 0) {
    // 既不是回收也不是手停 —— 进程自己没了。会话还在,说句话就能接回。
    const msg = `调度台进程意外退出(exit ${exitStatus})。CLI 会话还在,再说一句话会自动接回;需要的话也可以点「继续」。`;
    writeRunError(lead.out, msg);
    publish(lead, { kind: "error", message: msg });
  }
  writeTurnEnd(lead.out, endIso);
  lead.out.end();
  await setTaskStatus(lead.taskId, "idle"); // 团队没有终态,进程没了就是待命
}

// ── 空闲回收 ────────────────────────────────────────────────────────────────
function clearIdle(lead: Lead): void {
  if (lead.idleTimer) clearTimeout(lead.idleTimer);
  lead.idleTimer = null;
}

function armIdle(lead: Lead): void {
  clearIdle(lead);
  if (!(IDLE_MS > 0)) return;
  const t = setTimeout(() => {
    if (lead.busy || lead.pending.length) return; // 刚好又忙起来了
    lead.closing = "recycle";
    try {
      lead.handle.close(); // 关 stdin,让它自己收尾退出
    } catch {
      /* 已经没了 */
    }
    const hard = setTimeout(() => {
      if (leads.get(lead.taskId) === lead) lead.handle.kill();
    }, CLOSE_GRACE_MS);
    (hard as { unref?: () => void }).unref?.();
  }, IDLE_MS);
  (t as { unref?: () => void }).unref?.();
  lead.idleTimer = t;
}
