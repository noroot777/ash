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
import { Writable } from "node:stream";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { AgentEvent, AgentType, TeamConfig } from "@ash/shared";
import { TEAM_DEFAULTS } from "@ash/shared";
import { db } from "../db/index.js";
import { tasks, projects, sessions, groups } from "../db/schema.js";
import { bus } from "../bus.js";
import { id, now, attachmentsPrompt } from "../util.js";
import { setTaskStatus } from "../status.js";
import { trackRun, untrackRun, takeStopped, stopTask } from "../runs.js";
import { pauseGroup } from "../scheduler.js";
import { taskWorkspace } from "../task-workspace.js";
import { resolveExecutorFor } from "../executors/index.js";
import type { ResidentHandle, ResumeFields } from "../executors/types.js";
import {
  LOST_SESSION_PATCH,
  SESSION_DROP_PERSISTENCE_FAILED_NOTE,
  sessionResumeFaultNote,
  shouldDropSession,
} from "../executors/session-lost.js";
import { NO_RESUMABLE_SESSION_NOTE, ROTATION_ALREADY_ANNOUNCED } from "@ash/shared/session-notes";
import { RUNS_DIR } from "../paths.js";
import { appendSessionTrace, writeTurn, writeTurnEnd, writeRunError } from "../transcript.js";
import type { SessionTraceEvent } from "../transcript.js";
import { recordUserConversationTurn } from "../conversation-turn.js";
import { recordSessionUsageEvent, setSessionContext } from "../usage.js";
import { LEAD_PREAMBLE, LEAD_NUDGE, LEAD_RESUMED, LEAD_WORKSPACE_RESET } from "./prompts.js";
import { withSkillInvocation, nativeCliCommand } from "../skills.js";
import { withGlobalBrowserPolicy } from "../browser-verification-policy.js";
import { affectedCodexResumeVersion, announceAffectedSessionReplacement } from "../session-version-guard.js";
import { latestTeamLeadSession } from "./session-selection.js";
import {
  idleRotation,
  onFreshSession,
  onRotationError,
  onRotationNotPersisted,
  onRotationPersisted,
  type RotationState,
} from "./rotation-state.js";

// 空闲多久回收进程(0/负数 = 永不回收)。测试用 ASH_TEAM_IDLE_MS=5000。
const IDLE_MS = Number(process.env.ASH_TEAM_IDLE_MS ?? 30 * 60_000);
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
  sessId: string; // ash 会话行 id,同时是 .md 文件名
  cliSessionId: string;
  agentType: AgentType;
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  cwd: string;
  handle: ResidentHandle;
  // 这一段常驻会话的 .md 落盘流。**摘牌后会被换成一个丢弃流**(见 retireLead):
  // 文件名就是 sessId,接管的新台开着同一个文件在写。
  out: Writable;
  busy: boolean;
  turnStart: string | null;
  pending: string[]; // 回合进行中攒下的执行者消息,turnEnd 时合并成一条送
  // 会话轮换旁注:实时立刻播,落盘攒到 writeTurnEnd 之后再补 —— 重建时 agentEnd 只往
  // 「最后一段是 agent」的气泡上盖时间戳(shared/src/index.ts),夹在正文和 agentEnd
  // 之间会让这一回合的用时失准。
  notices: { text: string; at: string }[];
  // CLI 刚报上来、但还没写进库的会话凭据。内存里的 id 换得比库快,这一笔补不上,进程
  // 一回收或 server 一重启就只能 fresh —— 刚建立的上下文无声消失(flushPendingCredential)。
  pendingCredential: ({ cliSessionId: string } & ResumeFields) | null;
  // 该写进 tasks.status 的值,以及还没写成功时的重试计时(见 setLeadStatus)。
  wantedStatus: "running" | "idle" | null;
  statusTimer: NodeJS.Timeout | null;
  // 已经不代表这个任务了(被接管/被抛弃)。摘牌后一个字都不许再写状态 —— 见 retireLead。
  retired: boolean;
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

