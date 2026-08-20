// 任务接力（跨机器 handoff）——导出侧与两端共用的协议/助手。
//
// 场景:下班前把本机还没跑完的任务「接力」到另一台跑着 harness 的机器上继续。
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
// V1 明确不做:鉴权(harness 全系统都没有,终端 API 本身就是一个 shell——只在可信内网
// 用)、team/duet 模式、ssh 执行器会话。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname, homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { readdir, readFile, appendFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, sessions, tasks } from "./db/schema.js";
import { claimTurn, isTurnClaimed, releaseTurn, stopTask } from "./runs.js";
import { setTaskStatus } from "./status.js";
import { expandHome, isGitRepo, worktreePathFor } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { DATA_DIR, RUNS_DIR } from "./paths.js";
import { codexHome, findRollout } from "./executors/codex-rollout.js";
import { sessionTranscriptPath, TURN_SENTINEL } from "./transcript.js";
import { publishTaskUpdated } from "./task-store.js";
import { id, now } from "./util.js";
import type {
  HandoffExportResult, HandoffPreflightResult, TaskHandoff,
} from "@harness/shared";

// 传输协议类型/错误类/尺寸常量在 handoff-types.ts(导出、导入、HTTP 面三处共用)。
import { HandoffError, MAX_BUNDLE_BYTES, MAX_FILE_BYTES, MB } from "./handoff-types.js";
import type { HandoffFilePayload, HandoffManifest, HandoffPingResponse } from "./handoff-types.js";

const exec = promisify(execFile);

// ── 小助手 ──────────────────────────────────────────────────────────────────

/**
 * claude CLI 存会话的项目目录名:cwd 中所有非字母数字字符替换成 `-`。
 * 实测样例:/Users/fjh/code/harness/.worktrees/KJN0ESTe5uBw
 *   → -Users-fjh-code-harness--worktrees-KJN0ESTe5uBw
 * claude 代码里没有公开这个函数,格式一旦变化,后果只是对端找不到会话文件 →
 * 干净退化成全新起跑,不会出错误状态。
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function claudeSessionFilePath(cwd: string, cliSessionId: string): string {
  return join(homedir(), ".claude", "projects", claudeProjectSlug(cwd), `${cliSessionId}.jsonl`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 32 * MB });
  return stdout.trim();
}

export async function repoRefTips(repoPath: string): Promise<{ name: string; commit: string }[]> {
  const repo = expandHome(repoPath);
  const refs: { name: string; commit: string }[] = [];
  try {
    const head = await git(repo, ["rev-parse", "HEAD"]);
    if (head) refs.push({ name: "HEAD", commit: head });
  } catch { /* 空仓库等,忽略 */ }
  try {
    const out = await git(repo, ["for-each-ref", "--format=%(refname:short)\x1f%(objectname)", "refs/heads"]);
    for (const line of out.split("\n").filter(Boolean).slice(0, 200)) {
      const [name, commit] = line.split("\x1f");
      if (name && commit) refs.push({ name, commit });
    }
  } catch { /* 非 git 仓库,返回已有的 */ }
  return refs;
}

async function fetchPeer<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(init?.timeoutMs ?? 15_000) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HandoffError(`连不上对端 harness（${url}）：${msg}`, 502, true);
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new HandoffError(`对端返回 ${res.status}：${body?.error ?? "未知错误"}`, 502);
  }
  if (body === null) {
    // 2xx 但应答体读不出来:对端多半已经处理成功,只是应答在路上断了——按网络类失败
    // 处理(network=true),让调用方按「可能已送达」收口而不是当确认失败。
    throw new HandoffError(`对端应答不完整（${url}）:连接中断或应答不是 JSON`, 502, true);
  }
  return body as T;
}

export function normalizePeerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) throw new HandoffError("目标地址必须以 http(s):// 开头");
  return trimmed.replace(/\/api$/, "");
}

// ── 导出侧 ──────────────────────────────────────────────────────────────────

type TaskRow = typeof tasks.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

async function loadSingleTask(taskId: string): Promise<{ task: TaskRow; project: typeof projects.$inferSelect }> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new HandoffError("任务不存在", 404);
  if (task.mode !== "single") throw new HandoffError("目前只支持单飞任务接力（team/duet 待后续版本）", 409);
  if (task.archived) throw new HandoffError("任务已归档,先取消归档再接力", 409);
  if (task.verifyRound != null) throw new HandoffError("就地验证轮进行中,等它出结论再接力", 409);
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) throw new HandoffError("任务所属项目不存在", 404);
  return { task, project };
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

