// 任务接力（跨机器 handoff）——导出侧与两端共用的协议/助手。
//
// 场景:下班前把本机还没跑完的任务「接力」到另一台跑着 ash 的机器上继续。
// 迁移三样东西,缺一样对端就续不上:
//   1. 任务与会话的**元数据**（tasks/sessions 行,manifest 里按列原样带走）
//   2. **git 状态**——任务 worktree 分支上的提交打成 `git bundle` 带走(接力前先把
//      未提交改动做一个 WIP 提交),对端 fetch 进它自己的仓库克隆再用 prepareWorktree
//      的恢复档把 worktree 原样搭回来
//   3. **CLI 会话文件**——claude 在 ~/.claude/projects/<cwd slug>/<sessionId>.jsonl,
//      codex 在 ~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl;都是自含的
//      事件流,放到对端对应位置后 `--resume` 就能接着聊(付一次全价读史,和本地隔夜
//      续跑同价)。会话文件缺失时干净退化:对端全新起跑,git 进度仍在。
// 另外把 data/runs/<taskId>/ 的会话产物(.md/.trace)也搬走,否则对端界面上这个任务
// 是一段空白历史。
//
// V1 明确不做:team/duet 模式。跨机器的身份与鉴权见 handoff-identity.ts(本机身份)、
// handoff-peer-client.ts(出站核对对端)、handoff-peers.ts(入站审批)。
import { hostname } from "node:os";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile, appendFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, queueItems, scheduledMessages, schedules, sessions, tasks } from "./db/schema.js";
import { claimTurn, isTurnClaimed, releaseTurn, stopTask } from "./runs.js";
import { setTaskStatus } from "./status.js";
import { expandHome, worktreePathFor } from "./git.js";
import { RUNS_DIR } from "./paths.js";
import { sessionTranscriptPath, TURN_SENTINEL } from "./transcript.js";
import { publishTaskUpdated } from "./task-store.js";
import { id, now } from "./util.js";
import type {
  HandoffExportResult, HandoffPreflightResult, HandoffPeerIdentity, TaskHandoff,
} from "@ash/shared";

// 传输协议类型/错误类/尺寸常量在 handoff-types.ts(导出、导入、HTTP 面三处共用)。
import { HandoffError, MAX_FILE_BYTES } from "./handoff-types.js";
import type { HandoffManifest } from "./handoff-types.js";
// 盘点与打包(会话文件、runs 产物、git bundle)在 handoff-collect.ts,这里只留流程编排。
import { collectRunArtifacts, collectSessionFiles, packGitState } from "./handoff-collect.js";
// 出站请求一律走 handoff-peer-client:每个请求带身份签名,且**打包前**先核对对端指纹
// (地址会漂,而接力推的是整个仓库和会话历史)。原理见那个文件顶部。
import {
  fetchPeer, normalizePeerUrl, pingPeer, rememberedFingerprint, rememberPeerFingerprint,
} from "./handoff-peer-client.js";
import { localIdentity, shortFingerprint } from "./handoff-identity.js";
import { collectUploads, isTextRel } from "./handoff-uploads.js";
import { beginHandoffPrepare, endHandoffPrepare } from "./handoff-guard.js";
import { cancelPendingMessage } from "./pending-messages.js";

