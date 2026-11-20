// 推送档 × 验收前置命令（合并预览档）：门禁绿了、自动接着验收并推送，推的那一刻远程又被别人推了新提交。
//
// 钉的是审查第 2 轮 F2：不能拿第一次门禁测过的那棵树 / 那个目标提交再合一次 —— 那会被旧基准拦成一般的
// merge_failed，真冲突不交回任务、不冲突也合不上。推不上去时本地没动过，同步进来，从头重新验收：
// ① 同步进来的提交跟任务冲突 → 按冲突口径交回任务去解，门禁不再跑，本地目标分支停在远程那一头；
// ② 不冲突 → 按同步之后的目标分支重跑门禁，绿了带着同一个冻结的目的地接着验收并推送。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const { baselineHarness } = await import("./accept-gate-baseline-fixture.js");
const h = await baselineHarness("navi-accept-push-gate-");
const { root, git, acceptTask, acceptGateState, runs, settled, fixture, taskRow } = h;

/** 给样本仓库配一个裸远程（main 推上去、设好上游）和一份「别人」的克隆。 */
function withRemote(repo: string, name: string) {
  const remote = join(root, `${name}.git`);
  const other = join(root, `${name}-other`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", remote, other]);
  git(other, "config", "user.name", "Other");
  git(other, "config", "user.email", "other@example.test");
  return { remote, other };
}

/** 一次性的 pre-push 钩子：Navi 推的那一刻，「别人」先往远程推一个提交。 */
function raceOnPush(repo: string, other: string, file: string, content: string) {
  writeFileSync(join(other, file), content);
  writeFileSync(join(repo, ".git", "hooks", "pre-push"), [
    "#!/bin/sh", 'rm -f "$0"', "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX",
    `cd ${JSON.stringify(other)} && git add -A && git commit -q -m "race ${file}" && git push -q origin main`, "",
  ].join("\n"), { mode: 0o755 });
}

try {
  // ① 冲突：任务新增了 use-b.js，别人在推送那一刻也推了一份不同的 use-b.js。
  {
    const sample = await fixture("push-gate-conflict", { baseline: "merge_preview" });
    const { remote, other } = withRemote(sample.repo, "push-gate-conflict");
    raceOnPush(sample.repo, other, "use-b.js", "module.exports = 'theirs';\n");
    await acceptTask(sample.taskId, "human", { push: true });
    await settled(sample.taskId);
    const all = await runs(sample.taskId);
    assert.equal(all.length, 1, "重来那一遍撞冲突：门禁不再跑");
    assert.equal(all[0]!.status, "passed");
    const theirs = git(remote, "rev-parse", "main");
    assert.equal(git(sample.repo, "rev-parse", "main"), theirs, "本地 main 没落下这次合并、同步到了远程那一头");
    assert.equal(git(sample.repo, "status", "--porcelain"), "");
    const row = await taskRow(sample.taskId);
    assert.equal(row.stage, "verified", "没推上去就不算合完");
    const issue = (await acceptGateState(sample.taskId)).baselineIssue;
    assert.equal(issue?.reason, "merge_conflict", JSON.stringify(issue));
    assert.deepEqual(issue?.conflictFiles, ["use-b.js"]);
    assert.ok(issue?.handoff, "冲突交回任务去解了（不是停在一句一般失败上）");
    assert.ok(existsSync(sample.cwd), "任务工作区还在");
  }

  // ② 不冲突：别人推的是另一个文件。按同步之后的 main 重跑门禁，绿了接着验收并推送。
  {
    const sample = await fixture("push-gate-clean", { baseline: "merge_preview" });
    const { remote, other } = withRemote(sample.repo, "push-gate-clean");
    raceOnPush(sample.repo, other, "theirs.txt", "theirs\n");
    await acceptTask(sample.taskId, "human", { push: true });
    await settled(sample.taskId, 2);
    const all = await runs(sample.taskId);
    assert.equal(all.length, 2, "目标分支变了：旧绿不拿来合，按新基准重跑了一遍");
    assert.ok(all.every((run) => run.status === "passed"));
    assert.equal(git(sample.repo, "merge-base", "--is-ancestor", all[1]!.previewBase!, "main"), "");
    assert.equal(git(sample.repo, "show", `${all[1]!.previewBase}:theirs.txt`), "theirs", "第二遍预演的是带着别人那个提交的 main");
    const row = await taskRow(sample.taskId);
    assert.equal(row.stage, "accepted");
    assert.equal(row.acceptedGateRunId, all[1]!.id, "凭据是按新基准跑的那一次");
    assert.equal(git(remote, "rev-parse", "main"), git(sample.repo, "rev-parse", "main"), "推上去了");
    assert.equal(git(remote, "show", "main:theirs.txt"), "theirs", "别人的提交还在");
    assert.equal(git(remote, "show", "main:use-b.js").includes("onDelivered"), true, "任务的改动也在");
  }
  console.log("accept push × gate: 推送期间远程又动 → 冲突交回任务 / 不冲突按新基准重跑门禁再推 通过");
} finally {
  await releaseTmpDb();
}
process.exit(0);
