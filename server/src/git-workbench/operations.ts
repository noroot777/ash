import type {
  GitAction,
  GitActionRequest,
  GitActionResult,
  GitJournalEntry,
} from "@ash/shared/git-workbench";
import { gitActionBlockReason } from "@ash/shared/git-workbench";
import { withRepoLock } from "../repo-lock.js";
import { readScmStatus, type ScmStatus } from "../git-status.js";
import {
  stagePaths,
  unstagePaths,
  discardPaths,
  commitWorkspace,
} from "../git-workspace-ops.js";
import { ScmOperationError } from "../scm-paths.js";
import {
  git,
  fail,
  commitOid,
  requireClean,
  freshStatus,
  confirmationFor,
  selectRoot,
  exactRef,
} from "./core.js";
import {
  appendEntry,
  backupHead,
  finishEntry,
  readJournal,
  startEntry,
} from "./journal.js";
import { runRefAction } from "./refs.js";
import { runSyncAction } from "./sync.js";
import { stageSelected } from "./patch.js";
import { continueOperation, resolveConflict } from "./conflicts.js";
import { rebasePlan } from "./rebase.js";
import { displayCommand, safeGitMessage } from "./command.js";
import { runRemoteAction } from "./remotes.js";
import { cleanupRebaseHelpers, deleteBackup } from "./maintenance.js";

const historyActions = new Set([
  "merge",
  "cherry-pick",
  "revert",
  "reset",
  "rebase",
  "rebase-plan",
  "pull",
  "undo",
]);
async function runAction(
  repo: string,
  root: string,
  projectId: string,
  actor: string,
  action: GitAction,
  entry: GitJournalEntry,
  status: ScmStatus,
  executeSequence: typeof git,
): Promise<string> {
  if (historyActions.has(action.kind)) requireClean(status);
  if (
    historyActions.has(action.kind) ||
    (action.kind === "commit" && action.amend)
  ) {
    await backupHead(repo, entry);
    await appendEntry(repo, entry);
  }
  if (action.kind === "branch-delete" || action.kind === "tag-delete") {
    const kind = action.kind === "branch-delete" ? "heads" : "tags";
    const sha = await exactRef(root, action.name, action.sha, kind);
    entry.backup = `refs/ash-backup/${entry.id}`;
    entry.recovery = action.kind === "branch-delete" ? "branch" : "tag";
    entry.targetName = action.name;
    await git(repo, ["update-ref", entry.backup, sha, ""]);
    await appendEntry(repo, entry);
  }
  if (await runRefAction(repo, root, action, actor, executeSequence))
    return "操作已完成";
  if (await runRemoteAction(root, projectId, action))
    return "远端配置或引用操作已完成";
  if (await runSyncAction(repo, root, projectId, action, executeSequence))
    return "远端操作已完成";
  switch (action.kind) {
    case "backup-delete":
      await deleteBackup(root, action.ref, action.sha);
      return "备份已删除，其独有历史可由 Git 垃圾回收释放";
    case "rebase-cleanup": {
      const result = await cleanupRebaseHelpers(root);
      if (result.blocked) fail(result.blocked);
      return `已清理 ${result.removed} 个已结束变基的辅助目录`;
    }
    case "stage": {
      const result = await stagePaths(root, repo, action.paths);
      return `已暂存 ${result.affected} 个路径${result.note ? `；${result.note}` : ""}`;
    }
    case "unstage":
      await unstagePaths(root, repo, action.paths);
      return "已取消暂存，内容保留在工作区";
    case "discard":
      await discardPaths(root, repo, action.paths, action.deleteUntracked);
      return "已丢弃指定改动";
    case "patch":
      await stageSelected(
        root,
        action.path,
        action.source,
        action.diff,
        action.lines,
      );
      return action.source === "staged"
        ? "已取消所选改动的暂存"
        : "已暂存所选改动";
    case "commit":
      if (!action.amend && !status.staged.length)
        fail("暂存区为空，请先暂存要提交的文件");
      await commitWorkspace(root, repo, {
        message: action.message,
        amend: action.amend,
      });
      return action.amend
        ? "已修订最近一次提交，原提交已保留备份"
        : "已提交暂存区内容";
    case "merge":
      await executeSequence(root, [
        "merge",
        "--no-edit",
        ...(action.strategy === "no-ff"
          ? ["--no-ff"]
          : action.strategy === "squash"
            ? ["--squash"]
            : []),
        await commitOid(root, action.target),
      ]);
      return action.strategy === "squash"
        ? "合并结果已暂存，请在变更视图填写信息并提交"
        : "合并完成";
    case "rebase":
      await executeSequence(root, [
        "rebase",
        await commitOid(root, action.target),
      ]);
      return "变基完成";
    case "rebase-plan":
      await rebasePlan(root, action.target, action.steps, executeSequence);
      return "交互式变基完成";
    case "cherry-pick":
    case "revert": {
      const target = await commitOid(root, action.target);
      const parents =
        (await git(root, ["rev-list", "--parents", "-n", "1", target]))
          .trim()
          .split(" ").length - 1;
      if (parents > 1 && !action.mainline)
        fail("这是合并提交，请明确选择作为主线的父提交编号", 400);
      await executeSequence(root, [
        action.kind,
        ...(action.mainline ? ["-m", String(action.mainline)] : []),
        ...(action.kind === "revert" ? ["--no-edit"] : []),
        target,
      ]);
      return "提交操作已完成";
    }
    case "reset":
      await git(root, [
        "reset",
        `--${action.mode}`,
        await commitOid(root, action.target),
      ]);
      return `已执行 ${action.mode} 重置，原 HEAD 已保留备份`;
    case "resolve":
      await resolveConflict(root, action);
      return "冲突文件已保存并暂存";
    case "continue":
    case "abort":
    case "skip":
      await continueOperation(root, action.kind, executeSequence);
      return action.kind === "abort"
        ? "已中止操作，Git 已恢复操作前状态"
        : "Git 已继续执行";
    case "undo": {
      const original = (await readJournal(repo)).find(
        (item) => item.id === action.id,
      );
      if (original?.recovery !== "head")
        fail("此备份请恢复为新分支，不可重置当前分支");
      if (
        !original?.backup ||
        !original.before ||
        !original.after ||
        original.root !== root ||
        original.branch !== status.branch.head ||
        original.after !== status.branch.oid
      )
        fail(
          "当前分支已经变化，不能直接撤销。可从操作记录的备份提交新建分支找回历史",
        );
      if (original!.state !== "succeeded") fail("只能撤销已成功完成的历史操作");
      await git(root, [
        "reset",
        "--hard",
        await commitOid(root, original!.backup!),
      ]);
      return "已恢复操作前的提交；恢复前的 HEAD 也已保留备份";
    }
    default:
      return fail("未知 Git 操作", 400);
  }
}