export async function handoffRemoteUrl(taskId: string): Promise<string> {
  const row = (await db.select({ handoff: tasks.handoff }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) throw new HandoffError("任务不存在", 404);
  let marker: TaskHandoff | null = null;
  try { marker = row.handoff ? JSON.parse(row.handoff) as TaskHandoff : null; } catch { marker = null; }
  if (marker?.direction !== "out" || !marker.peerUrl || marker.pending) {
    throw new HandoffError("任务没有已确认的对端接力记录", 409);
  }
  const targetUrl = normalizePeerUrl(marker.peerUrl);
  let projectId = marker.targetProjectId;
  if (!projectId) {
    const peerTask = await fetchPeer<{ projectId?: string }>(
      `${targetUrl}/api/tasks/${encodeURIComponent(marker.peerTaskId)}`,
    );
    if (!peerTask.projectId) throw new HandoffError("对端任务缺少项目信息", 502, true);
    projectId = peerTask.projectId;
  }
  return `${targetUrl}/?${new URLSearchParams({ project: projectId, task: marker.peerTaskId })}`;
}

// ── 导出侧 ──────────────────────────────────────────────────────────────────

type TaskRow = typeof tasks.$inferSelect;

// 队列成员不能单独接力:导出会把它结算成 canceled,而队列推进对 canceled 是透明跳过
// (scheduler.ts selectNextInQueue),源机会立刻启动后继——「当前步骤搬去对面继续」被
// 误当成「当前步骤已完成」。整队迁移需要目标机完成后回通知源机推进的协议,待后续版本。
async function assertNotQueueMember(taskId: string): Promise<void> {
  const queued = (await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
  if (queued) {
    throw new HandoffError("任务在队列里,接力会让源机误判本步骤已结束、提前启动队列后继;先从队列移出再接力", 409);
  }
}

async function loadSingleTask(taskId: string): Promise<{ task: TaskRow; project: typeof projects.$inferSelect }> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new HandoffError("任务不存在", 404);
  if (task.mode !== "single") throw new HandoffError("目前只支持单飞任务接力（team/duet 待后续版本）", 409);
  if (task.archived) throw new HandoffError("任务已归档,先取消归档再接力", 409);
  if (task.verifyRound != null) throw new HandoffError("就地验证轮进行中,等它出结论再接力", 409);
  await assertNotQueueMember(taskId);
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) throw new HandoffError("任务所属项目不存在", 404);
  return { task, project };
}

function parsedHandoff(raw: string | null): TaskHandoff | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as TaskHandoff; } catch { return null; }
}

/**
 * 接进来的任务只能回到来源机器。返回 undefined 表示普通接力；返回 null 表示老记录
 * 没有来源指纹，无法安全识别原机器；返回 string 时把它直接交给 pingPeer 做实际身份核对。
 */
function inboundReturnFingerprint(raw: string | null): string | null | undefined {
  const marker = parsedHandoff(raw);
  if (marker?.direction !== "in") return undefined;
  return marker.peerFp || null;
}