// 执行者汇报/提问,以及 ash 自己的唤醒语(inbox.ts 用)。
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
    retireLead(lead); // 它从此不代表这个任务:遗留的状态重试就地作废
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
    const promptedText = withSkillInvocation({ agentType: lead.agentType, cwd: lead.cwd, text });
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
  // 只看最新一条调度台会话：最新行的 id 被清掉时应开新会话，不能越过它复活更老的
  // 上下文（会话失效和版本替换两条清理路径都依赖这个判据）。
  let prev = latestTeamLeadSession(await db.select().from(sessions).where(eq(sessions.taskId, taskId)));
  const affectedSessionVersion = await affectedCodexResumeVersion(cfg.lead, prev?.cliSessionId);
  if (prev && affectedSessionVersion) {
    await announceAffectedSessionReplacement({
      taskId, sessionId: prev.id, role: "lead", agentType: cfg.lead, version: affectedSessionVersion,
    });
    await db.update(sessions).set(LOST_SESSION_PATCH).where(eq(sessions.id, prev.id));
    prev = undefined;
  }
  const resuming = !!prev?.cliSessionId;
  const objective = withSkillInvocation({ agentType: cfg.lead, cwd: ws.path, text: task.body?.trim() || task.title });
  const text = kind === "start" && resuming ? LEAD_NUDGE : rawText;
  const promptedText = kind === "user" ? withSkillInvocation({ agentType: cfg.lead, cwd: ws.path, text }) : text;
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
    // 可以在两段常驻之间改掉团队的执行器 profile(换 CLI、换供应商、改 CLI 配置覆盖)。
    // 沿用上一段的值,会话详情就会拿旧 profile 的 env 前缀去拼那条「复制去终端接着聊」
    // 的命令,直接是错的。
    await db
      .update(sessions)
      .set({
        turnStartedAt: turnStart,
        endedAt: null,
        exitStatus: null,
        commandLine: handle.commandLine,
        executor: ex.label,
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
    handle,
    out: createWriteStream(join(runDir, `${sessId}.md`), { flags: "a" }),
    busy: false,
    turnStart: null,
    pending: [],
    notices: [],
    pendingCredential: null,
    wantedStatus: null,
    statusTimer: null,
    retired: false,
    idleTimer: null,
    closing: null,
  };
  attachLead(lead);
  // 运行按钮带来的首个任务 prompt 不另记 turn；用户亲自发来的消息无论是否顺手
  // 打开了调度台，都必须成为可持久、可实时同步的一条 user turn。
  if (kind === "user") recordUserConversationTurn({ taskId, sessionId: sessId, role: "lead", agentType: lead.agentType, out: lead.out, text, at: turnStart });
  else if (resuming) recordSystemTurn(lead, text, turnStart);
  void beginTurn(lead, turnStart);
  return lead;
}

/**
 * 把一台组装好的调度台挂上线并开始消费它的事件流。**这两件事必须在同一个地方做**:
 * 「在 leads 里」的含义是「后续消息送进这个 handle 会被处理」,而那只有在 consume 那条
 * 循环还活着时才成立。只挂不消费、或消费者退了它还挂着,就是一台吞消息的假在线调度台
 * (consume 的兜底注释里有现场)。
 * 导出只为回归测试能驱动真的消费循环(scripts/test-team-lead-resilience.ts),
 * 生产路径只有 openLead 走这里。
 */
export function attachLead(lead: Lead): void {
  // 换台的那一刻就把老的摘牌。「谁说了算」不能只靠「此刻 leads 里是谁」现算 ——
  // 新台完全可能先于老台的遗留计时器正常收尾并把自己从 map 里删掉,那时 map 是空的,
  // 老台反而会被当成还有话语权(retireLead 顶部有现场)。
  const previous = leads.get(lead.taskId);
  if (previous && previous !== lead) retireLead(previous);
  leads.set(lead.taskId, lead);
  void consume(lead).catch((err) => console.error(`[ash] team consume(${lead.taskId}) failed:`, err));
}

