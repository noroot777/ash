// 派出去的任务建出来就带审查预约（server/src/review-on-create.ts、shared/src/review-on-create.ts）。
//
//  R1 默认审查者：设 / 换 / 取消，每人至多一位；被设为默认的那位删掉，默认跟着没了；
//  R2 带了默认的上游（MCP 建任务那条路缺省就是 "default"）：建出来就挂着预约 —— 默认那位、自动复审 3 轮、逻辑检查，
//     来源记成手动预约；还没开跑就能改、能取消；
//  R3 前置：上游完成时挂着预约 → 不是站稳、下游不起；审查通过 → 站稳、下游起；最后一轮没过 → 下游仍不起；
//  R4 没设默认 / 明确不审 / 新建面板（不传）：都不带预约；指定一位不存在的 → 400，一条都不建；
//  R5 别人名下的审查者既当不了我的默认，也指定不了；
//  R6 派活单与可以派出去的活：卡上那一格换了人 / 关掉，照这一格；没交就照单子上的（再缺省是默认）。
//  R7 任务和预约同一笔：预约写不进去时报错、任务也不留（单建和不串队的批次都是）；解析完、落库前那位审查者被删：
//     指定的那位 → 整批不建，「默认」→ 按落库那一刻的默认（已经没有了）不带，都不留指向不存在审查者的预约。
// 跑：npm -w server run test:review-on-create
import {
  api, createTasks, db, freeReviewRounds, freeReviewRuns, freeWorkflowStates, hasStarted, notePrerequisiteProgress, project, request, row,
  setup, sleep, started, step, tasks, teardown, until, arm, review,
} from "./prerequisite-fixture.js";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";

const { reviewerProfiles } = await import("../src/db/schema.js");
const { mountReviewerProfileRoutes } = await import("../src/reviewer-profiles.js");
const { reserveFreeReview, cancelFreeReviewReservation } = await import("../src/free-workflow.js");
const { resolveCreateReviews, ReviewOnCreateError } = await import("../src/review-on-create.js");
const { normalizeLaunch } = await import("../src/dispatch-plan.js");
const { normalizeSuggestionLaunch } = await import("../src/dispatch-suggestion-launch.js");
const { executorScopeForOwner } = await import("../src/auth/owned-executors.js");
mountReviewerProfileRoutes(api);

const slot = async (taskId: string) => (await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, taskId))).at(0) ?? null;
const json = async <T>(res: Response) => (await res.json()) as T;
const reviewer = async (name: string) => (await json<{ id: string }>(await request("POST", "/reviewer-profiles", { name, agentType: "claude" }))).id;
const defaults = async () => (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.isDefault, true))).map((profile) => profile.name);

