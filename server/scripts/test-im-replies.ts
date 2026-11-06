// 回给发话人的那一句（scope.ts reply）：他自己这次操作的结局 —— 接口报错、拒绝的原因、投不进房间、
// 拿不到回复 —— 出口不按「他此刻能不能看、任务和房间还在不在」拦（报错说的常常正是这件事，照核就
// 永远发不出去），只核群还绑着那个项目、项目是不是只推标题。
//
// 钉住的几件事：
// ① 任务删了：回它的失败卡发 /retry、回它的卡发 /stop，点它确认卡上的「确定」没办成 —— 原因都发得出去；
// ② 助手房间没了：投不进房间、拿回复时房间不在 —— 说明都发得出去；
// ③ 多人模式的群：看不到群绑定项目的成员 @ 机器人、回任务卡 /reply、/retry、/stop —— 原因都发到群里；
//    群换了项目，那句报错就不发了；
// ④ 只推标题：报错换成短句；
// ⑤ 时间线补记：时间线和系统提示两边都没记上，待记就留着，下次 recover() 补上。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-replies-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-replies");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failure: unknown = null;
try {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { chatRooms, projects, tasks } = await import("../src/db/schema.js");
  const { taskNotices } = await import("../src/db/schema-task-notice.js");
  const { imActions, imBindings, imGroups, imOutbox } = await import("../src/db/schema-im.js");
  const { and, eq, inArray } = await import("drizzle-orm");
  const mode = await import("../src/auth/mode.js");
  const store = await import("../src/auth/store.js");
  const visibility = await import("../src/auth/visibility.js");
  const { bindingOf } = await import("../src/im/binding.js");
  const { createEnvelope } = await import("../src/im/envelopes.js");
  const { patchOptions } = await import("../src/im/meta.js");
  const { scopeFor } = await import("../src/im/scope.js");
  const { APP, OWNER, FakeFeishu, buildApp, assemble, contentOf, buttonsOf } = await import("./im-fixture.js");

  await ensureSchema();
  const app = buildApp();
  const fake = new FakeFeishu();
  const im = await assemble(app, fake);

  const at = new Date().toISOString();
  mkdirSync(join(stage, "repo"), { recursive: true });
  await db.insert(projects).values({ id: "p1", name: "飞书项目", repoPath: join(stage, "repo"), apiKeys: null, createdAt: at } as never);
  await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: at });
  const dest = { receiveType: "open_id" as const, receiveId: OWNER, recipientOpenId: OWNER };
  const sentText = () => fake.sends().map((call) => JSON.stringify(contentOf(call))).join("\n");
  const repliesTo = (messageId: string) => fake.sends().filter((call) => call.path.includes(`/messages/${messageId}/reply`))
    .map((call) => JSON.stringify(contentOf(call))).join("\n");

  // ── ① 任务删了 ───────────────────────────────────────────────────────────
  {
    await db.insert(tasks).values([{
      id: "tx", projectId: "p1", title: "要删的任务", body: "", status: "paused", question: "选哪个？",
      questionOptions: JSON.stringify(["甲", "乙"]), createdAt: at, updatedAt: at,
    }, {
      id: "txf", projectId: "p1", title: "要删的失败任务", body: "", status: "failed", endedAt: at, createdAt: at, updatedAt: at,
    }] as never);
    await im.reconciler.reconcile(["tx", "txf"]);
    await im.settle();
    const card = (await db.select().from(imOutbox).where(eq(imOutbox.taskId, "tx"))).find((row) => row.state === "sent")!;
    assert.ok(card?.messageId, "提问卡发出去了");
    const failedCard = (await db.select().from(imOutbox).where(eq(imOutbox.taskId, "txf"))).find((row) => row.state === "sent")!;
    assert.equal(failedCard?.kind, "failed", "失败卡发出去了");
    // 确认卡在任务还在时就出来了；「确定」放慢，走「处理中 → 结果改卡」那一路。
    const stop = await im.say({ text: "/stop", parentId: card.messageId! });
    await im.settle();
    const confirm = fake.sends().find((call) => call.path.includes(`/messages/${stop}/reply`))!;
    const value = buttonsOf(contentOf(confirm)).find((button) => button.value?.op === "confirm")!.value!;
    const confirmed = im.commands.confirmed.bind(im.commands);
    im.commands.confirmed = async (principal, payload) => { await sleep(3_000); return confirmed(principal, payload); };

    await db.delete(tasks).where(inArray(tasks.id, ["tx", "txf"]));
    fake.reset();
    const retry = await im.say({ text: "/retry", parentId: failedCard.messageId! });
    const stopAgain = await im.say({ text: "/stop", parentId: card.messageId! });
    await im.settle();
    assert.match(repliesTo(retry), /没能重试：/, "任务删了，/retry 的原因照发");
    assert.match(repliesTo(stopAgain), /停不了：/, "任务删了，/stop 直接说停不了，不出一张发不出去的确认卡");
    assert.equal((await db.select().from(imOutbox).where(eq(imOutbox.kind, "confirm"))).length, 1, "没给删了的任务再出确认卡");

    await im.click(OWNER, value);
    await sleep(3_400);
    await im.settle();
    assert.match(repliesTo(card.messageId!) + sentText(), /没办成：/, "点「确定」没办成：原因照发，不按卡的来源拦");
    im.commands.confirmed = confirmed;
  }

  // ── ② 助手房间没了 ───────────────────────────────────────────────────────
  {
    const binding = (await bindingOf(APP, OWNER))!;
    const ctx = {
      messageId: "om_relay_post", chatId: "oc_p2p", chatType: "p2p" as const,
      principal: { channel: "feishu" as const, appId: APP, openId: OWNER }, binding, dest, card: null,
    };
    fake.reset();
    assert.equal(await im.relay.post(ctx, "msg:om_relay_post", "room-gone", "你好", [], null, null), false);
    await im.settle();
    assert.match(repliesTo("om_relay_post"), /没能送进 ash：/, "房间没了，投不进去的说明照发");

    // 投进去了、回复还没来，房间被删了。
    const member = { agentType: "claude", name: "Claude" };
    await db.insert(chatRooms).values({ id: "room-del", projectId: "", ownerUserId: null, name: "飞书", members: JSON.stringify([member]), kind: "assistant", createdAt: at } as never);
    const { imInbound } = await import("../src/db/schema-im.js");
    await db.insert(imInbound).values({
      id: "msg:om_relay_poll", channel: "feishu", appId: APP, openId: OWNER, chatId: "oc_p2p", chatType: "p2p", kind: "assistant",
      roomId: "room-del", state: "sent", detail: "im-chat-message", createdAt: at, updatedAt: at,
      scope: JSON.stringify(await scopeFor(APP, dest, { kind: "room", roomId: "room-del", projectId: null })),
    } as never);
    await db.delete(chatRooms).where(eq(chatRooms.id, "room-del"));
    fake.reset();
    await im.relay.poll();
    await im.settle();
    assert.match(repliesTo("om_relay_poll"), /没拿到回复：/, "房间没了，拿不到回复的说明照发");
  }

  // ── ⑤ 时间线补记 ─────────────────────────────────────────────────────────
  {
    const outboxId = (await db.select({ id: imOutbox.id }).from(imOutbox).where(eq(imOutbox.appId, APP)).limit(1)).at(0)!.id;
    const envelope = await createEnvelope({ outboxId, taskId: "tz", action: "retry", recipientOpenId: OWNER, generation: "g" });
    await db.update(imActions).set({ usedAt: at, result: "已重试", audit: "经飞书（我）点了「重试」" }).where(eq(imActions.id, envelope));
    // tz 没有会话（时间线记不进去），系统提示的写入也被拦下。
    await dbClient.execute("CREATE TRIGGER im_test_notice BEFORE INSERT ON task_notices BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await im.actions.recover();
    const pending = (await db.select().from(imActions).where(eq(imActions.id, envelope))).at(0)!;
    assert.equal(pending.audit, "经飞书（我）点了「重试」", "两边都没记上：待记留着");
    await dbClient.execute("DROP TRIGGER im_test_notice");
    await im.actions.recover();
    assert.equal((await db.select().from(imActions).where(eq(imActions.id, envelope))).at(0)!.audit, null, "补记上了才清");
    assert.equal((await db.select().from(taskNotices).where(eq(taskNotices.taskId, "tz"))).length, 1, "记成了一条系统提示");
  }

  // ── ③ 多人模式的群 ───────────────────────────────────────────────────────
  const root = join(stage, "root");
  for (const dir of ["alice", "bob"]) mkdirSync(join(root, dir), { recursive: true });
  await mode.setInstanceMode("multi", root);
  const alice = await store.createUser({ name: "alice", role: "member", dirName: "alice", gitName: "A", gitEmail: "a@x", createdBy: null });
  const bob = await store.createUser({ name: "bob", role: "member", dirName: "bob", gitName: "B", gitEmail: "b@x", createdBy: alice.id });
  for (const user of [alice, bob]) await store.updateUser(user.id, { status: "active" });
  mkdirSync(join(root, "alice", "pa"), { recursive: true });
  await db.insert(projects).values({ id: "pa", name: "pa", repoPath: join(root, "alice", "pa"), apiKeys: null, createdAt: at, ownerUserId: alice.id } as never);
  await visibility.addProjectMember({ projectId: "pa", userId: alice.id, role: "member", addedBy: alice.id });
  await db.insert(tasks).values({ id: "tg", projectId: "pa", title: "群里的任务", body: "", status: "failed", createdAt: at, updatedAt: at, endedAt: at, ownerUserId: alice.id } as never);
  await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: "ou_bob", userId: bob.id, boundAt: at });
  await db.insert(imGroups).values({ channel: "feishu", appId: APP, chatId: "oc_pa", projectId: "pa", name: "a 群", boundBy: alice.id, pushCards: 1, boundAt: at });
  await im.reconciler.run(() => im.reconciler.reconcile(["tg"]));
  await im.settle();
  const groupCard = (await db.select().from(imOutbox).where(and(eq(imOutbox.taskId, "tg"), eq(imOutbox.receiveId, "oc_pa")))).at(0)!;
  assert.ok(groupCard.messageId, `群里的失败卡发出去了：${groupCard.state} ${groupCard.resolution}`);
  assert.equal(groupCard.kind, "failed");
  const asBob = (text: string, parentId?: string) => im.say({ openId: "ou_bob", chatType: "group", chatId: "oc_pa", text, mentionBot: true, parentId });
  {
    fake.reset();
    const talk = await asBob("帮我看看");
    const reply = await asBob("/reply 换个思路", groupCard.messageId!);
    const retry = await asBob("/retry", groupCard.messageId!);
    const stop = await asBob("/stop", groupCard.messageId!);
    await im.settle();
    assert.match(repliesTo(talk), /还没配置过 ash 助手/, "建不了群聊房间：原因发到群里");
    assert.match(repliesTo(reply), /没发进任务：/, "看不到项目的成员 /reply：原因发到群里");
    assert.match(repliesTo(retry), /没能重试：/, "看不到项目的成员 /retry：原因发到群里");
    assert.match(repliesTo(stop), /停不了：/, "看不到项目的成员 /stop：原因发到群里");
  }

  // ── ④ 只推标题 ───────────────────────────────────────────────────────────
  {
    await patchOptions({ titleOnlyProjectIds: ["pa"] });
    fake.reset();
    const retry = await asBob("/retry", groupCard.messageId!);
    await im.settle();
    assert.match(repliesTo(retry), /没能重试，原因见 ash。/, "只推标题：换成短句");
    assert.doesNotMatch(repliesTo(retry), /没能重试：/);
    await patchOptions({ titleOnlyProjectIds: [] });
  }

  // ── ③ 续：群换了项目 ─────────────────────────────────────────────────────
  {
    im.sender.stop();
    const retry = await asBob("/retry", groupCard.messageId!);
    await db.update(imGroups).set({ projectId: "p1" }).where(eq(imGroups.chatId, "oc_pa"));
    fake.reset();
    im.sender.start();
    await im.settle();
    assert.equal(repliesTo(retry), "", "群换了项目：原项目的报错不发");
    const row = (await db.select().from(imOutbox).where(eq(imOutbox.replyTo, retry))).at(0)!;
    assert.equal(row.state, "resolved");
    assert.match(row.resolution ?? "", /群绑的已不是这个项目/);
  }

  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-replies: ok");
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
