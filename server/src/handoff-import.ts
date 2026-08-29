// 任务接力——导入侧。协议与导出逻辑见 handoff.ts 顶部注释。
//
// 这里的职责:把对端 POST 过来的 manifest 落成本机的一个完整任务——git 分支 fetch
// 进本地仓库、prepareWorktree 恢复档搭回工作目录、tasks/sessions 行落库、CLI 会话
// 文件放到本机 CLI 期望的位置、runs 产物归位,最后(可选)立刻续跑。
// 失败要么整体 4xx/5xx(什么都没建),要么建成但带 notes 说明哪些东西退化了;
// 不留半截任务。
//
// 这个文件只留**编排**。三块具体活计各自成文件:
//   - handoff-import-payload.ts:manifest 校验、git bundle 进仓库、会话/产物写盘
//     (「不信任对端」的那一层)
//   - handoff-import-free-workflow.ts:审查历史翻译成本机行(机器本地外键重新解析)
//   - handoff-uploads.ts:上传附件本体与各处文本里的路径改写
import { and, eq, inArray } from "drizzle-orm";
import { existsSync } from "node:fs";
import { db } from "./db/index.js";
import {
  freeReviewRounds, freeReviewRuns, freeWorkflowEvents, freeWorkflowStates,
  projects, scheduledMessages, schedules, sessions, tasks,
} from "./db/schema.js";
import { HandoffError, type HandoffManifest } from "./handoff-types.js";
import { applyUploadRewrites, buildUploadRewrites, hasUploadRewrites, writeUploads } from "./handoff-uploads.js";
import { localUploadNames, registerUploads } from "./uploads.js";
import { ensureWorkdir, expandHome, prepareWorktree, projectHealthLight, worktreePathFor } from "./git.js";
import { findRollout } from "./executors/codex-rollout.js";
import { assertHandoffNotCanceled, beginHandoffImport, endHandoffImport } from "./handoff-transfer-state.js";
import { publishPendingMessages } from "./pending-messages.js";
import { createTasks, publishTaskUpdated } from "./task-store.js";
import { resumeOrRunTask } from "./task-resume.js";
import { localIdentity } from "./handoff-identity.js";
import { buildFreeWorkflowRows } from "./handoff-import-free-workflow.js";
// 校验 / git bundle / 文件写盘这三件事在载荷落地层(不信任对端的那一层)。
import {
  importGitBundle, jsonOr, SETTLED, validate, writePayloadFiles, type CliConfigDirs,
} from "./handoff-import-payload.js";
import { claudeSessionFilePath } from "./handoff-collect.js";
import { cliConfigDirForOwner } from "./auth/run-env.js";
import { discardMigratedWorkspace } from "./workspace-cleanup.js";
import { id, now } from "./util.js";
import type { TaskHandoff } from "@ash/shared";

export interface HandoffImportResult {
  ok: true;
  taskId: string;
  workspace: string | null;
  sessionsMigrated: number;
  autoResume: boolean;
  // true = 本机已有这次接力导入的任务,本次是应答丢失后的幂等收口(零副作用)。
  // 源机据此决定取消哪批待发送消息原件:幂等收口只对应第一次带走的那批。
  idempotent?: boolean;
  // 代码到底落没落到本机:"bundle" = 分支和 worktree 都恢复好了,"none" = 没有 git
  // 载荷,或本机按非 worktree 任务导入(那条路根本不 fetch 分支)。源机靠这一句证明
  // 「确实全量传完了」,才敢删掉自己那份 worktree 和分支;老版本对端不报这个字段,
  // 源机据此保守地什么都不删。
  git?: "bundle" | "none";
  notes: string[];
}

export async function importHandoff(
  input: unknown,
  // `ownerUserId`:落地任务归**对端那个人**(§八 三条继承规则之三、§十一)。
  // 自用模式恒 null,与本功能上线前一致。
  context: { sourceUrl?: string | null; ownerUserId?: string | null } = {},
): Promise<HandoffImportResult> {
  const m = validate(input);
  if (!beginHandoffImport(m.task.id)) {
    throw new HandoffError("这个任务的另一次导入还在本机进行中,等它落定后再原样重试", 409);
  }
  try {
    assertHandoffNotCanceled(m.task.id, m.transferId, m.sourceFingerprint);
    return await importValidated(m, context);
  } finally {
    endHandoffImport(m.task.id);
  }
}

