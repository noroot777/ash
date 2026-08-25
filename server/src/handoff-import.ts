// 任务接力——导入侧。协议与导出逻辑见 handoff.ts 顶部注释。
//
// 这里的职责:把对端 POST 过来的 manifest 落成本机的一个完整任务——git 分支 fetch
// 进本地仓库、prepareWorktree 恢复档搭回工作目录、tasks/sessions 行落库、CLI 会话
// 文件放到本机 CLI 期望的位置、runs 产物归位,最后(可选)立刻续跑。
// 失败要么整体 4xx/5xx(什么都没建),要么建成但带 notes 说明哪些东西退化了;
// 不留半截任务。
import { homedir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { noteTasks, projects, scheduledMessages, schedules, sessions, tasks } from "./db/schema.js";
import { claudeProjectSlug } from "./handoff-collect.js";
import {
  HandoffError, MAX_FILE_BYTES, MB, safeRel,
  type HandoffManifest, type HandoffFilePayload, type HandoffMessagePayload,
  type HandoffSchedulePayload, type HandoffUploadPayload,
} from "./handoff-types.js";
import {
  applyUploadRewrites, buildUploadRewrites, hasUploadRewrites, isTextRel,
  MAX_UPLOADS, rewriteKindFor, writeUploads, type UploadRewrites,
} from "./handoff-uploads.js";
import { ensureWorkdir, expandHome, prepareWorktree, projectHealthLight, workspaceTrackedDirty, worktreePathFor } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { DATA_DIR, RUNS_DIR } from "./paths.js";
import { codexHome, findRollout } from "./executors/codex-rollout.js";
import { assertHandoffNotCanceled, beginHandoffImport, endHandoffImport } from "./handoff-transfer-state.js";
import { publishPendingMessages } from "./pending-messages.js";
import { createTasks, publishTaskUpdated } from "./task-store.js";
import { deleteTaskAssociations } from "./task-routes.js";
import { resumeOrRunTask } from "./task-resume.js";
import { localIdentity } from "./handoff-identity.js";
import { id, now } from "./util.js";
import type { TaskHandoff } from "@ash/shared";
import { execFileText as exec } from "./exec.js";

// 导入只接受**已结算**的状态;running/queued 混进来(理论上不该有)一律落 canceled,
// 假 running 会骗过所有「在跑」判断却没有任何进程。
const SETTLED = new Set(["backlog", "paused", "done", "failed", "canceled"]);

const isStr = (v: unknown): v is string => typeof v === "string";

/** JSON 列必须真的是 JSON——坏值现在拒收,好过落库后每次序列化都炸。 */
function jsonOr(v: unknown, fallback: string): string {
  if (!isStr(v)) return fallback;
  try { JSON.parse(v); return v; } catch { return fallback; }
}

function validate(input: unknown): HandoffManifest {
  const m = input as HandoffManifest;
  if (!m || typeof m !== "object") throw new HandoffError("导入体必须是 JSON 对象");
  if (m.version !== 1) throw new HandoffError(`不认识的接力协议版本 ${String((m as { version?: unknown }).version)},两边 ash 版本差太远`);
  if (!isStr(m.targetProjectId)) throw new HandoffError("缺 targetProjectId");
  const sourceFingerprint = (m as { sourceFingerprint?: unknown }).sourceFingerprint;
  if (sourceFingerprint != null && (!isStr(sourceFingerprint) || !/^[0-9a-f]{64}$/.test(sourceFingerprint))) {
    throw new HandoffError("sourceFingerprint 非法");
  }
  const originFingerprint = (m as { originFingerprint?: unknown }).originFingerprint;
  if (originFingerprint != null && (!isStr(originFingerprint) || !/^[0-9a-f]{64}$/.test(originFingerprint))) {
    throw new HandoffError("originFingerprint 非法");
  }
  // transferId 宽容校验:老版本导出没有这个字段,缺了照收(只是失去幂等重放能力)。
  const tid = (m as { transferId?: unknown }).transferId;
  if (tid != null && (!isStr(tid) || tid.length > 64)) throw new HandoffError("transferId 非法");
  const returnTid = (m as { returnTransferId?: unknown }).returnTransferId;
  if (returnTid != null && (!isStr(returnTid) || returnTid.length > 64)) throw new HandoffError("returnTransferId 非法");
  const sourcePort = (m as { sourcePort?: unknown }).sourcePort;
  if (sourcePort != null && (typeof sourcePort !== "number" || !Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65_535)) {
    throw new HandoffError("sourcePort 非法");
  }
  const t = m.task;
  if (!t || !isStr(t.id) || !/^[A-Za-z0-9_-]{6,64}$/.test(t.id)) throw new HandoffError("task.id 非法");
  if (!isStr(t.title) || !isStr(t.body) || !isStr(t.createdAt)) throw new HandoffError("task 关键字段缺失");
  if (!Array.isArray(m.sessions) || m.sessions.length > 200) throw new HandoffError("sessions 非法");
  if (!Array.isArray(m.files) || m.files.length > 500) throw new HandoffError("files 非法(最多 500 个)");
  for (const f of m.files) {
    if (!isStr(f.rel) || !isStr(f.dataBase64)) throw new HandoffError("file 载荷字段缺失");
    if (!["claude-session", "codex-rollout", "run-artifact"].includes(f.kind)) {
      throw new HandoffError(`不认识的文件类型 ${String(f.kind)}`);
    }
  }
  // uploads/messages/schedule 宽容校验:老版本导出没有这些字段。
  const ups = (m as { uploads?: unknown }).uploads;
  if (ups != null) {
    if (!Array.isArray(ups) || ups.length > MAX_UPLOADS) throw new HandoffError(`uploads 非法(最多 ${MAX_UPLOADS} 个)`);
    for (const u of ups as HandoffUploadPayload[]) {
      if (!isStr(u.name) || !isStr(u.sourcePath) || !isStr(u.dataBase64)) throw new HandoffError("upload 载荷字段缺失");
    }
  }
  const msgs = (m as { messages?: unknown }).messages;
  if (msgs != null) {
    if (!Array.isArray(msgs) || msgs.length > 200) throw new HandoffError("messages 非法(最多 200 条)");
    for (const x of msgs as HandoffMessagePayload[]) {
      if (!isStr(x.text) || !isStr(x.attachments) || !isStr(x.mode) || !isStr(x.sendAt) || !isStr(x.createdAt)) {
        throw new HandoffError("message 载荷字段缺失");
      }
    }
  }
  const sch = (m as { schedule?: unknown }).schedule;
  if (sch != null && (!sch || typeof sch !== "object" || !["once", "cron"].includes((sch as HandoffSchedulePayload).kind))) {
    throw new HandoffError("schedule 载荷非法");
  }
  if (m.git !== null) {
    if (!m.git || !isStr(m.git.branch) || !isStr(m.git.bundleBase64)) throw new HandoffError("git 载荷非法");
    if (!safeRefName(m.git.branch)) throw new HandoffError(`git 分支名非法:${m.git.branch.slice(0, 80)}`);
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(String(m.git.head))) throw new HandoffError("git head 不是提交号");
  }
  return m;
}

