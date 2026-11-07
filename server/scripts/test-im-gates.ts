// 预设工作流上接连几道「等我点头」× 飞书待验收卡（理由见 server/src/task-human-gate.ts 文件头）。
// 中途那几道放行只挪游标、不起新的一轮，成果身份前后一样；只认它，旧卡能放后来那一道、下一道也发不出新卡（审查复现）。
//
// ① 点第一道关的卡：只放这一道，卡上照实说「已放行」不说「合并」；线走到第二道关时推一张新卡（不被上一张已处理的卡
//    占住）；最后一道关的卡换回验收的说法，确认框和网页同一句；点它就地验收，结果和完成通知都不说「合并」；
// ② 网页先放了第一道，再点飞书里第一道的旧卡：回「过时」，不放后来那一道；
// ③ 接口自己也核：带着上一道关的身份进验收接口 → 409、线不动；不带关口那一截的老卡碰上已经领了身份的关也一样；
//    带着此刻这道关就照常放；加列之前就停在关口上的老任务（没有身份）代次和以前同形，老卡照旧有效；
// ④ 放行按「还是核过的那一道关」写：核过之后线才换了关，放行落空、阶段不动；
// ⑤ 门禁跑完自动续验收的那一次带着关口身份：选择原样存、原样读回来；
// ⑥ 只推标题的项目：待验收卡的确认框不带分支这些细节；
// ⑦ 放行之后、线走到下一站之前（游标还在这一道上）：身份不变、不冒新卡；同一道关的卡再点不放第二遍；
// ⑧ 接力导入停在关口上的任务：领新身份（不沿用带过来的），不在关口上不留。
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
  const { imBindings, imOutbox } = await import("../src/db/schema-im.js");
  const { and, asc, eq } = await import("drizzle-orm");
  const { api } = await import("../src/routes.js");
  const { mountTaskAcceptanceRoutes } = await import("../src/task-accept-routes.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { advanceWorkflowFrom } = await import("../src/workflow-advance.js");
  const { taskWorkflowDef } = await import("../src/workflows.js");
  const { humanGateOf, importedHumanGate, NO_GATE, releaseHumanGate } = await import("../src/task-human-gate.js");
  const { resultVersionOf } = await import("../src/task-result-version.js");
  const { parseChoices } = await import("../src/accept-gate-handoff.js");
  const { acceptIdentityOf, viewsOf } = await import("../src/im/attention.js");
  const { turnCard } = await import("../src/im/cards.js");
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
    assert.ok(first.humanGateId, "走到关口时领了身份");
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
    assert.notEqual(second.humanGateId, first.humanGateId, "第二道关领了新的身份");
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
    assert.match(notice ?? "", /^已验收：「关口 g2」/, `完成通知照实说：${notice}`);
  }

  // ── ② 网页先放了第一道，再点第一道的旧卡 ───────────────────────────────
  // ── ③ 接口自己也核 ──────────────────────────────────────────────────────
  {
    await seed("g3", ["first", "second", "third"]);
    const [old] = await cards("g3");
    const firstGate = acceptIdentityOf(old!.subject!).humanGate;
    assert.equal(firstGate, (await row("g3")).humanGateId, "卡的代次里带着这一道关的身份");
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
    const legacy = await im.ash.post(principal, "/api/tasks/g3/accept", { expectedResultVersion: resultVersion, expectedHumanGate: NO_GATE });
    assert.equal(!legacy.ok && legacy.data.reason, "gate_changed", "不带关口那一截的老卡碰上已经领了身份的关也不放");
    now = await row("g3");
    assert.equal(now.workflowAt, "second", "两次都没放");
    assert.equal(now.stage, "awaiting_acceptance");
    const current = await im.ash.post(principal, "/api/tasks/g3/accept", { expectedResultVersion: resultVersion, expectedHumanGate: humanGateOf(now) });
    assert.equal(current.ok && current.data.kind, "gate_released", "带着此刻这道关照常放");
    assert.equal((await row("g3")).workflowAt, "third");

    // 加列之前就停在关口上的老任务：没有身份，代次和以前同形（老卡照旧有效）。
    await db.update(tasks).set({ humanGateId: null }).where(eq(tasks.id, "g3"));
    const view = (await viewsOf(["g3"])).get("g3")!;
    assert.equal(view.turn?.generation, `a:${await resultVersionOf(await row("g3"))}`);
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

  // ── ⑦ 放行之后、线走到下一站之前 ─────────────────────────────────────────
  {
    await seed("g7", ["first", "second"]);
    const [card] = await cards("g7");
    const seen = await row("g7");
    // 只放行、不往下走：停在「放行之后、走到下一站之前」那一段（中间站跑着的时候就是这样）。
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
    assert.equal(!twice.ok && twice.data.reason, "gate_changed", `同一道关的卡不放第二遍：${JSON.stringify(twice)}`);
    assert.match(JSON.stringify(twice.data), /已经放行过了/);
    assert.equal((await row("g7")).workflowAt, "first", "没有再往下推一遍");
  }

  // ── ⑧ 接力导入 ──────────────────────────────────────────────────────────
  {
    const line = JSON.stringify({ workspace: "shared", steps: [makeStep("run", "run"), makeStep("human", "gate"), makeStep("accept", "accept")] });
    const arrived = importedHumanGate(line, "gate");
    assert.ok(arrived && arrived !== NO_GATE, "停在关口上：领一个身份");
    assert.notEqual(importedHumanGate(line, "gate"), arrived, "每次导入都是新的一个");
    assert.equal(importedHumanGate(line, "run"), null, "不在关口上不留");
    assert.equal(importedHumanGate(null, "gate"), null);
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