async function importValidated(
  m: HandoffManifest,
  context: { sourceUrl?: string | null; ownerUserId?: string | null },
): Promise<HandoffImportResult> {
  const notes: string[] = [];
  const project = (await db.select().from(projects).where(eq(projects.id, m.targetProjectId))).at(0);
  if (!project) throw new HandoffError("目标项目不存在(对端项目清单可能过期,重新预检)", 404);
  const existing = (await db.select().from(tasks).where(eq(tasks.id, m.task.id))).at(0);
  let existingMarker: TaskHandoff | null = null;
  let returning = false;
  if (existing) {
    // 应答丢失后的原样重试:同一个 transferId 说明就是同一次接力,按成功收口、零副作用,
    // 让源机把 pending 标记改写成「已接力」。没有 transferId(老版本)或对不上才是真冲突。
    if (existing.handoff) {
      try { existingMarker = JSON.parse(existing.handoff) as TaskHandoff; } catch { existingMarker = null; }
    }
    if ((existingMarker?.direction === "in" || existingMarker?.direction === "returned")
      && m.transferId && existingMarker.transferId === m.transferId) {
      return {
        ok: true,
        taskId: m.task.id,
        workspace: null,
        sessionsMigrated: existingMarker.sessions,
        // 收口应答报的是**这次接力当初导入时的事实**(存在 in 标记里),不是本次重放
        // 有没有再触发续跑(幂等收口零副作用,从不重复起跑)。老标记没存这个字段时
        // 按 false 报——宁可让源机以为没续跑,也不能谎报「已在对端跑起来了」。
        autoResume: existingMarker.autoResume ?? false,
        idempotent: true,
        // 收口应答同样报当初导入的事实:那一次代码真落了地,源机就可以放心收尾。
        git: existingMarker.git === "bundle" ? "bundle" : "none",
        notes: ["本机已有这次接力导入的任务(应答曾丢失,本次为幂等收口),未重复导入"],
      };
    }
    // 安全移回：本机这行必须正是之前交给当前来源机器的确认态存档。两边指纹一致才
    // 允许用返回的完整任务覆盖它；第三台机器拿同 id 来仍按冲突拒绝。
    returning = existingMarker?.direction === "out" && !existingMarker.pending && Boolean(existingMarker.peerFp)
      && existingMarker.peerFp === m.sourceFingerprint;
    if (!returning) {
      throw new HandoffError("本机已有同 id 任务，且不是从原接力目标安全移回。请在当前持有任务的机器上选择“移回”。", 409);
    }
  }
  // 优先信本机历史标记里的原机指纹；旧标记没有时，才接受签名 manifest 携带的值。
  // returning 只表示“可安全覆盖旧存档”，并不等于回到原机：第二次 A→B 时 B 也有 out 存档。
  const originFingerprint = existingMarker?.originFp ?? m.originFingerprint ?? null;
  // returned 必须由本机已有的 out 存档佐证。普通 import 的新任务只能信任来源机已获批准，
  // 不能再信它自报的 originFingerprint 来伪造“已移回本机”的展示与来源锁解除状态。
  const returnedHome = returning && originFingerprint === localIdentity().fingerprint;
  // 会话 id 冲突预检:必须在任何副作用之前拦下,否则落库落到一半 UNIQUE 炸掉,
  // 留下没有会话的半截任务(审查实测:import 500 后 GET 200、重试永远 409)。
  if (m.sessions.length) {
    const conflicts = await db
      .select({ id: sessions.id, taskId: sessions.taskId })
      .from(sessions)
      .where(inArray(sessions.id, m.sessions.map((s) => s.id)));
    const foreignConflicts = returning ? conflicts.filter((row) => row.taskId !== m.task.id) : conflicts;
    if (foreignConflicts.length) {
      throw new HandoffError(
        `会话 id 与本机其它任务冲突(${foreignConflicts.map((c) => c.id).join(", ")}),什么都没导入。`,
        409,
      );
    }
  }

  const isRepo = projectHealthLight(project.repoPath).isRepo;
  // useWorktree 依赖本机项目真的是 git 仓库;不是就退化成共享目录,如实记 notes。
  const useWorktree = m.task.useWorktree && isRepo;
  if (m.task.useWorktree && !isRepo) notes.push("本机项目不是 git 仓库,任务退化为共享目录运行,代码状态未迁移");

  // ── git:先分支进仓库,再恢复 worktree ────────────────────────────────────
  let workspace: string | null = null;
  if (useWorktree && m.git) {
    await importGitBundle(project.repoPath, m.task.id, m.git, notes);
    const ws = await prepareWorktree(project.repoPath, m.task.id, m.task.worktreeBase);
    workspace = ws.path;
    if (ws.branch !== m.git.branch) {
      // 源机的分支被手动改过名:fetch 进来的分支还在,但 worktree 挂的是标准名。
      notes.push(`源分支名 ${m.git.branch} 与本机 worktree 分支 ${ws.branch} 不一致,导入的提交在 ${m.git.branch} 上,必要时手动合一下`);
    }
    if (ws.fresh) {
      notes.push("worktree 是全新建的(没接上导入分支),代码进度可能没挂上——检查一下分支");
    }
  } else if (useWorktree) {
    // 没有 git 载荷(源机 worktree 没建过/detached):worktree 留给首次运行时惰性创建。
    workspace = worktreePathFor(project.repoPath, m.task.id);
  } else {
    workspace = ensureWorkdir(project.repoPath, m.task.id);
  }

  // ── 上传附件先落盘,算好路径改写对 ──────────────────────────────────────
  // 附件写盘 → 生成「源机旧路径→本机新路径」改写对(原始/JSON 转义两种形态)→ 改写
  // 任务文本字段和后面的文本类文件载荷。必须在拼 resumePrompt 前言**之前**改:前言
  // 会把 m.task.body 原文嵌进去。写盘失败的附件不进改写对,旧路径原样留着。
  const incomingUploads = m.uploads ?? [];
  const writtenUploads = await writeUploads(
    incomingUploads,
    notes,
    // 撞上本机既有文件/登记行的名字要避让;只有登记行本来就挂在**这条任务**上的那些
    // 才复用本机那一份(handoff-uploads.ts)。
    await localUploadNames(incomingUploads.map((u) => u.name), m.task.id),
  );
  // 落地的附件归这条被接过来的任务(uploads.ts):不登记的话它们在多人模式下是
  // 「无主资产」,只有实例管理员打得开 —— 接力过来的会话里那些图就全打不开了。
  // 这里是**登记**而不是绑定:字节就是上面这一句刚写下的,所以有资格建登记行 ——
  // bindUploadsToTask 只改已有的行,它挡的是「引用一个没登记的文件就算认领」。
  // 只登记 fresh 的那些:撞名复用的那份是本机原主的东西,归属一动不动。
  await registerUploads(writtenUploads.filter((u) => u.fresh).map((u) => u.name), { taskId: m.task.id });
  const rewrites = buildUploadRewrites(writtenUploads);
  const messages = m.messages ?? [];
  if (hasUploadRewrites(rewrites)) {
    const rwPlain = (s: string | null): string | null => (s == null ? null : applyUploadRewrites(s, rewrites, "plain"));
    const rwJson = (s: string | null): string | null => (s == null ? null : applyUploadRewrites(s, rewrites, "json"));
    m.task.body = applyUploadRewrites(m.task.body, rewrites, "plain");
    m.task.resumePrompt = rwPlain(m.task.resumePrompt);
    m.task.question = rwPlain(m.task.question);
    // questionOptions/questionItems 列本身是 JSON 文档,路径在其中以转义形态出现。
    m.task.questionOptions = rwJson(m.task.questionOptions);
    m.task.questionItems = rwJson(m.task.questionItems);
    // 待发送消息:正文是纯文本,attachments 列是 JSON string[](路径以转义形态出现)。
    for (const msg of messages) {
      msg.text = applyUploadRewrites(msg.text, rewrites, "plain");
      msg.attachments = applyUploadRewrites(msg.attachments, rewrites, "json");
    }
    notes.push(`迁移上传附件 ${writtenUploads.length} 个,文本里的源机路径已改写为本机路径`);
  }

  // ── 定时计划 ────────────────────────────────────────────────────────────
  // 普通首次导入仍在任务行之前清孤儿并落计划；安全移回要和“替换历史存档”放进同一个
  // 事务，失败时原任务/会话/计划完整回滚，不能为了移回先把本机存档拆掉。
  const scheduleId = m.schedule ? id() : null;
  const scheduleValues = m.schedule && scheduleId ? {
    id: scheduleId,
    taskId: m.task.id,
    kind: m.schedule.kind,
    at: m.schedule.at ?? null,
    cron: m.schedule.cron ?? null,
    enabled: m.schedule.enabled !== false,
    lastRunAt: m.schedule.lastRunAt ?? null,
    createdAt: now(),
  } : null;
  if (!returning) {
    await db.delete(schedules).where(eq(schedules.taskId, m.task.id));
    await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, m.task.id));
    if (scheduleValues) await db.insert(schedules).values(scheduleValues);
  }
  if (m.schedule) notes.push(`迁移定时计划(${m.schedule.kind === "cron" ? "周期" : "一次性"}),今后由本机触发`);

  // ── 文件先落盘,再落库 ──────────────────────────────────────────────────
  // 顺序有讲究:文件写一半崩了只留下无害的磁盘残留(重试会原样覆盖);反过来先落库
  // 再写文件,「任务行在、文件没到」就是半截任务。arrived 是真正写盘成功的会话文件名。
  //
  // 落进哪个 CLI 配置目录按**落地任务的归属人**算,不是宿主机的 `~/.claude`:多用户
  // 模式下起跑会注入 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`,写错地方等于没搬(见下面那道闸)。
  const importCwd = workspace ?? expandHome(project.repoPath);
  const cliDirs: CliConfigDirs = {
    claude: await cliConfigDirForOwner(context.ownerUserId, "claude"),
    codex: await cliConfigDirForOwner(context.ownerUserId, "codex"),
  };
  const arrived = await writePayloadFiles(m.files, m.task.id, importCwd, rewrites, notes, cliDirs);

  // ── cliSessionId 只认「文件写盘成功、且 CLI 自己找得到」的会话 ────────────
  // claude 的文件名是 `<cliSessionId>.jsonl`,codex 是 `rollout-<ts>-<threadId>.jsonl`。
  // 两种都还要再问一次「CLI 站在它自己的配置目录里看得见吗」:文件在盘上但 CLI 定位不到
  // 时保留 cliSessionId 就是假恢复,续跑只会换来一句「找不到会话/线程」然后整回合空转。
  // codex 是目录深度(它只按 sessions/YYYY/MM/DD 扫描),claude 是配置目录本身。
  const hasFile = (s: HandoffManifest["sessions"][number]): boolean =>
    !!s.cliSessionId && [...arrived].some(
      (name) => name === `${s.cliSessionId}.jsonl` || name.endsWith(`-${s.cliSessionId}.jsonl`),
    );
  const usable = new Map<string, boolean>();
  for (const s of m.sessions) {
    let ok = hasFile(s);
    if (ok && s.agentType === "codex") {
      ok = !!(await findRollout(s.cliSessionId!, cliDirs.codex));
      if (!ok) notes.push(`codex 会话 ${s.id} 的 rollout 已写盘但无法按标准目录定位,按未迁移处理`);
    }
    if (ok && s.agentType === "claude") {
      ok = existsSync(claudeSessionFilePath(importCwd, s.cliSessionId!, cliDirs.claude));
      if (!ok) notes.push(`claude 会话 ${s.id} 已写盘但不在本机 CLI 的配置目录下,按未迁移处理`);
    }
    usable.set(s.id, ok);
  }
  const migrated = m.sessions.filter((s) => usable.get(s.id));

  // ── 接力前言:告诉续跑的 agent 它被搬过机器了 ─────────────────────────
  // 这段话**不写进 resume_prompt**——那一列是「任务正等续跑指令」的门禁,写了会让刚
  // 接过来的任务一进门就把派审/预约/修复/预览整排按钮判成禁用(用户 2026-08-27:接力
  // 任务除了横幅标记外和普通任务没有区别)。改挂在 handoff 标记的 notice 上,由
  // orchestrator 在下一回合注入一次,见 handoff-notice.ts。
  const agentType = m.task.agentType ?? "claude";
  const latest = [...m.sessions]
    .filter((s) => s.agentType === agentType)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
  const resumable = !!latest && !!usable.get(latest.id);
  const noticeLines = [
    `【任务接力】本任务从另一台机器(${m.sourceHost})接力到本机继续。`,
    m.git ? "git 分支和已提交的改动已随任务迁移。" : "代码没有随任务迁移,以本机仓库当前状态为准。",
    `工作目录从 ${m.sourceWorkspace ?? "(未知)"} 变为 ${workspace},历史对话里引用的旧绝对路径一律以新目录为准。`,
    "先快速核对工作目录(git log/status、关键文件是否符合预期),再继续完成任务目标。",
  ];
  // 源机留下的 checkpoint 指令原样带走,不再被前言裹一层。
  let resumePrompt = m.task.resumePrompt;
  if (m.sessions.length > 0 && !resumable) {
    notes.push("CLI 会话历史未迁移,续跑将开全新会话");
    noticeLines.push("注意:CLI 会话历史没有随任务迁移,这是一个全新会话。");
    // 挂着 checkpoint 指令时续跑走 continueTask 而不是 runTask,那条路的 prompt 里
    // **不含任务正文**——会话历史又没到货,不自带就等于让 agent 空手上阵。
    if (resumePrompt) {
      resumePrompt = `任务目标全文如下:\n\n${m.task.body}\n\n上次暂停时留下的续跑提示:\n${resumePrompt}`;
    }
  }
  const handoffNotice = noticeLines.join("");

  const marker: TaskHandoff = {
    // 覆盖旧 out 存档不一定是回家：任务再次交给曾持有机器时也会命中 returning。
    // 只有接收机就是 originFp 对应的原机才解除来源锁；否则仍是 in，只能移回原机。
    direction: returnedHome ? "returned" : "in",
    // 源机生成的接力身份证:应答丢失后源机原样重试时,靠它把「已有同 id 任务」识别成
    // 同一次接力并幂等收口(见上面 existing 分支)。
    transferId: m.transferId ?? null,
    // 任务级移回完成后仍保留原 out 存档的 transfer id：如果成功应答在路上丢失，
    // 持有机可以用同一凭据重新探测并让 importHandoff 按 m.transferId 幂等收口。
    ...(m.returnTransferId !== undefined ? { returnTransferId: m.returnTransferId } : {}),
    // 导入时有没有触发自动续跑,存成事实:应答丢失后的幂等收口靠它如实回答源机
    // 「任务在对端跑起来了没有」,而不是一律回 false 误导用户去对端手动再点一次。
    autoResume: m.autoResume,
    peerUrl: context.sourceUrl ?? null,
    peerName: m.sourceHost || null,
    peerFp: m.sourceFingerprint ?? null,
    originFp: originFingerprint,
    peerTaskId: m.task.id,
    at: now(),
    sessions: migrated.length,
    git: useWorktree && m.git ? "bundle" : "none",
    notice: handoffNotice,
  };
  const status = SETTLED.has(m.task.status) ? m.task.status : "canceled";
  const taskValues = {
    projectId: project.id,
    title: m.task.title,
    body: m.task.body,
    status,
    stage: m.task.stage,
    labels: jsonOr(m.task.labels, "[]"),
    agentType: m.task.agentType,
    model: m.task.model,
    reasoningEffort: m.task.reasoningEffort,
    autoTitle: m.task.autoTitle,
    useWorktree,
    worktreeBase: useWorktree ? m.task.worktreeBase : null,
    workflow: jsonOr(m.task.workflow, "") || null,
    workflowMode: (m.task.workflowMode as "free" | "workflow" | undefined) ?? "workflow",
    workflowAt: m.task.workflowAt,
    reviewStep: m.task.reviewStep,
    verifyRounds: m.task.verifyRounds ?? 0,
    verifyStationRounds: m.task.verifyStationRounds ?? 0,
    resumePrompt,
    question: m.task.question,
    questionOptions: jsonOr(m.task.questionOptions, "") || null,
    questionItems: jsonOr(m.task.questionItems, "") || null,
    // 验收落账随任务走(老 manifest 没有这三个字段,按缺失处理)。尾段进度位不带,
    // 理由见 handoff-types.ts。
    acceptedTargetBranch: m.task.acceptedTargetBranch ?? null,
    acceptedBaseCommit: m.task.acceptedBaseCommit ?? null,
    acceptedMergeCommit: m.task.acceptedMergeCommit ?? null,
    pinnedAt: m.task.pinnedAt,
    starredAt: m.task.starredAt,
    createdAt: m.task.createdAt,
    updatedAt: now(),
    startedAt: m.task.startedAt,
    endedAt: m.task.endedAt,
    handoff: JSON.stringify(marker),
    scheduleId,
  };
  const taskRow = {
    id: m.task.id,
    mode: "single" as const,
    executorId: null,
    reportBack: false,
    ...taskValues,
    // 接力导入的任务归对端那个人:之后它在本机重跑、回复,烧的都是他自己的 key。
    ownerUserId: context.ownerUserId ?? null,
  };
  const sessionRows = m.sessions.map((s) => ({
    id: s.id,
    taskId: m.task.id,
    role: s.role,
    agentType: s.agentType,
    executor: s.executor,
    executorId: null,
    executorFingerprint: null,
    turnModel: s.turnModel,
    turnReasoningEffort: s.turnReasoningEffort,
    worktreePath: useWorktree ? workspace : null,
    branch: s.branch,
    cwd: workspace,
    cliSessionId: usable.get(s.id) ? s.cliSessionId : null,
    commandLine: s.commandLine,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    exitStatus: s.exitStatus,
    stoppedAs: s.stoppedAs,
    sideTurn: s.sideTurn ?? false,
    activeMs: s.activeMs,
    turnStartedAt: s.turnStartedAt,
    usageInput: s.usageInput,
    usageOutput: s.usageOutput,
    usageCacheRead: s.usageCacheRead,
    usageCacheWrite: s.usageCacheWrite,
    usageReasoning: s.usageReasoning,
    usageCostUsd: s.usageCostUsd,
    usageTurns: s.usageTurns,
    contextUsed: s.contextUsed,
    contextWindow: s.contextWindow,
    contextWindowEstimated: s.contextWindowEstimated,
  }));
  // 自由工作流的审查历史(翻译成本机行,落库在下面两条路径里各自执行)。
  const freeWorkflowRows = await buildFreeWorkflowRows(m.task.id, m.freeWorkflow, notes);
  const messageRows = messages.map((msg) => ({
    id: id(),
    taskId: m.task.id,
    text: msg.text,
    attachments: jsonOr(msg.attachments, "[]"),
    agent: msg.agent,
    executorId: null,
    model: msg.model,
    reasoningEffort: msg.reasoningEffort,
    sessionRole: msg.sessionRole,
    mode: msg.mode === "queued" ? "queued" as const : "timed" as const,
    sendAt: msg.sendAt,
    status: "pending" as const,
    createdAt: msg.createdAt,
    sentAt: null,
    deliveringSince: null,
  }));

  if (returning) {
    try {
      await db.transaction(async (tx) => {
        // 安全移回只覆盖 manifest 真正携带的任务字段。分组与依赖是**整组一起挪**的东西，
        // 不在单任务协议里（用户 2026-08-27 确认），整行删除再插入会把它们静默清空。
        await tx.update(tasks).set({
          ...taskValues,
          // 执行器 id 只在本机有意义；agent 类型没变才保留原机选择，否则按类型重新解析。
          executorId: existing?.agentType === m.task.agentType ? existing.executorId : null,
        }).where(eq(tasks.id, m.task.id));
        // 会话、计划和 pending 消息确实随 manifest 迁移，只替换这三类；已发送/取消的
        // 本机消息仍是本机历史，不能和未迁移的自由工作流关联一起误删。
        await tx.delete(sessions).where(eq(sessions.taskId, m.task.id));
        await tx.delete(schedules).where(eq(schedules.taskId, m.task.id));
        await tx.delete(scheduledMessages).where(and(
          eq(scheduledMessages.taskId, m.task.id),
          eq(scheduledMessages.status, "pending"),
        ));
        // 审查历史现在也随任务迁移:回来的这份是最新的全量,本机旧存档整体让位。
        // 先删 rounds(外键在 run 上,run 删了就找不着它们了),再删 run/事件/预约。
        const staleRuns = await tx.select({ id: freeReviewRuns.id }).from(freeReviewRuns)
          .where(eq(freeReviewRuns.taskId, m.task.id));
        if (staleRuns.length) {
          await tx.delete(freeReviewRounds).where(inArray(freeReviewRounds.runId, staleRuns.map((r) => r.id)));
        }
        await tx.delete(freeReviewRuns).where(eq(freeReviewRuns.taskId, m.task.id));
        await tx.delete(freeWorkflowEvents).where(eq(freeWorkflowEvents.taskId, m.task.id));
        await tx.delete(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, m.task.id));
        if (freeWorkflowRows.state) await tx.insert(freeWorkflowStates).values(freeWorkflowRows.state);
        if (freeWorkflowRows.runs.length) await tx.insert(freeReviewRuns).values(freeWorkflowRows.runs);
        if (freeWorkflowRows.rounds.length) await tx.insert(freeReviewRounds).values(freeWorkflowRows.rounds);
        if (freeWorkflowRows.events.length) await tx.insert(freeWorkflowEvents).values(freeWorkflowRows.events);
        if (scheduleValues) await tx.insert(schedules).values(scheduleValues);
        if (sessionRows.length) await tx.insert(sessions).values(sessionRows);
        if (messageRows.length) await tx.insert(scheduledMessages).values(messageRows);
      });
      await publishTaskUpdated(m.task.id);
      notes.push(returnedHome
        ? "任务已安全移回原机，本机原历史存档已由返回的最新上下文替换"
        : "任务已接到本机，本机旧存档已由最新上下文替换；这仍是接入任务，只能移回原机");
    } catch (e) {
      throw new HandoffError(
        `移回落库失败，事务已回滚，本机原历史存档仍完整保留。原始错误:${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
        500,
      );
    }
  } else {
  // 任务行真的插进去了才置真:插入本身撞 UNIQUE 时,库里那行是别人(或历史)的,
  // 补偿回滚绝不能按公共 task id 把它删掉。
  let taskRowInserted = false;
  try {
    // sessions 作为 afterInsert 塞进 createTasks:会话插入失败时 task.created 广播还没发,
    // 回滚后前端不会闪过「幽灵任务」;成功时广播出去的任务已带全会话。
    await createTasks([taskRow], async () => {
      // createTasks 先 await 任务行插入、再调 afterInsert——走到这里说明任务行是本次建的。
      taskRowInserted = true;
      if (sessionRows.length) await db.insert(sessions).values(sessionRows);
      if (messageRows.length) {
        // 导入即 pending:sent 只在原话真的进了会话之后才写,源机的 status/sentAt/
        // 投递租约一概不带。id 重新生成——同一批消息可能曾在多台机器间来回接力。
        await db.insert(scheduledMessages).values(messageRows);
      }
      if (freeWorkflowRows.state) await db.insert(freeWorkflowStates).values(freeWorkflowRows.state);
      if (freeWorkflowRows.runs.length) await db.insert(freeReviewRuns).values(freeWorkflowRows.runs);
      if (freeWorkflowRows.rounds.length) await db.insert(freeReviewRounds).values(freeWorkflowRows.rounds);
      if (freeWorkflowRows.events.length) await db.insert(freeWorkflowEvents).values(freeWorkflowRows.events);
    });
  } catch (e) {
    // 补偿回滚:任务行 + 已插入的会话行一起清掉,不留半截任务(审查实测:UNIQUE 炸在
    // 会话插入后,GET 200 但任务残废、重试永远 409)。只清自己建的行——任务行没插成
    // (taskRowInserted=false)说明库里那行属于别的导入,动不得。git 分支/worktree/
    // 已写盘文件的残留无害——重试会原样覆盖。
    let rollbackFailed = false;
    if (taskRowInserted) {
      try {
        if (freeWorkflowRows.rounds.length) {
          await db.delete(freeReviewRounds)
            .where(inArray(freeReviewRounds.runId, [...new Set(freeWorkflowRows.rounds.map((r) => r.runId))]));
        }
        await db.delete(freeReviewRuns).where(eq(freeReviewRuns.taskId, m.task.id));
        await db.delete(freeWorkflowEvents).where(eq(freeWorkflowEvents.taskId, m.task.id));
        await db.delete(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, m.task.id));
        await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, m.task.id));
        await db.delete(sessions).where(eq(sessions.taskId, m.task.id));
        await db.delete(tasks).where(eq(tasks.id, m.task.id));
      } catch { rollbackFailed = true; /* 没有更好的办法,如实上报,让源机保留 pending */ }
    }
    // 本次导入建出来的 worktree/分支也一并收掉:接力宣告失败,本机就不该留下一份
    // 「谁都不认领、源机也不知道」的检出(用户 2026-08-27:没彻底传完的话对方也应该
    // 把建了的删掉,并宣布接力失败)。只在**任务行确实是本次插进去的**时候才动手——
    // taskRowInserted=false 说明库里那行属于别的导入,它的 worktree 动不得。
    if (taskRowInserted && useWorktree) {
      await discardMigratedWorkspace(project.repoPath, m.task.id)
        .catch(() => { /* 清不掉不改变结论:源机照样保留自己那份,重试会原样覆盖 */ });
    }
    // 计划行在任务行之前插的,不管任务行插没插成都要清——留着就是孤儿,重试时上面的
    // 孤儿清扫兜底,但能现在清干净就别指望兜底。
    if (scheduleId) {
      try { await db.delete(schedules).where(eq(schedules.id, scheduleId)); } catch { rollbackFailed = true; }
    }
    const msg = e instanceof Error ? e.message : String(e);
    const err = rollbackFailed
      ? new HandoffError(`导入落库失败,且补偿回滚也失败了——本机可能留有半截任务 ${m.task.id},请先在本机检查/清理再重试。原始错误:${msg.slice(0, 300)}`, 500)
      : new HandoffError(`导入落库失败,已回滚,本机没有留下半截任务,可直接重试。原始错误:${msg.slice(0, 300)}`, 500);
    // 回滚失败 = 不能再向源机保证「本机没落库」,应答不带 ash 标记(见 handoff-routes)。
    err.unsettled = rollbackFailed;
    throw err;
  }
  }

  if (messages.length) {
    notes.push(`迁移待发送消息 ${messages.length} 条,到期后在本机照常投递`);
    publishPendingMessages(m.task.id);
  }

  if (m.autoResume) {
    // 火后不管:失败会照常走任务自己的失败结算,在界面上可见。
    void resumeOrRunTask(m.task.id, { reason: "run" }).catch((e) => {
      console.warn(`[handoff] 接力任务 ${m.task.id} 自动续跑失败:`, e);
    });
    notes.push("已触发自动续跑");
  }

  return {
    ok: true,
    taskId: m.task.id,
    workspace,
    sessionsMigrated: migrated.length,
    autoResume: m.autoResume,
    git: useWorktree && m.git ? "bundle" : "none",
    notes,
  };
}
