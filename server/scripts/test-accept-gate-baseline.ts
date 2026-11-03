// 门禁基准三档（shared/src/accept-gate.ts 的 AcceptGateBaseline）的回归。
//
// 撞车场景照 2026-11-02 的真实事故搭：任务 B 从旧 main 开工、用着回调旧名 `onDelivered`；它开工
// 之后 main 上进了把它改名成 `onInputSettled` 的那次合并（任务 A）。B 自己分支的快照里两样都对得上，
// 所以门禁绿；合进 main 之后 main 红 —— 只有「合并预览」那一档测到合并之后那棵树。
//
// 每条路都把**批量预判**（acceptGateWouldRun）和**真按下去**（acceptTask）摆在一起断言：预判说
// 不跑而真按下去跑了（或反过来），统一验收就会停在半路。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const { baselineHarness } = await import("./accept-gate-baseline-fixture.js");
const h = await baselineHarness("ash-gate-baseline-");
const { root, git, sleep, passesOn, db, projects, acceptTask, acceptGateState, bus, previewMerge, mergeTaskBranch, api,
  runs, taskRow, projectRow, wouldRun, commitOnMain, fixture, settled } = h;

try {
  // ① 默认档 = 老行为：没设过的项目就是分支快照，撞车照旧漏过去（这正是要给用户的那颗开关的理由）。
  {
    const sample = await fixture("branch-default", { collide: true });
    assert.equal((await projectRow(sample.projectId)).acceptGateBaseline, "branch");
    assert.equal((await acceptGateState(sample.taskId)).baseline, "branch");
    assert.equal((await acceptGateState(sample.taskId)).baselineBlock, null);
    assert.equal(await wouldRun(sample), true);
    await acceptTask(sample.taskId);
    await settled(sample.taskId);
    const [row] = await runs(sample.taskId);
    assert.equal(row!.status, "passed", "分支快照里 B 的旧名还在，门禁是绿的");
    assert.equal(row!.previewBase, null);
    assert.equal(row!.previewCommit, null);
    assert.equal(row!.fastForward, false);
    assert.doesNotMatch(readFileSync(row!.logPath, "utf8"), /baseline:/, "默认档的日志与老版本一字不差");
    assert.equal((await taskRow(sample.taskId)).stage, "accepted");
    assert.equal(passesOn(sample.repo), false, "合进 main 之后 main 是红的 —— 默认档测不到这一棵");
  }

  // ② 要求已含目标分支 · 拒绝：不含 main 尖端就在跑之前拒，一条运行记录都不建，预判同样说不跑。
  {
    const sample = await fixture("contains-refuse", { baseline: "contains_target" });
    const state = await acceptGateState(sample.taskId);
    assert.equal(state.baseline, "contains_target");
    assert.match(state.baselineBlock ?? "", /git merge main/);
    assert.equal(await wouldRun(sample), false, "真按下去会被拒，预判不能说要跑");
    const refused = await acceptTask(sample.taskId);
    assert.equal(refused.accepted, false);
    if (!refused.accepted) {
      assert.equal(refused.reason, "accept_gate_target_behind");
      assert.match(refused.error, /还没包含 main 的最新提交.*有 1 个提交不在任务分支里/);
      assert.match(refused.error, /git merge main/);
    }
    assert.equal((await runs(sample.taskId)).length, 0);
    assert.equal((await taskRow(sample.taskId)).stage, "verified");
    // ② 放行：任务把 main 合进来之后，同一按就跑门禁并合上。
    git(sample.cwd, "merge", "--no-edit", "main");
    assert.equal((await acceptGateState(sample.taskId)).baselineBlock, null);
    assert.equal(await wouldRun(sample), true);
    await acceptTask(sample.taskId);
    await settled(sample.taskId);
    const [row] = await runs(sample.taskId);
    assert.equal(row!.status, "passed");
    assert.equal(row!.previewBase, null, "这一档测的仍是分支那棵树");
    assert.equal(row!.fastForward, true);
    assert.equal((await taskRow(sample.taskId)).stage, "accepted");
  }

  // ③ 合并预览 · 撞车被拦：门禁测预演的合并结果，红了不合，main 一动不动。
  {
    const sample = await fixture("preview-collision", { baseline: "merge_preview", collide: true });
    const mainBefore = git(sample.repo, "rev-parse", "main");
    const state = await acceptGateState(sample.taskId);
    assert.deepEqual(state.baselineTarget, { branch: "main", commit: mainBefore });
    assert.equal(state.baselineBlock, null);
    assert.equal(await wouldRun(sample), true);
    await acceptTask(sample.taskId);
    await settled(sample.taskId);
    const [row] = await runs(sample.taskId);
    assert.equal(row!.status, "failed");
    assert.equal(row!.failure, "exit_code");
    assert.equal(row!.previewBase, mainBefore, "预览基准记进 run");
    assert.ok(row!.previewCommit && row!.previewCommit !== row!.sourceCommit, "快照 HEAD 是那次预演合并");
    const log = readFileSync(row!.logPath, "utf8");
    assert.match(log, new RegExp(`baseline: 合并预览.*main = ${mainBefore}`), "日志写明预览基准是哪个 main 提交");
    assert.match(log, /onDelivered is gone/);
    assert.equal(git(sample.repo, "rev-parse", "main"), mainBefore, "预演只在快照里合，真仓库一个字节没动");
    assert.equal(git(sample.cwd, "rev-parse", "HEAD"), row!.sourceCommit, "任务分支也没被动过");
    assert.equal((await taskRow(sample.taskId)).stage, "verified");
    assert.equal(passesOn(sample.repo), true);
  }

  // ④ 合并预览 · 预演冲突：按冲突口径拒绝、不跑门禁；预判同样说不跑。
  {
    const sample = await fixture("preview-conflict", { baseline: "merge_preview" });
    writeFileSync(join(sample.cwd, "api.js"), "exports.onDelivered = () => 'task';\n");
    git(sample.cwd, "commit", "-am", "task edits api");
    commitOnMain(sample.repo, "api.js", "exports.onDelivered = () => 'main';\n", "main edits api");
    const mainBefore = git(sample.repo, "rev-parse", "main");
    assert.match((await acceptGateState(sample.taskId)).baselineBlock ?? "", /冲突/);
    assert.equal(await wouldRun(sample), false);
    const refused = await acceptTask(sample.taskId);
    assert.equal(refused.accepted, false);
    if (!refused.accepted) {
      assert.equal(refused.reason, "merge_conflict");
      assert.deepEqual(refused.conflictFiles, ["api.js"]);
      assert.equal(refused.targetBranch, "main");
      assert.ok(refused.sourceBranch);
    }
    assert.equal((await runs(sample.taskId)).length, 0, "冲突时不跑门禁");
    assert.equal(git(sample.repo, "rev-parse", "main"), mainBefore);
    assert.equal(git(sample.repo, "status", "--porcelain"), "");
  }

  // ⑤ 合并预览 · 复用指纹含目标分支尖端：main 没动 → 旧绿复用；main 动了 → 旧绿不复用，按新 main 重跑。
  {
    const sample = await fixture("preview-reuse", { baseline: "merge_preview", delay: 500 });
    const firstBase = git(sample.repo, "rev-parse", "main");
    await acceptTask(sample.taskId);
    // 门禁开跑之后在 main 的工作区里放一个未跟踪文件：绿了之后的续验收在合并前被它拦下，于是那份绿
    // 留在原地，正好拿来问「它还作不作数」。（跑之前放会被廉价的合并阻塞检查先拦掉，门禁根本不跑。）
    writeFileSync(join(sample.repo, "blocker.txt"), "blocks the merge\n");
    await settled(sample.taskId);
    const [first] = await runs(sample.taskId);
    assert.equal(first!.status, "passed");
    assert.equal(first!.previewBase, firstBase);
    assert.equal((await taskRow(sample.taskId)).stage, "verified");
    assert.equal((await acceptGateState(sample.taskId)).latest?.stale, false);
    assert.equal(await wouldRun(sample), false, "main 没动：同一份预演结果可以直接复用");
    // main 前进了（别的任务的合并）：那份绿预演的不是这一次要合的那一棵。
    commitOnMain(sample.repo, "later.txt", "later\n", "another merge lands on main");
    const secondBase = git(sample.repo, "rev-parse", "main");
    assert.equal((await acceptGateState(sample.taskId)).latest?.stale, true);
    assert.equal(await wouldRun(sample), true, "main 动了：预判必须说要重跑");
    rmSync(join(sample.repo, "blocker.txt"));
    await acceptTask(sample.taskId);
    await settled(sample.taskId, 2);
    const all = await runs(sample.taskId);
    assert.equal(all.length, 2, "旧绿没被拿来合新 main");
    assert.equal(all[1]!.status, "passed");
    assert.equal(all[1]!.previewBase, secondBase);
    const accepted = await taskRow(sample.taskId);
    assert.equal(accepted.stage, "accepted");
    assert.equal(accepted.acceptedGateRunId, all[1]!.id, "凭据是按新 main 预演的那一次");
    assert.equal(existsSync(join(sample.repo, "later.txt")), true);
  }

  // ⑥ 合并预览 · 跑的那十几分钟里 main 又进了合并：绿了之后自动续验收时核出基准过期，按新 main 再跑一遍。
  {
    const sample = await fixture("preview-drift", { baseline: "merge_preview", delay: 600 });
    await acceptTask(sample.taskId);
    await sleep(150);
    commitOnMain(sample.repo, "during.txt", "during\n", "merge lands while the gate runs");
    const latestMain = git(sample.repo, "rev-parse", "main");
    await settled(sample.taskId, 2);
    const all = await runs(sample.taskId);
    assert.equal(all.length, 2);
    assert.notEqual(all[0]!.previewBase, latestMain);
    assert.equal(all[1]!.previewBase, latestMain);
    const accepted = await taskRow(sample.taskId);
    assert.equal(accepted.stage, "accepted");
    assert.equal(accepted.acceptedGateRunId, all[1]!.id);
  }

  // ㉕ 合并预览 · 跑的那会儿项目把 core.autocrlf 打开了（第 3 轮复审 F1）：树一个字节没动，但合进去之后
  // 检出的是 CRLF。凭据记着快照实际用的转换配置，自动续验收核出它变了，按新配置重跑（这次红了），不合。
  {
    const sample = await fixture("preview-autocrlf-drift", { baseline: "merge_preview", delay: 600 });
    writeFileSync(join(sample.repo, ".gitattributes"), "*.txt text\n");
    writeFileSync(join(sample.repo, "value.txt"), "good\n");
    writeFileSync(join(sample.repo, "use-lf.js"),
      "if (require('node:fs').readFileSync(__dirname + '/value.txt').includes(13)) throw new Error('CRLF');\n");
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "main adds an LF-checked text file");
    git(sample.cwd, "merge", "--no-edit", "main");
    commitOnMain(sample.repo, "later.txt", "later\n", "main moves on");
    const before = git(sample.repo, "rev-parse", "main");
    await acceptTask(sample.taskId);
    await sleep(150);
    git(sample.repo, "config", "core.autocrlf", "true");
    await settled(sample.taskId, 2);
    const all = await runs(sample.taskId);
    assert.equal(all.length, 2);
    assert.equal(all[0]!.status, "passed");
    assert.equal(all[0]!.previewTree, all[1]!.previewTree, "树没变");
    assert.notEqual(all[0]!.previewMaterialization, all[1]!.previewMaterialization);
    assert.equal(all[1]!.status, "failed", "按新配置检出的是 CRLF，同一条命令红了");
    assert.notEqual((await taskRow(sample.taskId)).stage, "accepted");
    assert.equal(git(sample.repo, "rev-parse", "main"), before, "没有合进去");
    git(sample.repo, "config", "--unset", "core.autocrlf");
  }

  // ⑦ 设置入口：只收三档原文；改了立刻作用于下一次验收的判定（门禁卡读的同一份）。
  {
    const sample = await fixture("setting", {});
    const bad = await api.request(`/projects/${sample.projectId}`, { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ acceptGateBaseline: "preview" }) });
    assert.equal(bad.status, 400);
    assert.equal((await projectRow(sample.projectId)).acceptGateBaseline, "branch");
    // 每次改都发项目级事件：别的页面（停在项目设置上的那一个）靠它重拉项目，不只是任务卡片。
    const published: string[] = [];
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === "project.updated") published.push(event.projectId);
    });
    for (const mode of ["contains_target", "merge_preview", "branch"] as const) {
      const response = await api.request(`/projects/${sample.projectId}`, { method: "PATCH",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ acceptGateBaseline: mode }) });
      assert.equal(response.status, 200);
      assert.equal((await acceptGateState(sample.taskId)).baseline, mode);
      assert.equal(await wouldRun(sample), mode !== "contains_target");
    }
    unsubscribe();
    assert.deepEqual(published, [sample.projectId, sample.projectId, sample.projectId]);
  }

  // ⑧ 合并预览 · 仓库配了外部合并驱动：预演会执行它，所以在预演之前就拒，三个入口（看卡片、批量
  // 预判、真按下去）一个都不许把它跑起来。
  {
    const sample = await fixture("preview-driver", { baseline: "merge_preview" });
    const marker = join(root, "driver-ran");
    git(sample.repo, "config", "merge.review.driver", `touch '${marker}'; false`);
    writeFileSync(join(sample.cwd, ".gitattributes"), "data.txt merge=review\n");
    writeFileSync(join(sample.cwd, "data.txt"), "task\n");
    git(sample.cwd, "add", "-A");
    git(sample.cwd, "commit", "-m", "task edits data");
    writeFileSync(join(sample.repo, "data.txt"), "main\n");
    git(sample.repo, "add", "data.txt");
    git(sample.repo, "commit", "-m", "main edits data");
    assert.match((await acceptGateState(sample.taskId)).baselineBlock ?? "", /合并驱动（review）/);
    assert.equal(await wouldRun(sample), false);
    const refused = await acceptTask(sample.taskId);
    assert.equal(refused.accepted, false);
    if (!refused.accepted) assert.equal(refused.reason, "accept_gate_preview_unavailable");
    assert.equal(existsSync(marker), false, "门禁命令之外没有执行项目配的合并驱动");
    assert.equal((await runs(sample.taskId)).length, 0);
  }

  // ⑨ 合并预览 · 有方向的内置驱动（merge=union）：两边改同一个文件、git 能自动合。门禁测的必须
  // 就是真合并那一棵 —— 快照里反向再合一次会合出 task 在前的另一棵树，从前因此永远建不起快照。
  {
    const sample = await fixture("preview-union", { baseline: "merge_preview" });
    writeFileSync(join(sample.repo, ".gitattributes"), "data.txt merge=union\n");
    writeFileSync(join(sample.repo, "data.txt"), "seed\n");
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "union attribute");
    git(sample.cwd, "merge", "--no-edit", "main");
    writeFileSync(join(sample.cwd, "data.txt"), "task\n");
    git(sample.cwd, "commit", "-am", "task edits data");
    writeFileSync(join(sample.repo, "data.txt"), "main\n");
    git(sample.repo, "commit", "-am", "main edits data");
    await acceptTask(sample.taskId);
    await settled(sample.taskId);
    const [row] = await runs(sample.taskId);
    assert.equal(row!.status, "passed", row!.failure ?? "");
    assert.ok(row!.previewCommit);
    assert.equal((await taskRow(sample.taskId)).stage, "accepted");
    assert.equal(readFileSync(join(sample.repo, "data.txt"), "utf8"), "main\ntask\n", "真合并：目标分支在前");
  }

  // ⑩ 预演执行层本身不执行项目程序：上面⑧那道提前判断漏判时（它只为把话说清楚），预演照样没有
  // 程序可调 —— 隔离的 git 目录里没有任何驱动定义，属性点名的驱动退回内置合并。
  {
    const repo = join(root, "isolated-preview");
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.name", "Gate Baseline Test");
    git(repo, "config", "user.email", "baseline@example.test");
    const marker = join(root, "isolated-driver-ran");
    git(repo, "config", "merge.review.driver", `touch '${marker}'; false`);
    writeFileSync(join(repo, ".gitattributes"), "data.txt merge=review\n");
    writeFileSync(join(repo, "data.txt"), "one\ntwo\nthree\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "seed");
    git(repo, "checkout", "-b", "task");
    writeFileSync(join(repo, "data.txt"), "ONE\ntwo\nthree\n");
    git(repo, "commit", "-am", "task edits the first line");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "main");
    writeFileSync(join(repo, "data.txt"), "one\ntwo\nTHREE\n");
    git(repo, "commit", "-am", "main edits the last line");
    const merged = await previewMerge(repo, git(repo, "rev-parse", "main"), head);
    assert.ok("tree" in merged, JSON.stringify(merged));
    assert.equal(existsSync(marker), false, "预演没有执行仓库配的合并驱动");
    if ("tree" in merged) assert.equal(git(repo, "show", `${merged.tree}:data.txt`), "ONE\ntwo\nTHREE");
  }

  // ⑪ 合并预览 · 目标分支带进来的文件要过过滤器：在快照里检出它就会执行那段程序，所以预演之前就拒。
  {
    const sample = await fixture("preview-filter", { baseline: "merge_preview" });
    const marker = join(root, "filter-ran");
    git(sample.repo, "config", "filter.review.smudge", `touch '${marker}'; cat`);
    git(sample.repo, "config", "filter.review.clean", "cat");
    writeFileSync(join(sample.repo, ".gitattributes"), "target.txt filter=review\n");
    writeFileSync(join(sample.repo, "target.txt"), "target\n");
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "main adds a filtered file");
    rmSync(marker, { force: true });
    assert.match((await acceptGateState(sample.taskId)).baselineBlock ?? "", /过滤器/);
    assert.equal(await wouldRun(sample), false);
    const refused = await acceptTask(sample.taskId);
    assert.equal(refused.accepted, false);
    if (!refused.accepted) assert.equal(refused.reason, "accept_gate_preview_unavailable");
    assert.equal(existsSync(marker), false, "没有为预演或快照执行过滤器");
    assert.equal((await runs(sample.taskId)).length, 0);
  }

  // ⑫ 合并预览 · 两个提交没动、合并配置变了：合出来的是另一棵树，旧绿不作数；最终合并只许落下测过的那棵。
  {
    const sample = await fixture("preview-config", { baseline: "merge_preview", delay: 500 });
    mkdirSync(join(sample.repo, "dir"));
    writeFileSync(join(sample.repo, "dir", "a.txt"), "seed\n");
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "main adds dir");
    git(sample.cwd, "merge", "--no-edit", "main");
    writeFileSync(join(sample.cwd, "dir", "b.txt"), "task\n");
    git(sample.cwd, "add", "-A");
    git(sample.cwd, "commit", "-m", "task adds dir/b.txt");
    git(sample.repo, "mv", "dir", "renamed");
    git(sample.repo, "commit", "-m", "main renames dir");
    git(sample.repo, "config", "merge.directoryRenames", "true");
    await acceptTask(sample.taskId);
    writeFileSync(join(sample.repo, "blocker.txt"), "blocks the merge\n");
    await settled(sample.taskId);
    const [first] = await runs(sample.taskId);
    assert.equal(first!.status, "passed");
    assert.ok(first!.previewTree);
    assert.equal((await acceptGateState(sample.taskId)).latest?.stale, false);
    assert.equal(await wouldRun(sample), false);
    git(sample.repo, "config", "merge.directoryRenames", "false");
    assert.equal((await acceptGateState(sample.taskId)).latest?.stale, true, "同样两个提交，合并配置变了就不是测过的那棵");
    assert.equal(await wouldRun(sample), true);
    rmSync(join(sample.repo, "blocker.txt"));
    const mainBefore = git(sample.repo, "rev-parse", "main");
    const landed = await mergeTaskBranch(sample.repo, sample.taskId, "main", "safe",
      { sourceCommit: first!.sourceCommit!, expectedTree: first!.previewTree! });
    assert.equal(landed.ok, false, "合出来的不是测过的那棵树就不落");
    if (!landed.ok) assert.match(landed.message, /不是验收前置命令测过的那一棵/);
    assert.equal(git(sample.repo, "rev-parse", "main"), mainBefore);
    assert.equal(git(sample.repo, "status", "--porcelain"), "");
  }

  // ⑬ 合并预览 · 主检出的本地属性把过滤器掩掉了，克隆里却没有那份覆盖（第 1 轮复审 F1）：提前判断放行，
  // 快照照样不许执行它 —— 硬边界在实际检出的那个环境里。过滤器定义在全局配置（克隆也读得到的那一层）。
  {
    const globalConfig = join(root, "global-gitconfig");
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    const marker = join(root, "masked-filter-ran");
    writeFileSync(globalConfig, `[filter "review"]\n\tsmudge = touch '${marker}'; cat\n\tclean = cat\n`);
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const sample = await fixture("preview-masked-filter", { baseline: "merge_preview" });
      writeFileSync(join(sample.repo, ".gitattributes"), "target.txt filter=review\n");
      writeFileSync(join(sample.repo, "target.txt"), "target\n");
      git(sample.repo, "add", "-A");
      git(sample.repo, "commit", "-m", "main adds a filtered file");
      mkdirSync(join(sample.repo, ".git", "info"), { recursive: true });
      writeFileSync(join(sample.repo, ".git", "info", "attributes"), "target.txt -filter\n");
      rmSync(marker, { force: true });
      assert.equal((await acceptGateState(sample.taskId)).baselineBlock, null, "主检出里这个文件确实不过滤");
      await acceptTask(sample.taskId);
      await settled(sample.taskId);
      const [row] = await runs(sample.taskId);
      assert.equal(row!.status, "passed", row!.failure ?? "");
      assert.ok(row!.previewCommit);
      assert.equal(existsSync(marker), false, "快照检出没有执行全局配的过滤器");
    } finally {
      if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    }
  }

  // ⑯ 合并预览 · 过滤器定义经 init.templateDir 抄进了克隆的本地配置（第 2 轮复审 F1）：快照的本地配置
  // 整份换成 ash 核定的那一份，模板带进来的东西一行都不留，检出照样没有程序可调。
  {
    const globalConfig = join(root, "template-gitconfig");
    const template = join(root, "git-template");
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    const marker = join(root, "template-filter-ran");
    mkdirSync(template);
    writeFileSync(join(template, "config"), `[filter "review"]\n\tsmudge = touch '${marker}'; cat\n\tclean = cat\n`);
    writeFileSync(globalConfig, `[init]\n\ttemplateDir = ${template}\n`);
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const sample = await fixture("preview-template-filter", { baseline: "merge_preview" });
      writeFileSync(join(sample.repo, ".gitattributes"), "target.txt filter=review\n");
      writeFileSync(join(sample.repo, "target.txt"), "target\n");
      git(sample.repo, "add", "-A");
      git(sample.repo, "commit", "-m", "main adds a filtered file");
      mkdirSync(join(sample.repo, ".git", "info"), { recursive: true });
      writeFileSync(join(sample.repo, ".git", "info", "attributes"), "target.txt -filter\n");
      rmSync(marker, { force: true });
      assert.equal((await acceptGateState(sample.taskId)).baselineBlock, null);
      await acceptTask(sample.taskId);
      await settled(sample.taskId);
      const [row] = await runs(sample.taskId);
      assert.equal(row!.status, "passed", row!.failure ?? "");
      assert.equal(existsSync(marker), false, "模板抄进克隆的过滤器没有被执行");
    } finally {
      if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    }
  }

  // ⑰ 合并预览 · 项目本地开了 core.autocrlf（第 2 轮复审 F2）：快照检出与收尾核验读同一份转换配置，
  // 只读的门禁命令绿了就是绿了，不会把 CRLF 当成「测试改了源码」。
  {
    const sample = await fixture("preview-autocrlf", { baseline: "merge_preview" });
    git(sample.repo, "config", "core.autocrlf", "true");
    commitOnMain(sample.repo, "target.txt", "target\n", "main adds a text file");
    await acceptTask(sample.taskId);
    await settled(sample.taskId);
    const [row] = await runs(sample.taskId);
    assert.equal(row!.status, "passed", row!.failure ?? "");
    assert.equal((await taskRow(sample.taskId)).stage, "accepted");
  }

  // ⑱ 最终合并 · 树对不上、撤回也失败（第 1 轮审查 F1）：不许再说「目标分支没动」，要如实报出它现在在哪、
  // 合并之前在哪、怎么退回。撤回失败用合并之后的钩子留一把 index.lock 注入。
  {
    const sample = await fixture("rollback-failure", {});
    const hook = join(sample.repo, ".git", "hooks", "post-merge");
    writeFileSync(hook, "#!/bin/sh\ntouch \"$(git rev-parse --git-dir)/index.lock\"\n", { mode: 0o755 });
    const before = git(sample.repo, "rev-parse", "main");
    const landed = await mergeTaskBranch(sample.repo, sample.taskId, "main", "safe",
      { sourceCommit: git(sample.cwd, "rev-parse", "HEAD"), expectedTree: git(sample.repo, "rev-parse", "main^{tree}") });
    const after = git(sample.repo, "rev-parse", "main");
    assert.equal(landed.ok, false);
    assert.notEqual(after, before, "注入成功：撤回确实没做成");
    if (!landed.ok) {
      assert.doesNotMatch(landed.message, /目标分支没动/);
      assert.match(landed.message, /没能撤回/);
      assert.ok(landed.message.includes(after.slice(0, 12)) && landed.message.includes(before), landed.message);
    }
    rmSync(join(sample.repo, ".git", "index.lock"), { force: true });
  }

  // ⑲ 合并预览 · 目标分支改了随仓库提交的依赖目录（第 1 轮审查 F2）：快照里依赖目录借的是任务工作区那份
  // 旧的，放不下合并后的内容，门禁之前就拒。
  {
    const sample = await fixture("preview-tracked-vendor", { baseline: "merge_preview" });
    mkdirSync(join(sample.repo, "vendor"));
    commitOnMain(sample.repo, "vendor/value.txt", "SAFE\n", "main commits vendor");
    git(sample.cwd, "merge", "--no-edit", "main");
    commitOnMain(sample.repo, "vendor/value.txt", "BROKEN\n", "main updates vendor");
    assert.match((await acceptGateState(sample.taskId)).baselineBlock ?? "", /依赖内容（vendor）/);
    assert.equal(await wouldRun(sample), false);
    const refused = await acceptTask(sample.taskId);
    assert.equal(refused.accepted, false);
    if (!refused.accepted) assert.equal(refused.reason, "accept_gate_preview_unavailable");
    assert.equal((await runs(sample.taskId)).length, 0);
  }

  // ㉑ 合并预览 · 依赖根是一条指回仓库别处的链（vendor -> shared，第 2 轮审查 F1）：借进来的是工作区里
  // shared 那棵旧树，比的必须是借用实际读取的落点，不是目录名。
  {
    const sample = await fixture("preview-linked-vendor", { baseline: "merge_preview" });
    mkdirSync(join(sample.repo, "shared"));
    writeFileSync(join(sample.repo, "shared", "value.txt"), "SAFE\n");
    symlinkSync("shared", join(sample.repo, "vendor"));
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "main commits vendor -> shared");
    git(sample.cwd, "merge", "--no-edit", "main");
    commitOnMain(sample.repo, "shared/value.txt", "BROKEN\n", "main updates shared");
    assert.match((await acceptGateState(sample.taskId)).baselineBlock ?? "", /依赖内容（[^）]*shared/);
    assert.equal(await wouldRun(sample), false);
    const refused = await acceptTask(sample.taskId);
    assert.equal(refused.accepted, false);
    if (!refused.accepted) assert.equal(refused.reason, "accept_gate_preview_unavailable");
    assert.equal((await runs(sample.taskId)).length, 0);
  }

  // ㉒ 只是打开验收台（读门禁状态）不许调起项目程序（第 2 轮审查 F2）：diff-tree / check-attr / status
  // 读索引就会跑 core.fsmonitor。合并预览档、设了与没设门禁命令都一样。
  {
    const sample = await fixture("state-fsmonitor", { baseline: "merge_preview" });
    const marker = join(root, "fsmonitor-ran");
    const monitor = join(root, "fsmonitor.sh");
    writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(sample.repo, "config", "core.fsmonitor", monitor);
    rmSync(marker, { force: true });
    await acceptGateState(sample.taskId);
    assert.equal(await wouldRun(sample), true);
    assert.equal(existsSync(marker), false, "设了门禁：读状态、预判都没有调起 fsmonitor");
    await db.update(projects).set({ acceptGateCommand: null }).where(eq(projects.id, sample.projectId));
    await acceptGateState(sample.taskId);
    assert.equal(existsSync(marker), false, "没设门禁：读状态没有调起 fsmonitor");
    git(sample.repo, "config", "--unset", "core.fsmonitor");
  }

  // ⑳ 合并预览 · 一个这次没改过、平时一直靠过滤器检出的老文件（第 1 轮审查 F3）：封好的快照检出整棵树，
  // 它也会被写成另一份，所以过滤器检查问整棵树而不只是这次的改动。
  {
    const sample = await fixture("preview-existing-filter", { baseline: "merge_preview" });
    const marker = join(root, "existing-filter-ran");
    writeFileSync(join(sample.repo, ".gitattributes"), "value.txt filter=review\n");
    writeFileSync(join(sample.repo, "value.txt"), "SAFE\n");
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "main adds a filtered file");
    git(sample.cwd, "merge", "--no-edit", "main");
    commitOnMain(sample.repo, "later.txt", "later\n", "main moves on");
    git(sample.repo, "config", "filter.review.smudge", `touch '${marker}'; cat`);
    git(sample.repo, "config", "filter.review.clean", "cat");
    assert.match((await acceptGateState(sample.taskId)).baselineBlock ?? "", /过滤器（review）/);
    assert.equal(await wouldRun(sample), false);
    const refused = await acceptTask(sample.taskId);
    assert.equal(refused.accepted, false);
    if (!refused.accepted) assert.equal(refused.reason, "accept_gate_preview_unavailable");
    assert.equal(existsSync(marker), false);
    assert.equal((await runs(sample.taskId)).length, 0);
  }

  // ㉓ 合并预览 · 主检出的 info/attributes 给 *.txt 配了 CRLF 转换（第 3 轮审查 F1）：快照只认树里的
  // .gitattributes，写出来的字节和平时检出的不是一份，门禁之前就拒，不许「快照绿、合进去红」。
  {
    const sample = await fixture("preview-info-attributes", { baseline: "merge_preview" });
    writeFileSync(join(sample.repo, ".git", "info", "attributes"), "*.txt text eol=crlf\n");
    assert.match((await acceptGateState(sample.taskId)).baselineBlock ?? "", /换行 \/ 编码转换的（unrelated\.txt）/);
    assert.equal(await wouldRun(sample), false);
    const refused = await acceptTask(sample.taskId);
    assert.equal(refused.accepted, false);
    if (!refused.accepted) assert.equal(refused.reason, "accept_gate_preview_unavailable");
    assert.equal((await runs(sample.taskId)).length, 0);
  }

  // ㉔ 合并预览 · 任务已含目标分支、不用合（第 3 轮审查 F2）：快照照样走封好的环境。全局配置里定义的
  // smudge 没被屏蔽时先拒；用 info/attributes 屏蔽后放行，检出快照也不许调起它。
  {
    const sample = await fixture("preview-contained-sealed", { baseline: "merge_preview" });
    writeFileSync(join(sample.repo, ".gitattributes"), "value.txt filter=preview-smudge\n");
    writeFileSync(join(sample.repo, "value.txt"), "SAFE\n");
    git(sample.repo, "add", "-A");
    git(sample.repo, "commit", "-m", "main adds a filtered file");
    git(sample.cwd, "merge", "--no-edit", "main");
    const marker = join(root, "contained-smudge-ran");
    const globalConfig = join(root, "contained.gitconfig");
    writeFileSync(globalConfig, `[filter "preview-smudge"]\n\tsmudge = touch '${marker}'; cat\n\tclean = cat\n`);
    const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      assert.match((await acceptGateState(sample.taskId)).baselineBlock ?? "", /过滤器（preview-smudge）/);
      assert.equal(await wouldRun(sample), false);
      writeFileSync(join(sample.repo, ".git", "info", "attributes"), "value.txt -filter\n");
      assert.equal((await acceptGateState(sample.taskId)).baselineBlock, null);
      assert.equal(await wouldRun(sample), true);
      const target = git(sample.repo, "rev-parse", "main");
      await acceptTask(sample.taskId);
      await settled(sample.taskId);
      const [row] = await runs(sample.taskId);
      assert.equal(row!.status, "passed", row!.failure ?? "");
      assert.equal(row!.previewBase, target);
      assert.equal(row!.previewCommit, null, "已含目标分支：不合，测的就是分支那棵树");
      assert.equal(existsSync(marker), false, "快照检出没有调起全局配置里的 smudge");
      assert.equal((await taskRow(sample.taskId)).stage, "accepted");
    } finally {
      if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
    }
  }

  // ⑭ SHA-256 仓库也能预演：隔离目录按项目的对象格式建（与上面 SHA-1 的那份并存）。
  {
    const repo = join(root, "sha256-preview");
    execFileSync("git", ["init", "-q", "--object-format=sha256", "-b", "main", repo]);
    git(repo, "config", "user.name", "Gate Baseline Test");
    git(repo, "config", "user.email", "baseline@example.test");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "seed");
    git(repo, "checkout", "-b", "task");
    writeFileSync(join(repo, "task.txt"), "task\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "task");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "main");
    writeFileSync(join(repo, "main.txt"), "main\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "main");
    const merged = await previewMerge(repo, git(repo, "rev-parse", "main"), head);
    assert.ok("tree" in merged, JSON.stringify(merged));
    if ("tree" in merged) assert.equal(git(repo, "ls-tree", "--name-only", merged.tree), "main.txt\nseed.txt\ntask.txt");
  }

  // ⑮ 子进程没读完 stdin 就退出：写端的 EPIPE 收在执行助手里，调用方只拿到一次命令失败。
  {
    const { execFileText } = await import("../src/exec.js");
    const failed = await execFileText("git", ["-C", root, "check-attr", "--source=no-such-ref", "-z", "--stdin", "merge"],
      { input: "some/path/file.txt\0".repeat(100000) }).then(() => false, () => true);
    assert.equal(failed, true);
  }

  console.log(JSON.stringify({ branchDefault: true, containsRefuse: true, containsPass: true, previewCollision: true,
    previewConflict: true, previewReuse: true, previewDrift: true, setting: true, previewDriver: true, previewUnion: true,
    isolatedPreview: true, previewFilter: true, previewConfig: true, maskedFilter: true, sha256Preview: true, stdinEpipe: true, templateFilter: true, autocrlf: true, rollbackFailure: true, trackedVendor: true, existingFilter: true, linkedVendor: true, stateFsmonitor: true,
    infoAttributes: true, containedSealed: true, autocrlfDrift: true }));
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