/** 会话文件盘点:每条会话的文件在哪、能不能搬。dryRun 时不读内容（preflight 用）。 */
async function collectSessionFiles(
  rows: SessionRow[],
  fallbackCwd: string | null,
  dryRun: boolean,
): Promise<{ files: HandoffFilePayload[]; found: Set<string>; notes: string[] }> {
  const files: HandoffFilePayload[] = [];
  const found = new Set<string>();
  const notes: string[] = [];
  for (const s of rows) {
    if (!s.cliSessionId) continue;
    let abs: string | null = null;
    let rel = "";
    let kind: HandoffFilePayload["kind"];
    if (s.agentType === "claude") {
      kind = "claude-session";
      rel = `${s.cliSessionId}.jsonl`;
      for (const cwd of [s.cwd, s.worktreePath, fallbackCwd]) {
        if (!cwd) continue;
        const candidate = claudeSessionFilePath(cwd, s.cliSessionId);
        if (existsSync(candidate)) { abs = candidate; break; }
      }
    } else if (s.agentType === "codex") {
      kind = "codex-rollout";
      abs = await findRollout(s.cliSessionId);
      // 协议里 rel 一律 `/` 分隔:Windows 上 relative 产出反斜杠,POSIX 导入侧会把
      // 整串当成一个文件名落错地方(codex 按目录深度扫描,从此找不到这份会话)。
      if (abs) rel = relative(join(codexHome(), "sessions"), abs).split(sep).join("/");
    } else {
      notes.push(`会话 ${s.id}（${s.agentType}）:该执行器的会话文件迁移暂不支持,对端只能全新起跑`);
      continue;
    }
    if (!abs) {
      notes.push(`会话 ${s.id}（${s.agentType}）:本机找不到 CLI 会话文件,对端只能全新起跑`);
      continue;
    }
    const size = statSync(abs).size;
    if (size > MAX_FILE_BYTES) {
      notes.push(`会话 ${s.id}:会话文件 ${Math.round(size / MB)}MB 超限,跳过`);
      continue;
    }
    found.add(s.id);
    if (!dryRun) {
      files.push({ kind, rel, dataBase64: (await readFile(abs)).toString("base64") });
    }
  }
  return { files, found, notes };
}

async function collectRunArtifacts(taskId: string, notes: string[]): Promise<HandoffFilePayload[]> {
  const root = join(RUNS_DIR, taskId);
  if (!existsSync(root)) return [];
  const out: HandoffFilePayload[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(abs); continue; }
      if (!entry.isFile()) continue;
      const size = statSync(abs).size;
      if (size > MAX_FILE_BYTES) {
        notes.push(`会话产物 ${entry.name} ${Math.round(size / MB)}MB 超限,跳过`);
        continue;
      }
      out.push({ kind: "run-artifact", rel: relative(root, abs).split(sep).join("/"), dataBase64: (await readFile(abs)).toString("base64") });
    }
  };
  await walk(root);
  return out;
}

/**
 * git 状态打包。只在任务开了 worktree 且 worktree/分支真实存在时有货:
 * 未提交改动先做 WIP 提交（进的是任务自己的分支,不碰用户分支）,然后跟对端仓库的
 * 分支尖协商公共前置提交,打一个尽量薄的 bundle;协商不出就整条历史全量打包。
 */