/** 停掉正在跑的回合并等结算收尾（镜像 /stop 端点的语义:没有活进程但状态是 running/queued 就直接标 canceled）。 */
async function stopAndSettle(taskId: string): Promise<TaskRow> {
  const fresh = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  let task = await fresh();
  if (task.status === "running" || task.status === "queued") {
    if (!stopTask(taskId)) await setTaskStatus(taskId, "canceled");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      task = await fresh();
      if (task.status !== "running" && task.status !== "queued" && !isTurnClaimed(taskId)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (task.status === "running" || task.status === "queued") {
      throw new HandoffError("停止任务超时（agent 还没退出）,稍等几秒再试", 409);
    }
  }
  return task;
}

/**
 * 对端还没批准本机时,把「下一步该干什么」讲清楚再拦下来。
 * 拦在**打包之前**:等到 /import 才被 401 顶回来的话,任务已经被停掉、bundle 也白打了
 * 一遍。预检不拦(见 preflightHandoff),它只如实报状态,让对话框把指纹摆出来。
 */
function assertPeerAcceptsUs(peer: HandoffPeerIdentity | null): void {
  if (!peer) return;
  const me = shortFingerprint(localIdentity().fingerprint);
  if (peer.peerStatus === "pending") {
    throw new HandoffError(
      `目标机还没批准本机(本机指纹 ${me})。到目标机「设置 → 默认规则 → 接力来源」批准它再重试 —— 刚才的探测已经把本机送进对端的待批准列表了。`,
      409,
    );
  }
  if (peer.peerStatus === "blocked") {
    throw new HandoffError(
      `目标机把本机(指纹 ${me})列为已拒绝。要接力,先到目标机的「接力来源」列表里改掉。`,
      409,
    );
  }
}

/** 接力预检:探测对端、核对身份、匹配项目、盘点本地可搬运的东西。只读,不停任务不动文件。 */
export async function preflightHandoff(taskId: string, targetUrlRaw: string): Promise<HandoffPreflightResult> {
  const { task, project } = await loadSingleTask(taskId);
  const targetUrl = normalizePeerUrl(targetUrlRaw);
  const returnFingerprint = inboundReturnFingerprint(task.handoff);
  if (returnFingerprint === null) {
    throw new HandoffError("这份接入任务缺少来源机器指纹，无法确认该移回哪台机器；请先升级来源机并重新接力", 409);
  }
  // 身份核对在最前面:指纹对不上就直接抛,连盘点都不做——用户要先解决「这台是不是
  // 我那台机器」,别让一堆盘点数字把警告冲下去。
  const expectedFingerprint = returnFingerprint ?? await rememberedFingerprint(targetUrl);
  const { ping, peer } = await pingPeer(targetUrl, expectedFingerprint);
  // 项目匹配靠仓库目录名:两台机器的绝对路径几乎必然不同,目录名是最稳的公共项。
  // 两侧路径可能来自不同操作系统(本机 Windows、对端 macOS,或反过来),所以不用
  // 跟随运行平台的 basename,统一按 win32 规则切——/ 和 \ 都认、吃掉盘符和尾分隔符,
  // 而 POSIX 目录名里不会出现 \,不受影响。只按 "/" 切会把 D:\a\b 整条当成目录名。
  const base = (p: string) => win32.basename(expandHome(p));
  const localBase = base(project.repoPath);
  const suggested = localBase
    ? ping.projects.find((p) => p.isRepo && base(p.repoPath) === localBase) ?? null
    : null;
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  const withCli = rows.filter((s) => s.cliSessionId);
  const { found, notes } = await collectSessionFiles(rows, expandHome(project.repoPath), true);
  const wt = worktreePathFor(project.repoPath, taskId);
  const gitReady = !!task.useWorktree && existsSync(wt);
  // 项目清单为空有两种原因,别混成一句话:对端真没建项目,还是它没批准本机所以不报。
  if (!ping.projects.length) {
    if (peer?.peerStatus === "pending") {
      notes.push(`目标机还没批准本机(本机指纹 ${shortFingerprint(localIdentity().fingerprint)}),在批准之前它不会报出项目清单`);
    } else if (peer?.peerStatus === "blocked") {
      notes.push("目标机把本机列为已拒绝的接力来源");
    } else {
      notes.push("对端还没有任何项目——先在对端把同一个仓库添加为项目");
    }
  }
  if (peer?.trust === "first-seen") {
    notes.push(`第一次连这台目标机:身份指纹 ${peer.short}——和对端设置页上显示的那串核对一下,接力成功后本机会记住它`);
  }
  if (peer === null) {
    notes.push("目标机没有报出身份(版本过旧),这次接力无法核对「对面是不是原来那台机器」");
  }
  // 载荷里有整个仓库和完整会话历史,加不加密是用户该在按下按钮之前就看到的事实。
  if (peer && !peer.canEncrypt) {
    notes.push("目标机版本过旧、收不了加密载荷,这次会明文传输(同网段抓包能读到仓库和会话历史)");
  } else if (peer && !peer.encrypted) {
    notes.push("本机在「设置 → 默认规则 → 接力传输加密」里关掉了加密,这次会明文传输");
  }
  // 待发送消息与定时计划的盘点(对话框如实列出要随任务走的东西)。按 taskId 查而不是
  // tasks.scheduleId——路由与调度器都以 taskId 为准,scheduleId 只是反向缓存。
  const pendingMsgs = await db.select().from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "pending")));
  const scheduleRow = (await db.select().from(schedules).where(eq(schedules.taskId, taskId))).at(0);
  // 上传附件盘点:正文/续跑提示/提问/待发送消息 + run 产物文本就够了(回复回合的附件
  // 路径必然出现在任务 transcript 里);会话 JSONL 留给真正导出时全量扫。
  const uploadTexts = [
    task.body, task.resumePrompt ?? "", task.question ?? "",
    ...pendingMsgs.flatMap((x) => [x.text, x.attachments]),
  ];
  const runRoot = join(RUNS_DIR, taskId);
  if (existsSync(runRoot)) {
    const walkTexts = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) { await walkTexts(abs); continue; }
        if (!entry.isFile() || !isTextRel(entry.name) || statSync(abs).size > MAX_FILE_BYTES) continue;
        uploadTexts.push(await readFile(abs, "utf8"));
      }
    };
    await walkTexts(runRoot);
  }
  const uploads = await collectUploads(uploadTexts, notes, true);
  return {
    ok: true,
    target: { url: targetUrl, host: ping.host },
    peer,
    projects: ping.projects,
    suggestedProjectId: suggested?.id ?? null,
    local: {
      status: task.status,
      running: task.status === "running" || task.status === "queued",
      sessions: withCli.length,
      sessionFilesFound: found.size,
      uploads: uploads.length,
      pendingMessages: pendingMsgs.length,
      schedule: (scheduleRow?.kind as "once" | "cron" | undefined) ?? null,
      git: gitReady ? "bundle" : "none",
      notes,
    },
  };
}