// ── 事件消费 ────────────────────────────────────────────────────────────────
async function consume(lead: Lead): Promise<void> {
  let exitStatus = 0;
  // 事件流被掀翻了吗 —— 跟「进程报了个非零退出码」是两回事,收尾那句话的措辞不一样。
  let aborted = false;
  // CLI 否认过这条会话，或 Codex stderr 证明 thread 已 poisoned 吗（见
  // executors/session-lost.ts）。调度台是常驻会话，踩这个坑比一次性任务更死：
  // 每次说话都 --resume 同一个坏 id，而收尾那句话还在告诉
  // 用户「会话还在,再说一句就能接回」—— 他会照做,然后一次次撞同一堵墙。
  //
  // Codex 常驻在同一条 events 流里跑很多回合，所以这不是一个布尔而是一台小状态机：
  // 「坏没坏 / 等不等新 id / 那句『已作废』说没说过且属不属实」三件事必须一起翻篇，
  // 漏复位其中一个就会把上一条会话的结论串到下一条上（rotation-state.ts 顶部有现场）。
  let rotation = idleRotation();
  let pendingTraceText = "";
  const flushTraceText = () => {
    if (!pendingTraceText) return;
    traceLead(lead, lead.turnStart ?? now(), { kind: "text", text: pendingTraceText });
    pendingTraceText = "";
  };
  // 兜底:上面每个写库点都已经各自把失败咽下了(persistOrReport),这里管的是**剩下**
  // 那些没预料到的抛出 —— 执行器解析、用量记账、乃至 events 流自己炸掉。掀翻循环本身
  // 不致命,**跳过 closeLead 才致命**(理由见 reportLeadFailure 顶部),所以这里只如实说
  // 一句、收掉这台已经没人消费事件的进程,然后照常往下走那段收尾。
  try {
    for await (const event of lead.handle.events) {
      if (event.kind === "turnEnd") {
        flushTraceText();
        await endTurn(lead);
        // 上一回合欠着的新会话凭据在这儿补:补上了,轮换事宜这才算真翻篇。
        if (await flushPendingCredential(lead)) rotation = onFreshSession(rotation);
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
          lead.pendingCredential = {
            cliSessionId: event.cliSessionId,
            ...ex.resumeFields(lead.cwd, event.cliSessionId),
          };
        }
        // CLI 报上新的 thread id：上一条会话的轮换事宜就此翻篇（fault / 等新 id /
        // 那句「已作废」说没说过，三个一起归零）—— 但**只有凭据真写进库了才算数**。
        // 没写进去还翻篇的话,收尾会按「一切正常」处理:既不补写凭据也不再作废旧的,
        // 库里就永远不知道这条会话(见 flushPendingCredential)。
        if (await flushPendingCredential(lead)) rotation = onFreshSession(rotation);
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
        // scope:"session" 说的是「这条恢复会话作废了」，不是「本回合失败了」（见
        // executors/codex.ts）。当成普通 error 会让一个正常收尾的回合在执行过程里记一笔
        // 异常；跟 duet、single-run 一样按 scope 分流，降成 system 旁注。
        const sessionNotice = emittedEvent.kind === "error" && emittedEvent.scope === "session";
        if (!sessionNotice
          && (emittedEvent.kind === "thinking" || emittedEvent.kind === "tool" || emittedEvent.kind === "error" || emittedEvent.kind === "usage" || emittedEvent.kind === "attachment")) {
          traceLead(lead, lead.turnStart ?? now(), emittedEvent);
        }
        // 水位相反：**覆盖**。常驻会话尤其需要它——流水一路加到几百万，只有水位能回答
        // 「这个调度台离上下文塞满还有多远」。正因为是覆盖,摘牌后就不能再写:那一行现在
        // 归接管的那台,旧进程的水位盖上去就是错的(用量是累加的真实开销,照记不误)。
        if (emittedEvent.kind === "context" && !lead.retired) await setSessionContext(lead.sessId, emittedEvent.context);
        if (emittedEvent.kind === "error") {
          const previousFault = rotation.fault;
          if (sessionNotice) noteSessionNotice(lead, emittedEvent.message);
          else writeRunError(lead.out, emittedEvent.message);
          rotation = onRotationError(rotation, emittedEvent.message);
          if (rotation.fault === "poisoned" && previousFault !== "poisoned" && lead.handle.dropSession) {
            // 不能等整条常驻 events 流关闭：pending 消息会在 turnEnd 后立刻开下一回合。
            // 这里先作废闭包里的 id 与持久恢复字段，所以下一个 startTurn 必然 fresh。
            lead.handle.dropSession();
            lead.cliSessionId = "";
            // 这条会话行可能已经被新进程接管了（工作目录被抽走那条路会复用同一行）。跟
            // closeLead 里那道闸同一个理由：晚到的旧进程不能抹掉新进程刚报上来的有效 id。
            // 内存里的 id 照样作废——那只影响这个已经出局的 handle；但一个字都不写进时间线：
            // 那条会话现在归新进程管，说「已作废」既不属实也没人该照做。
            if (leads.get(lead.taskId) === lead) {
              let note = sessionResumeFaultNote("poisoned");
              try {
                await db.update(sessions).set(LOST_SESSION_PATCH).where(eq(sessions.id, lead.sessId));
                // 只有真清成了才算「已经说过且属实」：收尾那两句据此不再重复整段。
                rotation = onRotationPersisted(rotation);
              } catch (error) {
                // 内存里的恢复 id 已经作废，不能让一次持久化故障杀掉常驻消费循环；同时明确
                // 告知用户重启前数据库里可能还留着旧 id。没清成就**不算说过** —— 宁可让收尾
                // 把完整那句再说一遍，也不能留下一句报喜的短话。
                const message = `已停止续跑损坏的 Codex 会话，但清理数据库恢复字段失败：${error instanceof Error ? error.message : String(error)}`;
                writeRunError(lead.out, message);
                traceLead(lead, lead.turnStart ?? now(), { kind: "error", message });
                publish(lead, { kind: "error", message });
                note = SESSION_DROP_PERSISTENCE_FAILED_NOTE;
                rotation = onRotationNotPersisted(rotation);
              }
              noteSessionNotice(lead, note);
            } else {
              // superseded：库里那份归新进程管，我们没清也不该说清了。
              rotation = onRotationNotPersisted(rotation);
            }
          }
        }
        if (emittedEvent.kind === "done") exitStatus = emittedEvent.exitStatus;
        if (!sessionNotice) publish(lead, emittedEvent);
        continue;
      }
      publish(lead, event);
    }
  } catch (error) {
    console.error(`[ash] team consume(${lead.taskId}) aborted:`, error);
    aborted = true;
    // 事件流被掀翻时我们从没拿到过 done —— 那个初值 0 是「还没人报过退出码」,不是
    // 「正常收尾」。照原样落库就是把异常中断记成成功退出(第 3 轮审查)。
    if (exitStatus === 0) exitStatus = ABORTED_EXIT_STATUS;
    // 这句只说发生了什么。「会话还接不接得回」由 closeLead 按 rotation 统一给 ——
    // 在这儿写死「用同一条 CLI 会话接回」,碰上刚判过 poisoned 的会话就是自相矛盾的指路。
    reportLeadFailure(lead, `调度台事件流异常中断：${error instanceof Error ? error.message : String(error)}`);
    try {
      lead.handle.kill();
    } catch {
      // 多半是它自己先没的,收尾照走。
    }
  }
  flushTraceText();
  // 关台前最后一次补欠账:补上了就不该再按「这条会话作废了」收尾。
  if (await flushPendingCredential(lead)) rotation = onFreshSession(rotation);
  await closeLead(lead, exitStatus, rotation, aborted);
}