export async function executeWorkbench(
  repo: string,
  projectId: string,
  actor: { id: string; name: string },
  request: GitActionRequest,
  guard?: (root: string, action: GitAction) => Promise<() => void>,
): Promise<GitActionResult> {
  const entry = startEntry(request.root, request.action.kind, actor.name);
  entry.command = displayCommand(request.action);
  try {
    await appendEntry(repo, entry);
    return await withRepoLock(repo, async () => {
      let release: (() => void) | undefined;
      let attemptedSequence = false;
      const executeSequence: typeof git = (...args) => {
        attemptedSequence = true;
        return git(...args);
      };
      try {
        const { root } = await selectRoot(repo, request.root);
        release = await guard?.(root, request.action);
        const status = await freshStatus(root, request.version);
        entry.before = status.branch.oid || undefined;
        entry.branch = status.branch.head;
        const blocked = gitActionBlockReason(status, request.action.kind);
        if (blocked) fail(blocked);
        const expected = confirmationFor(request.action, status);
        if (expected !== null && request.confirmation !== expected)
          fail(`请先输入「${expected}」确认这个操作`, 400);
        entry.state = "running";
        entry.message = "正在执行";
        await appendEntry(repo, entry);
        const message = await runAction(
          repo,
          root,
          projectId,
          actor.id,
          request.action,
          entry,
          status,
          executeSequence,
        );
        entry.after =
          (await readScmStatus(root).catch(() => null))?.branch.oid ||
          undefined;
        entry.state = "succeeded";
        entry.message = message;
        await appendEntry(repo, entry).catch(() => {
          entry.message +=
            "；操作已生效，但结果日志写入失败，请刷新 Git 状态核对";
        });
        return { ok: true as const, message: entry.message, entry };
      } catch (error) {
        const status = await readScmStatus(request.root).catch(() => null);
        entry.after = status?.branch.oid || undefined;
        const inProgress =
          attemptedSequence && (status?.operation || status?.merge.length);
        entry.state = inProgress ? "conflict" : "failed";
        entry.message =
          safeGitMessage(
            error instanceof Error ? error.message : String(error),
          ) +
          (inProgress ? "\nGit 操作尚未完成，请在冲突面板继续或中止。" : "");
        await appendEntry(repo, entry).catch(() => {});
        throw new ScmOperationError(
          entry.message,
          error instanceof ScmOperationError ? error.status : 409,
        );
      } finally {
        release?.();
      }
    });
  } finally {
    finishEntry(entry.id);
  }
}