/**
 * 分支名与 head 会**原样进 git 的 argv**(`branch -f <branch> <head>`、refspec 拼接、
 * `<head>^{commit}`),只判 `typeof === "string"` 不够:`-` 开头的值会被 git 当成选项
 * (参数注入),含 `..`/控制字符的会把 refspec 拆坏或指向仓库目录之外。这里按 git 自己的
 * refname 规则收窄——保留非 ASCII(中文分支名是合法的),只挡掉危险形状。
 * 文件落盘方向的同类校验在 handoff-types.ts `safeRel` 与 handoff-uploads.ts `SAFE_NAME`。
 */
function safeRefName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (/^[-./]/.test(name) || /[/.]$/.test(name) || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  return !/[\x00-\x20\x7f~^:?*[\\]/.test(name);
}

/** bundle 落进本地仓库:verify 确认前置提交齐全,再把分支强制 fetch 进来。 */
async function importGitBundle(
  repoPath: string,
  taskId: string,
  git: NonNullable<HandoffManifest["git"]>,
  notes: string[],
): Promise<void> {
  const repo = expandHome(repoPath);
  // 空 bundle = 源机确认本机已有全部提交(见 handoff.ts packGitState),只需对齐分支。
  if (!git.bundleBase64) {
    await withRepoLock(repoPath, async () => {
      try {
        await exec("git", ["-C", repo, "cat-file", "-e", `${git.head}^{commit}`]);
      } catch {
        throw new HandoffError(
          `对端说本机已有提交 ${git.head.slice(0, 8)},但本机仓库里找不到——两边仓库状态漂了,重新预检再试`,
          409,
        );
      }
      try {
        await exec("git", ["-C", repo, "branch", "-f", git.branch, git.head]);
        notes.push(`本机已有分支全部提交,分支 ${git.branch} 已对齐(未传输 git 数据)`);
      } catch {
        // 分支正被某个 worktree 检出时 branch -f 会拒绝;提交都在,如实记录即可。
        notes.push(`本机已有分支全部提交,但 ${git.branch} 正被占用无法强制对齐,以本机分支现状为准`);
      }
    });
    return;
  }
  const tmpDir = join(DATA_DIR, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const bundlePath = join(tmpDir, `handoff-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bundle`);
  try {
    await writeFile(bundlePath, Buffer.from(git.bundleBase64, "base64"));
    let updatedCheckedOutWorktree = false;
    await withRepoLock(repoPath, async () => {
      try {
        await exec("git", ["-C", repo, "bundle", "verify", bundlePath], { maxBuffer: 4 * MB });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new HandoffError(
          `git bundle 校验失败——本机仓库缺少接力分支的前置提交。先在本机把仓库 git fetch/pull 到较新状态再重试接力。原始错误:${msg.slice(0, 400)}`,
          409,
        );
      }
      const taskWorktree = worktreePathFor(repoPath, taskId);
      let checkedOutHere = false;
      try {
        const { stdout } = await exec("git", ["-C", taskWorktree, "symbolic-ref", "--quiet", "--short", "HEAD"]);
        checkedOutHere = stdout.trim() === git.branch;
      } catch { /* worktree 不存在或不在这个分支，走普通 fetch */ }
      if (!checkedOutHere) {
        // `+` 强制更新:重复接力同一任务(先删了旧任务)时分支可能已存在旧尖。
        await exec("git", [
          "-C", repo, "fetch", bundlePath,
          `+refs/heads/${git.branch}:refs/heads/${git.branch}`,
        ], { maxBuffer: 4 * MB });
        return;
      }

      const dirty = await workspaceTrackedDirty(taskWorktree);
      if (dirty !== false) {
        throw new HandoffError(
          dirty
            ? `原机保留的任务 worktree 有已跟踪文件的未提交改动，不能用移回内容覆盖：${taskWorktree}。先提交或还原这些改动，再重试移回。`
            : `无法确认原机任务 worktree 是否干净：${taskWorktree}。先检查这个目录，再重试移回。`,
          409,
        );
      }
      const tempRef = `refs/ash-handoff/import/${taskId}-${Date.now().toString(36)}`;
      try {
        await exec("git", ["-C", repo, "fetch", bundlePath, `+refs/heads/${git.branch}:${tempRef}`], { maxBuffer: 4 * MB });
        const { stdout: fetchedHead } = await exec("git", ["-C", repo, "rev-parse", tempRef]);
        if (fetchedHead.trim() !== git.head) throw new HandoffError("接力 bundle 的分支尖与 manifest 不一致", 409);
        await exec("git", ["-C", taskWorktree, "reset", "--hard", git.head]);
        updatedCheckedOutWorktree = true;
      } finally {
        await exec("git", ["-C", repo, "update-ref", "-d", tempRef]).catch(() => {});
      }
    });
    notes.push(`git 分支 ${git.branch} 已导入(${git.full ? "全量历史" : "增量"})${updatedCheckedOutWorktree ? "，原机保留的 worktree 已更新到返回提交" : ""}`);
  } finally {
    rmSync(bundlePath, { force: true });
  }
}

/**
 * 把 manifest 里的文件落到本机对应位置,返回**真正写盘成功**的会话文件名(basename)集合。
 * cliSessionId 只认这个集合——manifest 里声称带了文件、但被跳过/写失败的会话,一律按
 * 未迁移处理,否则续跑时 CLI 按 id 找不到历史就成了假恢复。
 */
async function writePayloadFiles(
  files: HandoffFilePayload[],
  taskId: string,
  remoteCwd: string,
  rewrites: UploadRewrites,
  notes: string[],
): Promise<Set<string>> {
  const claudeDir = join(homedir(), ".claude", "projects", claudeProjectSlug(remoteCwd));
  const arrived = new Set<string>();
  for (const f of files) {
    // 协议约定 rel 用 `/` 分隔,但老版本 Windows 源机导出的是 `\`——两种都按段拆开重组,
    // 否则整串反斜杠在 POSIX 上是一个文件名,写进错误位置后 findRollout 永远找不到
    // (审查实测:跨平台假迁移)。
    const segs = f.rel.split(/[\\/]/);
    let dest: string;
    if (f.kind === "claude-session") {
      // 会话文件名就是 `<uuid>.jsonl`,不允许带任何目录成分。
      if (!/^[A-Za-z0-9_-]+\.jsonl$/.test(f.rel)) { notes.push(`claude 会话文件名非法,跳过:${f.rel}`); continue; }
      dest = join(claudeDir, f.rel);
    } else if (f.kind === "codex-rollout") {
      if (!safeRel(f.rel)) { notes.push(`codex rollout 路径非法,跳过:${f.rel}`); continue; }
      dest = join(codexHome(), "sessions", ...segs);
    } else {
      if (!safeRel(f.rel)) { notes.push(`产物路径非法,跳过:${f.rel}`); continue; }
      dest = join(RUNS_DIR, taskId, ...segs);
    }
    let data = Buffer.from(f.dataBase64, "base64");
    if (data.byteLength > MAX_FILE_BYTES) { notes.push(`${f.rel} 解码后超限,跳过`); continue; }
    if (hasUploadRewrites(rewrites) && isTextRel(f.rel)) {
      // 会话 JSONL/产物文本里的上传附件路径改写成本机路径。上下文按扩展名声明
      // (.jsonl/.json/.trace 整体是 JSON,.md/.txt 是混排文本),POSIX 源机接力到
      // Windows 目标机时两种形态才能各改各的,JSONL 改完仍是合法 JSON;二进制不碰。
      data = Buffer.from(applyUploadRewrites(data.toString("utf8"), rewrites, rewriteKindFor(f.rel)), "utf8");
    }
    mkdirSync(dirname(dest), { recursive: true });
    await writeFile(dest, data);
    if (f.kind !== "run-artifact") arrived.add(segs.at(-1)!);
  }
  return arrived;
}

export interface HandoffImportResult {
  ok: true;
  taskId: string;
  workspace: string | null;
  sessionsMigrated: number;
  autoResume: boolean;
  // true = 本机已有这次接力导入的任务,本次是应答丢失后的幂等收口(零副作用)。
  // 源机据此决定取消哪批待发送消息原件:幂等收口只对应第一次带走的那批。
  idempotent?: boolean;
  notes: string[];
}

export async function importHandoff(
  input: unknown,
  context: { sourceUrl?: string | null } = {},
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
  context: { sourceUrl?: string | null },
): Promise<HandoffImportResult> {
  const notes: string[] = [];
  const project = (await db.select().from(projects).where(eq(projects.id, m.targetProjectId))).at(0);
  if (!project) throw new HandoffError("目标项目不存在(对端项目清单可能过期,重新预检)", 404);
  const existing = (await db
    .select({ id: tasks.id, handoff: tasks.handoff })
    .from(tasks)
    .where(eq(tasks.id, m.task.id))).at(0);
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
  const writtenUploads = await writeUploads(m.uploads ?? [], notes);
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
  const arrived = await writePayloadFiles(m.files, m.task.id, workspace ?? expandHome(project.repoPath), rewrites, notes);

  // ── cliSessionId 只认「文件写盘成功、且 CLI 自己找得到」的会话 ────────────
  // claude 的文件名是 `<cliSessionId>.jsonl`,codex 是 `rollout-<ts>-<threadId>.jsonl`。
  // codex 还要过 findRollout:它只按 sessions/YYYY/MM/DD 的标准深度扫描,rel 深度不对时
  // 文件在盘上但 codex 定位不到,保留 cliSessionId 就是假恢复(续跑报找不到线程)。
  const hasFile = (s: HandoffManifest["sessions"][number]): boolean =>
    !!s.cliSessionId && [...arrived].some(
      (name) => name === `${s.cliSessionId}.jsonl` || name.endsWith(`-${s.cliSessionId}.jsonl`),
    );
  const usable = new Map<string, boolean>();
  for (const s of m.sessions) {
    let ok = hasFile(s);
    if (ok && s.agentType === "codex") {
      ok = !!(await findRollout(s.cliSessionId!));
      if (!ok) notes.push(`codex 会话 ${s.id} 的 rollout 已写盘但无法按标准目录定位,按未迁移处理`);
    }
    usable.set(s.id, ok);
  }
  const migrated = m.sessions.filter((s) => usable.get(s.id));

  // ── resumePrompt:告诉续跑的 agent 它被搬过机器了 ───────────────────────
  const agentType = m.task.agentType ?? "claude";
  const latest = [...m.sessions]
    .filter((s) => s.agentType === agentType)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
  const resumable = !!latest && !!usable.get(latest.id);
  const preamble = [
    `【任务接力】本任务从另一台机器(${m.sourceHost})接力到本机继续。`,
    m.git ? "git 分支和已提交的改动已随任务迁移。" : "代码没有随任务迁移,以本机仓库当前状态为准。",
    `工作目录从 ${m.sourceWorkspace ?? "(未知)"} 变为 ${workspace},历史对话里引用的旧绝对路径一律以新目录为准。`,
    "先快速核对工作目录(git log/status、关键文件是否符合预期),再继续完成任务目标。",
  ].join("");
  let resumePrompt: string | null;
  if (m.sessions.length === 0) {
    resumePrompt = m.task.resumePrompt; // 没跑过的任务原样保留,首跑走正常 fresh 路径
  } else if (resumable) {
    resumePrompt = preamble + (m.task.resumePrompt ? `\n\n上次暂停时留下的续跑提示:\n${m.task.resumePrompt}` : "");
  } else {
    // 会话文件没到货:续跑会开全新 CLI 会话、只看到这一条消息,任务正文必须自带。
    notes.push("CLI 会话历史未迁移,续跑将开全新会话(任务正文已并入首条消息)");
    resumePrompt = [
      preamble,
      "\n\n注意:CLI 会话历史没有随任务迁移,这是一个全新会话。任务目标全文如下:\n\n" + m.task.body,
      m.task.resumePrompt ? `\n\n上次暂停时留下的续跑提示:\n${m.task.resumePrompt}` : "",
    ].join("");
  }

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
  };
  const status = SETTLED.has(m.task.status) ? m.task.status : "canceled";
  const taskRow = {
    id: m.task.id,
    projectId: project.id,
    title: m.task.title,
    body: m.task.body,
    mode: "single" as const,
    status,
    stage: m.task.stage,
    labels: jsonOr(m.task.labels, "[]"),
    agentType: m.task.agentType,
    executorId: null,
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
    pinnedAt: m.task.pinnedAt,
    starredAt: m.task.starredAt,
    createdAt: m.task.createdAt,
    updatedAt: now(),
    startedAt: m.task.startedAt,
    endedAt: m.task.endedAt,
    handoff: JSON.stringify(marker),
    scheduleId,
    reportBack: false,
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
    const preservedNoteLinks = await db.select().from(noteTasks).where(eq(noteTasks.taskId, m.task.id));
    try {
      await db.transaction(async (tx) => {
        await deleteTaskAssociations(m.task.id);
        await tx.delete(tasks).where(eq(tasks.id, m.task.id));
        await tx.insert(tasks).values(taskRow);
        if (scheduleValues) await tx.insert(schedules).values(scheduleValues);
        if (sessionRows.length) await tx.insert(sessions).values(sessionRows);
        if (messageRows.length) await tx.insert(scheduledMessages).values(messageRows);
        if (preservedNoteLinks.length) await tx.insert(noteTasks).values(preservedNoteLinks);
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
    });
  } catch (e) {
    // 补偿回滚:任务行 + 已插入的会话行一起清掉,不留半截任务(审查实测:UNIQUE 炸在
    // 会话插入后,GET 200 但任务残废、重试永远 409)。只清自己建的行——任务行没插成
    // (taskRowInserted=false)说明库里那行属于别的导入,动不得。git 分支/worktree/
    // 已写盘文件的残留无害——重试会原样覆盖。
    let rollbackFailed = false;
    if (taskRowInserted) {
      try {
        await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, m.task.id));
        await db.delete(sessions).where(eq(sessions.taskId, m.task.id));
        await db.delete(tasks).where(eq(tasks.id, m.task.id));
      } catch { rollbackFailed = true; /* 没有更好的办法,如实上报,让源机保留 pending */ }
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
    notes,
  };
}
