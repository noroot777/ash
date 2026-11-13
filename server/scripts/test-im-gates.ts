// 预设工作流上接连几道「等我点头」× 飞书待验收卡（理由见 server/src/task-human-gate.ts 文件头）。
// 中途那几道放行只挪游标、不起新的一轮，成果身份前后一样；只认它，旧卡能放后来那一道、下一道也发不出新卡（审查复现）。
//
// ① 点第一道关的卡：只放这一道，卡上照实说「已放行」不说「合并」；线走到第二道关时推一张新卡（不被上一张已处理的卡
//    占住）；最后一道关的卡换回验收的说法，确认框和网页同一句；点它就地验收，结果和完成通知都不说「合并」；
// ② 网页先放了第一道，再点飞书里第一道的旧卡：回「过时」，不放后来那一道；
// ③ 接口自己也核：带着上一段的身份（线还没离开过关口时是 NO_GATE，和加列之前的老卡同形）进验收接口 → 409、线不动；
//    带着此刻这一段就照常放；
// ④ 放行按「还是核过的那一道关」写：核过之后线才换了关，放行落空、阶段不动；
// ⑤ 门禁跑完自动续验收的那一次带着关口身份：选择原样存、原样读回来；
// ⑥ 只推标题的项目：待验收卡的确认框不带分支这些细节；
// ⑦ 放行之后线停在这一道上（往下走没成、或者被重启打断）：身份不变、不冒新卡；同一段的卡再点就是重走一遍，照常放；
// ⑧ 先验证、再点头：验证还在跑时发的卡走到关口原地换成放行的样子、不另推；放行进了下一站验证是新的一段、新卡，
//    旧卡收成「这一关已经放行过了」、不会被翻回来；走到下一道关又是原地换。
// ⑨ 验收结果的说法：只推标题那一版不带分支名、标签名、尾段原话；「合并后不提交」事后提交了就说合并了；
// ⑩ 放行之后往下走那一段没跑成：结果卡照实说线停住了、不说「接着往下走」，网页那一端拿到的响应也带着停住了；
//    这件事还等着人按，卡不收、换了新信封，对账也不收它；原因修好之后再点同一张卡，线从这一道走过去；
// ⑪ 对账、重启接管同一个判据（im/attention.ts awaitsPress）：卡上显示着上一下的结局、还有验收前置命令在替他跑，
//    不动；跑完了这件事还等着人按，换新信封重新能点；点过收起来的卡这件事还等着人按就复活；重启前占着没结局的信封，
//    同一件事还在就放回去；
// ⑫ 放行之后线挪到了下一站验证、那一轮却没开起来：照实说没开起来、停在那一站，不说「接着往下走」，也不叫人再放一次。
// 接力导入一律新领身份，钉在 test-handoff-local.ts。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-gates-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-gates");

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { imActions, imBindings, imOutbox } = await import("../src/db/schema-im.js");
  const { acceptGateRuns } = await import("../src/db/schema-accept-gate.js");
  const { releaseGate } = await import("../src/task-accept-tail.js");
  const { ACTED } = await import("../src/im/reconcile.js");
  const { cardHeaderOf } = await import("../src/im/outbox.js");
  const { renderCard } = await import("../src/im/feishu/cards.js");
  const { and, asc, eq } = await import("drizzle-orm");
  const { api } = await import("../src/routes.js");
  const { mountTaskAcceptanceRoutes } = await import("../src/task-accept-routes.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { advanceWorkflowFrom } = await import("../src/workflow-advance.js");
  const { taskWorkflowDef } = await import("../src/workflows.js");
  const { humanGateOf, NO_GATE, releaseHumanGate } = await import("../src/task-human-gate.js");
  const { resultVersionOf } = await import("../src/task-result-version.js");
  const { parseChoices } = await import("../src/accept-gate-handoff.js");
  const { acceptIdentityOf, viewsOf } = await import("../src/im/attention.js");
  const { acceptedLabel, settledCard, turnCard } = await import("../src/im/cards.js");
  const { acceptedOutcome } = await import("../src/im/actions.js");
  const { patchOptions } = await import("../src/im/meta.js");
  const { makeStep } = await import("@ash/shared/workflow");
  const { APP, OWNER, FakeFeishu, buildApp, assemble, contentOf, textOf, buttonsOf } = await import("./im-fixture.js");

  await ensureSchema();
  mountTaskAcceptanceRoutes(api);
  const app = buildApp();
  const fake = new FakeFeishu();
  const im = await assemble(app, fake);
  await patchOptions({ notifyCompleted: true });

  const at = new Date().toISOString();
  mkdirSync(join(stage, "repo"), { recursive: true });
  await db.insert(projects).values({ id: "p1", name: "飞书项目", repoPath: join(stage, "repo"), apiKeys: null, createdAt: at } as never);
  await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: at });
  const principal = { channel: "feishu" as const, appId: APP, openId: OWNER };
  const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
  const cards = (taskId: string) => db.select().from(imOutbox)
    .where(and(eq(imOutbox.taskId, taskId), eq(imOutbox.kind, "accept"))).orderBy(asc(imOutbox.createdAt));
  const acceptButton = (card: { content: string }) => buttonsOf(JSON.parse(card.content)).find((button) => button.value?.op === "accept")!;
  /** 一条线：干活 → 这几道「等我点头」→ 合并并清理。任务干完了，从干活那一站推一步（真推进器）走进第一道关，再对一次账。 */
  const seed = async (id: string, gates: string[]) => {
    const line = JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"), ...gates.map((gate) => makeStep("human", gate)), makeStep("accept", "accept")] });
    await db.insert(tasks).values({
      id, projectId: "p1", title: `关口 ${id}`, body: "", status: "done", useWorktree: false, workflow: line, workflowAt: "run",
      endedAt: at, createdAt: at, updatedAt: at,
    } as never);
    await advanceWorkflowFrom(await row(id), taskWorkflowDef(line), "run");
    await im.reconciler.reconcile([id]);
    await im.settle();
  };

  // ── ① 正常点完一道关，下一道关有新卡 ────────────────────────────────────
  {
    await seed("g2", ["first", "second"]);
    const first = await row("g2");
    assert.equal(first.workflowAt, "first");
    assert.equal(first.stage, "awaiting_acceptance");
    assert.equal(first.humanGateId, null, "还没离开过关口：没有身份");
    const [card] = await cards("g2");
    assert.ok(card, "第一道关推了卡");
    assert.equal(acceptButton(card!).text, "放行，继续下一站", "中途那道关：按钮说放行");
    assert.match(textOf(JSON.parse(card!.content)), /等你放行/);
    assert.match(card!.content, /只是放行这一关/, "确认框和网页同一句");
    assert.doesNotMatch(card!.content, /合并回|清理工作区|验收前置命令/, "中途关口的卡不许说会合并、会跑门禁");

    const released = await im.click(OWNER, acceptButton(card!).value!);
    assert.match(textOf(released.card?.data), /已放行这一关/, JSON.stringify(released));
    assert.doesNotMatch(JSON.stringify(released), /合并/, "放行不说成合并");
    const second = await row("g2");
    assert.equal(second.workflowAt, "second");
    assert.equal(second.stage, "awaiting_acceptance");
    assert.ok(second.humanGateId, "离开第一道关时领了新的一段");
    assert.equal(await resultVersionOf(second), await resultVersionOf(first), "成果身份没变：只靠它分不出两道关");

    fake.reset();
    await im.reconciler.reconcile(["g2"]);
    await im.settle();
    const all = await cards("g2");
    assert.equal(all.length, 2, "第二道关推了一张新卡，没被上一张已处理的卡占住");
    assert.equal(fake.sends().length, 1, "新卡是一条新消息（会提醒）");
    const next = all.find((item) => item.id !== card!.id)!;
    assert.notEqual(next.subject, card!.subject, "两道关两个代次");
    assert.equal(acceptButton(next).text, "验收通过", "最后一道关：按钮换回验收");
    assert.match(next.content, /标记为验收完成/, "就地任务：确认框照网页说不动 git");
    assert.match((await im.click(OWNER, acceptButton(card!).value!)).toast!.content, /已经处理过了/);

    const done = await im.click(OWNER, acceptButton(next).value!);
    assert.match(textOf(done.card?.data), /已验收：改动就在原工作区里/, JSON.stringify(done));
    assert.equal((await row("g2")).stage, "accepted");
    const last = acceptIdentityOf(next.subject!);
    const again = await im.ash.post(principal, "/api/tasks/g2/accept", { expectedResultVersion: last.resultVersion, expectedHumanGate: last.humanGate });
    assert.equal(again.ok && again.data.kind, "already_accepted", `最后一道关点第二下照实回「验收过了」：${JSON.stringify(again)}`);
    fake.reset();
    await im.reconciler.reconcile(["g2"]);
    await im.settle();
    const notice = fake.sends().map((call) => textOf(contentOf(call))).find((text) => text.includes("「关口 g2」"));
    assert.match(notice ?? "", /^【飞书项目】已验收：「关口 g2」/, `完成通知照实说：${notice}`);
  }

  // ── ② 网页先放了第一道，再点第一道的旧卡 ───────────────────────────────
  // ── ③ 接口自己也核 ──────────────────────────────────────────────────────
  {
    await seed("g3", ["first", "second", "third"]);
    const [old] = await cards("g3");
    const firstGate = acceptIdentityOf(old!.subject!).humanGate;
    assert.equal(firstGate, NO_GATE, "还没离开过关口：代次没有关口那一截，和加列之前的卡同形");
    assert.equal(old!.subject, `a:${await resultVersionOf(await row("g3"))}`);
    const web = await acceptTask("g3");
    assert.equal(web.accepted && web.kind, "gate_released", JSON.stringify(web));
    assert.equal((await row("g3")).workflowAt, "second");
    const stale = await im.click(OWNER, acceptButton(old!).value!);
    assert.match(stale.toast?.content ?? "", /过时/, JSON.stringify(stale));
    let now = await row("g3");
    assert.equal(now.workflowAt, "second", "旧卡没把第二道关放掉");
    assert.equal(now.stage, "awaiting_acceptance");

    const resultVersion = await resultVersionOf(now);
    const older = await im.ash.post(principal, "/api/tasks/g3/accept", { expectedResultVersion: resultVersion, expectedHumanGate: firstGate });
    assert.equal(!older.ok && older.data.reason, "gate_changed", JSON.stringify(older));
    now = await row("g3");
    assert.equal(now.workflowAt, "second", "没放");
    assert.equal(now.stage, "awaiting_acceptance");
    const current = await im.ash.post(principal, "/api/tasks/g3/accept", { expectedResultVersion: resultVersion, expectedHumanGate: humanGateOf(now) });
    assert.equal(current.ok && current.data.kind, "gate_released", "带着此刻这道关照常放");
    assert.equal((await row("g3")).workflowAt, "third");
  }

  // ── ④ 放行按「还是核过的那一道关」写 ────────────────────────────────────
  {
    await seed("g4", ["first", "second"]);
    const seen = await row("g4");
    const def = taskWorkflowDef(seen.workflow);
    // 核过身份之后、放行落库之前，线换了一道关（直接改库模拟另一条推进路径抢先）。
    await db.update(tasks).set({ humanGateId: "another-arrival" }).where(eq(tasks.id, "g4"));
    const late = await releaseHumanGate(seen, def, null);
    assert.equal(!late.accepted && late.reason, "gate_changed", JSON.stringify(late));
    assert.equal((await row("g4")).stage, "awaiting_acceptance", "放行落空：阶段没被清掉");
    const fresh = await releaseHumanGate(await row("g4"), def, null);
    assert.equal(fresh.accepted && fresh.kind, "gate_released", "核的是此刻这一份就照常放");
    assert.equal((await row("g4")).stage, null);
  }

  // ── ⑤ 门禁续验收的选择带着关口身份 ──────────────────────────────────────
  {
    const choices = parseChoices(JSON.stringify({ by: "human", expectedResultVersion: "r1", expectedHumanGate: "gate-1" }));
    assert.equal(choices?.expectedHumanGate, "gate-1");
    assert.equal(choices?.expectedResultVersion, "r1");
    assert.equal(parseChoices(JSON.stringify({ by: "human", expectedHumanGate: 3 }))?.expectedHumanGate, undefined, "不是字符串当没记");
  }

  // ── ⑥ 只推标题：确认框不带细节 ──────────────────────────────────────────
  {
    await seed("g6", ["only"]);
    const view = (await viewsOf(["g6"])).get("g6")!;
    assert.equal(view.turn?.kind, "accept");
    const shown = JSON.stringify(turnCard(view, view.turn!, { link: null, titleOnly: true }, "envelope-g6"));
    const full = JSON.stringify(turnCard(view, view.turn!, { link: null, titleOnly: false }, "envelope-g6"));
    assert.ok(view.turn?.kind === "accept" && full.includes(view.turn.confirm), "平时确认框就是网页那一句");
    assert.ok(view.turn?.kind === "accept" && !shown.includes(view.turn.confirm), "只推标题时换成不带细节的那一句");
  }

  // ── ⑦ 放行之后线停在这一道上 ─────────────────────────────────────────────
  {
    await seed("g7", ["first", "second"]);
    const [card] = await cards("g7");
    const seen = await row("g7");
    // 只放行、不往下走：和往下走那一段没跑成、或者跑到一半被重启打断之后一个样子。
    const released = await releaseHumanGate(seen, taskWorkflowDef(seen.workflow), null);
    assert.equal(released.accepted && released.kind, "gate_released");
    const between = await row("g7");
    assert.equal(between.workflowAt, "first");
    assert.equal(between.stage, null);
    const view = (await viewsOf(["g7"])).get("g7")!;
    assert.equal(view.turn?.generation, card!.subject, "身份还是这一道：代次没变");
    fake.reset();
    await im.reconciler.reconcile(["g7"]);
    await im.settle();
    assert.equal((await cards("g7")).length, 1, "这一段不冒新卡");
    assert.equal(fake.sends().length, 0);
    const twice = await im.ash.post(principal, "/api/tasks/g7/accept", {
      expectedResultVersion: acceptIdentityOf(card!.subject!).resultVersion, expectedHumanGate: acceptIdentityOf(card!.subject!).humanGate,
    });
    assert.equal(twice.ok && twice.data.kind, "gate_released", `同一段的卡再点就是重走：${JSON.stringify(twice)}`);
    assert.equal((await row("g7")).workflowAt, "second", "这一次走过去了");
  }

  // ── ⑧ 先验证、再点头 ────────────────────────────────────────────────────
  {
    const line = JSON.stringify({ workspace: "shared", steps: [
      makeStep("run", "run"), makeStep("verify", "v1"), makeStep("human", "first"), makeStep("verify", "v2"), makeStep("human", "second"),
      makeStep("accept", "accept"),
    ] });
    const def = taskWorkflowDef(line);
    const noVerify = { startVerifyRound: async () => undefined }; // 只看游标和卡，不真开验证轮
    await db.insert(tasks).values({
      id: "g8", projectId: "p1", title: "关口 g8", body: "", status: "done", useWorktree: false, workflow: line, workflowAt: "run",
      endedAt: at, createdAt: at, updatedAt: at,
    } as never);
    await advanceWorkflowFrom(await row("g8"), def, "run", noVerify);
    assert.equal((await row("g8")).workflowAt, "v1");
    await db.update(tasks).set({ stage: "verifying" }).where(eq(tasks.id, "g8"));
    fake.reset();
    await im.reconciler.reconcile(["g8"]);
    await im.settle();
    const [early] = await cards("g8");
    assert.ok(early, "验证还在跑：待验收卡已经发了");
    assert.equal(acceptButton(early!).text, "验收通过");

    // 验证过了，走进第一道关：同一张卡原地换成放行的样子。
    await db.update(tasks).set({ stage: "verified" }).where(eq(tasks.id, "g8"));
    await advanceWorkflowFrom(await row("g8"), def, "v1", noVerify);
    assert.equal((await row("g8")).workflowAt, "first");
    fake.reset();
    await im.reconciler.reconcile(["g8"]);
    await im.settle();
    let all = await cards("g8");
    assert.equal(all.length, 1, "走到关口不另推一张");
    assert.equal(fake.sends().length, 0, "不发新消息");
    assert.notEqual(all[0]!.state, "resolved", "卡没被收起来");
    assert.equal(acceptButton(all[0]!).text, "放行，继续下一站", "原地换成放行的样子");

    // 放行，线走进下一站验证：新的一段、新卡；旧卡照实收起来，不被翻回来。
    await releaseHumanGate(await row("g8"), def, null);
    await advanceWorkflowFrom(await row("g8"), def, "first", noVerify);
    assert.equal((await row("g8")).workflowAt, "v2");
    await db.update(tasks).set({ stage: "verifying" }).where(eq(tasks.id, "g8"));
    fake.reset();
    await im.reconciler.reconcile(["g8"]);
    await im.settle();
    all = await cards("g8");
    assert.equal(all.length, 2, "新的一段一张新卡");
    const old = all.find((item) => item.id === early!.id)!;
    assert.equal(old.state, "resolved");
    assert.match(old.content, /这一关已经放行过了/, "不说成「有了新的一轮」");
    const later = all.find((item) => item.id !== early!.id)!;
    assert.ok(acceptIdentityOf(later.subject!).humanGate !== NO_GATE, "新的一段带着身份");

    // 第二站验证过了，走进最后一道关：又是原地换，旧卡也还收着。
    await db.update(tasks).set({ stage: "verified" }).where(eq(tasks.id, "g8"));
    await advanceWorkflowFrom(await row("g8"), def, "v2", noVerify);
    assert.equal((await row("g8")).workflowAt, "second");
    fake.reset();
    await im.reconciler.reconcile(["g8"]);
    await im.settle();
    all = await cards("g8");
    assert.equal(all.length, 2);
    assert.equal(fake.sends().length, 0);
    assert.equal(all.find((item) => item.id === early!.id)!.state, "resolved", "旧卡没被翻回来");
    assert.equal(acceptButton(all.find((item) => item.id === later.id)!).text, "验收通过");
  }

  // ── ⑨ 验收结果的说法 ────────────────────────────────────────────────────
  {
    const secret = "feature/secret-x";
    const merged = acceptedOutcome({ kind: "isolated_worktree", merge: "fast_forward", targetBranch: secret });
    assert.match(merged.text!, /已验收合并（合入 feature\/secret-x）/);
    assert.equal(merged.brief, "已验收合并。", "只推标题：不带分支名");
    const staged = acceptedOutcome({ kind: "isolated_worktree", merge: "no_commit", targetBranch: secret });
    assert.ok(staged.text!.includes(secret) && !staged.brief!.includes(secret));
    const tagged = acceptedOutcome({ kind: "isolated_worktree", merge: "tagged", tag: "ash-accepted/abc123" });
    assert.ok(tagged.text!.includes("ash-accepted/abc123") && !tagged.brief!.includes("ash-accepted"), "只推标题：不带标签名");
    const broken = acceptedOutcome({ kind: "isolated_worktree", merge: "fast_forward", targetBranch: secret, tail: { ok: false, step: "跑一条命令", reason: "npm ERR! token=abc" } });
    assert.equal(broken.tone, "orange");
    assert.ok(broken.text!.includes("npm ERR!"));
    assert.ok(!broken.brief!.includes(secret) && !broken.brief!.includes("npm ERR!") && broken.brief!.includes("没跑成"), broken.brief);
    assert.equal(acceptedOutcome({ kind: "in_place" }).brief, undefined, "没有细节可藏：不另备一版");

    assert.match(acceptedLabel({ acceptedMergeMethod: "no_commit", acceptedMergeCommit: null }), /还没提交/);
    assert.equal(acceptedLabel({ acceptedMergeMethod: "no_commit", acceptedMergeCommit: "abc123" }), "已验收合并", "事后提交了：就是合并了");
    assert.match(acceptedLabel({ acceptedMergeMethod: "tagged", acceptedMergeCommit: null }), /只打了标签/);
    assert.equal(acceptedLabel({ acceptedMergeMethod: null, acceptedMergeCommit: null }), "已验收");
  }

  // ── ⑩ 放行之后往下走那一段没跑成 ────────────────────────────────────────
  {
    const lineWith = (cmd: string) => JSON.stringify({ workspace: "shared", steps: [
      makeStep("run", "run"), makeStep("human", "first"), { ...makeStep("command", "deploy"), p: { cmd, where: "workspace" } },
      makeStep("human", "second"), makeStep("accept", "accept"),
    ] });
    const line = lineWith("echo boom-deploy >&2; exit 3");
    await db.insert(tasks).values({
      id: "g10", projectId: "p1", title: "关口 g10", body: "", status: "done", useWorktree: false, workflow: line, workflowAt: "run",
      endedAt: at, createdAt: at, updatedAt: at,
    } as never);
    await advanceWorkflowFrom(await row("g10"), taskWorkflowDef(line), "run");
    await im.reconciler.reconcile(["g10"]);
    await im.settle();
    const [card] = await cards("g10");
    const pressed = await im.click(OWNER, acceptButton(card!).value!);
    const said = textOf(pressed.card?.data);
    assert.match(said, /已放行这一关，但线没能接着往下走：「跑一条命令」没跑成（boom-deploy/, said);
    assert.match(said, /修好之后再点一次「放行，继续下一站」/, "照实说再点一次是什么");
    assert.doesNotMatch(said, /这条线接着往下走/);
    assert.equal(pressed.toast?.type, "warning");
    assert.equal((await row("g10")).workflowAt, "first", "确实停在这一道上");
    // 放行办成了，这件事却还等着人按：卡不收，换了新信封，按钮还能点。
    const again = buttonsOf(pressed.card?.data).find((button) => button.value?.op === "accept");
    assert.equal(again?.text, "放行，继续下一站", `卡上还有能点的放行：${JSON.stringify(pressed)}`);
    assert.notEqual(again!.value!.e, acceptButton(card!).value!.e, "换了新信封");
    let kept = await cards("g10");
    assert.equal(kept.length, 1);
    assert.notEqual(kept[0]!.state, "resolved", "卡没收起来");
    assert.equal(kept[0]!.content, JSON.stringify(pressed.card!.data), "库里那份就是带回去的那张");
    assert.match((await im.click(OWNER, acceptButton(card!).value!)).toast!.content, /已经处理过了/, "点过的那个信封照旧算用过了");

    // 对账按同一个判据：不收、不另推，停住了那一句也还在。
    fake.reset();
    await im.reconciler.reconcile(["g10"]);
    await im.settle();
    kept = await cards("g10");
    assert.equal(kept.length, 1);
    assert.notEqual(kept[0]!.state, "resolved");
    assert.match(kept[0]!.content, /没能接着往下走/);
    assert.equal(acceptButton(kept[0]!).value!.e, again!.value!.e, "按钮还是那个新信封");
    assert.equal(fake.sends().length, 0, "不另推");

    const web = await acceptTask("g10");
    assert.equal(web.accepted && web.kind, "gate_released", "网页那一端照样能重放");
    assert.equal(web.accepted && web.tail?.ok, false, "响应带回停住了");
    assert.ok(web.accepted && !web.tail?.movedOn, "还停在这一道上");

    // 原因修好了（命令改成能过），再点同一张卡：从这一道重新往下走，这张卡这才收起来。
    await db.update(tasks).set({ workflow: lineWith("echo deploy-ok") }).where(eq(tasks.id, "g10"));
    const fixed = await im.click(OWNER, acceptButton((await cards("g10"))[0]!).value!);
    assert.match(textOf(fixed.card?.data), /已放行这一关，这条线接着往下走/, JSON.stringify(fixed));
    assert.equal((await row("g10")).workflowAt, "second", "这一次走过去了");
    const closed = (await cards("g10")).find((item) => item.id === card!.id)!;
    assert.equal(closed.state, "resolved");
    assert.equal(closed.resolution, ACTED);
  }

  // ── ⑪ 对账、重启接管同一个判据 ──────────────────────────────────────────
  {
    await seed("g11", ["first", "second"]);
    const [card] = await cards("g11");
    const envelope = acceptButton(card!).value!.e as string;
    // 一下点击办完了、卡上显示着它的结局（没有按钮），验收前置命令还在替他跑：accept_gate_running 留下的样子。
    const result = JSON.stringify(renderCard(settledCard(cardHeaderOf(card!.content), "验收前置命令在跑。", { link: null }, "wathet")));
    await db.update(imActions).set({ usedAt: at, claimedBy: "gone:1", result: "验收前置命令在跑。" }).where(eq(imActions.id, envelope));
    await db.update(imOutbox).set({ content: result }).where(eq(imOutbox.id, card!.id));
    await db.insert(acceptGateRuns).values({
      id: "run-g11", taskId: "g11", projectId: "p1", command: "true", cwd: stage, status: "running", logPath: join(stage, "g11.log"), startedAt: at,
    } as never);
    await im.reconciler.reconcile(["g11"]);
    await im.settle();
    let now = (await cards("g11"))[0]!;
    assert.equal(now.content, result, "还在替他跑：卡面归那一下管");

    // 跑完了，这件事却还等着人按（比如没能交回任务）：换新信封，按钮又能点了。
    await db.update(acceptGateRuns).set({ status: "failed" }).where(eq(acceptGateRuns.id, "run-g11"));
    await im.reconciler.reconcile(["g11"]);
    await im.settle();
    now = (await cards("g11"))[0]!;
    assert.notEqual(now.state, "resolved");
    assert.notEqual(acceptButton(now)?.value?.e ?? envelope, envelope, `换了新信封：${now.content}`);
    assert.match(now.content, /上一次点下去的那件事办完了/);
    await db.delete(acceptGateRuns).where(eq(acceptGateRuns.id, "run-g11"));

    // 点过收起来的卡（ACTED），这件事还等着人按：对账复活它，不让它停在一张没有按钮的卡上。
    await db.update(imOutbox).set({ state: "resolved", resolution: ACTED, content: result }).where(eq(imOutbox.id, now.id));
    await im.reconciler.reconcile(["g11"]);
    await im.settle();
    now = (await cards("g11"))[0]!;
    assert.notEqual(now.state, "resolved", "复活了");
    assert.ok(acceptButton(now), "按钮回来了");

    // 重启接管：上一次运行占着、没结局的信封，同一件事还在就放回去。
    const live = acceptButton(now).value!.e as string;
    await db.update(imActions).set({ usedAt: at, claimedBy: "gone:2", result: null }).where(eq(imActions.id, live));
    assert.equal(await im.actions.recover(), 1);
    assert.equal((await db.select().from(imActions).where(eq(imActions.id, live))).at(0)!.usedAt, null, "放回去了");
    const pressed = await im.click(OWNER, acceptButton(now).value!);
    assert.match(textOf(pressed.card?.data), /已放行这一关，这条线接着往下走/, JSON.stringify(pressed));
    assert.equal((await row("g11")).workflowAt, "second");
  }

  // ── ⑫ 放行之后下一站验证没开起来 ────────────────────────────────────────
  {
    const line = JSON.stringify({ workspace: "shared", steps: [
      makeStep("run", "run"), makeStep("human", "first"), makeStep("verify", "v2"), makeStep("human", "second"), makeStep("accept", "accept"),
    ] });
    await db.insert(tasks).values({
      id: "g12", projectId: "p1", title: "关口 g12", body: "", status: "done", useWorktree: false, workflow: line, workflowAt: "run",
      endedAt: at, createdAt: at, updatedAt: at,
    } as never);
    await advanceWorkflowFrom(await row("g12"), taskWorkflowDef(line), "run");
    assert.equal((await row("g12")).workflowAt, "first");
    await releaseHumanGate(await row("g12"), taskWorkflowDef(line), null);
    const offline = { startVerifyRound: async () => { throw new Error("verifier-offline"); } };
    const tail = await releaseGate("g12", offline);
    assert.deepEqual(tail, { ok: false, step: "自动验证", reason: "verifier-offline", movedOn: true }, JSON.stringify(tail));
    assert.equal((await row("g12")).workflowAt, "v2", "游标挪到了那一站");
    const told = acceptedOutcome({ kind: "gate_released", tail });
    assert.match(told.text!, /已放行这一关，但下一站「自动验证」没开起来（verifier-offline），线停在那一站/, told.text);
    assert.doesNotMatch(told.text!, /接着往下走|再点一次/);
    assert.ok(told.brief && !told.brief.includes("verifier-offline"), "只推标题不带原话");
  }

  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-gates: ok");
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
