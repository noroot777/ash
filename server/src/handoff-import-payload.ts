// 任务接力——导入侧的**载荷落地层**:manifest 校验、git bundle 进仓库、会话/产物文件
// 写盘。从 handoff-import.ts 拆出来(那边只留编排:恢复工作目录 → 落库 → 可选续跑),
// 业务背景见 handoff.ts 顶部注释。
//
// 这一层的共同立场是**不信任对端**:manifest 是网上来的字节,每个字段先验形状再用;
// ref 名、相对路径、解码后的体积各有一道闸,任何一条不过就跳过并留注记,而不是把它
// 写到本机文件系统上某个算出来的位置。
import { mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeProjectDir } from "./handoff-collect.js";
import {
  HandoffError, MAX_FILE_BYTES, MB, safeRel,
  type HandoffManifest, type HandoffFilePayload, type HandoffMessagePayload,
  type HandoffSchedulePayload, type HandoffUploadPayload,
} from "./handoff-types.js";
import {
  applyUploadRewrites, hasUploadRewrites, isTextRel, MAX_UPLOADS, rewriteKindFor,
  type UploadRewrites,
} from "./handoff-uploads.js";
import { expandHome, workspaceTrackedDirty, worktreePathFor } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { DATA_DIR, RUNS_DIR } from "./paths.js";
import { codexHome } from "./executors/codex-rollout.js";
import { assertWorktreeHeadCanAdvance, untrackedOverwriteConflicts } from "./handoff-worktree-safety.js";
import { execFileText as exec } from "./exec.js";

// 导入只接受**已结算**的状态;running/queued 混进来(理论上不该有)一律落 canceled,
// 假 running 会骗过所有「在跑」判断却没有任何进程。
export const SETTLED = new Set(["backlog", "paused", "done", "failed", "canceled"]);

const isStr = (v: unknown): v is string => typeof v === "string";

/** JSON 列必须真的是 JSON——坏值现在拒收,好过落库后每次序列化都炸。 */
export function jsonOr(v: unknown, fallback: string): string {
  if (!isStr(v)) return fallback;
  try { JSON.parse(v); return v; } catch { return fallback; }
}

export function validate(input: unknown): HandoffManifest {
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
export async function importGitBundle(
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
        await assertWorktreeHeadCanAdvance(taskWorktree, tempRef);
        const conflicts = await untrackedOverwriteConflicts(taskWorktree, tempRef);
        if (conflicts === null) {
          throw new HandoffError(`无法确认原机任务 worktree 的未跟踪文件是否会被覆盖：${taskWorktree}。先检查这个目录，再重试移回。`, 409);
        }
        if (conflicts.length) {
          const shown = conflicts.slice(0, 8).join("、");
          const more = conflicts.length > 8 ? ` 等 ${conflicts.length} 项` : "";
          throw new HandoffError(
            `原机保留的任务 worktree 有未跟踪文件会被移回内容覆盖：${shown}${more}。先移动、提交或删除这些文件，再重试移回。`,
            409,
          );
        }
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

/** 会话文件该落进谁的 CLI 配置目录:`auth/run-env.ts` 的 cliConfigDirForOwner 算出来的那两个。 */
export type CliConfigDirs = { claude: string | null; codex: string | null };

/**
 * 把 manifest 里的文件落到本机对应位置,返回**真正写盘成功**的会话文件名(basename)集合。
 * cliSessionId 只认这个集合——manifest 里声称带了文件、但被跳过/写失败的会话,一律按
 * 未迁移处理,否则续跑时 CLI 按 id 找不到历史就成了假恢复。
 *
 * `cliDirs` 不是可选项:多用户模式下 CLI 起跑带着 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`,
 * 写进宿主机 `~/.claude` 就是写进一个 CLI 永远不看的地方——盘上有、`--resume` 找不到,
 * 正是「假恢复」的另一种形态。
 */
export async function writePayloadFiles(
  files: HandoffFilePayload[],
  taskId: string,
  remoteCwd: string,
  rewrites: UploadRewrites,
  notes: string[],
  cliDirs: CliConfigDirs,
): Promise<Set<string>> {
  const claudeDir = claudeProjectDir(remoteCwd, cliDirs.claude);
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
      dest = join(codexHome(cliDirs.codex), "sessions", ...segs);
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