try {
  await setup();
  const p = await project();

  // ── R4（前半）还没设默认：缺省 "default" 也不带，跟以前一样 ──
  {
    const res = await request("POST", `/groups/${p.group}/tasks/batch`, { tasks: [{ body: "没设默认" , review: "default" }] });
    assert.equal(res.status, 201);
    const [created] = (await json<{ tasks: { id: string }[] }>(res)).tasks;
    assert.equal(await slot(created!.id), null, "没设默认审查者：不带预约");
  }

  // ── R1 默认审查者 ──
  const alpha = await reviewer("alpha");
  const beta = await reviewer("beta");
  {
    let res = await request("PATCH", `/reviewer-profiles/${alpha}`, { isDefault: true });
    assert.equal(res.status, 200);
    assert.equal((await json<{ isDefault: boolean }>(res)).isDefault, true);
    assert.deepEqual(await defaults(), ["alpha"]);
    res = await request("PATCH", `/reviewer-profiles/${beta}`, { isDefault: true });
    assert.deepEqual(await defaults(), ["beta"], "换一位：原来那位不再是默认");
    res = await request("PATCH", `/reviewer-profiles/${beta}`, { isDefault: false });
    assert.deepEqual(await defaults(), [], "取消");
    const list = await json<{ id: string; isDefault: boolean }[]>(await request("GET", "/reviewer-profiles"));
    assert.ok(list.every((item) => item.isDefault === false), "清单里带着默认标记");
    const gamma = await reviewer("gamma");
    await request("PATCH", `/reviewer-profiles/${gamma}`, { isDefault: true });
    assert.equal((await request("DELETE", `/reviewer-profiles/${gamma}`)).status, 200);
    assert.deepEqual(await defaults(), [], "默认那位被删：默认为空");
    assert.equal((await request("PATCH", `/reviewer-profiles/${alpha}`, { isDefault: "yes" })).status, 400);
    await request("PATCH", `/reviewer-profiles/${alpha}`, { isDefault: true });
  }

  // ── R2 + R3 带默认预约的上游 → 下游等审查 ──
  {
    const res = await request("POST", `/groups/${p.group}/tasks/batch`, {
      tasks: [{ key: "up", title: "上游", body: "上游", review: "default" }, { key: "down", title: "下游", body: "下游", prerequisites: ["up"], review: "default" }],
    });
    assert.equal(res.status, 201);
    const [up, down] = (await json<{ tasks: { id: string }[] }>(res)).tasks.map((task) => task.id);
    const armed = await slot(up!);
    assert.ok(armed?.reviewArmed, "建出来就挂着预约");
    assert.equal(armed?.selectedReviewerId, alpha, "交给默认那位");
    assert.equal(armed?.reviewRetryLimit, 3, "自动复审 3 轮");
    assert.equal(armed?.reviewCheckMode, "logic", "逻辑检查");
    assert.equal(armed?.reviewSource, "user", "跟手动预约是同一个东西");
    assert.equal((await row(up!)).status, "backlog");

    // 还没开跑：能改、能取消（以前对 backlog 是拒的）。
    await reserveFreeReview(up!, { reviewerId: beta, checkMode: "syntax", retryLimit: 1 });
    assert.equal((await slot(up!))?.selectedReviewerId, beta);
    await cancelFreeReviewReservation(down!);
    assert.equal((await slot(down!))?.reviewArmed, false, "还没开跑也能取消");
    await reserveFreeReview(up!, { reviewerId: alpha, checkMode: "logic", retryLimit: 3 });

    const res2 = await request("POST", `/tasks/${down}/run`);
    assert.equal((await json<{ waiting?: boolean }>(res2)).waiting, true, "上游还没完成：下游等着");
    await p.finish(up!);
    assert.equal(await step(up!), "review_reserved", "完成时挂着预约：等审查，不是站稳");
    notePrerequisiteProgress(up!);
    await sleep(600);
    assert.equal(hasStarted(down!), false, "预约着审查：下游不起");

    // 预约被消费、审查通过（只落库，不跑审查者）。
    await arm(up!, false);
    await review(up!, "passed", "passed");
    assert.equal(await step(up!), "settled", "审查通过：站稳");
    notePrerequisiteProgress(up!);
    started.push(down!);
    await until("审查通过：下游起跑", () => hasStarted(down!));
  }

  // ── R3（后半）最后一轮没过：下游仍不起 ──
  {
    const res = await request("POST", `/groups/${p.group}/tasks/batch`, {
      tasks: [{ key: "up", title: "上游2", body: "上游", review: "default" }, { key: "down", title: "下游2", body: "下游", prerequisites: ["up"] }],
    });
    const [up, down] = (await json<{ tasks: { id: string }[] }>(res)).tasks.map((task) => task.id);
    assert.ok((await slot(up!))?.reviewArmed);
    assert.equal((await json<{ waiting?: boolean }>(await request("POST", `/tasks/${down}/run`))).waiting, true);
    await p.finish(up!);
    assert.equal(await step(up!), "review_reserved");
    // 自动复审 3 轮用完：第 4 轮没过，链停在 stopped。
    await arm(up!, false);
    const runId = await review(up!, "failed", "failed");
    await db.update(freeReviewRuns).set({ status: "stopped", retryLimit: 3, currentRound: 4 }).where(eq(freeReviewRuns.id, runId));
    await db.update(freeReviewRounds).set({ round: 4 }).where(eq(freeReviewRounds.runId, runId));
    assert.equal(await step(up!), "review_failed", "最后一轮没过：不算站稳");
    notePrerequisiteProgress(up!);
    await sleep(600);
    assert.equal(hasStarted(down!), false, "最后一轮没过：下游仍不起");
  }

  // ── R4 不带的几种 ──
  {
    let res = await request("POST", `/groups/${p.group}/tasks/batch`, { tasks: [{ body: "不审", review: "none" }, { body: "批次默认关", }], defaults: { review: "none" } });
    for (const task of (await json<{ tasks: { id: string }[] }>(res)).tasks) assert.equal(await slot(task.id), null, "明确不审：不带");
    res = await request("POST", "/tasks", { projectId: p.key, title: "新建面板", body: "x", mode: "single" });
    assert.equal(res.status, 201);
    assert.equal(await slot((await json<{ id: string }>(res)).id), null, "新建面板不传：不带");
    res = await request("POST", "/tasks", { projectId: p.key, title: "回复框派出去", body: "x", mode: "single", review: { reviewer: "beta" } });
    assert.equal((await slot((await json<{ id: string }>(res)).id))?.selectedReviewerId, beta, "按名字指定一位");
    const before = (await db.select().from(tasks)).length;
    res = await request("POST", `/groups/${p.group}/tasks/batch`, { tasks: [{ body: "a" }, { body: "b", review: { reviewer: "nobody" } }] });
    assert.equal(res.status, 400, "指定的审查者不存在：400");
    assert.match((await json<{ error: string }>(res)).error, /nobody/);
    assert.equal((await db.select().from(tasks)).length, before, "整批不建");
    res = await request("POST", `/groups/${p.group}/tasks/batch`, { tasks: [{ body: "a", review: 3 }] });
    assert.equal(res.status, 400, "形状不对：400");
  }

  // ── R5 别人名下的 ──
  {
    const at = new Date().toISOString();
    await db.insert(reviewerProfiles).values({ id: "bob-r", name: "bob 的", agentType: "claude", ownerUserId: "bob", isDefault: true, createdAt: at, updatedAt: at });
    const mine = await resolveCreateReviews([{ id: "t1", workflowMode: "free", ownerUserId: null, review: "default" }]);
    assert.deepEqual(mine.map((item) => item.reviewerId), [alpha], "我的默认只在我名下认");
    const bobs = await resolveCreateReviews([{ id: "t2", workflowMode: "free", ownerUserId: "bob", review: "default" }]);
    assert.deepEqual(bobs.map((item) => item.reviewerId), ["bob-r"]);
    await assert.rejects(resolveCreateReviews([{ id: "t3", workflowMode: "free", ownerUserId: null, review: { reviewer: "bob-r" } }]), ReviewOnCreateError,
      "别人的审查者指定不了");
    assert.equal((await request("PATCH", "/reviewer-profiles/bob-r", { isDefault: true })).status, 400, "别人的审查者设不成我的默认");
    // 预约本来就不适用的（团队执行者、审查任务、非自由工作流）：不带，也不报错。
    const skipped = await resolveCreateReviews([
      { id: "t4", workflowMode: "free", parentId: "lead", review: "default" },
      { id: "t5", workflowMode: "free", reviewOf: "x", review: { reviewer: "nobody" } },
      { id: "t6", workflowMode: "preset", review: "default" },
    ]);
    assert.deepEqual(skipped, []);
  }

  // ── R6 派活单 / 可以派出去的活：照卡上那一格 ──
  {
    const scope = await executorScopeForOwner(null);
    const target = { agentType: "claude" as const, executorId: null, model: null, reasoningEffort: null };
    const plan = {
      id: "plan", question: "q", order: "serial" as const, proposedAt: "",
      items: [
        { title: "a", body: "a", note: "", target: null, review: { reviewer: beta } },
        { title: "b", body: "b", note: "", target: null },
        { title: "c", body: "c", note: "", target: null, review: "none" as const },
      ],
    };
    const launch = normalizeLaunch(plan, { planId: "plan", order: "serial", items: [
      { index: 0, target }, { index: 1, target }, { index: 2, target, review: { reviewer: alpha } },
    ] }, scope);
    assert.ok(!("error" in launch));
    assert.deepEqual(launch.picks.map((pick) => pick.review), [{ reviewer: beta }, "default", { reviewer: alpha }]);
    const bad = normalizeLaunch(plan, { planId: "plan", order: "serial", items: [{ index: 0, target, review: "maybe" }] }, scope);
    assert.ok("error" in bad && bad.status === 400);
    const suggested = normalizeSuggestionLaunch({ order: "parallel", items: [
      { id: "s1", title: "s", body: "s", target, worktreeBase: null },
      { id: "s2", title: "s", body: "s", target, worktreeBase: null, review: "none" },
    ] }, scope);
    assert.ok(!("error" in suggested));
    assert.deepEqual(suggested.items.map((item) => item.review), ["default", "none"]);
  }

  // ── R7 同一笔落库；落库前审查者被删 ──
  {
    const titled = async (title: string) => (await db.select().from(tasks).where(eq(tasks.title, title))).length;
    await db.run(sql.raw("CREATE TRIGGER reject_reservation BEFORE INSERT ON free_workflow_states BEGIN SELECT RAISE(ABORT, 'injected'); END"));
    try {
      let res = await request("POST", "/tasks", { projectId: p.key, title: "预约写不进去", body: "x", mode: "single", review: "default" });
      assert.notEqual(res.status, 201, "预约写不进去：报错");
      assert.equal(await titled("预约写不进去"), 0, "单建：任务也不留");
      res = await request("POST", `/groups/${p.group}/tasks/batch`, { tasks: [{ title: "批次预约写不进去", body: "x", review: "default" }] });
      assert.notEqual(res.status, 201);
      assert.equal(await titled("批次预约写不进去"), 0, "不串队的批次：任务也不留");
    } finally {
      await db.run(sql.raw("DROP TRIGGER reject_reservation"));
    }

    const at = new Date().toISOString();
    const draft = (id: string, review: "default" | { reviewer: string }) => ({
      id, projectId: p.key, title: id, body: "x", mode: "single" as const, status: "backlog" as const, agentType: "claude" as const,
      workflowMode: "free" as const, useWorktree: false, review, createdAt: at, updatedAt: at,
    });
    const doomed = await reviewer("doomed");
    const removeDoomed = async () => assert.equal((await request("DELETE", `/reviewer-profiles/${doomed}`)).status, 200);
    await assert.rejects(createTasks([draft("race-explicit", { reviewer: doomed })], undefined, removeDoomed), ReviewOnCreateError,
      "指定的那位在落库前被删：整批不建");
    assert.equal(await titled("race-explicit"), 0);
    const fleeting = await reviewer("fleeting");
    await request("PATCH", `/reviewer-profiles/${fleeting}`, { isDefault: true });
    const [created] = await createTasks([draft("race-default", "default")], undefined, async () => {
      assert.equal((await request("DELETE", `/reviewer-profiles/${fleeting}`)).status, 200);
    });
    assert.equal(await slot(created!.id), null, "默认那位在落库前被删：按那一刻的默认（没有）不带");
    const dangling = await db.all<{ n: number }>(sql.raw(
      "SELECT count(*) AS n FROM free_workflow_states s LEFT JOIN reviewer_profiles r ON r.id = s.selected_reviewer_id WHERE s.review_armed = 1 AND s.selected_reviewer_id IS NOT NULL AND r.id IS NULL"));
    assert.equal(dangling[0]?.n, 0, "没有指向不存在审查者的预约");
  }

  console.log("review-on-create: ok");
} finally {
  await teardown();
}
