// ── 常驻调度台(§Team)────────────────────────────────────────────────────────
// 一个 mode:"team" 的任务 = 一个不断的 CLI **会话**。三种入站消息汇到同一根管子:
// 用户插话、执行者汇报、执行者提问。于是旧编排组的三个毛病一起消失:30s tick
// 延迟、continueTask 单飞锁丢消息、「协调者顶着一次性任务状态机反复 done→running」。
//
// 「会话不断」有两种实现,本文件不关心是哪种(都藏在 ResidentHandle 后面):
//   • claude = 进程级常驻,一个进程吃多个回合(stream-json 双向)
//   • codex  = 会话级常驻,每回合一个 `exec resume <thread_id>` 进程
//     (它没有 stdin 注入通道;实测与取舍见 executors/codex-resident.ts)
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
import { mkdirSync, createWriteStream, existsSync } from "node:fs";
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
import { sessionTargetKey } from "../executors/resume.js";
import { RUNS_DIR } from "../paths.js";
import { appendSessionTrace, writeTurn, writeTurnEnd, writeRunError } from "../transcript.js";
import { recordUserConversationTurn } from "../conversation-turn.js";
import { recordSessionUsageEvent, setSessionContext } from "../usage.js";
import { LEAD_PREAMBLE, LEAD_NUDGE, LEAD_RESUMED, LEAD_WORKSPACE_RESET } from "./prompts.js";
import { withSkillInvocation, nativeCliCommand } from "../skills.js";
import { withGlobalBrowserPolicy } from "../browser-verification-policy.js";

// 空闲多久回收进程(0/负数 = 永不回收)。测试用 HARNESS_TEAM_IDLE_MS=5000。
const IDLE_MS = Number(process.env.HARNESS_TEAM_IDLE_MS ?? 30 * 60_000);
// close() 之后还赖着不走的宽限,超时硬杀。
const CLOSE_GRACE_MS = 10_000;

const INTERRUPT_NOTE = "〔系统〕已打断调度者当前回合,插入你的新指令";
const HALT_NOTE = "〔系统〕你按了「停止全组」:调度台进程与所有在跑的执行者都已停止,执行者可从中断处恢复。再说一句话就能把调度者接回同一会话。";
const RECYCLE_NOTE = (min: number) =>
  `〔系统〕调度台空闲超过 ${min} 分钟,进程已回收(待命)。你或执行者再说话时会自动接回同一会话,上下文不丢。`;
// 调度台脚下的工作目录没了(多半是它自己按吩咐删掉了所在的 worktree)。
const WORKSPACE_GONE_NOTE = (cwd: string) =>
  `〔系统〕检测到调度台的工作目录 ${cwd} 已不存在(worktree 被删除),当前进程已无法继续执行命令,先收掉它。这条消息会用同一个 CLI 会话重新接回:能恢复的会原样恢复,恢复不了则会新建一个空目录并明确告知。`;

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
  remote: boolean;
  handle: ResidentHandle;
  out: WriteStream;
  busy: boolean;
  turnStart: string | null;
  pending: string[]; // 回合进行中攒下的执行者消息,turnEnd 时合并成一条送
  idleTimer: NodeJS.Timeout | null;
  closing: "recycle" | "halt" | "workspace" | null;
}

const leads = new Map<string, Lead>();
const opening = new Map<string, Promise<Lead>>();

export function teamIsLive(taskId: string): boolean {
  return leads.has(taskId) || opening.has(taskId);
}

// 用户插话(continueTask 顶部分流过来)。
// **返回值 = 这句话有没有真的进到调度台**。false 只有一种来源:离线时收到 CLI 原生
// 命令,被下面明确拒收(理由写进了会话)。上层拿它决定要不要记「已送达」—— 记了就
// 等于把一句从未送出的话标成 sent(见 continueTask 里那段)。
export async function deliverToLead(
  taskId: string,
  text: string,
  opts: { attachments?: string[]; throwOnOpenFailure?: boolean } = {},
): Promise<boolean> {
  return deliver(taskId, text + attachmentsPrompt(opts.attachments), "user", opts.throwOnOpenFailure);
}

// 执行者汇报/提问,以及 harness 自己的唤醒语(inbox.ts 用)。
export async function sendInbound(taskId: string, text: string): Promise<void> {
  await deliver(taskId, text, "inbound");
}

