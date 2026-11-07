// 回给一次请求的业务内容（scope.ts requestScope）：命令回执、确认卡、/todo 清单、房间回复都按消息进来那一刻的
// 绑定实例盖，不按办完时的现状；正文列着的资源（/project 的项目、房间回复下面的任务）出口逐个现核。核不过
// 不发原文，换成一句固定说明（卡片也换成文字）。
//
// 钉住的几件事（多人模式，同一个飞书账号先绑 alice、办着的时候换绑给 bob）：
// ① /project 清单：取完列表、发出去之前换绑 —— 一个项目名都不发；什么都没变照发；
// ② /project 清单：取完列表之后被移出了其中一个项目（没换绑）—— 清单不发；
// ③ /project 名字：取完列表之后换绑 —— 不改新绑定的当前项目，说一句「刚换过绑定」；没换绑照常切；
//    项目选单：发卡之后换绑再点 —— 不改新绑定的当前项目；发卡之后被移出了那个项目再点 —— 不切；
// ④ /new 确认卡、/stop 确认卡、/todo 清单：办着的时候换绑 —— 原文不发，只发固定说明（bob 也看得见那个项目）；
// ⑤ 房间回复：下面列着的任务发出去之前看不到了 —— 回复不发；看得到照发、一个任务都没列也照发；旧版本投进房间的
//    （没记来源、或来源是办完才盖的）不按此刻的绑定补，回复和说明句都只发固定说明；
// ⑥ 旧版本落库、升级后还排着的发件行：没记列出的任务 / 项目 / 卡、没记是哪一次请求（确认卡、挂着任务的回执）——
//    缺了什么就当认不出什么，原文不发、只发固定说明，不当成「没有」放行。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-requests-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-requests");

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { chatMessages, chatRooms, projects, tasks } = await import("../src/db/schema.js");
  const { imBindings, imInbound, imOutbox } = await import("../src/db/schema-im.js");
  const { nanoid } = await import("nanoid");
  const { eq } = await import("drizzle-orm");
  const mode = await import("../src/auth/mode.js");
  const store = await import("../src/auth/store.js");
  const visibility = await import("../src/auth/visibility.js");
  const { bindingOf, unbindOwner } = await import("../src/im/binding.js");
  const { originOf, requestScope } = await import("../src/im/scope.js");
  const { APP, OWNER, FakeFeishu, buildApp, assemble, buttonsOf, contentOf } = await import("./im-fixture.js");

  await ensureSchema();
  const at = new Date().toISOString();
  const root = join(stage, "root");
  for (const dir of ["alice/pa", "bob/pq"]) mkdirSync(join(root, dir), { recursive: true });
  await mode.setInstanceMode("multi", root);
  const alice = await store.createUser({ name: "alice", role: "member", dirName: "alice", gitName: "A", gitEmail: "a@x", createdBy: null });
  const bob = await store.createUser({ name: "bob", role: "member", dirName: "bob", gitName: "B", gitEmail: "b@x", createdBy: alice.id });
  for (const user of [alice, bob]) await store.updateUser(user.id, { status: "active" });
  // pa 只有 alice 看得见；pq 两个人都看得见。
  await db.insert(projects).values([
    { id: "pa", name: "Alice 内部客户甲收购计划", repoPath: join(root, "alice", "pa"), apiKeys: null, createdAt: at, ownerUserId: alice.id },
    { id: "pq", name: "共享项目", repoPath: join(root, "bob", "pq"), apiKeys: null, createdAt: at, ownerUserId: bob.id },
  ] as never);
  const join_ = (projectId: string, userId: string) => visibility.addProjectMember({ projectId, userId, role: "member", addedBy: alice.id });
  await join_("pa", alice.id);
  await join_("pq", alice.id);
  await join_("pq", bob.id);
  await db.insert(tasks).values({
    id: "tq", projectId: "pq", title: "共享任务 Q", body: "", status: "paused", question: "要继续吗？",
    questionOptions: JSON.stringify(["要"]), createdAt: at, updatedAt: at, ownerUserId: alice.id,
  } as never);

  const app = buildApp();
  const fake = new FakeFeishu();
  const im = await assemble(app, fake);
  const dest = { receiveType: "open_id" as const, receiveId: OWNER, recipientOpenId: OWNER };
  const sentText = () => fake.sends().map((call) => JSON.stringify(contentOf(call))).join("\n");
  const repliesTo = (messageId: string) => fake.sends().filter((call) => call.path.includes(`/messages/${messageId}/reply`))
    .map((call) => JSON.stringify(contentOf(call))).join("\n");
  const WITHHELD = /这次操作的结果不在飞书里显示了（([^）]+)），请到 ash 网页查看。/;

  let generation = 0;
  /** 同一个飞书账号绑给 userId（每次都是新的一次绑定）。 */
  const bindTo = async (userId: string, projectId: string | null = null) => {
    await unbindOwner(alice.id);
    await unbindOwner(bob.id);
    await db.insert(imBindings).values({
      channel: "feishu", appId: APP, openId: OWNER, userId, projectId, boundAt: new Date(Date.now() + ++generation * 1_000).toISOString(),
    });
  };

  // 以他的身份读接口：读完、回到命令里之前停一下（读到的是 alice 那一次的数据）。
  let stall: { path: RegExp; reached: () => void; opened: Promise<void> } | null = null;
  const realGet = im.ash.get.bind(im.ash);
  im.ash.get = (async (who: never, path: `/api/${string}`) => {
    const result = await realGet(who, path);
    const held = stall;
    if (held?.path.test(path)) {
      stall = null;
      held.reached();
      await held.opened;
    }
    return result;
  }) as typeof im.ash.get;
  /** run 读到 path、停在那里时做 change，再放行。 */
  const during = async <T>(path: RegExp, run: () => Promise<T>, change: () => Promise<unknown>): Promise<T> => {
    let reached!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    stall = { path, reached, opened: new Promise<void>((resolve) => { release = resolve; }) };
    const pending = run();
    await arrived;
    await change();
    release();
    return pending;
  };
  const PROJECTS = /^\/api\/projects$/;

  // ── ① /project 清单：办着的时候换绑 ──────────────────────────────────────
  {
    await bindTo(alice.id);
    fake.reset();
    const kept = await during(PROJECTS, () => im.say({ text: "/project" }), async () => {});
    await im.settle();
    assert.match(repliesTo(kept), /Alice 内部客户甲收购计划/, "什么都没变：清单照发");
    assert.match(repliesTo(kept), /共享项目/);

    fake.reset();
    const switched = await during(PROJECTS, () => im.say({ text: "/project" }), () => bindTo(bob.id));
    await im.settle();
    assert.doesNotMatch(sentText(), /内部客户甲|共享项目/, "换绑给了 bob：alice 的项目清单一个字不发");
    assert.equal(WITHHELD.exec(repliesTo(switched))?.[1], "收件人已解绑或换了绑定", "只回一句固定说明");
  }

  // ── ② /project 清单：取完列表之后被移出了其中一个项目 ───────────────────
  {
    await bindTo(alice.id);
    fake.reset();
    const revoked = await during(PROJECTS, () => im.say({ text: "/project" }), () => visibility.removeProjectMember("pq", alice.id));
    await im.settle();
    assert.doesNotMatch(sentText(), /共享项目/, "列着的项目看不到了：清单不发");
    assert.equal(WITHHELD.exec(repliesTo(revoked))?.[1], "列出的某个项目已看不到了");
    await join_("pq", alice.id);
  }

  // ── ③ /project 名字：取完列表之后换绑 ────────────────────────────────────
  {
    await bindTo(alice.id);
    fake.reset();
    const switched = await during(PROJECTS, () => im.say({ text: "/project 共享项目" }), () => bindTo(bob.id));
    await im.settle();
    assert.equal((await bindingOf(APP, OWNER))!.projectId, null, "不改 bob 那一次绑定的当前项目");
    assert.match(repliesTo(switched), /你刚换过绑定，这次没切/);

    await bindTo(alice.id);
    fake.reset();
    const picked = await during(PROJECTS, () => im.say({ text: "/project 共享项目" }), async () => {});
    await im.settle();
    assert.equal((await bindingOf(APP, OWNER))!.projectId, "pq", "没换绑：照常切");
    assert.match(repliesTo(picked), /当前项目已切到「共享项目」/);

    const pickerFor = async () => {
      fake.reset();
      const message = await im.say({ text: "/project" });
      await im.settle();
      const reply = fake.sends().find((call) => call.path.includes(`/messages/${message}/reply`))!;
      return buttonsOf(contentOf(reply)).find((button) => button.text === "共享项目")!.value!;
    };
    await bindTo(alice.id);
    const stale = await pickerFor();
    await bindTo(bob.id);
    const voided = await im.click(OWNER, stale);
    assert.equal((await bindingOf(APP, OWNER))!.projectId, null, "选单发给 alice 那一次：换绑之后点，不改 bob 的当前项目");
    assert.doesNotMatch(JSON.stringify(voided), /已切到/, JSON.stringify(voided));

    await bindTo(alice.id);
    const revoked = await pickerFor();
    await visibility.removeProjectMember("pq", alice.id);
    const refused = await im.click(OWNER, revoked);
    assert.equal(refused.toast?.type, "error", JSON.stringify(refused));
    assert.equal((await bindingOf(APP, OWNER))!.projectId, null, "发卡之后被移出了那个项目：不切");
    await join_("pq", alice.id);
  }

  // ── ④ /new、/stop 确认卡、/todo 清单：办着的时候换绑 ─────────────────────
  {
    await bindTo(alice.id, "pq");
    await im.reconciler.run(() => im.reconciler.reconcile(["tq"]));
    await im.settle();
    const card = (await db.select().from(imOutbox).where(eq(imOutbox.taskId, "tq"))).find((row) => row.state === "sent");
    assert.ok(card?.messageId, "tq 的提问卡发给了 alice");

    fake.reset();
    const created = await during(PROJECTS, () => im.say({ text: "/new PRIVATE-NEW-TITLE\nPRIVATE-NEW-BODY" }), () => bindTo(bob.id, "pq"));
    await im.settle();
    assert.doesNotMatch(sentText(), /PRIVATE-NEW/, "/new：alice 打的确认卡不发给 bob");
    assert.equal(WITHHELD.exec(repliesTo(created))?.[1], "收件人已解绑或换了绑定", "/new：卡片换成固定说明");
    const confirm = (await db.select().from(imOutbox).where(eq(imOutbox.replyTo, created))).at(0)!;
    assert.equal(confirm.msgType, "text", "换成的是一句文字");
    assert.doesNotMatch(confirm.content, /PRIVATE-NEW/, "库里那份也换掉了");

    await bindTo(alice.id, "pq");
    fake.reset();
    const stopped = await during(/^\/api\/tasks\/tq$/, () => im.say({ text: "/stop", parentId: card!.messageId! }), () => bindTo(bob.id, "pq"));
    await im.settle();
    assert.doesNotMatch(repliesTo(stopped), /共享任务 Q/, "/stop：替 alice 出的确认卡不发给 bob");
    assert.equal(WITHHELD.exec(repliesTo(stopped))?.[1], "收件人已解绑或换了绑定");

    // /todo 不读接口：消息进来时是 alice，办之前换绑给 bob。
    await bindTo(alice.id, "pq");
    const binding = (await bindingOf(APP, OWNER))!;
    const ctx = {
      messageId: "om_todo", chatId: "oc_p2p", chatType: "p2p" as const, principal: { channel: "feishu" as const, appId: APP, openId: OWNER },
      binding, dest, card: null, origin: await originOf(APP, dest, binding),
    };
    await bindTo(bob.id, "pq");
    fake.reset();
    await im.commands.run(ctx, "todo", "");
    await im.settle();
    assert.doesNotMatch(repliesTo("om_todo"), /共享任务 Q/, "/todo：alice 的清单不发给 bob");
    assert.equal(WITHHELD.exec(repliesTo("om_todo"))?.[1], "收件人已解绑或换了绑定");
  }

  // ── ⑤ 房间回复下面列着的任务 ─────────────────────────────────────────────
  {
    await bindTo(alice.id);
    const binding = (await bindingOf(APP, OWNER))!;
    const origin = await originOf(APP, dest, binding);
    const member = { id: "m1", name: "助手", agentType: "claude", executorId: null, model: null, reasoningEffort: null };
    await db.insert(chatRooms).values({ id: "room-a", projectId: "", ownerUserId: alice.id, name: "飞书", members: JSON.stringify([member]), kind: "assistant", createdAt: at });
    /**
     * 房间里一问一答（linked：回复挂着 tq），在等回复的那一行投进来时按 scope 盖（null = 旧版本投的，没记）。
     * roomId 是不在的房间时只投那一行（等回复时读不到房间）。
     */
    const answered = async (n: number, scope: string | null, linked = true, roomId = "room-a") => {
      if (roomId === "room-a") {
        await db.insert(chatMessages).values([
          { id: `im-u${n}`, roomId, role: "user", author: "alice", body: `问 ${n}`, createdAt: new Date(Date.now() + n * 10).toISOString() },
          { id: `im-a${n}`, roomId, role: "agent", memberId: "m1", author: "助手", body: `ROOM-ANSWER-${n}`, taskId: linked ? "tq" : null, replyTo: `im-u${n}`, createdAt: new Date(Date.now() + n * 10 + 5).toISOString() },
        ]);
      }
      await db.insert(imInbound).values({
        id: `msg:om_room${n}`, channel: "feishu", appId: APP, openId: OWNER, chatId: "oc_p2p", chatType: "p2p", kind: "assistant",
        roomId, detail: `im-u${n}`, state: "sent", scope, createdAt: at, updatedAt: new Date().toISOString(),
      } as never);
    };
    const roomScope = JSON.stringify(requestScope(origin, { kind: "room", roomId: "room-a", projectId: null }));
    /** 旧版本投进房间时盖的（办完才按此刻的绑定盖、没有 request）：实例碰巧还对得上。 */
    const legacyScope = (roomId: string) => JSON.stringify({ kind: "room", roomId, projectId: null, bound: binding.boundAt });

    await answered(1, roomScope);
    fake.reset();
    await im.relay.poll();
    await im.settle();
    assert.match(repliesTo("om_room1"), /ROOM-ANSWER-1/, "看得到：回复照发");
    assert.match(repliesTo("om_room1"), /共享任务 Q/, "下面列着那个任务");

    await answered(2, roomScope);
    im.sender.stop();
    await im.relay.poll();
    await visibility.removeProjectMember("pq", alice.id);
    fake.reset();
    im.sender.start();
    await im.settle();
    assert.doesNotMatch(sentText(), /ROOM-ANSWER-2|共享任务 Q/, "列着的任务看不到了：回复不发");
    assert.equal(WITHHELD.exec(repliesTo("om_room2"))?.[1], "列出的某个任务已看不到了");
    await join_("pq", alice.id);

    await answered(3, null);
    await answered(4, roomScope, false);
    await answered(5, legacyScope("room-a"));
    await answered(6, legacyScope("room-legacy-gone"), true, "room-legacy-gone");
    fake.reset();
    await im.relay.poll();
    await im.settle();
    assert.match(repliesTo("om_room4"), /ROOM-ANSWER-4/, "一个任务都没列：照发（空清单照记）");
    assert.doesNotMatch(sentText(), /ROOM-ANSWER-3/, "旧版本投的、没记来源：不按此刻的绑定补一份照发");
    assert.equal(WITHHELD.exec(repliesTo("om_room3"))?.[1], "旧版本入队，没记下是哪一次请求");
    assert.doesNotMatch(sentText(), /ROOM-ANSWER-5/, "旧版本投的、办完才盖的来源：回复不发");
    assert.equal(WITHHELD.exec(repliesTo("om_room5"))?.[1], "旧版本入队，没记下是哪一次请求");
    assert.doesNotMatch(repliesTo("om_room6"), /没拿到回复：/, "旧版本投的：说明句也不拿它当请求进来那一刻");
    assert.equal(WITHHELD.exec(repliesTo("om_room6"))?.[1], "收件人已解绑或换了绑定");
  }

  // ── ⑥ 旧版本落库、升级后还排着的发件行 ─────────────────────────────────
  {
    await bindTo(alice.id);
    const binding = (await bindingOf(APP, OWNER))!;
    const origin = await originOf(APP, dest, binding);
    const bound = binding.boundAt;
    const by = origin.by;
    fake.reset();
    im.sender.stop();
    /** 照旧版本的样子排一句回执。 */
    const queue = (messageId: string, text: string, scope: unknown) =>
      im.commands.say({ messageId, dest }, text, scope as never);
    // 审查第 3 轮的复现：升级前积压的助手回复，房间还在、还归他，正文列着任务标题，来源里没有任务清单。
    await queue("om_legacy_room", "之前查询的结果\n· PRIVATE-LEGACY-ROOM", { kind: "room", roomId: "room-a", projectId: null, bound });
    // 新版本的样子、只是清单没记（投进房间时的那份底子原样发出去）。
    await queue("om_bare_room", "PRIVATE-BARE-ROOM", { kind: "room", roomId: "room-a", projectId: null, bound, by, request: true });
    await queue("om_bare_projects", "PRIVATE-BARE-PROJECTS", { kind: "projects", bound, by, request: true });
    await queue("om_bare_digest", "PRIVATE-BARE-DIGEST", { kind: "digest", bound, by, request: true });
    await queue("om_bare_reply", "PRIVATE-BARE-REPLY", { kind: "reply", bound, by, request: true });
    // 旧版本的 /stop 确认卡：按任务记、办完才盖的实例，没有 request（当成订阅者通知就不认实例了）。
    await im.reconciler.run(() => im.reconciler.insert({
      dest, taskId: null, kind: "confirm", subject: "om_legacy_confirm", replyTo: "om_legacy_confirm",
      content: JSON.stringify({ elements: [{ tag: "markdown", content: "停掉「共享任务 Q」？PRIVATE-LEGACY-CONFIRM" }] }),
      scope: { kind: "task", taskId: "tq", bound } as never,
    }));
    // 种类不是回执、来源却是只该由 requestScope 写的那几种：照样当旧版本办完才盖的。
    await im.reconciler.run(() => im.reconciler.insert({
      dest, taskId: null, kind: "notice", subject: "legacy:project", msgType: "text",
      content: JSON.stringify({ text: "PRIVATE-LEGACY-PROJECT" }), scope: { kind: "project", projectId: "pq", bound } as never,
    }));
    // 更早的版本：scope 列还没有，挂着任务的回执（taskId 只管回复路由）。
    await db.insert(imOutbox).values({
      id: nanoid(20), channel: "feishu", appId: APP, receiveType: "open_id", receiveId: OWNER, recipientOpenId: OWNER, taskId: "tq",
      kind: "reply", subject: "r:om_legacy_bare", msgType: "text", content: JSON.stringify({ text: "没答上：PRIVATE-LEGACY-NOSCOPE" }),
      replyTo: "om_legacy_bare", state: "pending", createdAt: at, updatedAt: at,
    } as never);
    im.sender.start();
    await im.settle();
    assert.doesNotMatch(sentText(), /PRIVATE-/, "旧版本落库的发件行：原文一条都不发");
    for (const [messageId, why] of [
      ["om_legacy_room", "旧版本入队，没记下是哪一次请求"],
      ["om_bare_room", "没记下列出的任务"],
      ["om_bare_projects", "没记下列出的项目"],
      ["om_bare_digest", "没记下列出的卡"],
      ["om_bare_reply", "没记下是哪个项目"],
      ["om_legacy_confirm", "旧版本入队，没记下是哪一次请求"],
      ["om_legacy_bare", "旧版本入队，没记下是哪一次请求"],
    ] as const) {
      assert.equal(WITHHELD.exec(repliesTo(messageId))?.[1], why, `${messageId}：只发固定说明`);
    }
    assert.equal((await db.select().from(imOutbox).where(eq(imOutbox.state, "pending"))).length, 0, "都落了结局，不卡在队列里");
  }

  im.relay.stop();
  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-requests: ok");
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
