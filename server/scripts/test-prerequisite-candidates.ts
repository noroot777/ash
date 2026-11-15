// 「建在谁上面」的候选（prerequisite-candidates.ts）和界面那条建任务的路：
//
//  C1 新建面板问的：本项目的任务全部列出；团队任务、团队执行者、已归档的不能选，各写原因；能选的写它到哪一步了；
//     选了一条之后合入分支跟着它走，合入别的分支的那条置灰；不用 worktree 时，代码还在分支上的前置置灰；
//  C2 已有的任务问的：已经是前置的、加上会成环的置灰；开工之后加不了也减不了（不再逐条判）；
//  C3 建任务时一次请求写两条前置，要求运行时前置没齐：回「在等」、不是挡回，也不是「开不了工」。
//
// 跑：npm -w server run test:prerequisites
import { at, db, project, request, setup, tasks, teardown } from "./prerequisite-fixture.js";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { taskPrerequisites } from "./prerequisite-fixture.js";
import type { PrerequisiteCandidates } from "@ash/shared/prerequisites";

const candidates = async (projectId: string, query: string) => {
  const res = await request("GET", `/projects/${projectId}/prerequisite-candidates?${query}`);
  assert.equal(res.status, 200);
  return await res.json() as PrerequisiteCandidates;
};
const problemOf = (list: PrerequisiteCandidates, id: string) => {
  const found = list.candidates.find((item) => item.taskId === id);
  assert.ok(found, `候选里要有 ${id}`);
  return found.problem;
};

try {
  await setup();

  // ── C1 新建面板 ────────────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    const lead = await p.task("lead");
    await db.update(tasks).set({ mode: "team" }).where(eq(tasks.id, lead));
    const worker = await p.task("worker");
    await db.update(tasks).set({ parentId: lead }).where(eq(tasks.id, worker));
    const shelved = await p.task("shelved");
    await db.update(tasks).set({ archived: true }).where(eq(tasks.id, shelved));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["-C", p.repo, "branch", "other"]);
    const elsewhere = await p.task("elsewhere", { mergeTargetBranch: "other" });
    const plain = await p.task("plain", { useWorktree: false });

    let list = await candidates(p.key, "useWorktree=1");
    assert.equal(list.locked, null);
    assert.equal(list.mergeTargetBranch, null, "一条都没选：合入分支照常按项目分支定");
    const ids = list.candidates.map((item) => item.taskId).sort();
    assert.deepEqual(ids, [a, elsewhere, lead, plain, shelved, worker].sort(), "本项目的任务全部列出");
    assert.equal(problemOf(list, a), null);
    assert.equal(list.candidates.find((item) => item.taskId === a)!.step, "not_started", "能选的写它此刻到哪一步了");
    assert.equal(problemOf(list, lead), "团队任务");
    assert.equal(problemOf(list, worker), "团队执行者");
    assert.equal(problemOf(list, shelved), "已归档");
    assert.equal(list.candidates.find((item) => item.taskId === lead)!.step, null, "不能选的不写步骤");
    assert.equal(problemOf(list, elsewhere), null, "还没选别的：哪条分支都行");

    list = await candidates(p.key, `useWorktree=1&selected=${a}`);
    assert.equal(list.mergeTargetBranch, "main", "合入分支跟着已选的前置走");
    assert.match(problemOf(list, elsewhere) ?? "", /合入 other，不是 main/, "合入别的分支的不能跟它选到一起");
    list = await candidates(p.key, `useWorktree=1&selected=${elsewhere},${a}`);
    assert.equal(list.mergeTargetBranch, "other", "按选的先后，第一条定下合入分支");
    assert.match(problemOf(list, a) ?? "", /合入 main，不是 other/, "已选里对不上的那条也如实标出");

    list = await candidates(p.key, "useWorktree=0");
    assert.match(problemOf(list, a) ?? "", /不用 worktree 拿不到/, "不用 worktree：代码还在分支上的前置拿不到");
    assert.equal(problemOf(list, plain), null, "前置自己也在项目目录里干活的，照服务端判据能选");
    assert.equal(list.mergeTargetBranch, null);
  }

  // ── C2 已有的任务 ──────────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    const b = await p.task("b", { prerequisites: [a] });
    const c = await p.task("c", { prerequisites: [b] });
    const loose = await p.task("loose");
    let list = await candidates(p.key, `taskId=${b}`);
    assert.equal(list.locked, null);
    assert.equal(list.removable, true);
    assert.equal(problemOf(list, a), "已经是前置");
    assert.match(problemOf(list, c) ?? "", /成环/);
    assert.equal(problemOf(list, loose), null);
    assert.equal(list.candidates.some((item) => item.taskId === b), false, "不列它自己");

    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, b));
    list = await candidates(p.key, `taskId=${b}`);
    assert.match(list.locked ?? "", /已经开工/, "起点定下来之后加不了");
    assert.equal(list.removable, false, "也减不了");
    assert.deepEqual(list.candidates, []);
    await db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, b));
  }

  // ── C3 建任务时一次写两条前置，前置没齐就等 ─────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    const b = await p.task("b");
    let res = await request("POST", "/tasks", {
      projectId: p.key, title: "建在两条上面", body: "test", mode: "single", agentType: "claude", useWorktree: true,
      worktreeBase: null, mergeTargetBranch: "main", workflowMode: "free", prerequisites: [a, b], createdAt: at,
    });
    assert.equal(res.status, 201, await res.clone().text());
    const created = await res.json() as { id: string };
    const edges = await db.select().from(taskPrerequisites).where(eq(taskPrerequisites.taskId, created.id));
    assert.deepEqual(edges.map((edge) => edge.prerequisiteId).sort(), [a, b].sort(), "两条前置随建任务一起写进去");
    res = await request("POST", `/tasks/${created.id}/run`);
    assert.equal(res.status, 202);
    const body = await res.json() as { started: boolean; waiting: boolean; blocked: boolean; reason: string };
    assert.equal(body.started, false);
    assert.equal(body.waiting, true, "前置没齐：记成等齐就起");
    assert.equal(body.blocked, false, "这是在等，不是开不了工");
    assert.match(body.reason, /在等前置/);
  }

  console.log("prerequisite candidates: draft/existing candidates, merge target follow, one-request create, waiting run passed");
} finally {
  await teardown();
}
