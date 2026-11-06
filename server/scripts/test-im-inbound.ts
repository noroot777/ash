// 飞书里发来的消息：绑定码、没绑定的人、群里 @、回复任务卡、斜杠命令、附件、助手房间与群聊房间的来回。
//
// 钉住的几件事（理由见 server/src/im/inbound.ts、commands.ts、relay.ts 的文件头）：
// ① 绑定码：单聊里发个人码 → 认领、回一句「回网页确认」；没绑定的人单聊只提示一次，群里不出声；
//    群里没 @ 机器人的话一律不理；
// ② 回复任务卡：此刻在等答复就是答复（多题按题号拆）；不是提问就当成发给任务的消息；收到点个表情；
//    答复只认那张卡自己问的那道题：回旧提问卡、回别的卡都不答到眼下这道题上；
// ③ 命令：/help /project /new（先确认，点确定才建任务并开跑）/stop（先确认，取消就不停）/todo；
//    不认识的消息类型回一句说明；
// ④ 助手房间：单聊里直接说话 → 照最近一间助手房间的配置建一间「飞书」，投进去；回复按 reply_to
//    对上、发回飞书（回在用户那条消息下面）；同一条飞书消息重复推送只投一次；
// ⑤ 附件：图片下载 → 转存进上传目录 → 路径随消息投进房间；
// ⑥ 群：在群里 @ 机器人发群码 → 认领（带群名）→ 确认 → 群里 @ 机器人说话进项目群聊房间，
//    自动补上 @成员名（群聊房间里不点名没人答）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-inbound-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
requireTmpDb("test-im-inbound");

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { chatMessages, chatRooms } = await import("../src/db/schema-chat.js");
  const { imBindings, imInbound, imOutbox } = await import("../src/db/schema-im.js");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { bindingOf, bindingView, createBindCode, rejectCode } = await import("../src/im/binding.js");
  const { confirmGroupCode, groupOf } = await import("../src/im/groups.js");
  const { chatMessageIdOf } = await import("../src/im/relay.js");
  const { APP, OWNER, FakeFeishu, buildApp, assemble, contentOf, textOf, buttonsOf, waitIdle } = await import("./im-fixture.js");

  await ensureSchema();
  const app = buildApp();
  const fake = new FakeFeishu();
  const im = await assemble(app, fake);

  const at = new Date().toISOString();
  mkdirSync(join(stage, "repo"), { recursive: true });
  await db.insert(projects).values({ id: "p1", name: "飞书项目", repoPath: join(stage, "repo"), apiKeys: null, createdAt: at } as never);
  const task = (over: Record<string, unknown>) => ({ projectId: "p1", body: "", createdAt: at, updatedAt: at, ...over });
  await db.insert(tasks).values([
    task({ id: "tq", title: "问库", status: "paused", question: "用哪个库？" }),
    task({ id: "tm", title: "两道题", status: "paused", question: "两件事要你定",
      questionItems: JSON.stringify([{ question: "数据库用什么？" }, { question: "要不要缓存？" }]) }),
    task({ id: "tf", title: "挂了", status: "failed", endedAt: at }),
  ] as never);
  await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: at });
  const statusOf = async (id: string) => (await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, id))).at(0)?.s;
  const repliesTo = (messageId: string) => fake.sends().filter((send) => send.path.includes(`/messages/${messageId}/reply`));
  const inboundOf = async (messageId: string) => (await db.select().from(imInbound).where(eq(imInbound.id, `msg:${messageId}`))).at(0)!;

  await im.reconciler.full();
  await im.settle();
  const cardOf = async (taskId: string) => (await db.select().from(imOutbox).where(and(eq(imOutbox.taskId, taskId), eq(imOutbox.state, "sent")))).at(0)!;

  // ── ① 绑定码、没绑定的人、群里没 @ ───────────────────────────────────────
  {
    const code = await createBindCode("", "user", null);
    const message = await im.say({ openId: "ou_fresh", text: `我的码 ${code.code.toLowerCase()}` });
    await im.settle();
    assert.match(textOf(contentOf(repliesTo(message)[0]!)), /收到绑定码/);
    const pending = await bindingView("", APP);
    assert.equal(pending.state, "pending", "认领了，等网页确认");
    await rejectCode("", "user", code.codeId);

    const first = await im.say({ openId: "ou_nobody", text: "你好" });
    const second = await im.say({ openId: "ou_nobody", text: "在吗" });
    await im.settle();
    assert.match(textOf(contentOf(repliesTo(first)[0]!)), /还没绑定/);
    assert.equal(repliesTo(second).length, 0, "一天只提示一次");

    const unmentioned = await im.say({ chatType: "group", chatId: "oc_g", text: "随便聊聊" });
    const strangerInGroup = await im.say({ openId: "ou_nobody", chatType: "group", chatId: "oc_g", text: "你好", mentionBot: true });
    const unboundGroup = await im.say({ chatType: "group", chatId: "oc_g", text: "大家好", mentionBot: true });
    await im.settle();
    assert.equal((await inboundOf(unmentioned)).kind, "ignored", "群里没 @ 机器人不理");
    assert.equal(repliesTo(strangerInGroup).length, 0, "群里没绑定的人不出声");
    assert.match(textOf(contentOf(repliesTo(unboundGroup)[0]!)), /还没绑定 ash 项目/);
  }

  // ── ② 回复任务卡 ─────────────────────────────────────────────────────────
  {
    const questionCard = await cardOf("tq");
    const reply = await im.say({ text: "用 zod", parentId: questionCard.messageId! });
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, "tq"))).at(0)!.question, null, "回复提问卡 = 答复");
    assert.equal((await inboundOf(reply)).kind, "answer");
    assert.ok(fake.reactions().some((call) => call.path.includes(`/messages/${reply}/reactions`)), "收到了点个表情");

    const multiCard = await cardOf("tm");
    await im.say({ text: "1. Postgres\n2. 先不要", parentId: multiCard.messageId! });
    const tm = (await db.select().from(tasks).where(eq(tasks.id, "tm"))).at(0)!;
    const record = (JSON.parse(tm.questionHistory!) as { answers?: string[] }[]).at(-1)!;
    assert.deepEqual(record.answers, ["Postgres", "先不要"], "多题按题号拆");

    const failedCard = await cardOf("tf");
    const nudge = await im.say({ text: "换个思路再试", parentId: failedCard.messageId! });
    const nudgeRow = await inboundOf(nudge);
    assert.equal(nudgeRow.kind, "reply");
    assert.equal(nudgeRow.state, "done", `发给任务的消息该被收下：${nudgeRow.detail}`);
    await Promise.all([["tq", "paused"], ["tm", "paused"], ["tf", "failed"]].map(([id, from]) => waitIdle(() => statusOf(id!), from)));

    // 两代提问：在第一问的卡下回「是」，不能答到第二问上。
    await db.insert(tasks).values(task({ id: "tg", title: "两代提问", status: "paused", question: "只检查、不修改？" }) as never);
    await im.reconciler.reconcile(["tg"]);
    await im.settle();
    const firstCard = await cardOf("tg");
    await db.update(tasks).set({ question: "删除所有数据？", updatedAt: new Date().toISOString() }).where(eq(tasks.id, "tg"));
    await im.reconciler.reconcile(["tg"]);
    await im.settle();
    const secondCard = await cardOf("tg");
    assert.notEqual(secondCard.id, firstCard.id, "第二问推了新卡");
    const late = await im.say({ text: "是", parentId: firstCard.messageId! });
    await im.settle();
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, "tg"))).at(0)!.question, "删除所有数据？", "旧卡下的回复没答到新问题上");
    assert.equal((await inboundOf(late)).detail, "stale_question");
    assert.match(textOf(contentOf(repliesTo(late)[0]!)), /问题已经换了/);
    // 回的是这个任务的另一种卡（不是提问卡）：也不当答复。
    await db.insert(imOutbox).values({
      id: "row-tg-failed", channel: "feishu", appId: APP, receiveType: "open_id", receiveId: OWNER, recipientOpenId: OWNER,
      taskId: "tg", kind: "failed", subject: "f:old", msgType: "interactive", content: "{}", state: "resolved", messageId: "om_tg_failed",
      createdAt: at, updatedAt: at,
    });
    const offCard = await im.say({ text: "是", parentId: "om_tg_failed" });
    assert.equal((await inboundOf(offCard)).detail, "not_question_card");
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, "tg"))).at(0)!.question, "删除所有数据？");
    const right = await im.say({ text: "不要删", parentId: secondCard.messageId! });
    assert.equal((await inboundOf(right)).state, "done", "回在眼下这道题的卡下才是答复");
    assert.match((await db.select().from(tasks).where(eq(tasks.id, "tg"))).at(0)!.questionHistory ?? "", /不要删/);
    const after = await im.say({ text: "再补一句", parentId: secondCard.messageId! });
    assert.equal((await inboundOf(after)).detail, "stale_question", "答过的题再回不当答复");
    await waitIdle(() => statusOf("tg"), "paused");
  }

  // ── ③ 命令 ───────────────────────────────────────────────────────────────
  {
    const help = await im.say({ text: "/help" });
    const list = await im.say({ text: "/project" });
    const pick = await im.say({ text: "/project 1" });
    await im.settle();
    assert.match(textOf(contentOf(repliesTo(help)[0]!)), /\/todo/);
    assert.match(textOf(contentOf(repliesTo(list)[0]!)), /1\. 飞书项目/);
    assert.match(textOf(contentOf(repliesTo(pick)[0]!)), /已切到「飞书项目」/);
    assert.equal((await bindingOf(APP, OWNER))!.projectId, "p1");

    const create = await im.say({ text: "/new 修个 bug\n登录页点了没反应" });
    await im.settle();
    const confirmCard = contentOf(repliesTo(create)[0]!);
    assert.match(textOf(confirmCard), /修个 bug/);
    const confirm = buttonsOf(confirmCard).find((button) => button.value?.op === "confirm")!;
    assert.equal((await db.select().from(tasks).where(eq(tasks.title, "修个 bug"))).length, 0, "没点确定不建任务");
    const created = await im.click(OWNER, confirm.value!);
    assert.equal(created.toast?.type, "success", JSON.stringify(created));
    const newTask = (await db.select().from(tasks).where(eq(tasks.title, "修个 bug"))).at(0);
    assert.ok(newTask, "点确定才建任务");
    assert.equal(newTask!.projectId, "p1");
    assert.equal(newTask!.body, "登录页点了没反应");
    await waitIdle(() => statusOf(newTask!.id));

    const stopBare = await im.say({ text: "/stop" });
    const stopCard = await im.say({ text: "/stop", parentId: (await cardOf("tm"))?.messageId ?? (await db.select().from(imOutbox).where(eq(imOutbox.taskId, "tm"))).at(0)!.messageId! });
    await im.settle();
    assert.match(textOf(contentOf(repliesTo(stopBare)[0]!)), /回复某张任务卡片/);
    const cancel = buttonsOf(contentOf(repliesTo(stopCard)[0]!)).find((button) => button.value?.op === "cancel")!;
    const cancelled = await im.click(OWNER, cancel.value!);
    assert.match(textOf(cancelled.card?.data), /已取消/);

    const todo = await im.say({ text: "/todo" });
    const sticker = await im.say({ messageType: "sticker", content: { file_key: "x" } });
    await im.settle();
    assert.ok(repliesTo(todo).length === 1, "/todo 回一句");
    assert.match(textOf(contentOf(repliesTo(sticker)[0]!)), /只认文字、图片和文件/);
  }

  // ── ④ ⑤ 助手房间 + 附件 ─────────────────────────────────────────────────
  {
    const member = { id: "m-helper", name: "助手", agentType: "claude", executorId: null, model: null, reasoningEffort: null };
    await db.insert(chatRooms).values({ id: "room-web", projectId: "", ownerUserId: null, name: "网页助手", members: JSON.stringify([member]), kind: "assistant", createdAt: at });
    const hello = await im.say({ text: "帮我看看今天的任务" });
    const binding = (await bindingOf(APP, OWNER))!;
    assert.ok(binding.assistantRoomId && binding.assistantRoomId !== "room-web", "照模板建了一间新的助手房间");
    const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, binding.assistantRoomId!))).at(0)!;
    assert.equal(room.name, "飞书");
    assert.equal(room.kind, "assistant");
    const posted = (await db.select().from(chatMessages).where(eq(chatMessages.id, chatMessageIdOf(`msg:${hello}`)))).at(0);
    assert.ok(posted, "消息按飞书消息 id 派生的编号投进房间");
    assert.equal(posted!.body, "帮我看看今天的任务");
    // 同一条飞书消息再推一次（长连接重推）：只投一次。
    await im.inbound.handle({
      sender: { sender_id: { open_id: OWNER }, sender_type: "user" },
      message: { message_id: hello, chat_id: "oc_p2p", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "帮我看看今天的任务" }) },
    });
    assert.equal((await db.select().from(chatMessages).where(and(eq(chatMessages.roomId, room.id), eq(chatMessages.role, "user")))).length, 1);

    const photo = await im.say({ messageType: "image", content: { image_key: "img_v3_key" } });
    const photoRow = await inboundOf(photo);
    const paths = JSON.parse(photoRow.attachments ?? "[]") as string[];
    assert.equal(paths.length, 1, `图片转存了：${photoRow.detail}`);
    assert.ok(paths[0]!.startsWith(join(stage, "uploads")), "落在上传目录里");
    assert.equal(readdirSync(join(stage, "uploads")).length, 1);
    const photoMessage = (await db.select().from(chatMessages).where(eq(chatMessages.id, chatMessageIdOf(`msg:${photo}`)))).at(0)!;
    assert.ok(photoMessage.body.includes(paths[0]!), "附件路径随消息进了房间");

    // 执行器在测试里起不来（ASH_RUNS_DIR 拦下 spawn），回复以失败收尾 —— 照样要发回飞书。
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      await im.relay.poll();
      const rows = await db.select().from(imInbound).where(inArray(imInbound.id, [`msg:${hello}`, `msg:${photo}`]));
      if (rows.every((row) => row.state === "replied")) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await im.settle();
    assert.equal((await inboundOf(hello)).state, "replied");
    assert.equal(repliesTo(hello).length, 1, "回复回在用户那条消息下面");
    const agentRows = await db.select().from(chatMessages).where(and(eq(chatMessages.roomId, room.id), eq(chatMessages.role, "agent")));
    assert.ok(agentRows.every((row) => row.replyTo), "智能体回复都记着回应的是哪一条");
  }

  // ── ⑥ 群 ────────────────────────────────────────────────────────────────
  {
    const groupCode = await createBindCode("", "group", "p1");
    const claim = await im.say({ chatType: "group", chatId: "oc_team", text: groupCode.code, mentionBot: true });
    await im.settle();
    assert.match(textOf(contentOf(repliesTo(claim)[0]!)), /收到群绑定码/);
    const confirmed = await confirmGroupCode("", groupCode.codeId, APP, { canSeeProject: async () => true, admin: false });
    assert.equal(confirmed.ok, true);
    assert.equal((await groupOf(APP, "oc_team"))!.name, "研发群", "认领时查到的群名");
    const talk = await im.say({ chatType: "group", chatId: "oc_team", text: "今天谁在改登录页？", mentionBot: true });
    const talkRow = await inboundOf(talk);
    assert.equal(talkRow.kind, "group");
    const groupRoom = (await db.select().from(chatRooms).where(eq(chatRooms.id, talkRow.roomId!))).at(0)!;
    assert.equal(groupRoom.kind, "chat");
    assert.equal(groupRoom.projectId, "p1");
    const groupMessage = (await db.select().from(chatMessages).where(eq(chatMessages.id, chatMessageIdOf(`msg:${talk}`)))).at(0)!;
    assert.equal(groupMessage.body, "@助手 今天谁在改登录页？", "群聊房间里自动点名");
    assert.equal(JSON.parse(groupMessage.mentions).length, 1, "点到了成员");
  }

  // 收尾：等聊天回复都落定，停掉部件再关库。
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const busy = await db.select({ id: chatMessages.id }).from(chatMessages).where(inArray(chatMessages.status, ["queued", "running"]));
    if (!busy.length) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  im.relay.stop();
  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-inbound: ok");
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