// 开台:第一次运行装前言+目标;已有历史会话则 --resume 接回(用 LEAD_NUDGE
// 当唤醒语);已经在线就只当一次唤醒,绝不开第二个进程。
export async function startTeam(taskId: string): Promise<void> {
  if (teamIsLive(taskId)) {
    await deliver(taskId, LEAD_NUDGE, "inbound");
    return;
  }
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
// 返回 true = 这句话进了调度台(或者由 open 带着它开台);false = **明确拒收**,
// 一个字都没送出去(见下面的原生命令分支)。调用方必须分得清这两者。
async function deliver(
  taskId: string,
  text: string,
  kind: Kind,
  throwOnOpenFailure = false,
): Promise<boolean> {
  let lead = leads.get(taskId);
  // 进程还活着,但它脚下的目录已经没了 —— 典型情形:调度者按用户吩咐删掉了自己
  // 所在的那个 worktree(它嘴上说"我已回落到主检出",实际 cwd 还钉在被删的路径
  // 上)。这时把消息送进去,它执行任何命令都会崩,用户白吃一次 exit 1,要等下一
  // 条消息才触发重开。所以现在就收掉它,让下面的 open 重走一遍 taskWorkspace:
  // 分支还在就恢复,恢复不了也会重建并明确告诉接回来的调度者文件已经不在了。
  if (lead && !existsSync(lead.cwd)) {
    lead.closing = "workspace";
    recordSystemTurn(lead, WORKSPACE_GONE_NOTE(lead.cwd));
    leads.delete(taskId); // 立刻腾位置,别让下面的 open 以为还在线
    try {
      lead.handle.kill();
    } catch {
      /* 进程可能已经自己没了 */
    }
    lead = undefined;
  }
  if (!lead) {
    const inflight = opening.get(taskId);
    if (!inflight) {
      // CLI 原生命令(claude 的 `/compact`)要求自己是消息的**第一个字**,而开台/接回
      // 一定会在前面拼上前言或 LEAD_RESUMED —— 拼完就不再是命令,会被当成一句闲聊
      // 发出去。调度台不在线时也压根没有「当前上下文」可压缩,所以这里不开台,直接
      // 把原因写回会话:让用户先用一句普通消息把调度者接回来,再发 `/compact`。
      const native = kind === "user" ? nativeCliCommand(await leadTypeOf(taskId), text) : null;
      if (native) {
        const why =
          `/${native} 没有送出：调度台当前不在线（进程已回收或还没开台）。` +
          `这类 CLI 原生命令必须是消息的第一个字才生效，而接回调度台时前面一定会带上唤醒前言。` +
          `请先随便说一句普通消息把调度者接回来，再单独发 /${native}。`;
        await noteToLead(taskId, why);
        // 定时/排队消息还要把「送不出去」传回 scheduler:它得让那条 pending 明确落
        // canceled 并把原文写回时间线,而不是留在托盘里每个 tick 被重新拒绝一次。
        if (throwOnOpenFailure) throw new Error(why);
        return false;
      }
      // 开台失败(典型:worktree 建不出来)不能静默 —— 路由是 void 调用的,抛出去
      // 只会变成被兜底吞掉的 unhandledRejection,用户什么都看不到。
      // 这一档仍算「接管了」(true):失败原因已经如实写进会话,消息本身是随开台一起
      // 送出去的,退回队列重试只会把同一份错误再演一遍。
      try {
        await open(taskId, text, kind);
      } catch (err) {
        await reportOpenFailure(taskId, err);
        if (throwOnOpenFailure) throw err;
      }
      return true;
    }
    try {
      lead = await inflight; // 别开第二个进程:等它开完,这条按普通消息送
    } catch (err) {
      // 发起 open 的那条消息负责记录失败；定时消息还要把失败传回 scheduler，
      // 让 pending 明确落 canceled，而不是到点后静默消失。
      if (throwOnOpenFailure) throw err;
      return true;
    }
  }
  push(lead, text, kind);
  return true;
}

// 调度台此刻不在线时,配置里写的是哪种 CLI(判定 `/compact` 这类原生命令要用)。
// 导出给路由层用:立即回复端点要先认出「这是发给调度台的原生命令」,才能把「送不出去」
// 当场答成失败,而不是排队等一个永远不该发生的补发(第 2 轮审查 finding 5)。
export async function leadTypeOf(taskId: string): Promise<AgentType> {
  const row = (await db.select({ team: tasks.team }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  try {
    if (row?.team) return (JSON.parse(row.team) as TeamConfig).lead ?? TEAM_DEFAULTS.lead;
  } catch {
    /* 脏数据按默认执行器算 */
  }
  return TEAM_DEFAULTS.lead;
}

// 没有进程可送的时候,把一条系统说明写进最近一条调度台会话的 .md(刷新后仍可见)
// 并广播(实时可见)—— 只弹一个 toast 不算数,用户刷新后必须还看得见发生过什么。
async function noteToLead(taskId: string, message: string): Promise<void> {
  const last = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
    .filter((s) => s.role === "lead")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .at(0);
  if (last) {
    const out = createWriteStream(join(RUNS_DIR, taskId, `${last.id}.md`), { flags: "a" });
    writeRunError(out, message);
    out.end();
    appendSessionTrace(taskId, last.id, last.turnStartedAt ?? last.startedAt, { kind: "error", message });
  }
  bus.publish({
    type: "agent.event",
    taskId,
    sessionId: last?.id ?? "",
    role: "lead",
    agentType: (last?.agentType as AgentType) ?? "claude",
    event: { kind: "error", message },
  });
}

// 开台失败:原因照上面的通道写回去,状态落回 idle —— 团队没有终态,开不起来就是待命。
async function reportOpenFailure(taskId: string, err: unknown): Promise<void> {
  await noteToLead(taskId, `调度台启动失败：${err instanceof Error ? err.message : String(err)}`);
  await setTaskStatus(taskId, "idle");
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
    const promptedText = withSkillInvocation({ agentType: lead.agentType, cwd: lead.cwd, text, remote: lead.remote });
    // 见头注 ②③:不打断的话用户要干等一整个回合,那就不是 steering 了。
    if (lead.busy) {
      lead.handle.interrupt();
      recordSystemTurn(lead, INTERRUPT_NOTE);
    }
    const at = now();
    recordUserConversationTurn({ taskId: lead.taskId, sessionId: lead.sessId, role: "lead", agentType: lead.agentType, out: lead.out, text, at });
    lead.handle.send(withGlobalBrowserPolicy(promptedText, "reminder"));
    void beginTurn(lead, at);
    return;
  }
  if (lead.busy) {
    lead.pending.push(text); // 回合结束再合并成一条,省一轮模型调用
    return;
  }
  const at = now();
  recordSystemTurn(lead, text, at);
  lead.handle.send(withGlobalBrowserPolicy(text, "reminder"));
  void beginTurn(lead, at);
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
  const objective = withSkillInvocation({ agentType: cfg.lead, cwd: ws.path, text: task.body?.trim() || task.title, remote: ex.target.kind === "ssh" });
  const text = kind === "start" && resuming ? LEAD_NUDGE : rawText;
  const promptedText = kind === "user" ? withSkillInvocation({ agentType: cfg.lead, cwd: ws.path, text, remote: ex.target.kind === "ssh" }) : text;
  // 接回:上下文都在 CLI 会话里,只补一句「你被中断过」。全新开台:前言 + 目标
  // (哪怕这次是被一条消息带起来的,前言也必须有 —— 否则它不知道自己是调度者)。
  // ws.fresh = 原 worktree 连分支一起没了、这次是重建的空目录,接回的调度者记忆
  // 还在但文件已经不在,必须打断这个连续性。
  const rawMessage = resuming
    ? LEAD_RESUMED + promptedText + (ws.fresh ? LEAD_WORKSPACE_RESET(ws.path) : "")
    : LEAD_PREAMBLE(taskId, cfg.worker) + objective + (promptedText ? `\n\n【新消息】${promptedText}` : "");
  const message = withGlobalBrowserPolicy(rawMessage, resuming ? "reminder" : "full");

  const turnStart = now();
  const sessId = resuming ? prev!.id : id();
  const runDir = join(RUNS_DIR, taskId);
  mkdirSync(runDir, { recursive: true });
  const handle = openResident({ prompt: message, cwd: ws.path, sessionId: prev?.cliSessionId ?? undefined });
  trackRun(taskId, handle);

  const cliSessionId = prev?.cliSessionId ?? handle.sessionId;
  if (resuming) {
    // 接回同一行会话:除了回合时间戳,**执行器那一组字段必须整组刷新** —— 用户完全
    // 可以在两段常驻之间改掉团队的执行器 profile(换 CLI、换供应商、改 CLI 配置覆盖、
    // 甚至改成 ssh 远端)。沿用上一段的值,会话详情就会拿旧 profile 的 env 前缀和
    // 「在哪台机器上跑」去拼那条「复制去终端接着聊」的命令,直接是错的。
    await db
      .update(sessions)
      .set({
        turnStartedAt: turnStart,
        endedAt: null,
        exitStatus: null,
        commandLine: handle.commandLine,
        executor: ex.label,
        target: sessionTargetKey(ex.target),
        ...ex.resumeFields(ws.path, cliSessionId),
      })
      .where(eq(sessions.id, sessId));
  } else {
    await db.insert(sessions).values({
      id: sessId,
      taskId,
      role: "lead",
      agentType: cfg.lead,
      executor: ex.label,
      target: sessionTargetKey(ex.target),
      worktreePath: ws.isWorktree ? ws.path : null,
      branch: ws.branch,
      cwd: ws.path,
      cliSessionId,
      ...ex.resumeFields(ws.path, cliSessionId),
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
    model: ex.model ?? null,
    reasoningEffort: ex.reasoningEffort ?? null,
    cwd: ws.path,
    remote: ex.target.kind === "ssh",
    handle,
    out: createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" }),
    busy: false,
    turnStart: null,
    pending: [],
    idleTimer: null,
    closing: null,
  };
  leads.set(taskId, lead);
  // 运行按钮带来的首个任务 prompt 不另记 turn；用户亲自发来的消息无论是否顺手
  // 打开了调度台，都必须成为可持久、可实时同步的一条 user turn。
  if (kind === "user") recordUserConversationTurn({ taskId, sessionId: sessId, role: "lead", agentType: lead.agentType, out: lead.out, text, at: turnStart });
  else if (resuming) recordSystemTurn(lead, text, turnStart);
  void beginTurn(lead, turnStart);
  void consume(lead).catch((err) => console.error(`[harness] team consume(${taskId}) failed:`, err));
  return lead;
}

// ── 事件消费 ────────────────────────────────────────────────────────────────
async function consume(lead: Lead): Promise<void> {
  let exitStatus = 0;
  let pendingTraceText = "";
  const flushTraceText = () => {
    if (!pendingTraceText) return;
    appendSessionTrace(lead.taskId, lead.sessId, lead.turnStart ?? now(), {
      kind: "text",
      text: pendingTraceText,
    });
    pendingTraceText = "";
  };
  for await (const event of lead.handle.events) {
    if (event.kind === "turnEnd") {
      flushTraceText();
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
          .set({ cliSessionId: event.cliSessionId, ...ex.resumeFields(lead.cwd, event.cliSessionId) })
          .where(eq(sessions.id, lead.sessId));
      }
      publish(lead, event);
      continue;
    }
    if (event.kind === "text") {
      lead.out.write(event.text);
      pendingTraceText += event.text;
    }
    else {
      const emittedEvent = event.kind === "usage"
        ? await recordSessionUsageEvent(lead.sessId, event, lead.agentType, lead.cliSessionId)
        : event;
      flushTraceText();
      if (emittedEvent.kind === "thinking" || emittedEvent.kind === "tool" || emittedEvent.kind === "error" || emittedEvent.kind === "usage" || emittedEvent.kind === "attachment") {
        appendSessionTrace(lead.taskId, lead.sessId, lead.turnStart ?? now(), emittedEvent);
      }
      // 水位相反：**覆盖**。常驻会话尤其需要它——流水一路加到几百万，只有水位能回答
      // 「这个调度台离上下文塞满还有多远」。
      if (emittedEvent.kind === "context") await setSessionContext(lead.sessId, emittedEvent.context);
      if (emittedEvent.kind === "error") writeRunError(lead.out, emittedEvent.message);
      if (emittedEvent.kind === "done") exitStatus = emittedEvent.exitStatus;
      publish(lead, emittedEvent);
      continue;
    }
    publish(lead, event);
  }
  flushTraceText();
  await closeLead(lead, exitStatus);
}

function publish(lead: Lead, event: AgentEvent): void {
  bus.publish({
    type: "agent.event",
    taskId: lead.taskId,
    sessionId: lead.sessId,
    role: "lead",
    agentType: lead.agentType,
    model: lead.model,
    reasoningEffort: lead.reasoningEffort,
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
  appendSessionTrace(lead.taskId, lead.sessId, at, {
    kind: "run",
    model: lead.model,
    reasoningEffort: lead.reasoningEffort,
  });
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
    const at = now();
    recordSystemTurn(lead, merged, at);
    lead.handle.send(withGlobalBrowserPolicy(merged, "reminder"));
    await beginTurn(lead, at);
    return;
  }
  await setTaskStatus(lead.taskId, "idle");
  armIdle(lead);
}

async function closeLead(lead: Lead, exitStatus: number): Promise<void> {
  clearIdle(lead);
  takeStopped(lead.taskId); // 消费停止标记:团队不走 settleTaskStatus,别漏给下一次
  untrackRun(lead.taskId, lead.handle);
  // 工作目录被抽走时我们会主动收掉旧进程、立刻开新的,旧进程的 close 事件晚一步
  // 才到 —— 它不能把已经接管的新会话摘掉,更不能把新回合的 running 改回 idle。
  const superseded = leads.get(lead.taskId) !== lead;
  if (!superseded) leads.delete(lead.taskId);
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
    appendSessionTrace(lead.taskId, lead.sessId, lead.turnStart ?? endIso, { kind: "error", message: msg }, endIso);
    publish(lead, { kind: "error", message: msg });
  }
  writeTurnEnd(lead.out, endIso);
  lead.out.end();
  if (!superseded) await setTaskStatus(lead.taskId, "idle"); // 团队没有终态,进程没了就是待命
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
