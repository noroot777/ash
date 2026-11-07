// 飞书发件的出口：每一行都按入队时记下的授权来源（scope）在发出、改卡那一刻现核，结局与待改卡一起落库。
//
// 钉住的几件事（理由见 server/src/im/scope.ts、exits.ts、outbox.ts、actions.ts 的文件头）：
// ① 删了任务：挂着它的通知不发；
// ② 解绑：助手回复、/tasks 任务列表、/new 表单、/todo 清单、决策卡的原文一条都不发（回给请求的换成一句固定说明），
//    不含 ash 数据的静态句照发；
// ③ 解绑重绑（同一个飞书账号、新的一次绑定）：替旧那一次做的个人回执不发；任务的决策卡按此刻的资格照发；
// ④ 改卡也过出口：排着的结果回写，项目改成只推标题 → 改上去的是短的那一版；收件人没资格了 → 改成
//    中性的收起卡；这两种改卡在额度见底时照发，「没办成」的原因回复也照发；
// ⑤ 结局一个事务：结局写到一半失败（改卡那一步被拦）→ 整笔没发生，信封还是「已占用、没结果」，
//    重启后 recover() 接管、照实改卡；结果卡随回执带回、没等到「已送到」就退出 → 过期后照样改一次；
//    送到了、带回去的就是库里那份 → 不另改；改卡改到一半结局落库、结果卡随回执送到 → 旧的改出去之后再改一次。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-exits-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-exits");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failure: unknown = null;
try {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { imActions, imBindings, imOutbox } = await import("../src/db/schema-im.js");
  const { and, eq } = await import("drizzle-orm");
  const { patchOptions } = await import("../src/im/meta.js");
  const { originOf, requestScope, scopeFor, SYSTEM_SCOPE } = await import("../src/im/scope.js");
  const { bindingOf } = await import("../src/im/binding.js");
  const { APP, OWNER, FakeFeishu, buildApp, assemble, contentOf, textOf, buttonsOf, waitIdle } = await import("./im-fixture.js");

  await ensureSchema();
  const app = buildApp();
  const fake = new FakeFeishu();
  const im = await assemble(app, fake);

  const at = new Date().toISOString();
  mkdirSync(join(stage, "repo"), { recursive: true });
  await db.insert(projects).values({ id: "p1", name: "飞书项目", repoPath: join(stage, "repo"), apiKeys: null, createdAt: at } as never);
  const task = (over: Record<string, unknown>) => ({ projectId: "p1", body: "", createdAt: at, updatedAt: at, ...over });
  const bind = (boundAt: string) => db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt });
  const unbind = () => db.delete(imBindings).where(eq(imBindings.openId, OWNER));
  await bind(at);
  const dest = { receiveType: "open_id" as const, receiveId: OWNER, recipientOpenId: OWNER };
  const rowsOf = (taskId: string) => db.select().from(imOutbox).where(and(eq(imOutbox.appId, APP), eq(imOutbox.taskId, taskId)));
  const rowById = async (id: string) => (await db.select().from(imOutbox).where(eq(imOutbox.id, id))).at(0)!;
  const sentText = () => fake.sends().map((call) => JSON.stringify(contentOf(call))).join("\n");
  const patchesOf = (messageId: string) => fake.patches().filter((call) => call.path.includes(messageId)).map((call) => JSON.parse(call.body.content));
  const statusOf = async (id: string) => (await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, id))).at(0)?.s;

  // ── ① 删了任务 ───────────────────────────────────────────────────────────
  {
    await db.insert(tasks).values(task({ id: "td", title: "要删的任务", status: "done", endedAt: at }) as never);
    im.sender.stop();
    await im.reconciler.run(async () => im.reconciler.insert({
      dest, taskId: "td", kind: "notice", subject: "n:td", msgType: "text", content: JSON.stringify({ text: "PRIVATE-NOTICE 做完了" }),
      scope: await scopeFor(APP, dest, { kind: "task", taskId: "td" }),
    }));
    await db.delete(tasks).where(eq(tasks.id, "td"));
    fake.reset();
    im.sender.start();
    await im.settle();
    assert.equal(sentText().includes("PRIVATE-NOTICE"), false, "任务删了，挂着它的通知不发");
    const notice = (await rowsOf("td"))[0]!;
    assert.equal(notice.state, "resolved");
    assert.match(notice.resolution ?? "", /任务已删除/);
  }

  // ── ② 解绑 ───────────────────────────────────────────────────────────────
  {
    await db.insert(tasks).values(task({ id: "tq", title: "排队时解绑的提问", status: "paused", question: "PRIVATE-QUESTION 要删吗？" }) as never);
    im.sender.stop();
    await im.reconciler.reconcile(["tq"]);
    await im.commands.say({ messageId: "om_assist", dest }, "PRIVATE-ASSISTANT-REPLY", requestScope(await originOf(APP, dest, (await bindingOf(APP, OWNER))!), { kind: "room", roomId: "room-x", projectId: null, taskIds: [] }));
    await im.commands.say({ messageId: "om_static", dest }, "STATIC-HINT", SYSTEM_SCOPE);
    await im.say({ text: "/tasks" });
    await im.say({ text: "/new PRIVATE-NEW-TITLE\nPRIVATE-NEW-BODY" });
    await im.say({ text: "/todo" });
    const kinds = (await db.select().from(imOutbox).where(eq(imOutbox.state, "pending"))).map((row) => row.kind);
    assert.ok(kinds.includes("confirm") && kinds.includes("question"), `都排上了：${kinds}`);
    await unbind();
    fake.reset();
    im.sender.start();
    await im.settle();
    const sent = sentText();
    assert.match(sent, /STATIC-HINT/, "不含 ash 数据的静态句照发");
    for (const secret of ["PRIVATE-ASSISTANT-REPLY", "PRIVATE-QUESTION", "PRIVATE-NEW", "飞书项目", "排队时解绑的提问"]) {
      assert.equal(sent.includes(secret), false, `解绑后不发：${secret}`);
    }
    assert.equal((await db.select().from(imOutbox).where(eq(imOutbox.state, "pending"))).length, 0, "没资格的都作废了，不留着重试");
  }

  // ── ③ 解绑重绑 ───────────────────────────────────────────────────────────
  {
    await bind(at);
    await db.insert(tasks).values(task({ id: "tr", title: "重绑前排的提问", status: "paused", question: "选哪个？", questionOptions: JSON.stringify(["甲", "乙"]) }) as never);
    im.sender.stop();
    await im.reconciler.reconcile(["tr"]);
    const old = await originOf(APP, dest, (await bindingOf(APP, OWNER))!);
    await im.commands.say({ messageId: "om_old", dest }, "PRIVATE-OLD-INSTANCE", requestScope(old, { kind: "projects", projectIds: ["p1"] }));
    await unbind();
    await bind(new Date(Date.now() + 1000).toISOString());
    fake.reset();
    im.sender.start();
    await im.settle();
    assert.equal(sentText().includes("PRIVATE-OLD-INSTANCE"), false, "替上一次绑定做的个人回执不发");
    assert.ok((await rowsOf("tr")).some((row) => row.state === "sent"), "任务的决策卡按此刻的资格照发");
  }

  // ── ④ 改卡也过出口 ───────────────────────────────────────────────────────
  const trCard = (await rowsOf("tr")).find((row) => row.state === "sent")!;
  /** 回复 tr 的卡发 /stop，拿到确认卡那一行和「确定」按钮。 */
  const stopCard = async () => {
    const message = await im.say({ text: "/stop", parentId: trCard.messageId! });
    await im.settle();
    const sent = fake.sends().find((call) => call.path.includes(`/messages/${message}/reply`))!;
    const row = (await db.select().from(imOutbox).where(eq(imOutbox.kind, "confirm"))).find((item) => item.replyTo === message)!;
    return { row: await rowById(row.id), value: buttonsOf(contentOf(sent)).find((button) => button.value?.op === "confirm")!.value! };
  };
  {
    im.commands.confirmed = async () => { await sleep(3_000); return { ok: true, final: true, text: "PRIVATE-RESULT-DETAIL", brief: "已办完（短）" }; };
    const brief = await stopCard();
    im.sender.stop();
    assert.match(textOf((await im.click(OWNER, brief.value)).card?.data), /处理中/);
    await sleep(3_400);
    assert.equal((await rowById(brief.row.id)).patchState, "result", "结果排着待改卡");
    await patchOptions({ titleOnlyProjectIds: ["p1"] });
    fake.reset();
    im.sender.start();
    await im.settle();
    const briefPatch = patchesOf(brief.row.messageId!);
    assert.equal(briefPatch.length, 1, "改了一次卡");
    assert.match(textOf(briefPatch[0]), /已办完（短）/, "项目改成只推标题：改上去的是短的那一版");
    assert.equal(JSON.stringify(briefPatch[0]).includes("PRIVATE-RESULT-DETAIL"), false);
    await patchOptions({ titleOnlyProjectIds: [] });

    const revoked = await stopCard();
    im.sender.stop();
    await im.click(OWNER, revoked.value);
    await sleep(3_400);
    await unbind();
    im.meter.setQuota(1);
    assert.equal(im.meter.level(), "exhausted");
    fake.reset();
    im.sender.start();
    await im.settle();
    const neutral = patchesOf(revoked.row.messageId!);
    assert.equal(neutral.length, 1, "没资格了也要改：额度见底照改");
    assert.match(textOf(neutral[0]), /这张卡已收起/, "改成中性的收起卡");
    assert.equal(JSON.stringify(neutral[0]).includes("PRIVATE-RESULT-DETAIL"), false);
    await bind(at);
    im.sender.stop();
    await im.reconciler.full();
    im.meter.setQuota(1_000_000);
    im.sender.start();
    await im.settle();

    // 没办成：卡面改回原样 + 卡下说原因，额度见底也都发。
    im.commands.confirmed = async () => { await sleep(3_000); return { ok: false, final: false, text: "接口拒了" }; };
    const failing = await stopCard();
    im.meter.setQuota(1);
    fake.reset();
    await im.click(OWNER, failing.value);
    await sleep(3_400);
    await im.settle();
    assert.equal(patchesOf(failing.row.messageId!).length, 1, "额度见底也把卡面改回原样");
    assert.match(sentText(), /没办成：接口拒了/, "额度见底也说原因");
    im.meter.setQuota(1_000_000);
  }

  // ── ⑤ 结局一个事务 ───────────────────────────────────────────────────────
  {
    im.commands.confirmed = async () => ({ ok: true, final: true, tone: "grey", text: "已停止。" });
    const card = await stopCard();
    // 结局写到改卡那一步被拦下（模拟两次写入之间退出）。
    await dbClient.execute(`CREATE TRIGGER im_test_block BEFORE UPDATE ON im_outbox WHEN OLD.id = '${card.row.id}' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const clicked = await im.click(OWNER, card.value);
    assert.equal(clicked.card, undefined, `没落库的结局不随回执带回：${JSON.stringify(clicked)}`);
    const envelope = (await db.select().from(imActions).where(eq(imActions.id, card.value.e as string))).at(0)!;
    assert.ok(envelope.usedAt, "信封还占着");
    assert.equal(envelope.result, null, "结局整笔没发生");
    assert.ok(buttonsOf(JSON.parse((await rowById(card.row.id)).content)).some((button) => button.value?.op === "confirm"), "卡面还是原样");
    // 重启：占用它的进程不在了；拦截撤掉。
    await db.update(imActions).set({ claimedBy: "old:proc" }).where(eq(imActions.id, card.value.e as string));
    await dbClient.execute("DROP TRIGGER im_test_block");
    fake.reset();
    assert.equal(await im.actions.recover(), 1, "重启后接管");
    await im.settle();
    const fixed = patchesOf(card.row.messageId!);
    assert.equal(fixed.length, 1);
    assert.match(textOf(fixed[0]), /不确定办成没有/, "照实改卡");

    // 结果卡随回执带回，没等到「已送到」就退出：过期后照样改一次。
    await db.insert(tasks).values(task({ id: "tk", title: "回执丢了", status: "paused", question: "要吗？", questionOptions: JSON.stringify(["要"]) }) as never);
    await im.reconciler.reconcile(["tk"]);
    await im.settle();
    const tkRow = (await rowsOf("tk"))[0]!;
    const opt = buttonsOf(JSON.parse(tkRow.content)).find((button) => button.value?.op === "opt")!.value!;
    fake.reset();
    const answered = await im.click(OWNER, opt);
    assert.match(textOf(answered.card?.data), /已答复/);
    assert.equal((await rowById(tkRow.id)).patchState, "acking", "等「已送到」");
    await im.sender.drainNow();
    assert.equal(patchesOf(tkRow.messageId!).length, 0, "还在等，不改卡");
    await db.update(imOutbox).set({ nextAt: new Date(Date.now() - 1000).toISOString() }).where(eq(imOutbox.id, tkRow.id));
    await im.sender.drainNow();
    const late = patchesOf(tkRow.messageId!);
    assert.equal(late.length, 1, "过期没确认：改一次");
    assert.match(textOf(late[0]), /已答复/);
    assert.equal((await rowById(tkRow.id)).patchState, "done");
    await waitIdle(() => statusOf("tk"), "paused");

    // 回执带回去的就是库里那份、而且送到了：记成 done，不另花一次改卡。
    await db.insert(tasks).values(["tk2", "tk3"].map((id) => task({ id, title: `回执 ${id}`, status: "paused", question: "要吗？", questionOptions: JSON.stringify(["要"]) })) as never);
    await im.reconciler.reconcile(["tk2", "tk3"]);
    await im.settle();
    const optOf = (row: { content: string }) => buttonsOf(JSON.parse(row.content)).find((button) => button.value?.op === "opt")!.value!;
    const tk2 = (await rowsOf("tk2"))[0]!;
    fake.reset();
    const delivered = await im.click(OWNER, optOf(tk2));
    await im.actions.acknowledged({ messageId: tk2.messageId!, envelopeId: optOf(tk2).e as string, card: delivered.card!.data, delivered: true });
    assert.equal((await rowById(tk2.id)).patchState, "done", "送到了：记成 done");
    await im.sender.drainNow();
    assert.equal(patchesOf(tk2.messageId!).length, 0, "不另花一次改卡");

    // 改卡改到一半，按钮落了结局、结果卡随回执送到了：刚改出去的那份旧的可能后到，照库里那份再改一次。
    const tk3 = (await rowsOf("tk3"))[0]!;
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let holding = true;
    const patchCard = im.api.patchCard.bind(im.api);
    im.api.patchCard = async (messageId, card, purpose) => {
      if (holding && messageId === tk3.messageId) { holding = false; reached(); await released; }
      return patchCard(messageId, card, purpose);
    };
    try {
      await db.update(imOutbox).set({ patchState: "pending", nextAt: null }).where(eq(imOutbox.id, tk3.id)); // 对账排了一次改原卡
      fake.reset();
      im.sender.kick();
      await entered;
      const answered = await im.click(OWNER, optOf(tk3));
      await im.actions.acknowledged({ messageId: tk3.messageId!, envelopeId: optOf(tk3).e as string, card: answered.card!.data, delivered: true });
      release();
      await im.settle();
    } finally {
      delete (im.api as { patchCard?: unknown }).patchCard;
    }
    const faces = patchesOf(tk3.messageId!);
    assert.equal(faces.length, 2, "旧的那份改出去之后再改一次");
    assert.doesNotMatch(textOf(faces[0]), /已答复/);
    assert.match(textOf(faces[1]), /已答复/, "最后落到卡上的是库里那份");
    assert.equal((await rowById(tk3.id)).patchState, "done");
    await waitIdle(() => statusOf("tk2"), "paused");
    await waitIdle(() => statusOf("tk3"), "paused");
  }

  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-exits: ok");
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