function publish(lead: Lead, event: AgentEvent): void {
  // 摘牌后一个字都不再广播:这条 sessionId 现在归接管的那台,用户正看着它说话,
  // 收到旧进程的「执行异常结束/意外退出」只会当成新会话出了事(见 retireLead)。
  if (lead.retired) return;
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

// 执行过程面板那条流。跟 publish / lead.out 同一块牌子:摘牌之后这条 sessId 的 trace
// 归接管的那台,旧进程晚到的事件不许再插进去(见 retireLead)。
function traceLead(lead: Lead, turnStart: string, event: SessionTraceEvent, at?: string): void {
  if (lead.retired) return;
  appendSessionTrace(lead.taskId, lead.sessId, turnStart, event, at);
}

// 收尾链上的持久化失败:如实落到三处(.md / trace / SSE),然后**咽回去**。
//
// 常驻调度台跟一次性任务不一样 —— 它的每一次写库都跑在 consume 那条 for-await 里面。
// 抛出去掀掉的不是一个回合,是整台调度台:closeLead 再也不会跑,于是 leads 里留着一台
// 没人消费事件的**假在线**调度台(后续消息照送进去,一个字都不落盘也不广播),任务永远
// 停在 running,攒下的轮换旁注烂在内存里 —— 只能靠重启恢复(2026-08-25 第 2 轮审查)。
// 一次写库失败该丢的只是那一行状态,不是这台调度台。
function reportLeadFailure(lead: Lead, message: string, at = now()): void {
  writeRunError(lead.out, message);
  traceLead(lead, lead.turnStart ?? at, { kind: "error", message }, at);
  publish(lead, { kind: "error", message });
}

/** 跑一次写库;失败只上报不外抛,返回它成没成。**只能在 lead.out.end() 之前调**。 */
async function persistOrReport(
  lead: Lead,
  what: string,
  run: () => PromiseLike<unknown>,
  at = now(),
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    console.error(`[ash] team ${what}(${lead.taskId}) persistence failed:`, error);
    reportLeadFailure(lead, `${what}写入数据库失败：${error instanceof Error ? error.message : String(error)}`, at);
    return false;
  }
}

const sessionUpdate = () => db.update(sessions);
type SessionPatch = Parameters<ReturnType<typeof sessionUpdate>["set"]>[0];

/**
 * 这台调度台名下那条会话行的**唯一写入口**。
 *
 * 摘牌之后一个字都不写:接管那条路会复用同一行(openLead 的 resuming 分支),新台刚把
 * endedAt/exitStatus 清成 null 表示「这一段正在跑」。旧台晚到的 turnEnd 一写,在线的
 * 会话就被标成已结束,activeMs 还把两段重叠的墙钟时间重复计一遍(2026-08-26 第 9 轮
 * 审查)。**收口成一个函数是刻意的**:上一轮只在 closeLead 补了闸,beginTurn/endTurn
 * 就漏了,而漏哪一个都是同一个坏结果。
 *
 * 「查完到写进去之间又换了台」这个窗口不存在:retireLead 是同步的,只能从别的同步代码
 * 里跑(attachLead / deliver / closeLead);而这里从判断到 drizzle 把语句递给 node:sqlite
 * 中间没有 await,谁也插不进来。
 */
async function updateOwnSession(lead: Lead, what: string, patch: SessionPatch, at = now()): Promise<boolean> {
  if (lead.retired) return false;
  return persistOrReport(lead, what, () => sessionUpdate().set(patch).where(eq(sessions.id, lead.sessId)), at);
}

