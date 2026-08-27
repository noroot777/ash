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
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentType, TeamConfig } from "@ash/shared";
import { TEAM_DEFAULTS } from "@ash/shared";
import { db } from "../db/index.js";
import { tasks, projects, sessions, groups } from "../db/schema.js";
import { bus } from "../bus.js";
import { id, now, attachmentsPrompt } from "../util.js";
import { setTaskStatus } from "../status.js";
import { trackRun, stopTask } from "../runs.js";
import { pauseGroup } from "../scheduler.js";
import { taskWorkspace } from "../task-workspace.js";
import { resolveExecutorFor } from "../executors/index.js";
import { LOST_SESSION_PATCH } from "../executors/session-lost.js";
import { RUNS_DIR } from "../paths.js";
import { appendSessionTrace, writeRunError } from "../transcript.js";
import { recordUserConversationTurn } from "../conversation-turn.js";
import { LEAD_PREAMBLE, LEAD_NUDGE, LEAD_RESUMED, LEAD_WORKSPACE_RESET } from "./prompts.js";
import { withSkillInvocation, nativeCliCommand } from "../skills.js";
import { withGlobalBrowserPolicy } from "../browser-verification-policy.js";
import { affectedCodexResumeVersion, announceAffectedSessionReplacement } from "../session-version-guard.js";
import { latestTeamLeadSession } from "./session-selection.js";
import { enqueueInbound, pendingInbound, type PendingInbound } from "./inbound-queue.js";
import type { Lead } from "./session-types.js";
import { createSessionConsumer } from "./session-consumer.js";
import { runEnvForTask } from "../auth/run-env.js";

const INTERRUPT_NOTE = "〔系统〕已打断调度者当前回合,插入你的新指令";
// 「再说一句话就接回同一会话」只在会话**还在**时成立。刚被判 poisoned 作废过的话,
// 这句就是把用户推回同一堵墙的错误指路 —— 以前靠事后补一条红色 error「更正上面那条」,
// 于是一次 exit 0 的健康回合被停掉后照样挂着「执行过程 · 1 异常」(第 2 轮审查 P1)。
// 现在按下按钮时就照实说,不留需要更正的话。
const HALT_NOTE = (resumable: boolean) =>
  "〔系统〕你按了「停止全组」:调度台进程与所有在跑的执行者都已停止,执行者可从中断处恢复。"
  + (resumable
    ? "再说一句话就能把调度者接回同一会话。"
    : "调度者这条 CLI 会话已经作废,再说一句话会开一条全新会话(之前的上下文不带过去)。");
// 调度台脚下的工作目录没了(多半是它自己按吩咐删掉了所在的 worktree)。
const WORKSPACE_GONE_NOTE = (cwd: string) =>
  `〔系统〕检测到调度台的工作目录 ${cwd} 已不存在(worktree 被删除),当前进程已无法继续执行命令,先收掉它。这条消息会用同一个 CLI 会话重新接回:能恢复的会原样恢复,恢复不了则会新建一个空目录并明确告知。`;

type Kind = "user" | "inbound" | "start";

const leads = new Map<string, Lead>();
const opening = new Map<string, Promise<Lead>>();
// 落库失败时的**最后一档**:没能写进 team_inbound 的入站消息只剩这一份内存副本。换台时
// 跟着它走(releasePending → adoptInbound),server 一重启就真没了 —— 但那是数据库当时
// 拒收的直接后果,总好过当场丢掉还一声不吭(2026-08-26 第 13 轮审查)。
const unqueuedFallback = new Map<string, string[]>();

export function teamIsLive(taskId: string): boolean {
  return leads.has(taskId) || opening.has(taskId);
}

// 用户插话(continueTask 顶部分流过来)。
// **返回值 = 这句话有没有真的进到调度台**。false 有两种来源:离线时收到 CLI 原生命令
// 被明确拒收,以及在线的调度台进程正在收尾、stdin 已经关了。上层拿它决定要不要记
// 「已送达」—— 记了就等于把一句从未送出的话标成 sent(见 continueTask 里那段)。
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
    // 会话在 consume 里被判 poisoned 时就地作废过(lead.cliSessionId 清空),所以这里
    // 问得出「还接得回吗」,不必等 closeLead 再去更正。
    lead.closingSaidRotated = !lead.cliSessionId;
    recordSystemTurn(lead, HALT_NOTE(!!lead.cliSessionId));
  }
  stopTask(taskId); // 常驻 handle 已 trackRun → killChild 三层击杀
  const owned = await db.select().from(groups).where(eq(groups.ownerTaskId, taskId));
  for (const g of owned) await pauseGroup(g.id);
  if (!lead) await setTaskStatus(taskId, "idle");
}

