// 飞书通道的「收不回来」那几处：唯一键、发件边界、重启接管、慢的确认卡。
//
// 钉住的几件事（理由见 server/src/im/outbox.ts、reconcile.ts、envelopes.ts、actions.ts、inbound.ts 的文件头）：
// ① 唯一键带上应用、空任务按空串：旧库迁过去、重复行清掉；换了应用的同一个群照样能推卡；
//    同键第二次入队报出来（返回 null），不当作已入队；
// ② 发件边界：排队期间项目改成只推标题、深链换了 → 发出去的是新样子；已经发出去的卡对账时按渲染
//    指纹改过去；收件人排队期间失去资格 → 不发；
// ③ 发送途中卡被收起：发完立刻照库里收好的样子改一次，不留原卡；
// ④ 重启接管：上一次运行点了一半的按钮 —— 事情没变就放回去（卡面改回原样、能再点），变了就记完收卡；
//    确认卡照实说不确定；收下没办的消息照原文重办；正要答复的那一步不重办、告诉用户不确定；
//    太旧的不补办、让用户重发；同 subject 的回执只入队一次；
// ⑤ 确认卡与决策卡同一条路：慢了先回「处理中」，办完补写结果；没办成把原卡改回去、卡下说原因。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-recovery-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-recovery");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failure: unknown = null;
try {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { ensureImSchema, imActions, imBindings, imInbound, imOutbox } = await import("../src/db/schema-im.js");
  const { and, eq } = await import("drizzle-orm");
  const { patchOptions } = await import("../src/im/meta.js");
  const { HELP } = await import("../src/im/commands.js");
  const { APP, OWNER, FakeFeishu, buildApp, assemble, contentOf, textOf, buttonsOf, waitIdle } = await import("./im-fixture.js");

  /** 能把下一次发消息卡在半路的假飞书。 */
  class GatedFeishu extends FakeFeishu {
    hold: { started: () => void; release: Promise<void> } | null = null;
    constructor() {
      super();
      const inner = this.fetch;
      this.fetch = (async (input: string | URL, init: RequestInit = {}) => {
        const hold = this.hold;
        if (hold && init.method === "POST" && /\/im\/v1\/messages\?/.test(String(input))) {
          this.hold = null;
          hold.started();
          await hold.release;
        }
        return inner(input, init);
      }) as typeof fetch;
    }
  }

  await ensureSchema();
  const app = buildApp();
  const fake = new GatedFeishu();
  const im = await assemble(app, fake);
  await patchOptions({ publicBaseUrl: "http://mac.tailnet:4317" });
  const at = new Date().toISOString();
  mkdirSync(join(stage, "repo"), { recursive: true });
  await db.insert(projects).values({ id: "p1", name: "飞书项目", repoPath: join(stage, "repo"), apiKeys: null, createdAt: at } as never);
  const task = (over: Record<string, unknown>) => ({ projectId: "p1", body: "", createdAt: at, updatedAt: at, ...over });
  const owner = { channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: at };
  await db.insert(imBindings).values(owner);
  const rowsOf = (taskId: string) => db.select().from(imOutbox).where(and(eq(imOutbox.appId, APP), eq(imOutbox.taskId, taskId)));
  const statusOf = async (id: string) => (await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, id))).at(0)?.s;
  const sentTo = (row: { messageId: string | null }) => fake.patches().filter((call) => call.path.includes(row.messageId!));
  const dest = { receiveType: "open_id" as const, receiveId: OWNER, recipientOpenId: OWNER };

  // ── ① 唯一键 ─────────────────────────────────────────────────────────────
  {
    // 旧库：唯一键不带应用、空 task_id 互不相撞 —— 留下两条同键的回执。
    await dbClient.execute("DROP INDEX im_outbox_dedupe");
    await dbClient.execute("CREATE UNIQUE INDEX im_outbox_subject ON im_outbox(receive_id, task_id, kind, subject)");
    const legacy = (id: string) => ({
      id, channel: "feishu", appId: APP, receiveType: "open_id", receiveId: OWNER, taskId: null, kind: "reply", subject: "r:dup",
      msgType: "text", content: "{}", state: "sent", createdAt: at, updatedAt: at,
    });
    await db.insert(imOutbox).values([legacy("dup-1"), legacy("dup-2")]);
    await ensureImSchema(dbClient as never);
    const names = (await dbClient.execute("PRAGMA index_list(im_outbox)")).rows.map((row) => row.name);
    assert.ok(names.includes("im_outbox_dedupe") && !names.includes("im_outbox_subject"), `索引迁过去了：${names}`);
    assert.equal((await db.select().from(imOutbox).where(eq(imOutbox.subject, "r:dup"))).length, 1, "同键的重复行只留一条");

    // 换了应用：旧应用在同一个收件人、同一件事上留着一行，新应用照样推得出去。
    await db.insert(tasks).values(task({ id: "tx", title: "换应用前失败的", status: "failed", endedAt: at }) as never);
    await db.insert(imOutbox).values({
      id: "old-app-row", channel: "feishu", appId: "cli_oldapp0000", receiveType: "open_id", receiveId: OWNER, taskId: "tx",
      kind: "failed", subject: `f:${at}`, msgType: "interactive", content: "{}", state: "resolved", createdAt: at, updatedAt: at,
    });
    await im.reconciler.reconcile(["tx"]);
    await im.settle();
    assert.equal((await rowsOf("tx")).at(0)?.state, "sent", "新应用的卡没被旧应用那一行挡住");

    const again = await im.reconciler.insert({ dest, taskId: null, kind: "reply", subject: "r:once", msgType: "text", content: JSON.stringify({ text: "一" }) });
    const twice = await im.reconciler.insert({ dest, taskId: null, kind: "reply", subject: "r:once", msgType: "text", content: JSON.stringify({ text: "二" }) });
    assert.ok(again);
    assert.equal(twice, null, "同键第二次入队报出来");
  }

  // ── ② 发件边界 ───────────────────────────────────────────────────────────
  {
    im.sender.stop();
    await db.insert(tasks).values(task({ id: "tp", title: "带隐私的提问", status: "paused", question: "PRIVATE-QUESTION-BODY 能删吗？" }) as never);
    await im.reconciler.reconcile(["tp"]);
    const queued = (await rowsOf("tp"))[0]!;
    assert.equal(queued.state, "pending");
    assert.match(queued.content, /PRIVATE-QUESTION-BODY/);
    // 排着队的时候改成只推标题、换了深链（直接改选项，不经路由那一下整体对账）。
    await patchOptions({ titleOnlyProjectIds: ["p1"], publicBaseUrl: "http://new.host:4317" });
    fake.reset();
    im.sender.start();
    await im.settle();
    const sent = fake.sends().find((call) => textOf(contentOf(call)).includes("带隐私的提问"));
    assert.ok(sent, "卡照样发了");
    assert.equal(JSON.stringify(contentOf(sent!)).includes("PRIVATE-QUESTION-BODY"), false, "发出去的是只推标题的样子");
    assert.ok(buttonsOf(contentOf(sent!)).some((button) => button.url?.startsWith("http://new.host:4317")), "深链是新的");

    // 已经发出去的卡：改回推全文，对账按渲染指纹把卡改过去。
    const tpRow = (await rowsOf("tp"))[0]!;
    await patchOptions({ titleOnlyProjectIds: [] });
    fake.reset();
    await im.reconciler.full();
    await im.settle();
    assert.equal(sentTo(tpRow).length, 1, "同一代的卡按新样子改了一次");
    assert.match(JSON.stringify(JSON.parse(sentTo(tpRow)[0]!.body.content)), /PRIVATE-QUESTION-BODY/);
    fake.reset();
    await im.reconciler.full();
    await im.settle();
    assert.equal(sentTo(tpRow).length, 0, "指纹对上了就不再改");

    // 排队期间收件人失去资格：决策卡与挂着任务的通知都不发。
    im.sender.stop();
    await db.insert(tasks).values(task({ id: "tr", title: "排队时解绑", status: "failed", endedAt: at }) as never);
    await im.reconciler.reconcile(["tr"]);
    await im.reconciler.insert({ dest: { receiveType: "chat_id", receiveId: "oc_nobody", recipientOpenId: null }, taskId: "tp", kind: "notice", subject: "n:1", msgType: "text", content: JSON.stringify({ text: "通知" }) });
    await db.delete(imBindings).where(eq(imBindings.openId, OWNER));
    fake.reset();
    im.sender.start();
    await im.settle();
    assert.equal(fake.sends().length, 0, "没有资格的一条都不发");
    assert.equal((await rowsOf("tr"))[0]!.state, "resolved");
    assert.equal((await db.select().from(imOutbox).where(eq(imOutbox.subject, "n:1"))).at(0)!.state, "resolved");
    await db.insert(imBindings).values(owner);
  }

  // ── ③ 发送途中被收起 ─────────────────────────────────────────────────────
  {
    await db.insert(tasks).values(task({ id: "tw", title: "发送途中答掉", status: "paused", question: "要发吗？" }) as never);
    let started = () => {};
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    let release = () => {};
    fake.hold = { started: () => started(), release: new Promise<void>((resolve) => { release = resolve; }) };
    fake.reset();
    await im.reconciler.reconcile(["tw"]);
    await inFlight;
    await db.update(tasks).set({ question: null }).where(eq(tasks.id, "tw"));
    await im.reconciler.reconcile(["tw"]);
    release();
    await im.settle();
    const row = (await rowsOf("tw"))[0]!;
    assert.ok(row.messageId, "卡发出去了");
    const fix = sentTo(row);
    assert.equal(fix.length, 1, "发完马上改一次");
    assert.match(textOf(JSON.parse(fix[0]!.body.content)), /已在别处答复/);
    assert.equal(buttonsOf(JSON.parse(fix[0]!.body.content)).filter((button) => button.value).length, 0, "改上去的不再有按钮");
  }

  // ── ④ 重启接管 ───────────────────────────────────────────────────────────
  {
    const crash = (envelopeId: string) => db.update(imActions).set({ usedAt: new Date().toISOString(), claimedBy: "old:proc" }).where(eq(imActions.id, envelopeId));
    await db.insert(tasks).values([
      task({ id: "ts", title: "点了一半没变", status: "paused", question: "选哪个？", questionOptions: JSON.stringify(["甲", "乙"]) }),
      task({ id: "tv", title: "点了一半已变", status: "paused", question: "还要吗？", questionOptions: JSON.stringify(["要"]) }),
    ] as never);
    await im.reconciler.reconcile(["ts", "tv"]);
    await im.settle();
    const optionOf = async (taskId: string) => buttonsOf(JSON.parse((await rowsOf(taskId))[0]!.content)).find((button) => button.value?.op === "opt")!.value!;
    const same = await optionOf("ts");
    const moved = await optionOf("tv");
    await crash(same.e as string);
    await crash(moved.e as string);
    assert.match((await im.click(OWNER, same)).toast!.content, /已经处理过了/, "崩在半路的信封停在「已占用」");
    await db.update(tasks).set({ question: "换了一道？", updatedAt: new Date().toISOString() }).where(eq(tasks.id, "tv"));

    await im.sender.drainNow();
    const stuckCreate = await im.say({ text: "/project 1" }).then(() => im.say({ text: "/new 重启时建的任务" }));
    await im.settle();
    const createCard = fake.sends().find((call) => call.path.includes(`/messages/${stuckCreate}/reply`))!;
    const createConfirm = buttonsOf(contentOf(createCard)).find((button) => button.value?.op === "confirm")!.value!;
    await crash(createConfirm.e as string);

    fake.reset();
    assert.equal(await im.actions.recover(), 3);
    await im.settle();
    const tsRow = (await rowsOf("ts"))[0]!;
    assert.equal((await db.select().from(imActions).where(eq(imActions.id, same.e as string))).at(0)!.usedAt, null, "事情没变：信封放回去");
    assert.equal(sentTo(tsRow).length, 1, "卡面改回原样（盖掉可能停着的「处理中」）");
    assert.ok(buttonsOf(JSON.parse(sentTo(tsRow)[0]!.body.content)).some((button) => button.value?.op === "opt"), "改回去的卡还能点");
    const retried = await im.click(OWNER, same);
    assert.equal(retried.toast?.type, "success", JSON.stringify(retried));
    assert.equal((await db.select().from(imActions).where(eq(imActions.id, moved.e as string))).at(0)!.result, "interrupted", "事情变了：记完，不放回");
    assert.equal((await rowsOf("tv")).filter((row) => row.state === "sent").length, 1, "新一代推了新卡，旧卡收起");
    const createRow = (await db.select().from(imOutbox).where(eq(imOutbox.kind, "confirm"))).find((row) => row.content.includes("不确定办成没有"));
    assert.ok(createRow, "确认卡照实说不确定");
    assert.equal(createRow!.state, "resolved");
    assert.equal((await db.select().from(tasks).where(eq(tasks.title, "重启时建的任务"))).length, 0, "不确定的不替用户再建一遍");
    await waitIdle(() => statusOf("ts"), "paused");

    // 收下没办的消息。
    const event = (id: string, text: string) => ({
      sender: { sender_id: { open_id: OWNER }, sender_type: "user" },
      message: { message_id: id, chat_id: "oc_p2p", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) },
    });
    assert.equal(await im.inbound.accept(event("om_crash_1", "/help")), "msg:om_crash_1");
    assert.equal(await im.inbound.accept(event("om_crash_1", "/help")), null, "重推的同一条不再收");
    const base = { channel: "feishu", appId: APP, openId: OWNER, chatId: "oc_p2p", chatType: "p2p", updatedAt: at };
    await db.insert(imInbound).values([
      { ...base, id: "msg:om_crash_2", kind: "reply", taskId: "ts", state: "dispatching", payload: JSON.stringify(event("om_crash_2", "x").message), createdAt: at },
      { ...base, id: "msg:om_crash_3", kind: "received", state: "received", payload: JSON.stringify(event("om_crash_3", "/help").message),
        createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
    ]);
    fake.reset();
    assert.equal(await im.inbound.recover(), 3);
    await im.settle();
    const replyOf = (id: string) => fake.sends().filter((call) => call.path.includes(`/messages/${id}/reply`)).map((call) => textOf(contentOf(call)));
    const inbound = async (id: string) => (await db.select().from(imInbound).where(eq(imInbound.id, `msg:${id}`))).at(0)!;
    assert.deepEqual(replyOf("om_crash_1"), [HELP], "收下没办的照原文重办");
    assert.equal((await inbound("om_crash_1")).state, "done");
    assert.match(replyOf("om_crash_2").join(), /不确定送到没有/, "正要发给任务的那一步不重办");
    assert.equal((await inbound("om_crash_2")).state, "failed");
    assert.match(replyOf("om_crash_3").join(), /没来得及处理/, "太旧的不补办");
    fake.reset();
    assert.equal(await im.inbound.recover(), 0, "接管过的不再接管");
    await im.commands.say({ messageId: "om_crash_1", dest }, HELP);
    await im.settle();
    assert.equal(fake.sends().length, 0, "同一条消息的同一句回执只入队一次");
  }

  // ── ⑤ 慢的确认卡 ─────────────────────────────────────────────────────────
  {
    const cardMessage = (await rowsOf("tx"))[0]!.messageId!;
    const stopCard = async () => {
      const message = await im.say({ text: "/stop", parentId: cardMessage });
      await im.settle();
      const sent = fake.sends().find((call) => call.path.includes(`/messages/${message}/reply`))!;
      const row = (await db.select().from(imOutbox).where(eq(imOutbox.kind, "confirm"))).find((item) => item.replyTo === message)!;
      return { row, value: buttonsOf(contentOf(sent)).find((button) => button.value?.op === "confirm")!.value! };
    };
    let outcome = { ok: true, text: "已停止。", final: true, tone: "grey" as const };
    im.commands.confirmed = async () => { await sleep(4_000); return outcome; };

    const slow = await stopCard();
    const started = Date.now();
    const first = await im.click(OWNER, slow.value);
    assert.ok(Date.now() - started < 3_600, "慢了先回执，不等办完");
    assert.match(textOf(first.card?.data), /处理中/);
    fake.reset();
    await sleep(2_000);
    await im.settle();
    assert.equal(sentTo(slow.row).length, 1, "办完补写一次");
    assert.match(textOf(JSON.parse(sentTo(slow.row)[0]!.body.content)), /已停止/);
    assert.equal((await db.select().from(imOutbox).where(eq(imOutbox.id, slow.row.id))).at(0)!.state, "resolved");

    outcome = { ok: false, text: "接口拒了", final: false } as never;
    const failing = await stopCard();
    await im.click(OWNER, failing.value);
    fake.reset();
    await sleep(2_000);
    await im.settle();
    assert.equal((await db.select().from(imActions).where(eq(imActions.id, failing.value.e as string))).at(0)!.usedAt, null, "没办成：信封放回去");
    assert.ok(buttonsOf(JSON.parse(sentTo(failing.row)[0]!.body.content)).some((button) => button.value?.op === "confirm"), "卡面改回原样");
    assert.match(fake.sends().map((call) => textOf(contentOf(call))).join(), /没办成：接口拒了/, "卡下说原因");
  }

  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-recovery: ok");
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