async function packGitState(
  task: TaskRow,
  repoPath: string,
  remoteRefs: { name: string; commit: string }[],
  notes: string[],
): Promise<HandoffManifest["git"]> {
  if (!task.useWorktree) {
    notes.push("任务不在独立 worktree 中运行,代码不随任务迁移——对端仓库以它本地的状态为准");
    return null;
  }
  const repo = expandHome(repoPath);
  const wt = worktreePathFor(repoPath, task.id);
  if (!existsSync(wt) || !(await isGitRepo(wt))) {
    notes.push("任务 worktree 尚未创建（还没跑过）,没有可迁移的代码状态");
    return null;
  }
  return withRepoLock(repoPath, async () => {
    const branch = await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch || branch === "HEAD") {
      notes.push("worktree 处于 detached HEAD,无法按分支打包,代码不随任务迁移");
      return null;
    }
    // WIP 提交:porcelain 非空才提交;身份缺失时补一个 harness 落款,别让接力卡在
    // 一台没配 git identity 的机器上。
    if (await git(wt, ["status", "--porcelain"])) {
      await git(wt, ["add", "-A"]);
      try {
        await git(wt, ["commit", "-m", "chore(handoff): 接力前自动保存未提交改动"]);
      } catch {
        await git(wt, [
          "-c", "user.name=harness", "-c", "user.email=harness@localhost",
          "commit", "-m", "chore(handoff): 接力前自动保存未提交改动",
        ]);
      }
      notes.push("未提交改动已在任务分支上做了一个 WIP 提交随包带走");
    }
    const head = await git(wt, ["rev-parse", "HEAD"]);
    // 前置提交协商:对端已有的提交（且是本分支祖先）不用重复打包。
    const prereqs: string[] = [];
    for (const ref of remoteRefs.slice(0, 100)) {
      if (prereqs.includes(ref.commit)) continue;
      try {
        await git(repo, ["cat-file", "-e", `${ref.commit}^{commit}`]);
        await git(repo, ["merge-base", "--is-ancestor", ref.commit, head]);
        prereqs.push(ref.commit);
      } catch { /* 对端这个提交本机没有,或不在本分支历史上 */ }
    }
    // 对端已有分支尖本身(重复接力/仓库已完全同步):`git bundle create ^HEAD HEAD`
    // 会以 "Refusing to create empty bundle" 拒绝——用空 bundleBase64 表示「提交都在,
    // 只需对齐分支指向」,导入侧不做 verify/fetch。
    if (prereqs.includes(head)) {
      notes.push("对端仓库已有本分支全部提交,git 数据无需传输");
      return { branch, head, full: false, prereqs, bundleBase64: "" };
    }
    const tmpDir = join(DATA_DIR, "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const bundlePath = join(tmpDir, `handoff-${task.id}-${Date.now()}.bundle`);
    try {
      const revArgs = prereqs.slice(0, 50).map((sha) => `^${sha}`);
      await git(repo, ["bundle", "create", bundlePath, ...revArgs, branch]);
      const size = statSync(bundlePath).size;
      if (size > MAX_BUNDLE_BYTES) {
        throw new HandoffError(
          `git bundle ${Math.round(size / MB)}MB 超限——两边仓库差距太大。先在目标机器上把仓库 fetch/pull 到较新状态,再重试接力`,
        );
      }
      if (!prereqs.length) {
        notes.push(`对端仓库没有和本分支重合的提交,bundle 打包了整条历史（${Math.round(size / MB)}MB）`);
      }
      return {
        branch,
        head,
        full: prereqs.length === 0,
        prereqs,
        bundleBase64: readFileSync(bundlePath).toString("base64"),
      };
    } finally {
      rmSync(bundlePath, { force: true });
    }
  });
}

