// 前置的交付证明、起点、恢复与并发（审查第 2 轮 F1–F6、N1、N2，第 3 轮 1–3 那几类）。主场景在 test-prerequisites.ts，
// 底层闸在 test-prerequisites-gate.ts。
//
//  R1 不用 worktree 的前置也要交出提交：项目目录有没提交的改动不算站稳；它在非目标分支上提交的，下游起点里有；
//     不用 worktree 的下游建在它上面照样能开工；
//  R2 已验收的前置、不用 worktree 的下游：项目目录检出的代码里有它才开工，检出的分支里没有就挡住说清；
//  R3 前置还没合入、目标分支后来有别人合进来的：起点里两边都有，diff 里一样都没有；
//  R4 代码真的到了下游干活的地方才算开工：换到一半断掉（日志记了、目录换了、开工没落库），前置又动过、
//     第二次判定记下新的一版还没换又断掉 —— 之后照样能开工、换到最新那一版；目录没了、分支还在的，分支
//     挪到起点；分支上有自己提交的挡住；
//  R5 停止与放行：放行那一路锁外读到的旧请求，排在停止后面就不起；已经认领回合正要起跑的，停止冻住那一次；
//  R6 同时加 A→B 与 B→A：只有一条落下；
//  R7 已验收不等于下游拿得到：换过克隆、分支和压缩前的源提交都没了，取验收合入的那个提交合进起点；
//     连它也读不到的不开工、说清楚（第 3 轮审查 1）；
//  R8 放行认领回合之后定起点抛错（ref 被锁住）：回合还回去，故障消失后照样起（第 3 轮审查 2）；
//  N1 「等齐就起」挂上 / 撤回时，那条任务的可用动作记脏（停止键跟着出现 / 消失）；
//  N2 从没跑过的任务停止等待，任务历史里留一条。
// 跑：npm -w server run test:prerequisites
import {
  acceptTask, commit, db, diffFiles, git, hasStarted, holdForPrerequisites, launchRecord, project, request, row,
  runs, setup, sleep, started, step, sweepPrerequisiteLaunches, taskPrerequisites, tasks, taskWorkspace, teardown, until,
  prerequisiteStanding,
} from "./prerequisite-fixture.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, or } from "drizzle-orm";

const { withPrerequisiteLock } = await import("../src/prerequisite-gate.js");
const { withdrawPrerequisiteRequest } = await import("../src/prerequisite-launch.js");
const { baseRef } = await import("../src/task-branch-plan.js");
const { journalInstall } = await import("../src/prerequisite-install.js");
const { taskNotices } = await import("../src/db/schema.js");
const { onTaskActionsDirty } = await import("../src/task-actions-dirty.js");

const has = (path: string, file: string) => existsSync(join(path, file));
const holdReason = async (id: string) => (await holdForPrerequisites({ id }, { source: "run" }))?.reason ?? null;

