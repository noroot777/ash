// 把下游**实际干活的地方**换到按前置定下的起点上 —— 定起点只是记一笔，代码得真的到了那里才算开工。
//
// 下游开工之前，它的代码可能已经以三种样子存在过（都是还没开工就被点过「打开预览」之类留下的）：
//   · 工作区目录在：原封未动（没有未提交改动、还停在一个「它从来没动过」的提交上）就地 `reset --keep` 过去；
//   · 目录没了、任务分支还在：起跑时 prepareWorktree 会从这条分支恢复目录，所以分支本身得先挪到起点；
//   · 都没有：起跑时按记下的起点新建，什么都不用做。
// 里面已经有自己的改动或提交的，不替它做决定，挡住并说清楚。
//
// 「它从来没动过的提交」认：建任务时冻结的那个（`worktreeStartCommit`），和开工判定**打算换到过的每一版**
// （`task_prerequisite_launches.install_journal`，只增不删）。后者是给半路断掉的那几次留的：记下、换过去、
// 开工还没落库时进程退出，重启后前置又动了、这一次又记下新的一版、还没换又断了 —— 目录停在哪一版上，
// 那一版都在日志里，认得出是 ash 换的。只记一个会被覆盖的意图做不到这一点：第二次断掉就丢了上一次的身份。
//
// 顺序（prerequisite-gate.ts）：先记日志 → 再换目录 / 挪分支 → 最后才落「已开工」并清空日志。任何一步之后
// 断掉，留下的都是「还没开工」，下一次判定从头核对；不会出现「库里说开工了、目录还是旧的」。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileText as exec } from "./exec.js";
import { expandHome, resolveWorktreeBranchName, worktreePathFor } from "./git.js";
import { commitAt } from "./task-branch-plan.js";
import { db } from "./db/index.js";
import { taskPrerequisiteLaunches, type tasks } from "./db/schema.js";
import { launchRecord } from "./prerequisite-store.js";

type TaskRow = typeof tasks.$inferSelect;

export type InstallPlan =
  | { kind: "none" }
  | { kind: "directory"; path: string }
  | { kind: "branch"; ref: string; from: string };

const label = (task: TaskRow) => `「${task.title || task.id}」`;

/** 要把下游换到 `start` 得做什么；有它自己的东西挡着就给出原因。只读，不改任何东西。 */
export async function planInstall(repoPath: string, task: TaskRow, start: string): Promise<{ ok: true; plan: InstallPlan } | { ok: false; reason: string }> {
  const repo = expandHome(repoPath);
  const journal = (await launchRecord(task.id))?.installJournal ?? [];
  const untouched = (head: string | null) => !!head && (head === task.worktreeStartCommit || journal.includes(head));
  const path = worktreePathFor(repoPath, task.id);
  // 只认挂着 `.git` 的活工作树：清理留下的空壳里跑 git 会上溯到主仓，读到的是主仓的提交（git.ts worktreeLeftoverAt）。
  if (existsSync(join(path, ".git"))) {
    const head = await commitAt(path, "HEAD");
    if (head === start) return { ok: true, plan: { kind: "none" } };
    const clean = !(await exec("git", ["-C", path, "status", "--porcelain"]).then((r) => r.stdout.trim(), () => "?"));
    if (!clean || !untouched(head)) {
      return { ok: false, reason: `${label(task)}的工作区里已经有自己的改动或提交，换不成前置的代码；放弃那些改动后会自动开工` };
    }
    return { ok: true, plan: { kind: "directory", path } };
  }
  const ref = `refs/heads/${await resolveWorktreeBranchName(repo, task.id)}`;
  const branchHead = await commitAt(repo, ref);
  if (!branchHead || branchHead === start) return { ok: true, plan: { kind: "none" } };
  if (!untouched(branchHead)) {
    return { ok: false, reason: `${label(task)}的任务分支上已经有自己的提交，换不成前置的代码；去掉那些提交后会自动开工` };
  }
  return { ok: true, plan: { kind: "branch", ref, from: branchHead } };
}

/** 照计划换过去。分支用比较后再改（`update-ref <新> <旧>`）：判定之后有人动过它就失败，不覆盖。 */
export async function applyInstall(repoPath: string, plan: InstallPlan, start: string): Promise<void> {
  if (plan.kind === "directory") await exec("git", ["-C", plan.path, "reset", "--keep", start]);
  else if (plan.kind === "branch") await exec("git", ["-C", expandHome(repoPath), "update-ref", plan.ref, start, plan.from]);
}

/** 换之前先把这一版记进日志（见文件头）。已经记过的不重复记。 */
export async function journalInstall(taskId: string, commit: string): Promise<void> {
  const journal = (await launchRecord(taskId))?.installJournal ?? [];
  if (journal.includes(commit)) return;
  const next = [...journal, commit];
  await db.insert(taskPrerequisiteLaunches).values({ taskId, installJournal: next })
    .onConflictDoUpdate({ target: taskPrerequisiteLaunches.taskId, set: { installJournal: next } });
}