/** 接力预检:探测对端、匹配项目、盘点本地可搬运的东西。只读,不停任务不动文件。 */
export async function preflightHandoff(taskId: string, targetUrlRaw: string): Promise<HandoffPreflightResult> {
  const { task, project } = await loadSingleTask(taskId);
  const targetUrl = normalizePeerUrl(targetUrlRaw);
  const ping = await fetchPeer<HandoffPingResponse>(`${targetUrl}/api/handoff/ping`);
  if (!ping?.ok || ping.service !== "harness") {
    throw new HandoffError("对端不是 harness（/api/handoff/ping 应答不对）", 502);
  }
  // 项目匹配靠仓库目录名:两台机器的绝对路径几乎必然不同,目录名是最稳的公共项。
  const base = (p: string) => expandHome(p).replace(/\/+$/, "").split("/").pop() ?? "";
  const localBase = base(project.repoPath);
  const suggested = localBase
    ? ping.projects.find((p) => p.isRepo && base(p.repoPath) === localBase) ?? null
    : null;
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  const withCli = rows.filter((s) => s.cliSessionId);
  const { found, notes } = await collectSessionFiles(rows, expandHome(project.repoPath), true);
  const wt = worktreePathFor(project.repoPath, taskId);
  const gitReady = !!task.useWorktree && existsSync(wt);
  if (!ping.projects.length) notes.push("对端还没有任何项目——先在对端把同一个仓库添加为项目");
  return {
    ok: true,
    target: { url: targetUrl, host: ping.host },
    projects: ping.projects,
    suggestedProjectId: suggested?.id ?? null,
    local: {
      status: task.status,
      running: task.status === "running" || task.status === "queued",
      sessions: withCli.length,
      sessionFilesFound: found.size,
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
  let prevMarker: TaskHandoff | null = null;
  if (prevHandoffRaw) {
    try { prevMarker = JSON.parse(prevHandoffRaw) as TaskHandoff; } catch { prevMarker = null; }
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
  // 先探测对端与目标项目,确认可行再停任务——反过来会白停一个正在跑的任务。
  const ping = await fetchPeer<HandoffPingResponse>(`${targetUrl}/api/handoff/ping`);
  if (!ping?.ok || ping.service !== "harness") throw new HandoffError("对端不是 harness", 502);
  const targetProject = ping.projects.find((p) => p.id === opts.targetProjectId);
  if (!targetProject) throw new HandoffError("对端没有这个项目 id,先重新预检", 409);

  task = await stopAndSettle(taskId);
  // 占住回合:导出期间队列/调度器不能再把它拉起来;占不到 = 有回合在收尾,让用户重试。
  if (!claimTurn(taskId, "handoff")) throw new HandoffError("任务回合还在收尾,稍等几秒再试", 409);
  try {
    const notes: string[] = [];
    const rows = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
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

    const manifest: HandoffManifest = {
      version: 1,
      sourceHost: hostname(),
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
      files: [...sessionFiles, ...artifacts],
    };

    // POST 出去的那一刻起对端就可能已经收下这份任务——应答丢了/源进程死在半路都不能
    // 让本机毫无痕迹(否则重试撞对端 409、本机任务还能再跑,正是双机分叉)。所以**先**
    // 落一个「接力未确认」的 pending 标记(它同样触发 handoff-guard 的启动硬拦),成功
    // 后改写成确认态;只有对端**明确应答失败**(没收下)才回滚到接力前的样子。
    const pendingMarker: TaskHandoff = {
      direction: "out",
      pending: true,
      transferId,
      // 冻结本次目标项目与 autoResume:收口重试必须原样重放(见上方 pendingRetry 校验)。
      targetProjectId: targetProject.id,
      autoResume,
      peerUrl: targetUrl,
      peerName: opts.targetName ?? ping.host,
      peerTaskId: taskId,
      at: now(),
      sessions: found.size,
      git: gitState ? "bundle" : "none",
    };
    await db.update(tasks)
      .set({ handoff: JSON.stringify(pendingMarker), updatedAt: now() })
      .where(eq(tasks.id, taskId));
    await publishTaskUpdated(taskId);

    let result: { ok: boolean; taskId: string; autoResume?: boolean; notes?: string[]; error?: string };
    try {
      result = await fetchPeer<{ ok: boolean; taskId: string; autoResume?: boolean; notes?: string[]; error?: string }>(
        `${targetUrl}/api/handoff/import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(manifest),
          timeoutMs: 600_000,
        },
      );
      if (!result.ok) throw new HandoffError(`对端导入失败：${result.error ?? "未知错误"}`, 502);
    } catch (e) {
      if (e instanceof HandoffError && e.network) {
        // 送没送到说不清:保留 pending 标记,把收口方法一并告诉用户。
        e.message += "。对端可能已经收到这份任务:本机保留「接力未确认」标记,原样重试会自动幂等收口;确认对端没收到的话,在任务横幅上移除接力标记即可在本机继续。";
        throw e;
      }
      // 对端明确说没收下(4xx/5xx 应答、或 ok:false):恢复接力前的标记,本机照常可跑。
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
      peerUrl: targetUrl,
      peerName: opts.targetName ?? ping.host,
      peerTaskId: result.taskId,
      at: now(),
      sessions: found.size,
      git: gitState ? "bundle" : "none",
    };
    await db.update(tasks)
      .set({ handoff: JSON.stringify(marker), updatedAt: now() })
      .where(eq(tasks.id, taskId));
    const latest = rows.at(-1);
    if (latest) {
      const line = {
        t: "system" as const, agent: latest.agentType, by: "system" as const, at: now(),
        text: `🔁 任务已接力到 ${marker.peerName}（${targetUrl}）继续执行,本机这份从此只是历史存档。`,
      };
      await appendFile(sessionTranscriptPath(taskId, latest.id), `\n${TURN_SENTINEL}${JSON.stringify(line)}\n`)
        .catch(() => { /* 产物目录可能不存在（从未跑过）,标记列已落库,不阻塞 */ });
    }
    await publishTaskUpdated(taskId);

    return {
      ok: true,
      remoteTaskId: result.taskId,
      remoteUrl: `${targetUrl}/tasks/${result.taskId}`,
      sessionsMigrated: found.size,
      git: gitState ? "bundle" : "none",
      // 以对端实际应答为准:重试撞上幂等分支时对端并没有续跑,不能按本次请求参数谎报。
      autoResume: result.autoResume ?? autoResume,
      notes,
    };
  } finally {
    releaseTurn(taskId);
  }
}
