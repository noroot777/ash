// 飞书卡片发出去之后任务又变了、完成与门禁通知、同时到的几句话建房间（自由审查第 1 轮的三条）。
//
// 钉住的几件事（理由见 server/src/task-result-version.ts、im/outcomes.ts、im/relay.ts 的文件头）：
// ① 验收：按钮按下去、真正验收之前任务又跑出了新结果 → 不验收，卡上说明；门禁跑着的时候任务又跑出新结果
//    → 门禁过了也不验收（延期的那次验收带着同一版身份）；团队调度台自己又跑一轮也算新结果；
// ② 重试：按钮按下去之后任务又失败了一次 → 不重试；/retry 只认回复在失败卡上；
// ③ 通知：飞书上点验收成功 → 回一条「已验收合并」；门禁通过 / 没通过各一条；重复对账不重发；同一次验收
//    摘牌挂回、再跑一轮不重发，就地任务真的再验收一次照样推；第一次看到的任务不补推；「完成也推」关着只记账，再打开也不补推；事件丢了由
//    全量对账补上；
// ④ 房间：同一个人在群里 / 单聊里同时发两句，只留一间、两句都进那一间（多建的删掉）；群这期间换了绑定 →
//    不落映射；群列表照实标出哪个群在收卡、看的人能不能改；
//    读房间只是这一下没读到（500）→ 不换房间、映射原样，这句不投、叫他再发；等回复时读不到 → 下一圈再看，
//    房间真没了（404）才说没拿到回复；库里的按钮记录坏了 → 拒掉、不按空的去验收；飞书传来的正文解析不了 →
//    叫他重发；发件队列里一行坏的 → 标成放弃、后面的照发；
// ⑤ @ 占位去掉之后，正文的缩进原样；
// ⑥ 团队验收占住全队（team-acceptance-hold.ts）：占着的时候共享执行者起不了跑、改不了状态、加不了新执行者、
//    别人带 force 也写不了工作区、调度台不在线时用户的话不开台；验收自己的守卫不把这份占位当成在飞；占住之后
//    调度台又跑了一轮 → 之后每道守卫都拒；放开之后一切照旧。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-outcomes-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-outcomes");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
/** 一个挂起点：到了就停住，等 release()。 */
function gate() {
  let reached!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { arrived, opened, reached, release };
}

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { acceptGateRuns, chatRooms, projects, sessions, sessionTurns, tasks } = await import("../src/db/schema.js");
  const { imActions, imBindings, imGroups, imInbound, imOutbox, imOutcomes } = await import("../src/db/schema-im.js");
  const { and, desc, eq, like } = await import("drizzle-orm");
  const { api } = await import("../src/routes.js");
  const { mountTaskAcceptanceRoutes } = await import("../src/task-accept-routes.js");
  const { whenAcceptGateSettled } = await import("../src/accept-gate.js");
  const { prepareWorktree } = await import("../src/git.js");
  const { patchOptions } = await import("../src/im/meta.js");
  const { CardActions } = await import("../src/im/actions.js");
  const { RoomRelay } = await import("../src/im/relay.js");
  const { bindingOf } = await import("../src/im/binding.js");
  const { deleteGroup, groupOf, groupRoomOf, groupsView } = await import("../src/im/groups.js");
  const { parseMessage } = await import("../src/im/feishu/message.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { resultVersionOf } = await import("../src/task-result-version.js");
  const { viewsOf } = await import("../src/im/attention.js");
  const { commitReopenAcceptedStage, peekAcceptedStage, reopenAcceptedStage, restoreTaskStage } = await import("../src/task-stage.js");
  const { holdDrift, holdMembers, holdTeamForAcceptance } = await import("../src/team-acceptance-hold.js");
  const { claimOwnTurn, heldForAcceptance, isTurnClaimed, releaseTurn } = await import("../src/runs.js");
  const { acceptanceGuard } = await import("../src/task-accept-guard.js");
  const { claimWorkspaceWrite, ACCEPTING_REFUSAL } = await import("../src/workspace-write-gate.js");
  const { deliverToLead } = await import("../src/team/session.js");
  const { APP, OWNER, FakeFeishu, buildApp, assemble, contentOf, textOf, buttonsOf } = await import("./im-fixture.js");

  await ensureSchema();
  mountTaskAcceptanceRoutes(api);
  const app = buildApp();
  const fake = new FakeFeishu();
  const im = await assemble(app, fake);

  const at = new Date().toISOString();
  const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
  mkdirSync(join(stage, "plain"), { recursive: true });
  await db.insert(projects).values({ id: "p1", name: "飞书项目", repoPath: join(stage, "plain"), apiKeys: null, createdAt: at } as never);
  await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: at });
  const principal = { channel: "feishu" as const, appId: APP, openId: OWNER };
  const taskRow = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
  const openCard = async (taskId: string, kind: string) => (await db.select().from(imOutbox).where(and(
    eq(imOutbox.taskId, taskId), eq(imOutbox.kind, kind), eq(imOutbox.state, "sent"),
  )).orderBy(desc(imOutbox.createdAt))).at(0)!;
  const noticesOf = (taskId: string) => db.select().from(imOutbox).where(and(eq(imOutbox.taskId, taskId), eq(imOutbox.kind, "notice")));
  const noticeText = async (taskId: string) => (await noticesOf(taskId)).map((row) => JSON.parse(row.content).text as string).join("\n");
  const timelineOf = async (taskId: string) => (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.taskId, taskId)))
    .map((session) => sessionTranscriptPath(taskId, session.id)).filter(existsSync).map((path) => readFileSync(path, "utf8")).join("\n");
  const buttonOf = (row: { content: string }, op: string) => buttonsOf(JSON.parse(row.content)).find((button) => button.value?.op === op)!;
  /** 一份卡片动作：按钮按下去、请求发进 ash 之前停在 hold 上。 */
  const heldActions = (hold: ReturnType<typeof gate>) => new CardActions({
    appId: APP, reconciler: im.reconciler, sender: im.sender, commands: im.commands,
    ash: { post: async (who: typeof principal, path: `/api/${string}`, body: unknown) => { hold.reached(); await hold.opened; return im.ash.post(who, path, body); } } as never,
  });
  let events = 0;
  const press = (actions: InstanceType<typeof CardActions>, value: Record<string, unknown>) =>
    actions.handle({ eventId: `ev-outcome-${++events}`, operatorOpenId: OWNER, value, formValue: {}, name: null });

  // ── ① 旧版成果上的验收 ───────────────────────────────────────────────────
  {
    await db.insert(tasks).values({ id: "ta", projectId: "p1", title: "第一版", body: "", status: "done", useWorktree: false, workflowMode: "free", endedAt: at, createdAt: at, updatedAt: at } as never);
    await db.insert(sessions).values({ id: "s-ta", taskId: "ta", role: "single", agentType: "claude", executor: "claude", cwd: join(stage, "plain"), startedAt: at, endedAt: at, activeMs: 0 } as never);
    await im.reconciler.reconcile(["ta"]);
    await im.settle();
    const card = await openCard("ta", "accept");
    const hold = gate();
    const pressing = press(heldActions(hold), buttonOf(card, "accept").value!);
    await hold.arrived;
    // 卡片代次已经核过、请求还没进验收：另一端又跑完了一轮。
    await db.update(tasks).set({ title: "没给人看过的第二版", endedAt: later(10) }).where(eq(tasks.id, "ta"));
    hold.release();
    const response = await pressing;
    await im.settle();
    assert.equal((await taskRow("ta")).stage, null, "点的是上一版：这一版不许被验收");
    assert.match(JSON.stringify(response), /又跑出了新结果/, "卡上说清为什么没验收");
    assert.match(await timelineOf("ta"), /验收没有执行/, "时间线留一笔");

    // 新卡上照常验收：合并 + 在卡下回一条「已验收合并」（不靠旧卡还开着）。直接改库不发事件，手动对一次账。
    await im.reconciler.reconcile(["ta"]);
    await im.settle();
    const fresh = await openCard("ta", "accept");
    assert.notEqual(fresh.id, card.id, "新一版推了新卡");
    fake.reset();
    const accepted = await press(im.actions, buttonOf(fresh, "accept").value!);
    assert.match(JSON.stringify(accepted), /已验收合并/);
    await im.settle();
    assert.equal((await taskRow("ta")).stage, "accepted");
    assert.match(await noticeText("ta"), /已验收合并：「没给人看过的第二版」/, "飞书上点验收成功也有完成通知");
    assert.ok(fake.sends().some((call) => call.path.includes(`/messages/${fresh.messageId}/reply`)), "通知回复在那张待验收卡下面");
    await im.reconciler.reconcile(["ta"]);
    await im.reconciler.full();
    await im.settle();
    assert.equal((await noticesOf("ta")).length, 1, "重复对账不重发");

    // 同一次验收：摘牌又原样挂回（问了一句、没改东西：生产的 peek → 摘牌 → 挂回），已验收时又跑了一轮旁路
    // 回合，事后又补记了一笔合并事实 —— 结束时刻、合并事实都变了，还是那一次，不再推。
    const firstAcceptance = (await taskRow("ta")).acceptanceId;
    assert.ok(firstAcceptance, "落下验收章就领了一个身份");
    const peeked = (await peekAcceptedStage("ta"))!;
    await commitReopenAcceptedStage("ta");
    assert.equal((await taskRow("ta")).acceptanceId, null, "摘牌连身份一起摘掉");
    await db.update(tasks).set({ status: "running", endedAt: null }).where(eq(tasks.id, "ta"));
    await im.reconciler.reconcile(["ta"]);
    await db.update(tasks).set({ status: "done", endedAt: later(80) }).where(eq(tasks.id, "ta"));
    assert.ok(await restoreTaskStage("ta", peeked.stage, "这一轮没改东西，验收章原样挂回。", peeked.snapshot));
    assert.equal((await taskRow("ta")).acceptanceId, firstAcceptance, "原样挂回：身份随快照回来");
    await im.reconciler.reconcile(["ta"]);
    await db.update(tasks).set({ status: "running", endedAt: null }).where(eq(tasks.id, "ta"));
    await im.reconciler.reconcile(["ta"]);
    await db.update(tasks).set({ status: "done", endedAt: later(90), acceptedMergeCommit: "c0ffee" }).where(eq(tasks.id, "ta"));
    await im.reconciler.reconcile(["ta"]);
    await im.settle();
    assert.equal((await noticesOf("ta")).length, 1, "同一次验收：摘牌挂回、再跑一轮、补记合并事实都不重推");
    // 改出新的一版、真的再验收一次（就地任务：落下的合并事实和上一次一模一样）：再推一条。
    await reopenAcceptedStage("ta");
    await db.update(tasks).set({ title: "改过的第三版", acceptedMergeCommit: null, endedAt: later(95) }).where(eq(tasks.id, "ta"));
    await im.reconciler.reconcile(["ta"]);
    await im.settle();
    const again = await openCard("ta", "accept");
    assert.match(JSON.stringify(await press(im.actions, buttonOf(again, "accept").value!)), /已验收合并/);
    await im.settle();
    assert.notEqual((await taskRow("ta")).acceptanceId, firstAcceptance, "新的一次验收换了身份");
    assert.equal((await noticesOf("ta")).length, 2, "新的一次验收再推一条");
    assert.match(await noticeText("ta"), /已验收合并：「改过的第三版」/);
  }

  // ── ① 续：团队调度台自己又跑了一轮，成果就换了一版 ─────────────────────
  {
    await db.insert(tasks).values([
      { id: "tlead", projectId: "p1", title: "团队", body: "", mode: "team", status: "idle", createdAt: at, updatedAt: at },
      { id: "tworker", projectId: "p1", parentId: "tlead", title: "执行者", body: "", mode: "single", status: "done", endedAt: later(110), createdAt: at, updatedAt: at },
    ] as never);
    const lead = await taskRow("tlead");
    assert.equal(await resultVersionOf(lead), later(110), "调度台自己的 ended_at 一直空着：先按执行者算");
    const view = (await viewsOf(["tlead"])).get("tlead")!;
    assert.equal(view.turn?.kind, "accept");
    assert.equal(view.turn?.generation, `a:${later(110)}`, "卡片代次和验收核的是同一份");
    // 调度台每轮收尾落回 idle、不写 ended_at：它自己的回合只记在 session_turns 上。
    await db.insert(sessionTurns).values({ id: "turn-lead", sessionId: "s-lead", taskId: "tlead", startedAt: later(120) } as never);
    assert.equal(await resultVersionOf(lead), later(120), "调度台自己又跑了一轮：成果换了一版，旧卡上的验收不再算数");
    assert.equal((await viewsOf(["tlead"])).get("tlead")!.turn?.generation, `a:${later(120)}`);

    // ⑥ 团队验收占住全队。开独立 worktree 的执行者不在占位里（改不到团队的目录，验收也不给它盖章）。
    await db.insert(tasks).values({ id: "tsolo", projectId: "p1", parentId: "tlead", title: "独立执行者", body: "", mode: "single", status: "done", useWorktree: true, endedAt: later(90), createdAt: at, updatedAt: at } as never);
    const release = await holdTeamForAcceptance("tlead");
    assert.deepEqual([...holdMembers("tlead")].sort(), ["tlead", "tworker"], "占住的是调度台和共享执行者");
    assert.ok(heldForAcceptance("tworker") && !heldForAcceptance("tsolo"));
    assert.equal(claimOwnTurn("tworker", "single"), null, "验收期间共享执行者起不了新的一轮");
    const busyAnswer = await app.request("/api/tasks/tworker", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "backlog" }) });
    assert.equal(busyAnswer.status, 409, "改回 backlog 也等验收结束");
    assert.match(JSON.stringify(await busyAnswer.json()), /所属团队正在验收/);
    const addWorker = await app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "p1", parentId: "tlead", title: "后加的", body: "x" }) });
    assert.equal(addWorker.status, 409, "验收期间加不了执行者：新来的不在占位里");
    assert.match(JSON.stringify(await addWorker.json()), /所属团队正在验收/);
    const peers = [{ id: "tlead", status: "idle" }, { id: "tworker", status: "done" }] as never;
    const context = { task: await taskRow("tlead"), root: { path: stage, source: "worktree" }, peers, busy: null } as never;
    await assert.rejects(claimWorkspaceWrite({
      taskId: "tlead", context, forced: true,
      busyError: (who) => new Error(who), archivedError: (message) => new Error(message), missingError: () => new Error("missing"),
    }), (error: Error) => error.message === ACCEPTING_REFUSAL, "别人带 force 也写不了被验收占着的工作区");
    assert.equal(await deliverToLead("tlead", "验收中插一句"), false, "调度台不在线：验收期间不开台，话退回托盘");
    assert.equal((await acceptanceGuard("tlead", "before_merge")).failure, null, "验收自己的守卫不把这份占位当成在飞");
    // 占住之后调度台 CLI 自己又起了一轮：之后每道守卫都拒（进门那一道由卡片上的版本核）。
    await db.insert(sessionTurns).values({ id: "turn-lead-2", sessionId: "s-lead", taskId: "tlead", startedAt: later(130) } as never);
    assert.match((await holdDrift("tlead")) ?? "", /验收途中团队又跑出了新的结果/);
    const drifted = (await acceptanceGuard("tlead", "before_merge")).failure;
    assert.equal(drifted?.reason, "result_changed", "成果变了：这一次不验收");
    release();
    assert.equal(holdMembers("tlead").size, 0);
    assert.equal(await holdDrift("tlead"), null);
    assert.ok(!isTurnClaimed("tworker"), "放开之后不再占着");
    const after = claimOwnTurn("tworker", "single");
    assert.ok(after, "验收结束：执行者照常起跑");
    releaseTurn("tworker", after!);
  }

  // ── ② 旧失败上的重试 ─────────────────────────────────────────────────────
  {
    await db.insert(tasks).values({ id: "tf", projectId: "p1", title: "跑挂了", body: "", status: "failed", endedAt: at, createdAt: at, updatedAt: at } as never);
    await im.reconciler.reconcile(["tf"]);
    await im.settle();
    const card = await openCard("tf", "failed");
    const hold = gate();
    const pressing = press(heldActions(hold), buttonOf(card, "retry").value!);
    await hold.arrived;
    await db.update(tasks).set({ endedAt: later(20) }).where(eq(tasks.id, "tf"));
    hold.release();
    const response = await pressing;
    await im.reconciler.reconcile(["tf"]);
    await im.settle();
    const row = await taskRow("tf");
    assert.equal(row.status, "failed", "点的是上一次失败：不重试");
    assert.equal(row.endedAt, later(20), "没有起新的一轮");
    assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, "tf"))).length, 0);
    assert.match(JSON.stringify(response), /又跑过了/, "卡上说清为什么没重试");

    // 回复那张旧失败卡发 /retry：同样带着卡上那一次失败进去。
    fake.reset();
    const command = await im.say({ text: "/retry", parentId: card.messageId! });
    await im.settle();
    assert.match(JSON.stringify(fake.sends().filter((call) => call.path.includes(`/messages/${command}/reply`)).map(contentOf)), /又跑过了/,
      "回复旧失败卡 /retry：不重试后来那一次");
    assert.equal((await taskRow("tf")).endedAt, later(20));

    fake.reset();
    const notice = await im.say({ text: "/retry", parentId: (await openCard("ta", "notice"))?.messageId ?? undefined });
    await im.settle();
    assert.match(JSON.stringify(fake.sends().filter((call) => call.path.includes(`/messages/${notice}/reply`)).map(contentOf)), /回复那张失败卡片/,
      "/retry 不是回在失败卡上：不猜它要重试哪一次");
  }

  // ── ③ 通知：第一次看到、开关关着 ─────────────────────────────────────────
  {
    await db.insert(tasks).values({ id: "told", projectId: "p1", title: "早就验收了", body: "", status: "done", stage: "accepted", endedAt: at, createdAt: at, updatedAt: at } as never);
    await im.reconciler.reconcile(["told"]);
    await im.settle();
    assert.equal((await noticesOf("told")).length, 0, "第一次看到就已验收：不补推");
    assert.equal((await db.select().from(imOutcomes).where(eq(imOutcomes.taskId, "told"))).length, 2, "但记下了账");

    await db.insert(tasks).values({ id: "tq", projectId: "p1", title: "关着开关验收", body: "", status: "done", endedAt: at, createdAt: at, updatedAt: at } as never);
    await im.reconciler.reconcile(["tq"]);
    await patchOptions({ notifyCompleted: false });
    await db.update(tasks).set({ stage: "accepted" }).where(eq(tasks.id, "tq"));
    await im.reconciler.reconcile(["tq"]);
    await patchOptions({ notifyCompleted: true });
    await im.reconciler.reconcile(["tq"]);
    await im.settle();
    assert.equal((await noticesOf("tq")).length, 0, "开关关着时的结局，打开后不补推");

    // 事件丢了（对账前重启、通道重启）：已验收的任务不在全量对账的常规候选里，按「账和现状对不上」补上。
    await db.insert(tasks).values({ id: "tlost", projectId: "p1", title: "丢了事件", body: "", status: "done", endedAt: at, createdAt: at, updatedAt: at } as never);
    await im.reconciler.reconcile(["tlost"]);
    await im.settle();
    await db.update(tasks).set({ stage: "accepted", acceptedGateMode: "unset" }).where(eq(tasks.id, "tlost"));
    await db.update(imOutbox).set({ state: "resolved", resolution: "acted" }).where(eq(imOutbox.taskId, "tlost"));
    await im.reconciler.full();
    await im.settle();
    assert.match(await noticeText("tlost"), /已验收合并：「丢了事件」/, "全量对账补上丢了的验收通知");
    await db.insert(acceptGateRuns).values({
      id: "run-lost", taskId: "tq", projectId: "p1", command: "true", cwd: stage, status: "failed",
      logPath: join(stage, "run-lost.log"), startedAt: later(100), finishedAt: later(101),
    } as never);
    await im.reconciler.full();
    await im.settle();
    assert.match(await noticeText("tq"), /验收前置命令没通过：「关着开关验收」/, "全量对账补上丢了的门禁通知");
    await im.reconciler.full();
    await im.settle();
    assert.equal((await noticesOf("tq")).length, 1, "补过的不再补");
  }

  // ── ③ 续：门禁出结果；门禁跑着时任务又跑出新结果 ─────────────────────────
  {
    const repo = join(stage, "repo");
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.name", "Ash Test");
    git(repo, "config", "user.email", "ash@example.test");
    writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "seed");
    const seed = async (projectId: string, command: string, taskId: string) => {
      await db.insert(projects).values({ id: projectId, name: projectId, repoPath: repo, acceptGateCommand: command, createdAt: at } as never);
      const ws = await prepareWorktree(repo, taskId, "main");
      writeFileSync(join(ws.path, `${taskId}.txt`), `${taskId}\n`);
      git(ws.path, "add", "-A");
      git(ws.path, "commit", "-m", taskId);
      await db.insert(tasks).values({
        id: taskId, projectId, title: `门禁 ${taskId}`, body: "", mode: "single", status: "done", agentType: "claude",
        useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main", workflowMode: "free", endedAt: at, createdAt: at, updatedAt: at,
      } as never);
      // 门禁红了要叫醒任务，那一轮往会话里写（spawn 在 ASH_RUNS_DIR 下被拦）。
      await db.insert(sessions).values({ id: `s-${taskId}`, taskId, role: "single", agentType: "claude", executor: "claude", cwd: ws.path, startedAt: at, endedAt: at, activeMs: 0 } as never);
      await im.reconciler.reconcile([taskId]);
      await im.settle();
      return openCard(taskId, "accept");
    };
    const finished = async (taskId: string) => {
      for (let i = 0; i < 400; i++) {
        const run = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId)).orderBy(desc(acceptGateRuns.startedAt))).at(0);
        // 这套装配没接总线（channel.ts 才接）：门禁、验收发的事件这里收不到，手动对一次账。
        if (run && run.status !== "running") { await whenAcceptGateSettled(run.id); await im.reconciler.reconcile([taskId]); await im.settle(); return run.status; }
        await sleep(25);
      }
      throw new Error(`门禁 ${taskId} 没跑完`);
    };

    const passing = await seed("gp", "true", "tgpass");
    assert.match(JSON.stringify(await press(im.actions, buttonOf(passing, "accept").value!)), /验收前置命令在跑/);
    assert.equal(await finished("tgpass"), "passed");
    assert.equal((await taskRow("tgpass")).stage, "accepted", "门禁绿了自动合并");
    const passText = await noticeText("tgpass");
    assert.match(passText, /验收前置命令通过了：「门禁 tgpass」/);
    assert.match(passText, /已验收合并：「门禁 tgpass」/);

    const failing = await seed("gf", "exit 3", "tgfail");
    await press(im.actions, buttonOf(failing, "accept").value!);
    assert.equal(await finished("tgfail"), "failed");
    assert.match(await noticeText("tgfail"), /验收前置命令没通过：「门禁 tgfail」/, "门禁红了也推一条");
    assert.doesNotMatch(await noticeText("tgfail"), /已验收合并/);

    const racing = await seed("gr", "sleep 1", "tgrace");
    await press(im.actions, buttonOf(racing, "accept").value!);
    // 门禁跑着，另一端又跑完了一轮（树没变，门禁照样会绿）。
    await db.update(tasks).set({ endedAt: later(30) }).where(eq(tasks.id, "tgrace"));
    assert.equal(await finished("tgrace"), "passed");
    assert.notEqual((await taskRow("tgrace")).stage, "accepted", "门禁绿了，但验收的那一版已经不是点的那一版：不合并");
    assert.match(await timelineOf("tgrace"), /验收没有执行/);
    assert.doesNotMatch(await noticeText("tgrace"), /已验收合并/);
  }

  // ── ④ 同时到的几句话建房间 ───────────────────────────────────────────────
  {
    const member = { id: "assistant", name: "bot", agentType: "codex" };
    await db.insert(chatRooms).values({ id: "tmpl", kind: "assistant", name: "助手", projectId: "", ownerUserId: null, members: JSON.stringify([member]), createdAt: at, updatedAt: at } as never);
    let serial = 0;
    let onCreate: (() => Promise<void>) | null = null;
    /** 模板列表等两个请求都到了才回：两句话一定都看到「还没有房间」。 */
    const rendezvous = () => {
      let arrivals = 0;
      let both!: () => void;
      const ready = new Promise<void>((resolve) => { both = resolve; });
      return async () => { if (++arrivals === 2) both(); await ready; };
    };
    let meet = rendezvous();
    /** 读单间房间时回 500（库忙、chat 那边抛了），模拟「这一下没读到」。 */
    let flaky = false;
    const relay = new RoomRelay({
      appId: APP, commands: im.commands,
      ash: {
        get: async (who: typeof principal, path: string) => {
          if (path.startsWith("/api/chats?")) { await meet(); return im.ash.get(who, path as `/api/${string}`); }
          if (flaky) return { ok: false, status: 500, error: "database is locked", data: {} };
          const id = decodeURIComponent(path.split("/").pop()!);
          const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, id))).at(0);
          return room ? { ok: true, status: 200, data: { room: { projectId: room.projectId, members: JSON.parse(room.members) } } } : { ok: false, status: 404, error: "chat not found", data: {} };
        },
        post: async (_who: typeof principal, _path: string, body: { kind: string; projectId: string; members: unknown[] }) => {
          const id = `race-room-${++serial}`;
          await db.insert(chatRooms).values({ id, kind: body.kind, name: "飞书", projectId: body.projectId, ownerUserId: null, members: JSON.stringify(body.members), createdAt: at, updatedAt: at } as never);
          await onCreate?.();
          return { ok: true, status: 200, data: { id } };
        },
      } as never,
    });
    const roomExists = async (id: string) => (await db.select().from(chatRooms).where(eq(chatRooms.id, id))).length > 0;

    await db.insert(imGroups).values({ channel: "feishu", appId: APP, chatId: "oc_race", projectId: "p1", name: "竞速群", boundBy: null, pushCards: 0, boundAt: at });
    const group = (await groupOf(APP, "oc_race"))!;
    const binding = (await bindingOf(APP, OWNER))!;
    const dest = { receiveType: "chat_id" as const, receiveId: "oc_race", recipientOpenId: null };
    const ctx = { principal, binding, dest, chatType: "group" as const, chatId: "oc_race", messageId: "om_race", card: null };
    const both = await Promise.all([relay.groupRoom(ctx, group), relay.groupRoom(ctx, group)]);
    const ids = both.map((room) => ("roomId" in room ? room.roomId : room.error));
    assert.equal(ids[0], ids[1], `两句话进同一间：${ids.join(" / ")}`);
    assert.equal(await groupRoomOf(APP, "oc_race", ""), ids[0], "映射记的就是那一间");
    await sleep(100);
    assert.deepEqual(await Promise.all(["race-room-1", "race-room-2"].map(roomExists)).then((alive) => alive.filter(Boolean).length), 1, "多建的那间删掉了");

    // 建房间的时候群换了一次绑定：这间不落进新绑定的映射。
    await deleteGroup(APP, "oc_race");
    await db.insert(imGroups).values({ channel: "feishu", appId: APP, chatId: "oc_race", projectId: "p1", name: "竞速群", boundBy: null, pushCards: 0, boundAt: later(40) });
    onCreate = async () => { await db.update(imGroups).set({ boundAt: later(50) }).where(eq(imGroups.chatId, "oc_race")); };
    meet = async () => {};
    const stale = await relay.groupRoom(ctx, (await groupOf(APP, "oc_race"))!);
    onCreate = null;
    assert.ok("error" in stale, "绑定换过：这一句不投，叫他再发一次");
    assert.equal(await groupRoomOf(APP, "oc_race", ""), null, "旧绑定下建的房间不落进新绑定的映射");
    await sleep(100);
    assert.equal(await roomExists(`race-room-${serial}`), false, "没领到的那间删掉了");

    // 单聊助手房间同理。
    meet = rendezvous();
    const p2p = { ...ctx, binding: (await bindingOf(APP, OWNER))!, chatType: "p2p" as const, chatId: "oc_p2p", dest: { receiveType: "open_id" as const, receiveId: OWNER, recipientOpenId: OWNER } };
    const rooms = await Promise.all([relay.assistantRoom(p2p), relay.assistantRoom({ ...p2p, binding: { ...p2p.binding } })]);
    assert.equal(typeof rooms[0], "string");
    assert.equal(rooms[0], rooms[1], `单聊两句进同一间助手房间：${JSON.stringify(rooms)}`);
    assert.equal((await bindingOf(APP, OWNER))!.assistantRoomId, rooms[0]);
    await sleep(100);
    const assistants = await db.select().from(chatRooms).where(and(eq(chatRooms.kind, "assistant"), like(chatRooms.id, "race-room-%")));
    assert.equal(assistants.length, 1, "多建的助手房间删掉了");

    // 读房间只是这一下没读到：不换房间。换了的话旧房间里还在路上的回复，出口就不认了（只认映射上那一间）。
    flaky = true;
    const created = serial;
    const blip = await relay.assistantRoom({ ...p2p, binding: (await bindingOf(APP, OWNER))! });
    assert.match(typeof blip === "string" ? blip : blip.error, /这一下没读到你的助手房间/, "读不到：这句不投，叫他再发");
    assert.equal((await bindingOf(APP, OWNER))!.assistantRoomId, rooms[0], "映射原样");
    await relay.groupRoom(ctx, (await groupOf(APP, "oc_race"))!);
    flaky = false;
    const groupRoom = await groupRoomOf(APP, "oc_race", "");
    assert.ok(groupRoom, "群里先建一间");
    flaky = true;
    const groupBlip = await relay.groupRoom(ctx, (await groupOf(APP, "oc_race"))!);
    assert.match("error" in groupBlip ? groupBlip.error : "", /这一下没读到你在这个群的房间/);
    assert.equal(await groupRoomOf(APP, "oc_race", ""), groupRoom, "群里的映射也原样");
    assert.equal(serial, created + 1, "读不到的那两次都没另建房间");

    // 等回复时读不到房间：下一圈再看；房间真没了才说没拿到回复。
    await db.insert(imInbound).values({
      id: "msg:om_wait", channel: "feishu", appId: APP, openId: OWNER, chatId: "oc_p2p", chatType: "p2p", kind: "assistant",
      roomId: "gone-room", detail: "im-x", state: "sent", createdAt: at, updatedAt: new Date().toISOString(),
    } as never);
    fake.reset();
    await relay.poll();
    assert.equal((await db.select().from(imInbound).where(eq(imInbound.id, "msg:om_wait"))).at(0)!.state, "sent", "这一下没读到：不算结局");
    flaky = false;
    await relay.poll();
    await im.settle();
    assert.equal((await db.select().from(imInbound).where(eq(imInbound.id, "msg:om_wait"))).at(0)!.state, "failed", "房间没了：这才算没拿到回复");
    assert.match(JSON.stringify(fake.sends().map(contentOf)), /没拿到回复/);
  }

  // ── ④ 续：群列表照实说「哪个群在收卡」「你能不能改」──────────────────────
  {
    await db.insert(imGroups).values([
      { channel: "feishu", appId: APP, chatId: "oc_old", projectId: "p1", name: "老群", boundBy: "u_me", pushCards: 1, boundAt: later(60) },
      { channel: "feishu", appId: APP, chatId: "oc_new", projectId: "p1", name: "新群", boundBy: "u_other", pushCards: 1, boundAt: later(70) },
    ]);
    const view = new Map((await groupsView("u_me", false, APP, null)).groups.map((item) => [item.chatId, item]));
    assert.deepEqual([view.get("oc_old")!.receiving, view.get("oc_new")!.receiving], [false, true], "同一项目两个群都开着推送：只有最近绑的那个在收");
    assert.deepEqual([view.get("oc_old")!.canEdit, view.get("oc_new")!.canEdit], [true, false], "别人绑的群：看得见、改不了");
    assert.equal((await groupsView("u_me", true, APP, null)).groups.find((item) => item.chatId === "oc_new")!.canEdit, true, "管理员改得了");
  }

  // ── ④ 续：库里读出来的东西坏了，不当成空的往下办 ────────────────────────────
  {
    // 按钮记录坏了：不能按空的办（空着就是不带版本去验收最新那一版），拒掉并说清。
    await db.insert(tasks).values({ id: "tbad", projectId: "p1", title: "按钮坏了", body: "", status: "done", useWorktree: false, workflowMode: "free", endedAt: at, createdAt: at, updatedAt: at } as never);
    await db.insert(sessions).values({ id: "s-tbad", taskId: "tbad", role: "single", agentType: "claude", executor: "claude", cwd: join(stage, "plain"), startedAt: at, endedAt: at, activeMs: 0 } as never);
    await im.reconciler.reconcile(["tbad"]);
    await im.settle();
    const card = await openCard("tbad", "accept");
    await db.update(imActions).set({ payload: "{坏" }).where(eq(imActions.outboxId, card.id));
    const response = await press(im.actions, buttonOf(card, "accept").value!);
    assert.match(JSON.stringify(response), /按钮记录读不出来/, "说清为什么没办");
    assert.equal((await taskRow("tbad")).stage, null, "没有不核版本就验收");

    // 飞书传来的正文解析不了：不当空消息吞掉，记成没办成、叫他重发。
    fake.reset();
    await im.inbound.handle({
      sender: { sender_id: { open_id: OWNER }, sender_type: "user" },
      message: { message_id: "om_garbled", chat_id: "oc_p2p", chat_type: "p2p", message_type: "text", content: "{坏", mentions: [] },
    } as never);
    await im.settle();
    assert.equal((await db.select().from(imInbound).where(eq(imInbound.id, "msg:om_garbled"))).at(0)!.state, "failed");
    assert.match(JSON.stringify(fake.sends().map(contentOf)), /没读懂/);

    // 发件队列里有一行内容坏了：标成放弃，排在它后面的照发，不卡住整条队列。
    fake.reset();
    const row = (id: string, content: string) => ({
      id, channel: "feishu", appId: APP, receiveType: "open_id", receiveId: OWNER, recipientOpenId: OWNER, taskId: null,
      kind: "online", subject: id, msgType: "text", content, state: "pending", createdAt: at, updatedAt: at,
    });
    await db.insert(imOutbox).values([row("row-garbled", "{坏"), row("row-after", JSON.stringify({ text: "后面这条" }))] as never);
    await im.sender.drainNow();
    const [garbled] = await db.select().from(imOutbox).where(eq(imOutbox.id, "row-garbled"));
    assert.equal(garbled!.state, "dead");
    assert.match(garbled!.lastError ?? "", /解析不了/);
    assert.equal((await db.select().from(imOutbox).where(eq(imOutbox.id, "row-after"))).at(0)!.state, "sent", "后面那条照发");
  }

  // ── ⑤ @ 占位与缩进 ───────────────────────────────────────────────────────
  {
    const mentions = [{ key: "@_user_1", openId: "ou_bot" }];
    const code = "@_user_1 看下这段\n    def f():\n        return  1\n";
    assert.equal(parseMessage("text", JSON.stringify({ text: code }), mentions).text, "看下这段\n    def f():\n        return  1");
    assert.equal(parseMessage("text", JSON.stringify({ text: "@_user_1\n  缩进的第一行" }), mentions).text, "  缩进的第一行");
    // 跟 @ 写在同一行的对齐、制表符也原样：只去掉占位符和隔开它的那一个空格。
    assert.equal(parseMessage("text", JSON.stringify({ text: "@_user_1 /reply x  =  1\t# 对齐" }), mentions).text, "/reply x  =  1\t# 对齐");
    assert.equal(parseMessage("text", JSON.stringify({ text: "看下  @_user_1 这里\t\t对齐" }), mentions).text, "看下  这里\t\t对齐");
    assert.equal(parseMessage("text", JSON.stringify({ text: "    return  1  @_user_1" }), mentions).text, "    return  1");
    // 只去一个分隔空白：行首 @ 后面多打的空格是缩进；行中间只有一侧有空白就留着它，不把两个词粘起来；连着的 @ 当一段。
    assert.equal(parseMessage("text", JSON.stringify({ text: "@_user_1    def f():" }), mentions).text, "   def f():");
    assert.equal(parseMessage("text", JSON.stringify({ text: "@_user_1  看下这段" }), mentions).text, " 看下这段");
    assert.equal(parseMessage("text", JSON.stringify({ text: "a@_user_1 b" }), mentions).text, "a b");
    assert.equal(parseMessage("text", JSON.stringify({ text: "a @_user_1b" }), mentions).text, "a b");
    assert.equal(parseMessage("text", JSON.stringify({ text: "a @_user_1 @_user_2 b" }), mentions).text, "a b");
    assert.equal(parseMessage("text", JSON.stringify({ text: "a@_user_1b" }), mentions).text, "ab");
    // post 里的 @ 是单独的节点：同样只去它和一个分隔空白，正文的缩进原样。
    const post = { zh_cn: { content: [[{ tag: "at", user_id: "@_user_1" }, { tag: "text", text: "   def f():" }], [{ tag: "text", text: "看下" }, { tag: "at", user_id: "@_user_1" }, { tag: "text", text: " 这里" }]] } };
    assert.equal(parseMessage("post", JSON.stringify(post), mentions).text, "  def f():\n看下 这里");
  }

  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-outcomes: ok");
} catch (error) {
  failure = error;
} finally {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
