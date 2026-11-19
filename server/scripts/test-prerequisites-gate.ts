// 前置的底层闸、工作区与并发（审查第 1 轮 F1–F7、N1、N2 那几类）。主场景在 test-prerequisites.ts。
//
//  G1 首次执行的每条入口都过闸：回复（暂存成待发送，等齐后作为首轮输入送达）、/fire、定时到点（runTask）、
//     排队消息补投（continueTask）在前置没站齐时一个字都不进执行器；
//  G2 工作区：先开过（预览）而原封未动的，开工时就地换到前置的代码；里面已有自己提交的，挡住并说清；
//     不用独立工作区的下游不能建在用 worktree 的前置上；
//  G3 前置压缩合入、目标分支后来又合进别的东西：下游从目标分支最新一版开工；
//  G4 证明不了就不算站稳：不用 worktree 的前置审过后项目目录又改了 → 审查后又改过；工作区已经清掉的，
//     拿审查锚定的提交对分支头，对上才算、分支后来又动了就不算；
//  G5 站稳判定交出它核实过的那一版，起点用那一版、不重读分支头；回合锁已占上、状态还没写 running 的算在跑；
//  G6 加前置与开工判定同时到：要么加上了、这次不开工，要么已开工、加前置被拒 —— 落定的边都带着交给它的版本；
//  G7 同一分组同时放行五条：最多四条在跑，有一条跑完第五条才起；
//  N1 停止能撤回「等齐就起」（连同等着一起开工的回复），之后前置站稳也不起；
//  N2 前置清单形状不对回 400，不是 500。
// 跑：npm -w server run test:prerequisites
import {
  acceptTask, commit, db, git, hasStarted, holdForPrerequisites, inputsOf, launchRecord, project, release,
  request, review, row, runs, setTaskStatus, setup, sleep, started, step, taskPrerequisites, tasks, teardown, until, view,
  prerequisiteStanding, taskWorkspace,
} from "./prerequisite-fixture.js";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const { runTask } = await import("../src/task-run.js");
const { continueTask } = await import("../src/orchestrator.js");
const { prerequisiteStart } = await import("../src/prerequisite-start-point.js");
const capacity = await import("../src/launch-capacity.js");

/** 一条前置：开出工作区、落一个提交，状态先停在 running（还没站稳）。 */
async function runningPrerequisite(p: Awaited<ReturnType<typeof project>>, suffix: string) {
  const id = await p.task(suffix);
  const ws = await p.finish(id);
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, id));
  return { id, ...ws };
}