/**
 * 把 CLI 报上来的新会话凭据补进库,**返回「这一次真的补上了」**。
 *
 * 为什么不是写一次就算完:`lead.cliSessionId` 是内存里当场换掉的,库里那笔靠这次写入。
 * 写失败还当它成了的话,后面三层会一起替它兜底失效 —— 内存 id 已是新值,同一个 id 再报
 * 一次会被「变了才写」挡掉;轮换状态机已经翻篇,不再记得欠着账;closeLead 的正常收尾只
 * 写退出码/用时,不补凭据。于是一次瞬时故障就永久留下「进程还能跑、数据库不知道这条
 * 会话」的分叉:一旦空闲回收或重启,下一次只能 fresh,刚建立的上下文无提示丢失,库里要是
 * 还留着更老的 id 甚至会去续跑旧会话(2026-08-25 第 3 轮审查)。
 *
 * 所以欠账留在 lead 上,由 consume 在**每个回合收尾和关台前**再试;调用点都在 consume
 * 里,是因为补上之后必须连带把 rotation 翻篇 —— 那个状态是 consume 的局部变量,而且
 * 「凭据立住了」和「不必再按作废收尾」本来就是同一件事。
 */
async function flushPendingCredential(lead: Lead): Promise<boolean> {
  const patch = lead.pendingCredential;
  if (!patch) return false;
  // 只补写**当前这一代**凭据。中途判过 poisoned 的话,内存 id 已经被清成空串、库里的恢复
  // 字段也刚清掉 —— 这时候把欠账补回去等于把刚判死的 thread 复活:用户看到的持久说明是
  // 「下次开全新会话」,库里却又指回同一条坏 thread,而且补写成功还会顺手把 rotation 翻篇,
  // 让 closeLead 也不再清它(2026-08-25 第 4 轮审查)。同代校验顺带挡住其它过代的路子。
  if (!lead.cliSessionId || patch.cliSessionId !== lead.cliSessionId) {
    lead.pendingCredential = null;
    return false;
  }
  // 这条会话行可能已经被新进程接管了(工作目录被抽走那条路会复用同一行)。晚到的旧消费者
  // 不能拿自己攒的这笔凭据盖掉新进程刚报上来的有效 id —— 跟 closeLead 里那道闸同一个理由。
  // 欠账就此作废:那条行现在归新进程管,补不补轮不到这个已经出局的 handle 决定。
  if (leads.get(lead.taskId) !== lead) {
    lead.pendingCredential = null;
    return false;
  }
  const ok = await updateOwnSession(lead, "新会话凭据", patch);
  if (ok) lead.pendingCredential = null;
  return ok;
}

const STATUS_RETRY_MS = Number(process.env.ASH_TEAM_STATUS_RETRY_MS ?? 5_000);

/**
 * 写这台调度台的任务状态,**写不进去就一直重试**。
 *
 * 别把它跟 activeMs、endedAt 那些统计混成一种语义。`tasks.status` 是路由门禁、排队投递
 * 和页面按钮的共同真相源:回合已经收了、agentEnd 已经落盘,库里却还写着 running,用户看到
 * 的是「仍在跑/可停止」,依赖 idle 的后续动作也不会推进。而常驻会话跟一次性任务不同 ——
 * 它收完一个回合就阻塞在 events 上,**没有下一个自然的补写时机**:默认要等下一条消息或
 * 30 分钟空闲回收,`ASH_TEAM_IDLE_MS<=0` 时可以永远维持(2026-08-25 第 5 轮审查)。所以这
 * 一笔必须自己带重试,而不是报一声就算完。
 *
 * 报错只报第一次(后面每 STATUS_RETRY_MS 静默重试),那之后再刷屏也不多给用户任何信息。
 */
async function setLeadStatus(lead: Lead, status: "running" | "idle", at = now()): Promise<void> {
  clearStatusRetry(lead);
  if (lead.retired) return; // 已经不代表这个任务了,状态归接管的那台管
  lead.wantedStatus = status;
  const what = status === "idle" ? "调度台待命状态" : "调度台运行状态";
  if (await persistOrReport(lead, what, () => setTaskStatus(lead.taskId, status), at)) {
    if (lead.wantedStatus === status) lead.wantedStatus = null;
    return;
  }
  armStatusRetry(lead);
}