export async function exportHandoff(
  taskId: string,
  opts: { targetUrl: string; targetProjectId: string; targetName?: string; autoResume?: boolean },
): Promise<HandoffExportResult> {
  const targetUrl = normalizePeerUrl(opts.targetUrl);
  const loaded = await loadSingleTask(taskId);
  const project = loaded.project;
  let task = loaded.task;
  // 上一次接力留下的标记:已确认送达(非 pending)= 别重复接力;pending = 上次应答
  // 丢了,这次是重试收口——沿用同一个 transferId,对端据此把「已有同 id 任务」识别成
  // 同一次接力,幂等返回成功而不是 409。
  const prevHandoffRaw = task.handoff;
  const prevMarker = parsedHandoff(prevHandoffRaw);
  const returnFingerprint = inboundReturnFingerprint(prevHandoffRaw);
  if (returnFingerprint === null) {
    throw new HandoffError("这份接入任务缺少来源机器指纹，无法确认该移回哪台机器；请先升级来源机并重新接力", 409);
  }
  if (prevMarker?.direction === "out" && !prevMarker.pending) {
    throw new HandoffError("任务已经接力出去了,别重复接力（对端已有一份同 id 任务）", 409);
  }
  const pendingRetry = prevMarker?.direction === "out" && prevMarker.pending ? prevMarker : null;
  // 收口重试只能**原样重放**:transferId 是幂等身份,换目标机/项目等于拿同一张身份证
  // 往第二台机器投递——两边各自导入成功,同一任务被复制成多份(审查实测)。目标参数
  // 一律以 pending 标记冻结的第一次为准;确要换目标,先在横幅上移除接力标记(终止这次
  // transfer),再发起全新接力(新 transferId)。
  if (pendingRetry) {
    if (pendingRetry.peerUrl && pendingRetry.peerUrl !== targetUrl) {
      throw new HandoffError(
        `上次接力发往「${pendingRetry.peerName ?? pendingRetry.peerUrl}」(${pendingRetry.peerUrl})还没确认送达,收口重试必须发往同一台机器。确认对端没收到、要换目标,先在任务横幅上移除接力标记,再发起全新接力。`,
        409,
      );
    }
    // 老版本 pending 标记没有冻结字段,只能拦到机器级;新标记连项目一起锁。
    if (pendingRetry.targetProjectId && pendingRetry.targetProjectId !== opts.targetProjectId) {
      throw new HandoffError(
        "上次接力还没确认送达,收口重试必须发往对端同一个项目(参数已按第一次发送冻结)。要换项目,先在任务横幅上移除接力标记,再发起全新接力。",
        409,
      );
    }
  }
  const transferId = pendingRetry?.transferId || id();
  // autoResume 同样冻结:重试时对端可能早已导入过(幂等分支零副作用),本次重新勾选
  // 并不会让对端多做任何事——manifest 按第一次的值重放,返回值以对端实际应答为准。
  const autoResume = pendingRetry && pendingRetry.autoResume !== undefined
    ? pendingRetry.autoResume
    : opts.autoResume ?? true;
  // 接力准备 barrier:从这里到导出收尾,「任务不在队列」必须保持成立——上面那次队列
  // 检查是一次性的,后面 ping/import 的网络等待里并发 queue insert 可以完整绕过它
  // (第 2 轮审查用延迟代理实测;TOCTOU 与「为什么用进程内存」见 handoff-guard.ts
  // 顶部注释)。queues.ts 的 insert/create 在改成员前检查同一 barrier。
  if (!beginHandoffPrepare(taskId)) {
    throw new HandoffError("这个任务已有一次接力正在进行,等它结束或失败后再发起", 409);
  }
  try {
    // 拿到 barrier 后复查队列成员:loadSingleTask 那次检查到这里隔着若干 await,可能已过期。
    await assertNotQueueMember(taskId);
    // 先探测对端与目标项目,确认可行再停任务——反过来会白停一个正在跑的任务。
    // pingPeer 同时做身份核对:指纹和上次记住的对不上就在这里抛,bundle 一个字节都不打。
    const expectedFingerprint = returnFingerprint ?? await rememberedFingerprint(targetUrl);
    const { ping, peer, sealTo } = await pingPeer(targetUrl, expectedFingerprint);
    assertPeerAcceptsUs(peer);
    const targetProject = ping.projects.find((p) => p.id === opts.targetProjectId);
    if (!targetProject) throw new HandoffError("对端没有这个项目 id,先重新预检", 409);

    task = await stopAndSettle(taskId);
    // 占住回合:导出期间队列/调度器不能再把它拉起来;占不到 = 有回合在收尾,让用户重试。
    if (!claimTurn(taskId, "handoff")) throw new HandoffError("任务回合还在收尾,稍等几秒再试", 409);
    try {
      const notes: string[] = [];
      const rows = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      // 待发送消息(只带 pending)与定时计划随任务走:接力守卫拦续跑、调度器跳过已接力
      // 任务,它们留在源机就永远不会兑现——不迁移等于静默丢掉用户已提交的东西(第 2 轮
      // 审查实测)。回合已占住,投递侧赢不了 markSent 需要的回合,这批行不会边导边发。
      const pendingMsgs = (await db.select().from(scheduledMessages)
        .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "pending"))))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const scheduleRow = (await db.select().from(schedules).where(eq(schedules.taskId, taskId))).at(0);
      const sourceWorkspace = rows.at(-1)?.cwd
        ?? (task.useWorktree ? worktreePathFor(project.repoPath, taskId) : expandHome(project.repoPath));

      let gitState: HandoffManifest["git"] = null;
      if (targetProject.isRepo) {
        const refs = await fetchPeer<{ refs: { name: string; commit: string }[] }>(
          `${targetUrl}/api/handoff/projects/${targetProject.id}/refs`,
        );
        gitState = await packGitState(task, project.repoPath, refs.refs ?? [], notes);
      } else {
        notes.push("对端项目不是 git 仓库,代码不随任务迁移");
      }

      const { files: sessionFiles, found, notes: sessNotes } = await collectSessionFiles(rows, sourceWorkspace, false);
      notes.push(...sessNotes);
      const artifacts = await collectRunArtifacts(taskId, notes);

      // 任务文本和文本类载荷(会话 JSONL/产物)里引用的上传附件一并打包——不带走的话,
      // 对端 agent 照着 prompt 里的源机绝对路径 Read 只会得到「文件不存在」。
      const uploads = await collectUploads(
        [
          task.body, task.resumePrompt ?? "", task.question ?? "",
          task.questionOptions ?? "", task.questionItems ?? "",
          ...pendingMsgs.flatMap((x) => [x.text, x.attachments]),
          ...[...sessionFiles, ...artifacts]
            .filter((f) => isTextRel(f.rel))
            .map((f) => Buffer.from(f.dataBase64, "base64").toString("utf8")),
        ],
        notes,
        false,
      );

      const manifest: HandoffManifest = {
        version: 1,
        sourceHost: hostname(),
        sourceFingerprint: localIdentity().fingerprint,
        targetProjectId: targetProject.id,
        transferId,
        autoResume,
        sourceWorkspace,
        task: {
          id: task.id, title: task.title, body: task.body,
          status: task.status, stage: task.stage, labels: task.labels,
          agentType: task.agentType, model: task.model, reasoningEffort: task.reasoningEffort,
          autoTitle: task.autoTitle, useWorktree: task.useWorktree, worktreeBase: task.worktreeBase,
          workflow: task.workflow, workflowMode: task.workflowMode, workflowAt: task.workflowAt,
          reviewStep: task.reviewStep, verifyRounds: task.verifyRounds, verifyStationRounds: task.verifyStationRounds,
          resumePrompt: task.resumePrompt, question: task.question,
          questionOptions: task.questionOptions, questionItems: task.questionItems,
          pinnedAt: task.pinnedAt, starredAt: task.starredAt,
          createdAt: task.createdAt, startedAt: task.startedAt, endedAt: task.endedAt,
        },
        sessions: rows.map((s) => ({
          id: s.id, role: s.role, agentType: s.agentType, executor: s.executor,
          turnModel: s.turnModel, turnReasoningEffort: s.turnReasoningEffort,
          worktreePath: s.worktreePath, branch: s.branch, cwd: s.cwd,
          cliSessionId: found.has(s.id) ? s.cliSessionId : null,
          commandLine: s.commandLine, startedAt: s.startedAt, endedAt: s.endedAt,
          exitStatus: s.exitStatus, stoppedAs: s.stoppedAs, sideTurn: s.sideTurn,
          activeMs: s.activeMs, turnStartedAt: s.turnStartedAt,
          usageInput: s.usageInput, usageOutput: s.usageOutput,
          usageCacheRead: s.usageCacheRead, usageCacheWrite: s.usageCacheWrite,
          usageReasoning: s.usageReasoning, usageCostUsd: s.usageCostUsd, usageTurns: s.usageTurns,
          contextUsed: s.contextUsed, contextWindow: s.contextWindow,
          contextWindowEstimated: s.contextWindowEstimated,
        })),
        git: gitState,
        uploads,
        messages: pendingMsgs.map((x) => ({
          text: x.text, attachments: x.attachments, agent: x.agent, model: x.model,
          reasoningEffort: x.reasoningEffort, sessionRole: x.sessionRole,
          mode: x.mode, sendAt: x.sendAt, createdAt: x.createdAt,
        })),
        schedule: scheduleRow
          ? {
              kind: scheduleRow.kind, at: scheduleRow.at, cron: scheduleRow.cron,
              enabled: scheduleRow.enabled, lastRunAt: scheduleRow.lastRunAt,
            }
          : null,
        files: [...sessionFiles, ...artifacts],
      };

      // POST 出去的那一刻起对端就可能已经收下这份任务——应答丢了/源进程死在半路都不能
      // 让本机毫无痕迹(否则重试撞对端 409、本机任务还能再跑,正是双机分叉)。所以**先**
      // 落一个「接力未确认」的 pending 标记(它同样触发 handoff-guard 的启动硬拦),成功
      // 后改写成确认态;只有对端**明确应答失败**(没收下)才回滚到接力前的样子。
      // 冻结这批消息 id:收口成功后只取消**第一次发送时带走的**那批。重试轮次里不能按
      // 当前 pending 重算——pending 期间新建的消息没有随幂等重放迁移到对端,按当前全量
      // 取消就是静默丢消息。中间某次重试若真的落成了全新导入(第一次根本没送到),对端
      // 实际收下的是那一次的清单,这里可能少取消几条——留在托盘里如实提醒,方向安全。
      const frozenMessageIds = pendingRetry
        ? (pendingRetry.messageIds ?? [])
        : pendingMsgs.map((x) => x.id);
      const pendingMarker: TaskHandoff = {
        direction: "out",
        pending: true,
        transferId,
        // 冻结本次目标项目与 autoResume:收口重试必须原样重放(见上方 pendingRetry 校验)。
        targetProjectId: targetProject.id,
        autoResume,
        ...(frozenMessageIds.length ? { messageIds: frozenMessageIds } : {}),
        peerUrl: targetUrl,
        peerName: opts.targetName ?? ping.host,
        peerFp: peer?.fingerprint ?? null,
        peerTaskId: taskId,
        at: now(),
        sessions: found.size,
        git: gitState ? "bundle" : "none",
      };
      await db.update(tasks)
        .set({ handoff: JSON.stringify(pendingMarker), updatedAt: now() })
        .where(eq(tasks.id, taskId));
      await publishTaskUpdated(taskId);

      let result: { ok: boolean; taskId: string; autoResume?: boolean; idempotent?: boolean; notes?: string[]; error?: string };
      try {
        result = await fetchPeer<{ ok: boolean; taskId: string; autoResume?: boolean; idempotent?: boolean; notes?: string[]; error?: string }>(
          `${targetUrl}/api/handoff/import`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(manifest),
            // 非 null 时载荷封给对端公钥再上路(handoff-crypto.ts)。签名照旧覆盖线上
            // 那串字节,所以加不加密对幂等收口和错误语义都没有影响。
            sealTo,
            timeoutMs: 600_000,
          },
        );
        // 2xx 但 ok:false:真 ash 的导入端点从不这样应答(要么 ok:true 要么抛错),
        // 多半是中间层拼的怪应答——同样按「送达未知」处理,保留 pending。
        if (!result.ok) throw new HandoffError(`对端导入失败：${result.error ?? "未知错误"}`, 502, true);
      } catch (e) {
        if (e instanceof HandoffError && e.network) {
          // 送没送到说不清:保留 pending 标记,把收口方法一并告诉用户。
          e.message += "。对端可能已经收到这份任务:本机保留「接力未确认」标记,原样重试会自动幂等收口;确认对端没收到的话,在任务横幅上移除接力标记即可在本机继续。";
          throw e;
        }
        // 带 ash 标记的业务拒绝(对端可证明没落库):恢复接力前的标记,本机照常可跑。
        await db.update(tasks)
          .set({ handoff: prevHandoffRaw, updatedAt: now() })
          .where(eq(tasks.id, taskId));
        await publishTaskUpdated(taskId);
        throw e;
      }
      notes.push(...(result.notes ?? []));

      // 确认送达:把 pending 标记改写成持久可见的「已接力」标记 + 时间线一条系统说明。
      const marker: TaskHandoff = {
        direction: "out",
        transferId,
        targetProjectId: targetProject.id,
        peerUrl: targetUrl,
        peerName: opts.targetName ?? ping.host,
        peerFp: peer?.fingerprint ?? null,
        peerTaskId: result.taskId,
        at: now(),
        sessions: found.size,
        git: gitState ? "bundle" : "none",
      };
      await db.update(tasks)
        .set({ handoff: JSON.stringify(marker), updatedAt: now() })
        .where(eq(tasks.id, taskId));
      // TOFU 落地:接力真的成功了才把对端指纹记进设置(首次配对)。放在成功之后,
      // 「点开对话框看一眼就退出」才不会静默改掉信任状态。记住之后,这个地址下次
      // 换了机器就会被 pingPeer 当场拦住。
      if (peer?.trust === "first-seen") {
        await rememberPeerFingerprint(targetUrl, peer.fingerprint)
          .catch(() => notes.push("对端身份没能记进设置(接力本身已成功),下次仍按首次配对处理"));
        notes.push(`已记住目标机身份指纹 ${peer.short};以后这个地址换了机器,接力会当场拦下`);
      }
      const latest = rows.at(-1);
      if (latest) {
        const line = {
          t: "system" as const, agent: latest.agentType, by: "system" as const, at: now(),
          text: `🔁 任务已接力到 ${marker.peerName}（${targetUrl}）继续执行,本机这份从此只是历史存档。`,
        };
        await appendFile(sessionTranscriptPath(taskId, latest.id), `\n${TURN_SENTINEL}${JSON.stringify(line)}\n`)
          .catch(() => { /* 产物目录可能不存在（从未跑过）,标记列已落库,不阻塞 */ });
      }
      // 源机原件收尾:已随任务迁走的待发送消息取消掉(时间线留档),否则用户移除接力
      // 标记后同一条消息会在两台机器各投一次。幂等收口只取消冻结的那批(见上);对端
      // 全新导入时收下的就是本次清单,按本次全量取消。
      const migratedIds = new Set(result.idempotent ? frozenMessageIds : pendingMsgs.map((x) => x.id));
      let msgsLeft = 0;
      for (const msg of pendingMsgs) {
        if (migratedIds.has(msg.id)) await cancelPendingMessage(msg, `已随任务接力到 ${marker.peerName ?? targetUrl}`);
        else msgsLeft += 1;
      }
      if (msgsLeft) {
        notes.push(`${msgsLeft} 条待发送消息是接力未确认期间新建的,没有随幂等收口迁移,仍留在本机托盘;需要对端执行的话,到对端重新发送,再取消本机这份`);
      }
      if (pendingMsgs.length > msgsLeft) notes.push(`迁移待发送消息 ${pendingMsgs.length - msgsLeft} 条,本机原件已取消并留档在时间线`);
      if (scheduleRow) notes.push("定时计划已随任务迁移,今后由对端触发;本机这份在接力标记存在期间不会触发");
      await publishTaskUpdated(taskId);

      return {
        ok: true,
        remoteTaskId: result.taskId,
        remoteUrl: `${targetUrl}/?${new URLSearchParams({ project: targetProject.id, task: result.taskId })}`,
        sessionsMigrated: found.size,
        git: gitState ? "bundle" : "none",
        // 以对端实际应答为准:重试撞上幂等分支时对端并没有续跑,不能按本次请求参数谎报。
        autoResume: result.autoResume ?? autoResume,
        notes,
      };
    } finally {
      releaseTurn(taskId);
    }
  } finally {
    endHandoffPrepare(taskId);
  }
}
