// 飞书决策卡片的一生：推出去 → 点按钮 → 结果就地换上；旧卡点不中新事；别处处理掉了卡片跟着收起。
//
// 钉住的几件事（理由见 server/src/im/reconcile.ts、envelopes.ts、actions.ts 的文件头）：
// ① 对账幂等：同一件事只推一张卡；收件人是绑定的单聊；卡上带深链与回调按钮；
// ② 点按钮：答复走 im 身份进真路由；结果卡随回调回应带回（不花额度）、不再改卡；
//    时间线留一笔「经飞书」；同一事件重放只认一次；同一张卡点第二次「已处理」；
//    不是发给你的卡点不动；
// ③ 旧卡：问题换了一代，旧卡上的点击回「过时」并把卡收起（acted，不再复活）；对账给新一代推新卡；
// ④ 别处处理掉：在网页上答了 → 卡片改成「已在别处答复」（排一次改卡）；任务被删 →「任务已删除」；
//    验收合并 → 收起 + 回复一条「已验收合并」（notifyCompleted 开着）；
// ⑤ 一口气积压太多：只推一张汇总，点汇总按钮每次放 5 张；
// ⑥ 额度见底：决策卡不发、留在 pending 等额度；回写点击结果照发；
// ⑦ 闸口卡：正文和「放行」认同一扇门 —— 开门行没写进 transcript 也摆出这一扇的方案；找不到这一扇的方案
//    就不给「放行」，不拿上一扇门的旧方案顶上（审查复现：看着旧方案放行了没看过的新方案）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-cards-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-cards");

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { imBindings, imOutbox } = await import("../src/db/schema-im.js");
  const { eq, and, inArray } = await import("drizzle-orm");
  const { patchOptions } = await import("../src/im/meta.js");
  const { sessions, taskNotices } = await import("../src/db/schema.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const fixture = await import("./im-fixture.js");
  const { APP, OWNER, FakeFeishu, buildApp, assemble, contentOf, textOf, buttonsOf, waitIdle } = fixture;

  await ensureSchema();
  const app = buildApp();
  const fake = new FakeFeishu();
  const im = await assemble(app, fake);
  await patchOptions({ publicBaseUrl: "http://mac.tailnet:4317" });

  const at = new Date().toISOString();
  mkdirSync(join(stage, "repo"), { recursive: true });
  await db.insert(projects).values({ id: "p1", name: "飞书项目", repoPath: join(stage, "repo"), apiKeys: null, createdAt: at } as never);
  const task = (over: Record<string, unknown>) => ({ projectId: "p1", body: "", createdAt: at, updatedAt: at, ...over });
  await db.insert(tasks).values([
    task({ id: "tq", title: "问一个问题", status: "paused", question: "选哪个？", questionOptions: JSON.stringify(["方案 A", "方案 B"]) }),
    task({ id: "tf", title: "跑挂了", status: "failed", endedAt: at }),
  ] as never);
  await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: at });
  const statusOf = async (id: string) => (await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, id))).at(0)?.s;
  const rowsOf = (taskId: string) => db.select().from(imOutbox).where(eq(imOutbox.taskId, taskId));

  // ── ① 推卡 ───────────────────────────────────────────────────────────────
  await im.reconciler.full();
  await im.settle();
  const firstSends = fake.sends();
  assert.equal(firstSends.length, 2, `两件事各推一张：${firstSends.map((s) => s.path).join(" ")}`);
  for (const send of firstSends) {
    assert.match(send.path, /receive_id_type=open_id/);
    assert.equal(send.body.receive_id, OWNER);
  }
  const questionCall = firstSends.find((send) => textOf(contentOf(send)).includes("选哪个？"))!;
  const questionCard = contentOf(questionCall);
  assert.equal(questionCard.config.update_multi, true);
  const optionButtons = buttonsOf(questionCard).filter((button) => button.value?.op === "opt");
  assert.deepEqual(optionButtons.map((button) => button.text), ["方案 A", "方案 B"]);
  assert.ok(buttonsOf(questionCard).some((button) => button.url?.includes("task=tq")), "卡上带深链");
  assert.deepEqual(Object.keys(optionButtons[0]!.value!).sort(), ["e", "i", "op"], "按钮 value 里只有信封 id 与动作");
  // 飞书对输入框的上限是 1000：超了整张卡被拒（2026-11-06 真机实测 230099）。
  const inputs = JSON.stringify(questionCard).match(/"max_length":(\d+)/g) ?? [];
  assert.ok(inputs.length > 0 && inputs.every((item) => Number(item.split(":")[1]) <= 1000), `输入框 max_length 不能超过 1000：${inputs}`);
  // 直接回复只用来答提问卡（inbound.ts）：失败卡上的提示得说清要以 /reply 开头。
  const failedCall = firstSends.find((send) => send !== questionCall)!;
  assert.match(textOf(contentOf(failedCall)), /以 \/reply 开头/, "失败卡提示以 /reply 开头回复");
  await im.reconciler.full();
  await im.settle();
  assert.equal(fake.sends().length, 2, "再对一遍不重复推");

  // ── ② 点按钮 ─────────────────────────────────────────────────────────────
  const optA = optionButtons[0]!.value!;
  const notMine = await im.click("ou_stranger", optA);
  assert.equal(notMine.toast?.type, "error");
  assert.match(notMine.toast!.content, /不是发给你的/);
  const before = fake.calls.length;
  const answered = await im.actions.handle({ eventId: "ev-fixed", operatorOpenId: OWNER, value: optA, formValue: {}, name: null });
  assert.equal(answered.toast?.type, "success", JSON.stringify(answered));
  assert.match(textOf(answered.card?.data), /已答复：方案 A/);
  const replay = await im.actions.handle({ eventId: "ev-fixed", operatorOpenId: OWNER, value: optA, formValue: {}, name: null });
  assert.equal(replay.card, undefined, "同一事件重放只认一次");
  const twice = await im.click(OWNER, optA);
  assert.match(twice.toast!.content, /已经处理过了/);
  const tq = (await db.select().from(tasks).where(eq(tasks.id, "tq"))).at(0)!;
  assert.equal(tq.question, null, "答复经真路由落进任务");
  assert.match(tq.questionHistory ?? "", /方案 A/);
  assert.equal(fake.calls.slice(before).filter((call) => call.method === "PATCH").length, 0, "结果卡随回调回应带回，不额外改卡");
  const [answeredRow] = await rowsOf("tq");
  assert.equal(answeredRow!.state, "resolved");
  assert.equal(answeredRow!.resolution, "acted");
  {
    // 留痕落在任务时间线（有会话时）或系统诊断里（还没有会话时），两处都是界面上看得到的。
    const notices = await db.select().from(taskNotices).where(eq(taskNotices.taskId, "tq"));
    const sessionRows = await db.select().from(sessions).where(eq(sessions.taskId, "tq"));
    const transcripts = sessionRows.map((row) => { try { return readFileSync(sessionTranscriptPath("tq", row.id), "utf8"); } catch { return ""; } });
    assert.ok([...notices.map((row) => row.reason), ...transcripts].some((text) => text.includes("经飞书")), "点按钮要在任务上留一笔「经飞书」");
  }
  await waitIdle(() => statusOf("tq"), "paused");

  // ── ③ 旧卡点不中新事 ─────────────────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "tg", title: "两代提问", status: "paused", question: "第一问？", questionOptions: JSON.stringify(["是", "否"]) }) as never);
  await im.reconciler.reconcile(["tg"]);
  await im.settle();
  const genOneCall = fake.sends().find((send) => textOf(contentOf(send)).includes("第一问？"))!;
  const genOne = buttonsOf(contentOf(genOneCall)).find((button) => button.value?.op === "opt")!.value!;
  await db.update(tasks).set({ question: "第二问？", questionOptions: JSON.stringify(["好", "不好"]), updatedAt: new Date().toISOString() }).where(eq(tasks.id, "tg"));
  const stale = await im.click(OWNER, genOne);
  assert.equal(stale.toast?.type, "warning");
  assert.match(textOf(stale.card?.data), /过时/);
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "tg"))).at(0)!.question, "第二问？", "旧卡没有答到新问题上");
  await im.settle();
  const tgRows = await rowsOf("tg");
  assert.equal(tgRows.length, 2, "新一代推了新卡");
  assert.ok(fake.sends().some((send) => textOf(contentOf(send)).includes("第二问？")));
  assert.equal(tgRows.filter((row) => row.state === "resolved" && row.resolution === "acted").length, 1, "旧卡收起后不再复活");

  // ── ④ 别处处理掉 ────────────────────────────────────────────────────────
  {
    // 网页上答了 tg 的第二问。
    const fresh = tgRows.find((row) => row.state === "sent")!;
    await db.update(tasks).set({ question: null, questionOptions: null }).where(eq(tasks.id, "tg"));
    fake.reset();
    await im.reconciler.reconcile(["tg"]);
    await im.settle();
    const patch = fake.patches().find((call) => call.path.includes(fresh.messageId!));
    assert.ok(patch, "别处答了就把卡改掉");
    assert.match(textOf(JSON.parse(patch!.body.content)), /已在别处答复/);
    assert.equal(buttonsOf(JSON.parse(patch!.body.content)).filter((button) => button.value).length, 0, "收起的卡不再有回调按钮");

    // 任务被删。
    await db.insert(tasks).values(task({ id: "td", title: "要被删的", status: "failed", endedAt: at }) as never);
    await im.reconciler.reconcile(["td"]);
    await im.settle();
    const tdRow = (await rowsOf("td"))[0]!;
    await db.delete(tasks).where(eq(tasks.id, "td"));
    fake.reset();
    await im.reconciler.full();
    await im.settle();
    const gone = fake.patches().find((call) => call.path.includes(tdRow.messageId!));
    assert.ok(gone, "删任务不发事件，靠全量对账把卡收掉");
    assert.match(textOf(JSON.parse(gone!.body.content)), /任务已删除/);

    // 网页上归档：同样不发事件，路由钩子叫 sweepSoon（防抖后整盘对一次）。
    await db.insert(tasks).values(task({ id: "tz", title: "要被归档的", status: "failed", endedAt: at }) as never);
    await im.reconciler.reconcile(["tz"]);
    await im.settle();
    const tzRow = (await rowsOf("tz"))[0]!;
    await db.update(tasks).set({ archived: true }).where(eq(tasks.id, "tz"));
    fake.reset();
    im.reconciler.sweepSoon();
    im.reconciler.sweepSoon();
    await im.settle();
    await im.settle();
    const shelved = fake.patches().filter((call) => call.path.includes(tzRow.messageId!));
    assert.equal(shelved.length, 1, "两次 sweepSoon 防抖成一次，卡只改一次");
    assert.match(textOf(JSON.parse(shelved[0]!.body.content)), /任务已归档/);

    // 验收合并：收起 + 在卡下回一句。
    await db.insert(tasks).values(task({ id: "ta", title: "等验收", status: "done", endedAt: at }) as never);
    await im.reconciler.reconcile(["ta"]);
    await im.settle();
    const acceptRow = (await rowsOf("ta"))[0]!;
    assert.equal(acceptRow.kind, "accept");
    const acceptButton = buttonsOf(JSON.parse(acceptRow.content)).find((button) => button.value?.op === "accept")!;
    assert.equal(acceptButton.confirm, true, "验收按钮要二次确认");
    assert.match(textOf(JSON.parse(acceptRow.content)), /以 \/reply 开头/, "待验收卡提示以 /reply 开头回复");
    await db.update(tasks).set({ stage: "accepted", acceptedMergeMethod: "fast_forward" }).where(eq(tasks.id, "ta"));
    fake.reset();
    await im.reconciler.reconcile(["ta"]);
    await im.settle();
    assert.match(textOf(JSON.parse(fake.patches()[0]!.body.content)), /已验收合并/);
    const merged = fake.sends().find((send) => send.path.includes(`/messages/${acceptRow.messageId}/reply`));
    assert.ok(merged, "合并后在原卡下回一条（会有提醒）");
    assert.match(textOf(contentOf(merged!)), /已验收合并/);
  }

  // ── ⑤ 积压 ───────────────────────────────────────────────────────────────
  {
    const ids = Array.from({ length: 7 }, (_, index) => `tflood${index}`);
    await db.insert(tasks).values(ids.map((id) => task({ id, title: `批量失败 ${id}`, status: "failed", endedAt: at })) as never);
    fake.reset();
    await im.reconciler.reconcile(ids);
    await im.settle();
    assert.equal(fake.sends().length, 1, "超过 5 张只推一张汇总");
    const summary = contentOf(fake.sends()[0]!);
    assert.match(textOf(summary), /批量失败/);
    const held = await db.select().from(imOutbox).where(and(eq(imOutbox.appId, APP), eq(imOutbox.state, "held")));
    assert.equal(held.length, 7);
    const push = buttonsOf(summary).find((button) => button.value?.op === "push")!;
    const released = await im.click(OWNER, push.value!);
    assert.match(released.toast!.content, /推送了 5 张，还剩 2 张/);
    await im.settle();
    assert.equal(fake.sends().length, 6, "放出来的 5 张发了");
  }

  // ── ⑥ 额度见底 ───────────────────────────────────────────────────────────
  {
    await db.insert(tasks).values(task({ id: "tq2", title: "额度见底时的提问", status: "paused", question: "还发吗？", questionOptions: JSON.stringify(["发"]) }) as never);
    await im.reconciler.reconcile(["tq2"]);
    await im.settle();
    const sent = (await rowsOf("tq2"))[0]!;
    assert.equal(sent.state, "sent");
    im.meter.setQuota(Math.max(1, im.meter.usage().calls));
    assert.equal(im.meter.level(), "exhausted");
    await db.insert(tasks).values(task({ id: "tf2", title: "额度见底时失败", status: "failed", endedAt: at }) as never);
    fake.reset();
    await im.reconciler.reconcile(["tf2"]);
    await im.settle();
    assert.equal(fake.sends().length, 0, "额度见底不发决策卡");
    const waiting = (await rowsOf("tf2"))[0]!;
    assert.equal(waiting.state, "pending", "留在 pending，等额度");
    assert.ok(waiting.nextAt && Date.parse(waiting.nextAt) > Date.now() + 60_000, "过一阵再看，不立即重试");
    const button = buttonsOf(JSON.parse(sent.content)).find((item) => item.value?.op === "opt")!;
    const result = await im.click(OWNER, button.value!);
    assert.equal(result.toast?.type, "success", "点按钮的回应不花额度，照常生效");
    im.meter.setQuota(1_000_000);
    await waitIdle(() => statusOf("tq2"), "paused");
  }

  // ── ⑦ 闸口卡：正文和「放行」认同一扇门 ─────────────────────────────────────
  {
    const { waitForGate } = await import("../src/duet/gates.js");
    const { nextGateVersion } = await import("../src/duet/gate-version.js");
    const ids = ["tg-kept", "tg-lost"];
    await db.insert(tasks).values(ids.map((id) => task({ id, title: `闸口 ${id}`, mode: "duet", status: "awaiting_review" })) as never);
    const decisions = new Map<string, Promise<unknown>>();
    for (const id of ids) {
      // 第 1 扇门的开门行写的是旧方案；第 2 扇门领了号，开门行没写进文件。
      mkdirSync(join(stage, "runs", id), { recursive: true });
      writeFileSync(join(stage, "runs", id, "transcript.jsonl"), JSON.stringify({
        type: "duet.gate", taskId: id, gate: "G1", open: true, version: 1, consensus: true, conclusionA: "OLD_PLAN_1", conclusionB: "OLD_PLAN_1",
      }) + "\n");
      // tg-lost：库里也没有这一扇的方案（加列之前开的门、或方案没落下）。
      const version = await nextGateVersion(id, id === "tg-kept" ? { consensus: true, conclusionA: "NEW_PLAN_2", conclusionB: "NEW_PLAN_2" } : null);
      decisions.set(id, waitForGate(id, version));
    }
    fake.reset();
    await im.reconciler.reconcile(ids);
    await im.settle();
    const cardOf = (id: string) => contentOf(fake.sends().find((send) => textOf(contentOf(send)).includes(`闸口 ${id}`))!);
    const kept = cardOf("tg-kept");
    assert.match(textOf(kept), /NEW_PLAN_2/, "摆出来的是这一扇门的方案");
    assert.doesNotMatch(textOf(kept), /OLD_PLAN_1/);
    const approve = buttonsOf(kept).find((button) => button.value?.op === "approve")!;
    assert.ok(approve, "看得到这一扇的方案才给放行");
    assert.equal((await im.click(OWNER, approve.value!)).toast?.type, "success");
    assert.deepEqual(await decisions.get("tg-kept"), { kind: "approve" });
    const lost = cardOf("tg-lost");
    assert.doesNotMatch(textOf(lost), /OLD_PLAN_1/, "找不到这一扇的方案：不拿上一扇门的顶上");
    assert.match(textOf(lost), /方案没找到/);
    assert.equal(buttonsOf(lost).some((button) => button.value?.op === "approve"), false, "没看到方案不给放行");
    const reject = buttonsOf(lost).find((button) => button.value?.op === "reject")!;
    assert.equal((await im.click(OWNER, reject.value!)).toast?.type, "success", "打回终止照常能点");
    assert.deepEqual(await decisions.get("tg-lost"), { kind: "reject" });
    await db.update(tasks).set({ status: "done" }).where(inArray(tasks.id, ids));
  }

  await waitIdle(() => statusOf("tf"));
  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-cards: ok");
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