// ── 投递 ────────────────────────────────────────────────────────────────────
// 返回 true = 这句话进了调度台(或者由 open 带着它开台);false = **明确拒收**,
// 一个字都没送出去。两个来源:离线时收到 CLI 原生命令(见下面的分支),以及在线的
// 调度台进程已经关了 stdin(见 push)。调用方必须分得清这两者。
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
  // 拒收的回执一路往上传:调用方拿它决定「这句话到底算不算送出去了」(见 push)。
  return push(lead, text, kind);
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

/**
 * 把一句话交给这台调度台。**返回值 = 它到底有没有被接住**。
 *
 * false 只有一个来源:进程明确拒收(收尾窗口里 stdin 已经关了,见 ResidentHandle.send)。
 * 这个回执必须一路传回上层 —— `deliver` → `deliverToLead` → `continueTask` 的
 * `onDelivered` 是排队/定时消息 pending → sent 的**唯一写点**。标了 sent,那条就从待发送
 * 托盘里消失、全表扫描也不会再看它(只扫 pending),用户预定的指令从此没人执行,而时间线
 * 上只有一句「没送进去」跟它自相矛盾(2026-08-26 第 14 轮审查)。
 *
 * 执行者汇报(inbound)被拒仍算 true:它有自己的持久待送队列接着(见 queueInbound),
 * 已经被接住了,不需要上层再管第二遍。
 */
