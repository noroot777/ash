// 飞书里发来的消息：绑定码、没绑定的人、群里 @、回复任务卡、斜杠命令、附件、助手房间与群聊房间的来回。
//
// 钉住的几件事（理由见 server/src/im/inbound.ts、commands.ts、relay.ts 的文件头）：
// ① 绑定码：单聊里发个人码 → 认领、回一句「回网页确认」；没绑定的人单聊只提示一次，群里不出声；
//    群里没 @ 机器人的话一律不理；
// ② 回复任务卡：此刻在等答复就是答复（多题按题号拆）；直接回复不是提问的卡不发给任务、告诉他用 /reply，
//    以 /reply 开头的才发给任务；收到点个表情；
//    答复只认那张卡自己问的那一次：回旧提问卡、回别的卡都不答到眼下这道题上（带附件也一样）；
//    回眼下这道题的卡带附件也是答复，附件跟着答复走；答复送到接口那一刻同一道题已经又问了一次
//    （题面一模一样）→ 接口按那一次的身份拒收；回在机器人自己的文字回执下面，认话题根上那张卡；
// ③ 命令：/help /project（回一张项目选单，点一下就切；点过的卡不能再点）/project 编号
//    /new（先确认，点确定才建任务并开跑）/new 不带参数（表单卡：选项目、填标题和要求，提交就建任务并开跑；
//    没填标题不建、表单还能再提交）/stop（先确认，取消就不停）/todo；
//    不认识的消息类型回一句说明；
// ④ 助手房间：单聊里直接说话 → 照最近一间助手房间的配置建一间「飞书」，投进去；回复按 reply_to
//    对上、发回飞书（回在用户那条消息下面）；同一条飞书消息重复推送只投一次；
// ⑤ 附件：图片下载 → 转存进上传目录 → 路径随消息投进房间；
// ⑥ 群：在群里 @ 机器人发群码 → 认领（带群名）→ 确认 → 群里 @ 机器人说话进项目群聊房间，
//    自动补上 @成员名（群聊房间里不点名没人答）；
// ⑦ 项目多到一张卡放不下：/project 选单、/new 表单上当前项目照样点得到、选得到，卡上说出还有几个没列出、怎么选到。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
  const { projects, tasks, uploads: uploadRows } = await import("../src/db/schema.js");
  const { chatMessages, chatRooms } = await import("../src/db/schema-chat.js");
  const { imBindings, imInbound, imOutbox } = await import("../src/db/schema-im.js");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { bindingOf, bindingView, createBindCode, rejectCode } = await import("../src/im/binding.js");
  const { confirmGroupCode, groupOf } = await import("../src/im/groups.js");
  const { chatMessageIdOf } = await import("../src/im/relay.js");
  const { AshClient } = await import("../src/im/ash-client.js");
  const { InboundRouter } = await import("../src/im/inbound.js");
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
  const uploads = () => existsSync(join(stage, "uploads")) ? readdirSync(join(stage, "uploads")).length : 0;

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
    const implicit = await im.say({ text: "换个思路再试", parentId: failedCard.messageId! });
    await im.settle();
    assert.equal((await inboundOf(implicit)).detail, "not_question_card", "直接回复失败卡不发给任务");
    assert.match(textOf(contentOf(repliesTo(implicit)[0]!)), /以 \/reply 开头/, "告诉他怎么捎话");
    assert.equal(await statusOf("tf"), "failed", "任务没被续上");
    const nudge = await im.say({ text: "/reply 换个思路再试", parentId: failedCard.messageId! });
    const nudgeRow = await inboundOf(nudge);
    assert.equal(nudgeRow.kind, "reply");
    assert.equal(nudgeRow.state, "done", `明说 /reply 的才发给任务：${nudgeRow.detail}`);
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

    // 发给任务的消息会清掉眼下的提问 —— 回旧卡、回别的卡带图也得先拦下。
    await db.insert(tasks).values(task({ id: "th", title: "带图回旧卡", status: "paused", question: "选 A 还是 B？" }) as never);
    await im.reconciler.reconcile(["th"]);
    await im.settle();
    const oldCard = await cardOf("th");
    await db.update(tasks).set({ question: "那 C 呢？", updatedAt: new Date().toISOString() }).where(eq(tasks.id, "th"));
    await im.reconciler.reconcile(["th"]);
    await im.settle();
    const newCard = await cardOf("th");
    assert.notEqual(newCard.id, oldCard.id);
    const questionOf = async () => (await db.select().from(tasks).where(eq(tasks.id, "th"))).at(0)!.question;
    const stalePhoto = await im.say({ messageType: "image", content: { image_key: "img_stale" }, parentId: oldCard.messageId! });
    assert.equal((await inboundOf(stalePhoto)).detail, "stale_question", "旧卡下带图也不当消息发");
    assert.equal(await questionOf(), "那 C 呢？", "眼下这道题没被清掉");
    await db.insert(imOutbox).values({
      id: "row-th-failed", channel: "feishu", appId: APP, receiveType: "open_id", receiveId: OWNER, recipientOpenId: OWNER,
      taskId: "th", kind: "failed", subject: "f:old", msgType: "interactive", content: "{}", state: "resolved", messageId: "om_th_failed",
      createdAt: at, updatedAt: at,
    });
    const offPhoto = await im.say({ messageType: "image", content: { image_key: "img_off" }, parentId: "om_th_failed" });
    assert.equal((await inboundOf(offPhoto)).detail, "not_question_card", "别的卡下带图也不当消息发");
    assert.equal(await questionOf(), "那 C 呢？");
    // 回在机器人的文字回执下面（父消息是那条回执，话题根是眼下这张提问卡）：认根上的卡，照常是答复。
    await db.insert(imOutbox).values({
      id: "row-th-ack", channel: "feishu", appId: APP, receiveType: "open_id", receiveId: OWNER, recipientOpenId: OWNER,
      taskId: "th", kind: "reply", subject: "ack:th", msgType: "text", content: JSON.stringify({ text: "没办成" }), state: "sent",
      messageId: "om_th_ack", replyTo: newCard.messageId, createdAt: at, updatedAt: at,
    });
    const threaded = await im.say({ text: "选 C", parentId: "om_th_ack", rootId: newCard.messageId! });
    assert.equal((await inboundOf(threaded)).kind, "answer", `话题里的回复认根上的提问卡：${(await inboundOf(threaded)).detail}`);
    assert.equal(await questionOf(), null);
    await waitIdle(() => statusOf("th"), "paused");

    // 回眼下这道题的卡、只发了一张图：照样是答复，附件跟着答复进那一轮。
    await db.insert(tasks).values(task({ id: "ti", title: "带图答复", status: "paused", question: "发张截图？" }) as never);
    await im.reconciler.reconcile(["ti"]);
    await im.settle();
    const shot = await im.say({ messageType: "image", content: { image_key: "img_answer" }, parentId: (await cardOf("ti")).messageId! });
    assert.equal((await inboundOf(shot)).kind, "answer", `带图回提问卡是答复：${(await inboundOf(shot)).detail}`);
    const ti = (await db.select().from(tasks).where(eq(tasks.id, "ti"))).at(0)!;
    assert.equal(ti.question, null);
    assert.match(ti.questionHistory ?? "", /见附件/);
    await waitIdle(() => statusOf("ti"), "paused");
    assert.equal((await db.select().from(uploadRows).where(eq(uploadRows.taskId, "ti"))).length, 1, "附件跟着答复归到这个任务");

    // 答复送到接口的那一刻，同一道题已经答过、又一字不差地问了一次：按发卡时那一次核，不答到新的这次上。
    await db.insert(tasks).values(task({ id: "tj", title: "同题再问", status: "paused", question: "继续吗？" }) as never);
    await im.reconciler.reconcile(["tj"]);
    await im.settle();
    const tjCard = await cardOf("tj");
    const reasked = new AshClient(async (request: Request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/tasks/tj/answer")) {
        await db.update(tasks).set({
          questionHistory: JSON.stringify([{ id: "h1", question: "继续吗？", answer: "早先答过", answeredAt: at, reply: "【答复】早先答过" }]),
        }).where(eq(tasks.id, "tj"));
      }
      return app.fetch(request);
    });
    const racer = new InboundRouter({
      appId: APP, api: im.api, ash: reasked, commands: im.commands, relay: im.relay, reconciler: im.reconciler, botOpenId: () => "ou_bot",
    });
    await racer.handle({
      sender: { sender_id: { open_id: OWNER }, sender_type: "user" },
      message: {
        message_id: "om_race", chat_id: "oc_p2p", chat_type: "p2p", parent_id: tjCard.messageId!, root_id: tjCard.messageId!,
        message_type: "image", content: JSON.stringify({ image_key: "img_race" }),
      },
    });
    await im.settle();
    assert.equal((await inboundOf("om_race")).state, "failed", "旧那一次的答复不落到新这一次上");
    const tj = (await db.select().from(tasks).where(eq(tasks.id, "tj"))).at(0)!;
    assert.equal(tj.question, "继续吗？", "新这一次还在等答复");
    assert.equal((JSON.parse(tj.questionHistory!) as unknown[]).length, 1);
    assert.match(textOf(contentOf(repliesTo("om_race")[0]!)), /没答上/);
  }

  // ── ③ 命令 ───────────────────────────────────────────────────────────────
  {
    const help = await im.say({ text: "/help" });
    const list = await im.say({ text: "/project" });
    await im.settle();
    assert.match(textOf(contentOf(repliesTo(help)[0]!)), /\/todo/);
    const picker = contentOf(repliesTo(list)[0]!);
    assert.match(textOf(picker), /当前：未指定/);
    const option = buttonsOf(picker).find((button) => button.text === "飞书项目");
    assert.equal(option?.value?.op, "pick", "每个项目一颗按钮");
    assert.equal((await bindingOf(APP, OWNER))!.projectId, null, "没点不切");
    const chosen = await im.click(OWNER, option!.value!);
    assert.equal(chosen.toast?.type, "success", JSON.stringify(chosen));
    assert.match(textOf(chosen.card?.data), /已切到「飞书项目」/);
    assert.equal(buttonsOf(chosen.card?.data).length, 0, "切完卡收起来，不留按钮");
    assert.equal((await bindingOf(APP, OWNER))!.projectId, "p1", "点一下就切");
    assert.match((await im.click(OWNER, option!.value!)).toast?.content ?? "", /已经处理过了/, "点过的卡不能再点");

    await db.update(imBindings).set({ projectId: null }).where(eq(imBindings.openId, OWNER));
    const pick = await im.say({ text: "/project 1" });
    await im.settle();
    assert.match(textOf(contentOf(repliesTo(pick)[0]!)), /已切到「飞书项目」/, "编号照样能切");
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

    const formCommand = await im.say({ text: "/new" });
    await im.settle();
    const form = contentOf(repliesTo(formCommand)[0]!);
    const select = JSON.stringify(form).match(/"tag":"select_static".*?"initial_option":"(\d+)"/);
    assert.equal(select?.[1], "0", "下拉框默认选当前项目");
    assert.match(textOf(form), /飞书项目/);
    const submit = buttonsOf(form).find((button) => button.value?.op === "submit")!;
    const blank = await im.click(OWNER, submit.value!, { project: "0", title: " ", body: "" }, "submit");
    assert.equal(blank.toast?.type, "warning", "没填标题不建");
    const submitted = await im.click(OWNER, submit.value!, { project: "0", title: "表单建的任务", body: "从卡片上填的要求" }, "submit");
    assert.equal(submitted.toast?.type, "success", JSON.stringify(submitted));
    assert.match(textOf(submitted.card?.data), /已建任务「表单建的任务」并开跑/);
    const formTask = (await db.select().from(tasks).where(eq(tasks.title, "表单建的任务"))).at(0);
    assert.equal(formTask?.projectId, "p1", "建在表单上选的项目");
    assert.equal(formTask?.body, "从卡片上填的要求");
    await waitIdle(() => statusOf(formTask!.id));
    assert.match((await im.click(OWNER, submit.value!, { project: "0", title: "再交一次" }, "submit")).toast?.content ?? "", /已经处理过了/, "提交过的表单不能再交");

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

    const uploadsBefore = uploads();
    const photo = await im.say({ messageType: "image", content: { image_key: "img_v3_key" } });
    const photoRow = await inboundOf(photo);
    const paths = JSON.parse(photoRow.attachments ?? "[]") as string[];
    assert.equal(paths.length, 1, `图片转存了：${photoRow.detail}`);
    assert.ok(paths[0]!.startsWith(join(stage, "uploads")), "落在上传目录里");
    assert.equal(uploads(), uploadsBefore + 1);
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

  // ── ⑦ 项目多到一张卡放不下 ────────────────────────────────────────────────
  {
    const many = Array.from({ length: 105 }, (_, index) => {
      const id = `pm${String(index).padStart(3, "0")}`;
      mkdirSync(join(stage, "repos", id), { recursive: true });
      return { id, name: `批量项目 ${id}`, repoPath: join(stage, "repos", id), apiKeys: null, createdAt: at };
    });
    await db.insert(projects).values(many as never);
    const order = await im.ash.get<{ id: string; name: string }[]>({ channel: "feishu", appId: APP, openId: OWNER }, "/api/projects");
    assert.ok(order.ok && order.data.length === 106, "106 个项目都看得见");
    const last = order.data.at(-1)!;
    await db.update(imBindings).set({ projectId: last.id }).where(eq(imBindings.openId, OWNER));

    const list = await im.say({ text: "/project" });
    const form = await im.say({ text: "/new" });
    await im.settle();
    const picker = contentOf(repliesTo(list)[0]!);
    assert.equal(buttonsOf(picker).length, 30, "选单一张卡放 30 个");
    const option = buttonsOf(picker).find((button) => button.text === last.name);
    assert.ok(option, "排在最后的当前项目照样有按钮");
    assert.match(textOf(picker), /还有 76 个项目没列出：发 \/project 名字 切过去/);
    assert.match(textOf((await im.click(OWNER, option!.value!)).card?.data), new RegExp(`已切到「${last.name}」`));

    const card = contentOf(repliesTo(form)[0]!);
    const parsed = JSON.parse(JSON.stringify(card).match(/"options":(\[.*?\])/)![1]!) as { text: { content: string }; value: string }[];
    assert.equal(parsed.length, 100, "下拉框放 100 个");
    const initial = /"initial_option":"(\d+)"/.exec(JSON.stringify(card))?.[1];
    assert.equal(parsed.find((entry) => entry.value === initial)?.text.content, last.name, "默认选中的就是排在最后的当前项目");
    assert.match(textOf(card), /还有 6 个项目没列出：先发 \/project 名字 把它设成当前项目，再发 \/new/);
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