/**
 * 这台调度台从此不再代表这个任务(被新进程接管,或工作目录没了被抛弃)。手上那笔待写状态
 * 就地作废,**所有共享产物一并断开**。
 *
 * 为什么不能只在计时器里查一下 `leads` 有没有人:**map 是空的不等于旧台还有话语权**。
 * 旧台的 running 写失败留下重试 → 新台接管 → 新台正常收尾、写了 idle 并把自己摘牌 →
 * 旧计时器这才到点,看到 map 是空的就把过期的 running 写了回去。这一次比原来那个坑更
 * 难自愈:已经没有任何在线调度台或下一个回合会来覆盖它(2026-08-25 第 6 轮审查)。
 *
 * 共享的不止 tasks.status:接管那条路(工作目录被抽走)**复用同一条会话行,连 .md 都是
 * 同一个文件**(文件名就是 sessId)。旧台晚到的正文、执行诊断和 agentEnd 会插进新台还
 * 没说完的那一段里 —— parseSessionOutput 见到 agentEnd 就收口,一条回复被切成两个气泡,
 * 用时也跟着算错(2026-08-26 第 8 轮审查)。所以这里把写流换成丢弃流:**换而不是 end,**
 * 因为消费循环还在跑,往已经 end 的流里写一个字就是 ERR_STREAM_WRITE_AFTER_END,当场
 * 打崩整个 server。trace 与 SSE 由 traceLead / publish 各自认这块牌子。
 */
function retireLead(lead: Lead): void {
  if (lead.retired) return; // 摘过一次就够了:再摘一次时新台可能正说到一半,不能往共享 .md 里补写
  lead.retired = true;
  clearStatusRetry(lead);
  lead.wantedStatus = null;
  // 攒着的轮换旁注必须**在断流之前**落盘。它为了不夹在正文和 agentEnd 之间才缓存下来
  // (见 Lead.notices),可摘牌之后 turnEnd/closeLead 的那次 flush 只会写进丢弃流 ——
  // 「这条会话已作废、下次会丢上下文」这句关键说明就只活在 SSE 里,用户刷新一次就再也
  // 看不到发生过什么(2026-08-26 第 9 轮审查)。
  //
  // 这里不补 agentEnd:摘牌的这一回合本来就不会再有收尾,那条排序约束针对的是正常收尾。
  // 时机也是安全的 —— retireLead 只从同步代码里跑,且都排在新台开口之前(deliver 里先
  // 摘牌再 open,attachLead 里先摘旧台再启动新台的消费循环),插不进别人的正文中间。
  flushSessionNotices(lead);
  const out = lead.out;
  lead.out = new Writable({ write(_chunk, _enc, done) { done(); } });
  out.end();
}

function clearStatusRetry(lead: Lead): void {
  if (lead.statusTimer) clearTimeout(lead.statusTimer);
  lead.statusTimer = null;
}

function armStatusRetry(lead: Lead): void {
  clearStatusRetry(lead);
  const status = lead.wantedStatus;
  if (!status || lead.retired) return;
  const t = setTimeout(() => {
    lead.statusTimer = null;
    // 摘过牌就永远不再写(retireLead);没摘牌但已经换了新台在线,也是新台说了算。
    const owner = leads.get(lead.taskId);
    if (lead.retired || lead.wantedStatus !== status || (owner && owner !== lead)) return;
    void setTaskStatus(lead.taskId, status)
      .then(() => {
        if (lead.wantedStatus === status) lead.wantedStatus = null;
      })
      .catch(() => armStatusRetry(lead));
  }, STATUS_RETRY_MS);
  (t as { unref?: () => void }).unref?.();
  lead.statusTimer = t;
}

// 入站消息(执行者汇报/提问、系统提示)记成 system turn:实时走 system 事件、
// 刷新走 .md 的哨兵行,两边长得一样。
function recordSystemTurn(lead: Lead, text: string, at = now()): void {
  writeTurn(lead.out, { t: "system", agent: lead.agentType, text }, at);
  publish(lead, { kind: "system", text, at });
}

// 会话轮换旁注:实时立刻播(用户正看着),落盘等 writeTurnEnd 之后由 flushSessionNotices
// 补 —— 理由见 Lead.notices。摘牌之后一句都不再说:那条会话现在归接管的那台,这台既不
// 该广播,攒下的也没有能落盘的地方(见 retireLead)。
function noteSessionNotice(lead: Lead, text: string): void {
  if (lead.retired) return;
  const at = now();
  lead.notices.push({ text, at });
  publish(lead, { kind: "system", text, at });
}

function flushSessionNotices(lead: Lead): void {
  const notices = lead.notices;
  lead.notices = [];
  for (const notice of notices) {
    writeTurn(lead.out, { t: "system", agent: lead.agentType, text: notice.text }, notice.at);
  }
}

async function beginTurn(lead: Lead, at = now()): Promise<void> {
  lead.busy = true;
  lead.turnStart = at;
  await updateOwnSession(lead, "回合开始状态", { turnStartedAt: at, endedAt: null }, at);
  traceLead(lead, at, {
    kind: "run",
    model: lead.model,
    reasoningEffort: lead.reasoningEffort,
  });
  await setLeadStatus(lead, "running", at);
}