try {
  await setup();

  // ── G1 首次执行的每条入口 ──────────────────────────────────────────────────
  {
    const p = await project();
    const a = await runningPrerequisite(p, "a");
    const b = await p.task("b", { prerequisites: [a.id] });
    let res = await request("POST", `/tasks/${b}/reply`, { text: "照这个方向开工：先写接口" });
    assert.equal(res.status, 202);
    assert.equal((await res.json() as { scheduled?: boolean }).scheduled, true, "回复：暂存成待发送，不直接开回合");
    res = await request("POST", `/tasks/${b}/fire`);
    assert.equal(res.status, 202);
    assert.equal((await res.json() as { waiting?: boolean }).waiting, true, "/fire：如实答在等，不谎报已触发");
    await runTask(b); // 定时到点走的就是它
    assert.equal(await continueTask(b, "排队消息补投"), false, "排队消息补投：没送出去");
    await sleep(300);
    assert.equal(hasStarted(b), false, "前置没站齐：一个字都没进执行器");
    assert.equal((await row(b)).status, "backlog");
    assert.ok((await launchRecord(b))?.requestedAt, "起跑请求记下了");
    started.push(b);
    await setTaskStatus(a.id, "done");
    await until("前置站稳：B 起跑", () => hasStarted(b));
    assert.ok(inputsOf(b).some((entry) => entry.input.includes("照这个方向开工：先写接口")), "暂存的回复作为首轮输入送达");
    assert.equal((await row(b)).worktreeStartCommit, a.head, "起点是前置的代码");
    release(b);
    console.log("✓ G1 回复、/fire、定时到点、排队补投都过前置闸；等齐后回复作为首轮输入送达");
  }

  // ── G2 工作区 ───────────────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await runningPrerequisite(p, "a");
    const q = await p.task("q", { prerequisites: [a.id] });
    const preview = await taskWorkspace(await row(q), p.repo); // 先点过「打开预览」
    const upstream = commit(a.path, "upstream.txt", "前置后来补的\n");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, a.id));
    assert.equal(await holdForPrerequisites({ id: q }, { source: "run" }), null);
    assert.equal(git(preview.path, "rev-parse", "HEAD"), upstream, "原封未动的工作区就地换到前置的代码");
    assert.ok(existsSync(join(preview.path, "upstream.txt")));
    assert.equal((await row(q)).worktreeStartCommit, upstream);

    const c = await runningPrerequisite(p, "c");
    const r = await p.task("r", { prerequisites: [c.id] });
    const touched = await taskWorkspace(await row(r), p.repo);
    commit(touched.path, "own.txt", "自己先写了\n");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, c.id));
    const hold = await holdForPrerequisites({ id: r }, { source: "run" });
    assert.match(hold?.reason ?? "", /已经有自己的改动或提交/);
    assert.match((await view(r)).blocked ?? "", /已经有自己的改动或提交/);
    assert.equal((await launchRecord(r))?.launchedAt ?? null, null, "没开工");

    const plain = await p.task("plain", { useWorktree: false });
    const added = await request("POST", `/tasks/${plain}/prerequisites`, { prerequisiteId: c.id });
    assert.equal(added.status, 400);
    assert.match((await added.json() as { error: string }).error, /不用独立工作区/);
    console.log("✓ G2 预览开过的工作区就地换到前置代码；已有提交的挡住；不用独立工作区的下游建不上");
  }

  // ── G3 压缩合入后再开工 ─────────────────────────────────────────────────────
  {
    const p = await project("squash");
    const x = await p.task("x");
    await p.finish(x);
    commit(p.path(x), "x2.txt", "第二个提交\n");
    assert.equal((await acceptTask(x)).accepted, true);
    const later = commit(p.repo, "later.txt", "别人后来合进来的\n");
    const w = await p.task("w", { prerequisites: [x] });
    await p.finish(w);
    assert.equal((await row(w)).worktreeStartCommit, later, "压缩合入的前置：从目标分支最新一版开工");
    for (const file of ["later.txt", `${x}.txt`, "x2.txt"]) assert.ok(existsSync(join(p.path(w), file)), `拿到了 ${file}`);
    console.log("✓ G3 前置压缩合入后，下游从目标分支最新一版开工");
  }

  // ── G4 证明不了就不算 ───────────────────────────────────────────────────────
  {
    const p = await project();
    const n = await p.task("n", { useWorktree: false, status: "done" });
    await review(n, "passed", "passed");
    assert.equal(await step(n), "settled");
    writeFileSync(join(p.repo, "edited-after-review.txt"), "审完又在项目目录里改\n");
    assert.equal(await step(n), "review_stale", "不用 worktree 的前置也核对审查锚点");
    rmSync(join(p.repo, "edited-after-review.txt"));

    const g = await p.task("g");
    const ws = await p.finish(g);
    await review(g, "passed", "passed");
    git(p.repo, "worktree", "remove", "--force", ws.path);
    const gone = await prerequisiteStanding(await row(g));
    assert.equal(gone.step, "settled", "工作区清掉了、分支头就是审过的那一版：算");
    assert.equal(gone.commit, ws.head);
    const moved = git(p.repo, "commit-tree", `${ws.head}^{tree}`, "-p", ws.head, "-m", "工作区外又动了分支");
    git(p.repo, "update-ref", `refs/heads/${ws.branch}`, moved);
    assert.equal(await step(g), "review_stale", "分支后来又动了：不算");
    console.log("✓ G4 不用 worktree 的前置核对审查锚点；工作区不在时拿审查锚定的提交对分支头");
  }

  // ── G5 交出核实过的那一版 ───────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    const ws = await p.finish(a);
    const standing = await prerequisiteStanding(await row(a));
    assert.equal(standing.commit, ws.head, "站稳时交出核实过的那一版");
    const turn = runs.claimOwnTurn(a);
    assert.ok(turn);
    assert.equal(await step(a), "running", "回合锁已占上、状态还没写 running：算在跑");
    runs.releaseTurn(a, turn!);
    const newer = commit(ws.path, "unreviewed.txt", "判定之后才提交的\n");
    const d = await p.task("d", { prerequisites: [a] });
    const start = await prerequisiteStart(p.repo, await row(d), [{ task: await row(a), commit: ws.head }]);
    assert.ok(start.ok);
    assert.equal(start.ok && start.commit, ws.head, "起点用核实过的那一版，不重读分支头");
    assert.notEqual(newer, ws.head);
    console.log("✓ G5 起点用站稳判定核实过的那一版；占着回合锁的前置算在跑");
  }

  // ── G6 加前置与开工判定同时到 ───────────────────────────────────────────────
  {
    const p = await project();
    for (const order of ["hold-first", "add-first"] as const) {
      const a = await p.task(`a-${order}`);
      await p.finish(a);
      const extra = await p.task(`extra-${order}`);
      const d = await p.task(`d-${order}`, { prerequisites: [a] });
      const add = () => request("POST", `/tasks/${d}/prerequisites`, { prerequisiteId: extra });
      const hold = () => holdForPrerequisites({ id: d }, { source: "run" });
      const [added, held] = order === "hold-first"
        ? await Promise.all([hold(), add()]).then(([h, r]) => [r, h] as const)
        : await Promise.all([add(), hold()]);
      const launched = !!(await launchRecord(d))?.launchedAt;
      const edges = await db.select().from(taskPrerequisites).where(eq(taskPrerequisites.taskId, d));
      if (added.status === 200) {
        assert.ok(held, `${order}：加上了新前置（还没开始），这一次不开工`);
        assert.equal(launched, false);
      } else {
        assert.equal(added.status, 409, `${order}：已开工，加前置被拒`);
        assert.equal(held, null);
        assert.equal(launched, true);
        assert.ok(edges.every((edge) => edge.inheritedCommit), "落定的边都带着交给它的版本");
      }
    }
    console.log("✓ G6 加前置与开工判定串行：边集合与起点一起落定");
  }

  // ── G7 名额 ─────────────────────────────────────────────────────────────────
  {
    // 名额数的是同组里占着执行回合的条数（launch-capacity.ts）：审查这类旁路回合不算；别的分组各算各的。
    {
      const q = await project();
      const other = await project();
      const ids: string[] = [];
      for (let index = 0; index < 5; index++) ids.push(await q.task(`c${index}`));
      const outsider = await other.task("c");
      const held = ids.slice(0, 4).map((id) => runs.claimOwnTurn(id)!);
      const fifth = await capacity.claimLaunchTurn(ids[4]!, q.group);
      assert.equal(fifth.ok ? "ok" : fifth.why, "full", "同组四条占着执行回合，第五条占不到");
      const elsewhere = await capacity.claimLaunchTurn(outsider, other.group);
      assert.ok(elsewhere.ok, "别的分组各算各的");
      runs.releaseTurn(outsider, elsewhere.turn);
      runs.releaseTurn(ids[0]!, held[0]!);
      const reviewer = runs.claimOwnTurn(ids[0]!, "reviewer")!;
      const after = await capacity.claimLaunchTurn(ids[4]!, q.group);
      assert.ok(after.ok, "腾出一条（换成审查回合不算数）就占得到");
      assert.equal(await capacity.runningInGroup(q.group), 4);
      runs.releaseTurn(ids[4]!, after.turn);
      runs.releaseTurn(ids[0]!, reviewer);
      for (const [index, turn] of held.slice(1).entries()) runs.releaseTurn(ids[index + 1]!, turn);
      assert.equal(await capacity.runningInGroup(q.group), 0);
    }

    const p = await project();
    const a = await runningPrerequisite(p, "a");
    const many = [];
    for (let index = 0; index < 5; index++) many.push(await p.task(`m${index}`, { prerequisites: [a.id] }));
    for (const id of many) assert.equal((await request("POST", `/tasks/${id}/run`)).status, 202);
    started.push(...many);
    await setTaskStatus(a.id, "done");
    await until("四条起跑", () => many.filter(hasStarted).length === 4);
    await sleep(500);
    assert.equal(many.filter(hasStarted).length, 4, "同时放行五条：最多四条在跑");
    release(many.find(hasStarted)!);
    await until("有一条跑完，第五条起", () => many.every(hasStarted));
    for (const id of many) release(id);
    console.log("✓ G7 名额数的是同组在跑的执行回合：同时放行五条最多四条在跑，跑完一条再补一条");
  }

  // ── N1 停止撤回等待 ─────────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await runningPrerequisite(p, "a");
    const b = await p.task("b", { prerequisites: [a.id] });
    assert.equal((await request("POST", `/tasks/${b}/reply`, { text: "等齐了就开工" })).status, 202);
    const stopped = await request("POST", `/tasks/${b}/stop`);
    assert.equal(stopped.status, 200, await stopped.clone().text());
    assert.equal((await launchRecord(b))?.requestedAt ?? null, null, "请求撤了");
    assert.equal((await view(b)).waiting, false, "页面上不再写在等");
    await setTaskStatus(a.id, "done");
    await sleep(800);
    assert.equal(hasStarted(b), false, "撤回之后前置站稳也不起");
    console.log("✓ N1 停止撤回「等齐就起」，连同等着一起开工的回复");
  }

  // ── N2 形状不对回 400 ───────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    assert.equal((await request("POST", `/tasks/${a}/prerequisites`, { prerequisiteIds: "x" })).status, 400);
    assert.equal((await request("POST", `/tasks/${a}/prerequisites`, { prerequisiteId: 3 })).status, 400);
    assert.equal((await request("POST", `/groups/${p.group}/tasks/batch`, { tasks: [{ body: "1", prerequisites: "x" }] })).status, 400);
    console.log("✓ N2 前置清单形状不对回 400");
  }
} finally {
  await teardown();
}
