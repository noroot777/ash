// 把下游**实际干活的地方**换到按前置定下的起点上 —— 定起点只是记一笔，代码得真的到了那里才算开工。
//
// 下游开工之前，它的代码可能已经以三种样子存在过（都是还没开工就被点过「打开预览」之类留下的）：
//   · 工作区目录在：原封未动（没有未提交改动、还停在一个「它从来没动过」的提交上）就地 `reset --keep` 过去；
//   · 目录没了、任务分支还在：起跑时 prepareWorktree 会从这条分支恢复目录，所以分支本身得先挪到起点；
//   · 都没有：起跑时按记下的起点新建，什么都不用做。
// 里面已经有自己的改动或提交的，不替它做决定，挡住并说清楚。
//
// 「它从来没动过的提交」认两个：建任务时冻结的那个（`worktreeStartCommit`），和上一次开工判定写下的意图
// （`baseRef`）。后者是给半路断掉的那一次留的：意图写下、目录已经换过去、开工还没落库时进程退出，
// 重启后那个目录停在意图上，不能因此被当成「有自己的提交」永远挡住。
//
// 顺序（prerequisite-gate.ts）：先写意图 → 再换目录 / 挪分支 → 最后才落「已开工」。任何一步之后断掉，
// 留下的都是「还没开工」，下一次判定从头核对；不会出现「库里说开工了、目录还是旧的」。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileText as exec } from "./exec.js";
import { expandHome, resolveWorktreeBranchName, worktreePathFor } from "./git.js";
import { baseRef, commitAt } from "./task-branch-plan.js";
import type { tasks } from "./db/schema.js";

type TaskRow = typeof tasks.$inferSelect;

export type InstallPlan =
  | { kind: "none" }
  | { kind: "directory"; path: string }
  | { kind: "branch"; ref: string; from: string };

const label = (task: TaskRow) => `「${task.title || task.id}」`;

/** 要把下游换到 `start` 得做什么；有它自己的东西挡着就给出原因。只读，不改任何东西。 */
export async function planInstall(repoPath: string, task: TaskRow, start: string): Promise<{ ok: true; plan: InstallPlan } | { ok: false; reason: string }> {
  const repo = expandHome(repoPath);
  const intent = await commitAt(repo, baseRef(task.id));
  const untouched = (head: string | null) => !!head && (head === task.worktreeStartCommit || head === intent);
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