// 一个回合说完了(进程还活着)。有攒下的执行者消息就立刻合并成一条继续跑,
// 否则落 idle(待命)并起空闲回收计时。
async function endTurn(lead: Lead): Promise<void> {
  const endIso = now();
  const spent = lead.turnStart ? Math.max(0, Date.parse(endIso) - Date.parse(lead.turnStart)) : 0;
  lead.busy = false;
  lead.turnStart = null;
  // 写库失败绝不能把下面整段收尾一起带走 —— writeTurnEnd、旁注落盘、待送消息、落 idle
  // 全在后面(理由见 persistOrReport)。丢的只是这一行用时统计。
  await updateOwnSession(
    lead,
    "回合收尾状态",
    { endedAt: endIso, activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${spent}` },
    endIso,
  );
  writeTurnEnd(lead.out, endIso);
  flushSessionNotices(lead);
  if (lead.pending.length) {
    const merged = lead.pending.join("\n\n---\n\n");
    lead.pending = [];
    const at = now();
    recordSystemTurn(lead, merged, at);
    lead.handle.send(withGlobalBrowserPolicy(merged, "reminder"));
    await beginTurn(lead, at);
    return;
  }
  await setLeadStatus(lead, "idle", endIso);
  armIdle(lead);
}

// 中途已经播过完整轮换说明后,收尾那两句只补一个指路,不重复整段。文案与前端判色的
// 共同真相源在 @ash/shared/session-notes(见那份文件顶部)。
// 事件流被掀翻时,没有任何进程报过退出码。落 0 等于把异常中断记成成功收尾;落 null 又会
// 让这条会话看起来还在跑(openLead 就是拿 null 表示「进行中」)。所以记一个明确的非零码,
// 真正的原因写在时间线和 trace 里。
const ABORTED_EXIT_STATUS = 1;

async function closeLead(
  lead: Lead,
  exitStatus: number,
  rotation: RotationState = idleRotation(),
  aborted = false,
): Promise<void> {
  clearIdle(lead);
  untrackRun(lead.taskId, lead.handle);
  // 工作目录被抽走时我们会主动收掉旧进程、立刻开新的,旧进程的 close 事件晚一步
  // 才到 —— 它不能把已经接管的新会话摘掉,更不能把新回合的 running 改回 idle。
  // 停止标记同理:那是任务级的共享状态,被接管的一方吞掉它,真正在跑的那台收尾时
  // 就当没被停过。
  const superseded = leads.get(lead.taskId) !== lead;
  if (!superseded) {
    leads.delete(lead.taskId);
    takeStopped(lead.taskId); // 消费停止标记:团队不走 settleTaskStatus,别漏给下一次
  } else {
    retireLead(lead); // 被接管的一方从此不写任何共享产物(状态/.md/trace/SSE),见 retireLead
  }
  const endIso = now();
  const spent = lead.turnStart ? Math.max(0, Date.parse(endIso) - Date.parse(lead.turnStart)) : 0;
  // CLI 否认了这条会话:把失效的 id 连同由它派生的三件套恢复命令一起清掉,下一次说话
  // 就会开一条全新会话(openResident 的判据就是「这行上有没有 cli_session_id」)。
  // 退出码 0 也要求上:正常收尾的回合不该因为正文里出现过这句话就丢掉会话。
  // superseded 也要排除:这条会话行已经被新进程接管了(工作目录被抽走那条路会复用同一
  // 行),晚到的旧收尾要是把新进程刚报上来的有效 id 抹掉,新常驻会话的 id 就永久丢了
  // —— 内存里 lead.cliSessionId 已是新值,那条「id 变了才写库」的分支不会再补写一次。
  const dropSession = shouldDropSession(rotation.fault, exitStatus) && !superseded;
  let dropNote = dropSession ? sessionResumeFaultNote(rotation.fault!) : null;
  // 被接管的一方连这条会话行也不许再 finalize:接管那条路会**复用同一行**(openLead 的
  // resuming 分支),新进程刚把 endedAt/exitStatus 清成 null 表示「这一段正在跑」。晚到的
  // 旧收尾一写,页面就同时看到「调度台在线」和「这条会话已退出」;activeMs 还会把两段
  // 重叠的墙钟时间重复计一遍(2026-08-26 第 7 轮审查)。这道闸现在住在 updateOwnSession
  // 里(第 9 轮审查:只在这儿挡,beginTurn/endTurn 就漏了),这里只管别把收尾停在半路 ——
  // 事件流、写流与内存 lead 仍须正常释放。
  const persisted = await updateOwnSession(
    lead,
    "调度台收尾状态",
    {
      exitStatus,
      endedAt: endIso,
      activeMs: sql`COALESCE(${sessions.activeMs}, 0) + ${spent}`,
      ...(dropSession ? LOST_SESSION_PATCH : {}),
    },
    endIso,
  );
  // 没写进去就不能沿用「恢复字段已清掉」的文案:库里那个坏 id 还在,下一次照样撞它。
  // (superseded 那一路 dropSession 恒为 false,所以「摘牌导致没写」不会走进这句。)
  if (!persisted && dropSession) dropNote = SESSION_DROP_PERSISTENCE_FAILED_NOTE;
  // 「再说一句话就能接回」成立要两个条件:手上真有一个 CLI 会话 id,而且它**已经落进库**
  // —— openResident 的判据就是会话行上那一列。fresh 调度台在拿到 thread id 之前就异常,
  // 或者凭据到最后一次补写也没写进去,照着那句话去点「继续」只会开一条全新会话,上下文
  // 一个字都回不来(2026-08-25 第 4 轮审查)。
  const resumable = !!lead.cliSessionId && !lead.pendingCredential;
  if (lead.closing === "recycle") {
    recordSystemTurn(lead, RECYCLE_NOTE(Math.round(IDLE_MS / 60_000)));
  } else if (!lead.closing && (aborted || exitStatus !== 0 || (dropSession && !rotation.announced))) {
    // 既不是回收也不是手停 —— 进程自己没了。会话还在,说句话就能接回;除非 CLI 刚
    // 否认过或判定 poisoned，那句「会话还在」就成了把用户推回同一堵墙的错误指路。
    // rotation.announced:中途已经播过同一条轮换说明**且属实**了,这里只补「进程意外
    // 退出」那半句,别把整段话重复第二遍。
    const rotationNote = dropSession ? (rotation.announced ? ROTATION_ALREADY_ANNOUNCED : dropNote) : null;
    // 「它是怎么没的」这半句要如实:事件流被掀翻时我们从没收到过退出码,不能编一个
    // 「exit N」冒充进程自报;dropSession 独自成立那一路(exit 0、正常收尾)则一个字都不加。
    const how = aborted
      ? "调度台事件流异常中断,进程已收掉。"
      : exitStatus !== 0
        ? `调度台进程意外退出(exit ${exitStatus})。`
        : "";
    const msg = `${how}${rotationNote ?? (resumable ? "CLI 会话还在,再说一句话会自动接回;需要的话也可以点「继续」。" : NO_RESUMABLE_SESSION_NOTE)}`;
    // 「进程自己没了」是真失败,红着走 error;剩下那一路(exit 0、没被掀翻,只是这条会话
    // 不能再续)跟中途 scope:"session" 的旁注同一档 —— 一个正常交卷的回合不该在执行过程
    // 里记一笔异常。
    if (aborted || exitStatus !== 0) {
      writeRunError(lead.out, msg);
      traceLead(lead, lead.turnStart ?? endIso, { kind: "error", message: msg }, endIso);
      publish(lead, { kind: "error", message: msg });
    } else {
      noteSessionNotice(lead, msg);
    }
  }
  // 回收和「停止全组」那两句都写着「再说一句话就能接回同一会话」,而这条会话刚被作废
  // (或压根没建起来)—— 不当场更正,用户刷新后看到的指引与真实状态正好相反,照做一次
  // 再撞一次墙。上面那个「进程自己没了」的分支已经在 msg 里说过了,别重复。
  //
  // 这是**用户自己点的停止/自然回收**,本回合没有任何失败:所以是 system 旁注,不是
  // 红色执行诊断(2026-08-26 第 7 轮审查)。真失败仍然红 —— 恢复字段没清成那一路,
  // persistOrReport 已经把写库失败如实报过一笔,`why` 里那句也带着「失败」二字,前端
  // 摘掉中性文案后照样判红(见 @ash/shared/session-notes)。
  if (lead.closing && (dropSession || !resumable)) {
    const why = dropSession ? (rotation.announced ? ROTATION_ALREADY_ANNOUNCED : dropNote) : NO_RESUMABLE_SESSION_NOTE;
    noteSessionNotice(lead, `更正上面那条:CLI 会话接不回了。${why}`);
  }
  writeTurnEnd(lead.out, endIso);
  flushSessionNotices(lead); // 回合中途攒下的轮换旁注:流关掉之前必须落盘
  lead.out.end();
  // 团队没有终态,进程没了就是待命。注意 lead.out 已经 end 了 —— 这一步失败只能走日志
  // 和 SSE,再往那条流里写一个字会当场 ERR_STREAM_WRITE_AFTER_END 打崩整个 server。
  // 失败同样要重试:这里写不进去,任务就永久停在 running(跟 setLeadStatus 同一个理由)。
  if (!superseded) {
    clearStatusRetry(lead);
    lead.wantedStatus = "idle";
    try {
      await setTaskStatus(lead.taskId, "idle");
      lead.wantedStatus = null;
    } catch (error) {
      console.error(`[ash] closeLead(${lead.taskId}) idle status failed:`, error);
      publish(lead, {
        kind: "error",
        message: `调度台待命状态写入数据库失败：${error instanceof Error ? error.message : String(error)}`,
      });
      armStatusRetry(lead);
    }
  }
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