async function push(lead: Lead, text: string, kind: Kind): Promise<boolean> {
  if (!text.trim()) return true;
  clearIdle(lead);
  if (kind === "user") {
    const promptedText = withSkillInvocation({ agentType: lead.agentType, cwd: lead.cwd, text, userId: lead.ownerUserId });
    // 见头注 ②③:不打断的话用户要干等一整个回合,那就不是 steering 了。
    const interrupted = lead.busy;
    if (interrupted) lead.handle.interrupt();
    const at = now();
    // **先确认进程收下了,再往时间线上落**。落早了这一句会以「用户已经说过」的样子留在
    // .md 里,可它接着还要由下一台补送 —— 同一句话在会话里出现两遍,而中间那一遍模型
    // 根本没收到。被拒时只留失败说明:原文还在待发送托盘里,用户看得见也等得到。
    if (!sendToLead(lead, promptedText)) {
      reportLeadFailure(lead, "这条消息没能送进调度台进程 —— 它正在收尾。这一句留在待发送托盘里,等下一台调度台接手时自动补送。", at);
      return false;
    }
    if (interrupted) recordSystemTurn(lead, INTERRUPT_NOTE, at);
    recordUserConversationTurn({ taskId: lead.taskId, sessionId: lead.sessId, role: "lead", agentType: lead.agentType, out: lead.out, text, at });
    void beginTurn(lead, at);
    return true;
  }
  if (lead.busy) {
    // 回合结束再合并成一条,省一轮模型调用 —— 但**先落库**:这一等横跨换台、关台和重启,
    // 只压在内存里的话,进程一换这条汇报就没了(见 team/inbound-queue.ts)。
    lead.pending.push(await queueInbound(lead, text));
    return true;
  }
  const at = now();
  // 跟 endTurn 同一条规矩:**先确认进程收下了,再算它送出去了**。还挂在 leads 里不等于
  // stdin 还开着 —— 空闲回收 close() 到 closeLead 之间就是这么一个窗口。没收下就排进持久
  // 队列等下一台送(这时候别落盘正文,否则下一台真送成时同一条汇报会在 .md 里出现两遍)。
  if (!sendToLead(lead, text)) {
    lead.pending.push(await queueInbound(lead, text, at));
    reportLeadFailure(lead, "执行者消息没能送进调度台进程(它正在收尾),先排进待送队列交给下一台接手的调度台。", at);
    return true;
  }
  recordSystemTurn(lead, text, at);
  void beginTurn(lead, at);
  return true;
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
  const objective = withSkillInvocation({ agentType: cfg.lead, cwd: ws.path, text: task.body?.trim() || task.title, userId: task.ownerUserId });
  const text = kind === "start" && resuming ? LEAD_NUDGE : rawText;
  const promptedText = kind === "user" ? withSkillInvocation({ agentType: cfg.lead, cwd: ws.path, text, userId: task.ownerUserId }) : text;
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
  const handle = openResident({
    prompt: message,
    cwd: ws.path,
    sessionId: prev?.cliSessionId ?? undefined,
    env: { ...(await runEnvForTask(taskId, cfg.lead)), ASH_TASK_ID: taskId },
  });
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
    ownerUserId: task.ownerUserId,
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

/**
 * 认领这条任务名下还没送出去的入站消息 —— 上一台没送成的、换台丢下的、上一个 server
 * 进程留下的,都在这儿接回来(队列本身见 team/inbound-queue.ts)。
 *
 * 放在 consume 的开头而不是 attachLead 里,是因为读库要 await 而 attachLead 必须同步返回;
 * 排在 for-await 之前就够了 —— 事件都在 generator 里排着,turnEnd 一定在认领之后才处理。
 * 按 seq 去重是防这一手:认领读库的这段时间里,并发的 push 可能刚好把同一行也塞进了 pending。
 */
async function adoptInbound(lead: Lead): Promise<void> {
  // 最后一档先取走:它只活在这个进程的内存里,没别的地方能等。
  const fallback = unqueuedFallback.get(lead.taskId) ?? [];
  unqueuedFallback.delete(lead.taskId);
  let rows: { seq: number; text: string }[] = [];
  try {
    rows = await pendingInbound(lead.taskId);
  } catch (error) {
    // 读不到不能当成「没有」:那等于把这些消息判死。如实说一句,它们仍在库里等下一台。
    reportLeadFailure(lead, `读取待送的执行者消息失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (lead.retired) {
    // 读库这段时间里被换掉了。库里那些自有下一台去认领,内存这一份得放回最后一档。
    if (fallback.length) unqueuedFallback.set(lead.taskId, [...fallback, ...(unqueuedFallback.get(lead.taskId) ?? [])]);
    return;
  }
  const have = new Set(lead.pending.map((m) => m.seq));
  lead.pending.unshift(
    ...rows.filter((r) => !have.has(r.seq)),
    // 落库失败过的排在有 seq 的之后 —— 它们没有序号,精确的先后早在写库被拒时就丢了。
    ...fallback.map((text) => ({ seq: null, text })),
  );
}

/**
 * 排进持久待送队列,**写库失败不抛**。
 *
 * 抛出去没有意义:这条链是 fire-and-forget 的(执行者结算侧 `notifyTeamLead(...)` 只
 * `.catch(console.error)`),异常最终只变成一行控制台日志,而执行者已经结算,没有任何补送
 * 入口 —— 一次瞬时故障就永久吃掉一份执行结果、一句失败说明或一个待回答的提问,用户刷新
 * 也看不到发生过什么(2026-08-26 第 13 轮审查)。
 *
 * 写不进去就退回内存副本(seq=null):这一回合照样送得出去,下一次回合收尾还会重试落库
 * (flushUnqueued),换台也带得走(releasePending)。失败本身如实落进会话。
 */
async function queueInbound(lead: Lead, text: string, at = now()): Promise<PendingInbound> {
  try {
    return await enqueueInbound(lead.taskId, text);
  } catch (error) {
    console.error(`[ash] team enqueueInbound(${lead.taskId}) failed:`, error);
    reportLeadFailure(
      lead,
      `执行者消息写入待送队列失败：${error instanceof Error ? error.message : String(error)}。`
        + `这条消息眼下只有一份内存副本,回合收尾时会重试落库;在那之前 server 重启就会丢。`,
      at,
    );
    return { seq: null, text };
  }
}

/** 重试把还没落库的那几条写进去。库一恢复它们就重新变成持久的;还是不行就照旧只有内存副本。 */
async function flushUnqueued(lead: Lead): Promise<void> {
  for (const message of lead.pending) {
    if (message.seq !== null) continue;
    try {
      message.seq = (await enqueueInbound(lead.taskId, message.text)).seq;
    } catch {
      // 还写不进去。第一次已经如实报过了,别每个回合再刷一遍屏 —— 内存副本还在,照样送。
      return;
    }
  }
}

/**
 * 交出这台手上的待送消息。有 seq 的留在 team_inbound 里等下一台认领;**没 seq 的只有内存
 * 这一份**,交给进程内的最后一档,别跟着这台一起没(见 unqueuedFallback)。
 *
 * 必须清空 `lead.pending`:摘牌不让旧进程闭嘴,它晚一步吐出的 turnEnd 照样会走 endTurn 那段
 * 合并投递,不清就是同一条汇报朝一个已经被杀的 handle 再送一遍,送「成」了还会把行删掉。
 */
function releasePending(lead: Lead): void {
  const unqueued = lead.pending.filter((m) => m.seq === null).map((m) => m.text);
  if (unqueued.length) {
    unqueuedFallback.set(lead.taskId, [...(unqueuedFallback.get(lead.taskId) ?? []), ...unqueued]);
  }
  lead.pending = [];
}

// ── 事件消费 ────────────────────────────────────────────────────────────────
const {
  beginTurn,
  clearIdle,
  consume,
  recordSystemTurn,
  reportLeadFailure,
  retireLead,
  sendToLead,
} = createSessionConsumer({ leads, adoptInbound, flushUnqueued, releasePending });