try {
  await setup();

  // ── R1 不用 worktree 的前置交出提交 ─────────────────────────────────────────
  {
    const p = await project();
    const s = await p.task("s", { useWorktree: false });
    const d = await p.task("d", { prerequisites: [s] });
    const e = await p.task("e", { prerequisites: [s], useWorktree: false });
    writeFileSync(join(p.repo, "uncommitted-parent.txt"), "还没提交\n");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, s));
    assert.equal(await step(s), "dirty", "项目目录有没提交的改动：证明不了交出了什么，不算站稳");
    assert.match(await holdReason(d) ?? "", /在等前置/);
    git(p.repo, "checkout", "-q", "-b", "side");
    const sideHead = commit(p.repo, "uncommitted-parent.txt", "提交了\n");
    const standing = await prerequisiteStanding(await row(s));
    assert.deepEqual([standing.step, standing.commit], ["settled", sideHead], "交出的是项目目录检出的那个提交");
    assert.equal(await holdReason(d), null);
    const ws = await taskWorkspace(await row(d), p.repo);
    assert.ok(has(ws.path, "uncommitted-parent.txt"), "它在非目标分支上的提交也在下游起点里");
    assert.equal((await db.select().from(taskPrerequisites).where(eq(taskPrerequisites.taskId, d))).at(0)?.inheritedCommit, sideHead,
      "交给下游的那一版如实记成它的提交，不是目标分支");
    assert.equal(await holdReason(e), null, "不用 worktree 的下游建在它上面：同一个检出，照样开工");
    git(p.repo, "checkout", "-q", "main");
    console.log("✓ R1 不用 worktree 的前置：没提交的不算站稳，交出检出的提交，下游起点里有");
  }

  // ── R2 已验收的前置、不用 worktree 的下游 ────────────────────────────────────
  {
    const p = await project();
    const seed = git(p.repo, "rev-parse", "HEAD");
    const a = await p.task("a");
    await p.finish(a, "accepted.txt");
    assert.equal((await acceptTask(a)).accepted, true);
    const s = await p.task("s", { prerequisites: [a], useWorktree: false });
    git(p.repo, "checkout", "-q", "-b", "old", seed);
    assert.match(await holdReason(s) ?? "", /项目目录当前检出的代码里还没有/, "检出的分支里没有它：挡住说清");
    git(p.repo, "checkout", "-q", "main");
    assert.equal(await holdReason(s), null, "检出的是合入了它的目标分支：开工");
    console.log("✓ R2 已验收的前置：不用 worktree 的下游按项目目录检出的代码判，拿得到才开工");
  }

  // ── R3 目标分支后来又合进别的 ───────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    const done = await p.finish(a, "a-only.txt");
    const mainHead = commit(p.repo, "main-new.txt", "别人合进来的\n");
    const b = await p.task("b", { prerequisites: [a] });
    assert.equal(await holdReason(b), null);
    const start = (await row(b)).worktreeStartCommit!;
    assert.notEqual(start, done.head, "不只是前置那一版");
    const ws = await taskWorkspace(await row(b), p.repo);
    assert.ok(has(ws.path, "a-only.txt") && has(ws.path, "main-new.txt"), "前置的和目标分支后来合进来的都在");
    assert.equal(git(p.repo, "merge-base", "--is-ancestor", mainHead, start) === "", true);
    assert.deepEqual(await diffFiles(b), [], "两边的都不算它自己的改动");
    console.log("✓ R3 前置没合入、目标分支动过：起点把最新目标分支一起合进来");
  }

  // ── R4 断在半路、分支还在 ───────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    const first = await p.finish(a, "first.txt");
    const q = await p.task("q", { prerequisites: [a] });
    const preview = await taskWorkspace(await row(q), p.repo);
    // 第一次判定换到一半断掉：日志记了、目录换过去了，「已开工」没落库。
    await journalInstall(q, first.head);
    git(p.repo, "update-ref", baseRef(q), first.head);
    git(preview.path, "reset", "-q", "--keep", first.head);
    assert.equal((await launchRecord(q))?.launchedAt ?? null, null);
    // 断掉期间前置又补了一版；第二次判定记下新的一版、还没换过去又断了。
    const second = commit(first.path, "second.txt", "断掉期间前置又补的\n");
    await journalInstall(q, second);
    git(p.repo, "update-ref", baseRef(q), second);
    assert.equal(await holdReason(q), null, "连断两次：目录停在第一次换到的那一版，日志里认得出没动过");
    assert.equal(git(preview.path, "rev-parse", "HEAD"), second, "换到这一次的起点");
    assert.equal((await row(q)).worktreeStartCommit, second);

    const r = await p.task("r", { prerequisites: [a] });
    const gone = await taskWorkspace(await row(r), p.repo);
    git(p.repo, "worktree", "remove", "--force", gone.path);
    assert.equal(await holdReason(r), null);
    assert.equal(git(p.repo, "rev-parse", gone.branch), second, "目录没了、分支还在：分支挪到起点");
    const restored = await taskWorkspace(await row(r), p.repo);
    assert.ok(has(restored.path, "second.txt"), "从分支恢复出来的目录里有前置的代码");

    const t = await p.task("t", { prerequisites: [a] });
    const own = await taskWorkspace(await row(t), p.repo);
    commit(own.path, "own.txt", "它自己的\n");
    git(p.repo, "worktree", "remove", "--force", own.path);
    assert.match(await holdReason(t) ?? "", /任务分支上已经有自己的提交/, "分支上有自己提交的：挡住说清");
    assert.equal((await launchRecord(t))?.launchedAt ?? null, null);
    console.log("✓ R4 先换代码再落开工：断在半路能接上，分支还在的挪到起点，有自己提交的挡住");
  }

  // ── R5 停止与放行 ───────────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    await p.finish(a);
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, a));
    const b = await p.task("b", { prerequisites: [a] });
    assert.equal((await request("POST", `/tasks/${b}/run`)).status, 202);
    assert.ok((await launchRecord(b))?.requestedAt);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, a)); // 不发事件：放行只由下面这一扫触发
    let open!: () => void;
    const holder = withPrerequisiteLock(b, () => new Promise<void>((resolve) => { open = resolve; }));
    const withdrawn = withdrawPrerequisiteRequest(b);
    const swept = sweepPrerequisiteLaunches(); // 锁外读到请求，排在撤回后面
    await sleep(100);
    open();
    await holder;
    assert.equal(await withdrawn, "withdrawn");
    await swept;
    await sleep(500);
    assert.equal(hasStarted(b), false, "撤回在前：放行那一路锁里重读，不起");
    assert.equal((await launchRecord(b))?.requestedAt ?? null, null, "请求没被复活");
    assert.equal((await row(b)).status, "backlog");

    const c = await p.task("c", { prerequisites: [a] });
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, a));
    assert.equal((await request("POST", `/tasks/${c}/run`)).status, 202);
    const turn = runs.claimOwnTurn(c, "single")!; // 放行那一路已经认领了回合、正要起跑
    assert.equal(await withdrawPrerequisiteRequest(c), "starting", "正在起跑的：冻住那一次");
    assert.equal(runs.takeStartFreeze(c), "canceled", "起跑前最后一道闸会把它撤回");
    runs.releaseTurn(c, turn);
    assert.equal((await launchRecord(c))?.requestedAt ?? null, null);
    console.log("✓ R5 停止与放行排成先后：撤回在前不起、正在起跑的被冻住");
  }

  // ── R6 同时反向加边 ─────────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    const b = await p.task("b");
    const [ab, ba] = await Promise.all([
      request("POST", `/tasks/${a}/prerequisites`, { prerequisiteId: b }),
      request("POST", `/tasks/${b}/prerequisites`, { prerequisiteId: a }),
    ]);
    assert.deepEqual([ab.status, ba.status].sort(), [200, 400], "一条落下，另一条按成环拒绝");
    const edges = await db.select().from(taskPrerequisites).where(or(
      and(eq(taskPrerequisites.taskId, a), eq(taskPrerequisites.prerequisiteId, b)),
      and(eq(taskPrerequisites.taskId, b), eq(taskPrerequisites.prerequisiteId, a))));
    assert.equal(edges.length, 1);
    console.log("✓ R6 同时加 A→B 与 B→A：判环与落边整图排队，不成环");
  }

  // ── R7 已验收、成果只剩验收合入的提交 ──────────────────────────────────────
  {
    const p = await project();
    const seed = git(p.repo, "rev-parse", "HEAD");
    git(p.repo, "checkout", "-q", "-b", "release");
    const merged = commit(p.repo, "delivered.txt", "压缩合入 release 的成果\n");
    git(p.repo, "checkout", "-q", "main");
    const gone = "0123456789abcdef0123456789abcdef01234567"; // 压缩前的源提交：换过克隆，读不到了
    const accept = (merge: string) => ({ status: "done", stage: "accepted", mergeTargetBranch: "release", acceptedTargetBranch: "release",
      acceptedSourceCommit: gone, acceptedBaseCommit: seed, acceptedMergeCommit: merge });
    const a = await p.task("a");
    await db.update(tasks).set(accept(merged)).where(eq(tasks.id, a));
    const b = await p.task("b", { prerequisites: [a], mergeTargetBranch: "main" });
    assert.equal(await holdReason(b), null);
    const ws = await taskWorkspace(await row(b), p.repo);
    assert.ok(has(ws.path, "delivered.txt"), "下游起点里真有它的成果，不是凭「已验收」认目标分支");
    assert.equal((await db.select().from(taskPrerequisites).where(eq(taskPrerequisites.taskId, b))).at(0)?.inheritedCommit, merged);
    const c = await p.task("c");
    await db.update(tasks).set(accept("fedcba9876543210fedcba9876543210fedcba98")).where(eq(tasks.id, c));
    const d = await p.task("d", { prerequisites: [c], mergeTargetBranch: "main" });
    assert.match(await holdReason(d) ?? "", /已经验收，但它交出的那一版在仓库里读不到了/, "证明不了就不开工");
    assert.equal((await launchRecord(d))?.launchedAt ?? null, null);
    console.log("✓ R7 已验收的前置：取读得到的成果提交合进起点，读不到的不开工");
  }

  // ── R8 认领回合之后抛错 ─────────────────────────────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    await p.finish(a);
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, a));
    const b = await p.task("b", { prerequisites: [a] });
    assert.equal((await request("POST", `/tasks/${b}/run`)).status, 202);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, a));
    const lock = join(p.repo, ".git", `${baseRef(b)}.lock`);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");
    const logged = console.error;
    console.error = () => {}; // 扫描会如实打出这次 git 失败
    try { await sweepPrerequisiteLaunches(); } finally { console.error = logged; }
    assert.equal(runs.turnIdentity(b), null, "定起点抛错：认领的回合还回去了");
    assert.equal(hasStarted(b), false);
    rmSync(lock);
    started.push(b);
    await sweepPrerequisiteLaunches();
    await until("故障消失后照样起", () => hasStarted(b));
    console.log("✓ R8 放行认领回合后定起点抛错：回合归还，故障消失后照样起");
  }

  // ── N1 / N2 停止键跟着请求走；从没跑过的停止留痕 ─────────────────────────────
  {
    const p = await project();
    const a = await p.task("a");
    await p.finish(a);
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, a));
    const b = await p.task("b", { prerequisites: [a] });
    const marks: string[] = [];
    onTaskActionsDirty((mark) => { if (mark.kind === "task") marks.push(mark.taskId); });
    assert.equal((await request("POST", `/tasks/${b}/run`)).status, 202);
    assert.ok(marks.includes(b), "挂上请求：可用动作记脏，停止键当场出现");
    marks.length = 0;
    const res = await request("POST", `/tasks/${b}/stop`);
    assert.equal(res.status, 200);
    assert.ok(marks.includes(b), "撤回请求：可用动作记脏");
    const notices = await db.select().from(taskNotices).where(eq(taskNotices.taskId, b));
    assert.ok(notices.some((notice) => notice.reason.includes("不再等前置站齐自动开工")), "没有会话可写时间线：记进任务历史");
    console.log("✓ N1 N2 停止键跟着「等齐就起」出现 / 消失；从没跑过的停止也留痕");
  }
} finally {
  await teardown();
}
