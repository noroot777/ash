// 回给发话人的那一句（scope.ts reply）：他自己这次操作的结局 —— 接口报错、拒绝的原因、投不进房间、
// 拿不到回复。报错原文常带着项目里的字，所以出口照样核：还是请求进来那一刻的那个人（绑定实例在那一刻
// 记下，办完之后不按现状重新盖）、他此刻还看得见那个项目、群还绑着它。核不过不发原文，换成一句不含 ash
// 数据的固定说明 —— 「看不到了 / 解绑了」常常正是报错要说的事，一声不吭他只会以为没收到。
//
// 钉住的几件事：
// ① 任务删了：回它的失败卡发 /retry、回它的卡发 /stop，点它确认卡上的「确定」没办成 —— 原因都发得出去；
// ② 助手房间没了：投不进房间、拿回复时房间不在 —— 说明都发得出去；
// ⑥ 办着的时候解绑 / 换绑（命令、卡片按钮慢路径和快路径）：报错原文一个字不发，只发固定说明；什么都没变照发原文；
// ③ 多人模式的群：看不到群绑定项目的成员 @ 机器人、回任务卡 /reply、/retry、/stop —— 只发固定说明；
//    看得到的照发；群换了项目、发起的人办着的时候解绑了，同样只发固定说明；
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
  const { bindingOf, unbindOwner } = await import("../src/im/binding.js");
  const { createEnvelope } = await import("../src/im/envelopes.js");
  const { patchOptions } = await import("../src/im/meta.js");
  const { originOf, scopeFor } = await import("../src/im/scope.js");
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
  // 重试接口的报错原文带着项目里的字（受控输入）。fakeRetry 打开时 /retry 不进真接口、回这一句；stall 在就先停在那里。
  const SECRET = "部署项目「内部客户甲」失败：/private/customer-a/deploy.sh 无法执行";
  const WITHHELD = /这次操作的结果不在飞书里显示了（([^）]+)），请到 ash 网页查看。/;
  const gate = () => {
    let reached!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    const opened = new Promise<void>((resolve) => { release = resolve; });
    return { arrived, opened, reached, release };
  };
  let fakeRetry = false;
  let stall: ReturnType<typeof gate> | null = null;
  const realPost = im.ash.post.bind(im.ash);
  im.ash.post = (async (who: never, path: `/api/${string}`, body?: unknown) => {
    if (!fakeRetry || !path.endsWith("/retry")) return realPost(who, path, body);
    const held = stall;
    if (held) { held.reached(); await held.opened; }
    return { ok: false, status: 409, error: SECRET, data: {} };
  }) as typeof im.ash.post;
  /** 请求进了 /retry、停在那里时做 change，再放行。返回 run 的结果。 */
  const during = async <T>(run: () => Promise<T>, change: () => Promise<unknown>): Promise<T> => {
    const held = stall = gate();
    const pending = run();
    await held.arrived;
    await change();
    held.release();
    const result = await pending;
    stall = null;
    return result;
  };

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
      origin: await originOf(APP, dest, binding),
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

    // 等回复的这段时间里解绑了（以他的身份读不了房间，等满时限才说）：说明句按投进房间那一刻的绑定核，不发原文。
    const long = new Date(Date.now() - 21 * 60_000).toISOString();
    await db.insert(imInbound).values({
      id: "msg:om_relay_gone", channel: "feishu", appId: APP, openId: OWNER, chatId: "oc_p2p", chatType: "p2p", kind: "assistant",
      roomId: "room-del", state: "sent", detail: "im-chat-message-2", createdAt: long, updatedAt: long,
      scope: JSON.stringify(await scopeFor(APP, dest, { kind: "room", roomId: "room-del", projectId: null })),
    } as never);
    await unbindOwner("");
    fake.reset();
    await im.relay.poll();
    await im.settle();
    assert.doesNotMatch(repliesTo("om_relay_gone"), /没拿到回复：/, "解绑了：拿不到回复的说明原文不发");
    assert.match(repliesTo("om_relay_gone"), /不在飞书里显示了（收件人已解绑或换了绑定）/);
    await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: at });

    // 换绑了（新的绑定读得到房间、房间没了）：同样按投进去那一刻的那一次绑定核。
    await db.insert(imInbound).values({
      id: "msg:om_relay_rebound", channel: "feishu", appId: APP, openId: OWNER, chatId: "oc_p2p", chatType: "p2p", kind: "assistant",
      roomId: "room-del", state: "sent", detail: "im-chat-message-3", createdAt: at, updatedAt: at,
      scope: JSON.stringify(await scopeFor(APP, dest, { kind: "room", roomId: "room-del", projectId: null })),
    } as never);
    await unbindOwner("");
    await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: new Date(Date.now() + 500).toISOString() });
    fake.reset();
    await im.relay.poll();
    await im.settle();
    assert.doesNotMatch(repliesTo("om_relay_rebound"), /没拿到回复：/, "换绑了：说明原文不发");
    assert.match(repliesTo("om_relay_rebound"), /不在飞书里显示了（收件人已解绑或换了绑定）/);
    await unbindOwner("");
    await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: at });
  }

  // ── ⑥ 办着的时候解绑 / 换绑 ─────────────────────────────────────────────
  {
    fakeRetry = true;
    const failedCardOf = async (id: string) => {
      await db.insert(tasks).values({ id, projectId: "p1", title: `失败任务 ${id}`, body: "", status: "failed", endedAt: at, createdAt: at, updatedAt: at } as never);
      await im.reconciler.reconcile([id]);
      await im.settle();
      const row = (await db.select().from(imOutbox).where(eq(imOutbox.taskId, id))).find((item) => item.kind === "failed" && item.state === "sent");
      assert.ok(row?.messageId, `${id} 的失败卡发出去了`);
      return row!;
    };
    const bindAgain = (boundAt: string) => db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt });
    const retryOn = (card: { messageId: string | null }) => () => im.say({ text: "/retry", parentId: card.messageId! });

    // 什么都没变：原文照发（他自己这一下的结局）。
    const kept = await failedCardOf("tr0");
    fake.reset();
    const same = await during(retryOn(kept), async () => {});
    await im.settle();
    assert.match(repliesTo(same), /没能重试：部署项目「内部客户甲」/, "绑定没变：报错原文照发");

    // 请求已经进了接口，网页上解绑：原账号不再收到报错原文。
    fake.reset();
    const unbound = await during(retryOn(kept), () => unbindOwner(""));
    await im.settle();
    assert.doesNotMatch(sentText(), /内部客户甲|customer-a/, "解绑了：报错原文一个字不发");
    assert.equal(WITHHELD.exec(repliesTo(unbound))?.[1], "收件人已解绑或换了绑定", "只回一句固定说明");
    const withheld = (await db.select().from(imOutbox).where(eq(imOutbox.replyTo, unbound))).at(0)!;
    assert.equal(withheld.state, "sent");
    assert.doesNotMatch(withheld.content, /内部客户甲/, "库里那份也换成了固定说明");
    assert.deepEqual(JSON.parse(withheld.scope!), { kind: "system" }, "换上的那句不含 ash 数据");

    // 换绑：同一个飞书账号重新绑了一次（新的实例）—— 也不发。
    await bindAgain(new Date(Date.now() + 1_000).toISOString());
    const rebindCard = await failedCardOf("tr1");
    fake.reset();
    const rebound = await during(retryOn(rebindCard), async () => {
      await unbindOwner("");
      await bindAgain(new Date(Date.now() + 2_000).toISOString());
    });
    await im.settle();
    assert.doesNotMatch(sentText(), /内部客户甲/, "换绑了：报错原文不发");
    assert.equal(WITHHELD.exec(repliesTo(rebound))?.[1], "收件人已解绑或换了绑定");

    // 卡片上的「重试」，慢路径（先回「处理中」、没办成的原因回复在卡下面）：点下去之后解绑。
    const slowCard = await failedCardOf("tr2");
    fake.reset();
    const retryValue = buttonsOf(JSON.parse(slowCard.content)).find((button) => button.value?.op === "retry")!.value!;
    const slow = stall = gate();
    const pressing = im.click(OWNER, retryValue);
    await slow.arrived;
    // 回执的计时器 unref 了：这边另挂一个，免得进程以为没事可等。
    const [response] = await Promise.all([pressing, sleep(2_600)]);
    assert.match(JSON.stringify(response), /处理中/, "慢路径：先回「处理中」");
    await unbindOwner("");
    slow.release();
    stall = null;
    await sleep(300);
    await im.settle();
    const fail = (await db.select().from(imOutbox).where(eq(imOutbox.kind, "fail"))).find((row) => row.replyTo === slowCard.messageId)!;
    assert.ok(fail, "没办成的原因回复入队了");
    assert.doesNotMatch(fail.content, /内部客户甲/, "按钮慢路径：解绑了不发报错原文");
    assert.equal(WITHHELD.exec(repliesTo(slowCard.messageId!))?.[1], "收件人已解绑或换了绑定");
    assert.doesNotMatch(sentText(), /内部客户甲/);

    // 快路径（结局随回执带回去，只有 toast）：点下去之后换绑，toast 里也不带原文。
    await bindAgain(new Date(Date.now() + 3_000).toISOString());
    const quickCard = await failedCardOf("tr3");
    const quickValue = buttonsOf(JSON.parse(quickCard.content)).find((button) => button.value?.op === "retry")!.value!;
    const quick = await during(() => im.click(OWNER, quickValue), async () => {
      await unbindOwner("");
      await bindAgain(new Date(Date.now() + 4_000).toISOString());
    });
    assert.doesNotMatch(JSON.stringify(quick), /内部客户甲/, "按钮快路径：换绑了，toast 不带原文");
    assert.match(JSON.stringify(quick), /没办成，原因见 ash。/);
    await unbindOwner("");
    await bindAgain(at);
    fakeRetry = false;
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
    // 他看不到这个群绑的项目：报错里可能就带着那个项目的字，只发固定说明（群里的人都看得到这一句）。
    for (const [said, what] of [[talk, "建不了群聊房间"], [reply, "/reply"], [retry, "/retry"], [stop, "/stop"]] as const) {
      assert.equal(WITHHELD.exec(repliesTo(said))?.[1], "看不到这个项目了", `看不到项目的成员 ${what}：只发固定说明`);
    }
    assert.doesNotMatch(repliesTo(reply) + repliesTo(retry) + repliesTo(stop), /没发进任务：|没能重试：|停不了：/);

    // 看得到的成员：原因照发到群里。
    await visibility.addProjectMember({ projectId: "pa", userId: bob.id, role: "member", addedBy: alice.id });
    fakeRetry = true;
    fake.reset();
    const seen = await asBob("/retry", groupCard.messageId!);
    await im.settle();
    assert.match(repliesTo(seen), /没能重试：部署项目「内部客户甲」/, "看得到项目的成员：原因发到群里");
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

  // ── ③ 续：发起的人办着的时候解绑了 ───────────────────────────────────────
  {
    fake.reset();
    const retry = await during(() => asBob("/retry", groupCard.messageId!), () => db.delete(imBindings).where(eq(imBindings.openId, "ou_bob")));
    await im.settle();
    assert.doesNotMatch(repliesTo(retry), /内部客户甲/, "发起的人解绑了：群里不发报错原文");
    assert.equal(WITHHELD.exec(repliesTo(retry))?.[1], "发起的人已解绑或换了绑定");
    await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: "ou_bob", userId: bob.id, boundAt: at });
  }

  // ── ③ 续：群换了项目 ─────────────────────────────────────────────────────
  {
    im.sender.stop();
    const retry = await asBob("/retry", groupCard.messageId!);
    await db.update(imGroups).set({ projectId: "p1" }).where(eq(imGroups.chatId, "oc_pa"));
    fake.reset();
    im.sender.start();
    await im.settle();
    assert.doesNotMatch(repliesTo(retry), /没能重试：|内部客户甲/, "群换了项目：原项目的报错不发");
    assert.equal(WITHHELD.exec(repliesTo(retry))?.[1], "群绑的已不是这个项目", "只发固定说明");

    // 旧版本入队、群里没记发起人的那种：认不出是谁发起的，不发原文。
    const group = (await db.select().from(imGroups).where(eq(imGroups.chatId, "oc_pa"))).at(0)!;
    const sample = (await db.select().from(imOutbox).where(eq(imOutbox.replyTo, retry))).at(0)!;
    const legacy = { ...sample, receiveType: "chat_id", receiveId: "oc_pa", scope: JSON.stringify({ kind: "reply", projectId: null, bound: group.boundAt }) };
    assert.deepEqual(await im.reconciler.exits.admission(legacy as never), { ok: false, why: "没记下是谁发起的" });
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
