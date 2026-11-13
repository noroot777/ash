// 新设备申请连进来 × 飞书配对卡（理由见 server/src/im/pairing.ts 文件头）。
//
// ① 递申请：机主的单聊收到一张卡，带着设备名、来源地址、配对码，「允许」带确认框；
// ② 点「允许」：申请获准（设备来领就进得来、名册里多一台），卡收成结果、不许再点第二遍；
// ③ 点「拒绝」：设备那边领到的是被拒绝；
// ④ 卡只认收件人本人：别的飞书账号点不动，申请还等着；
// ⑤ 网页上先处理了：卡收成「已在别处…」；拿着旧卡再点不改变任何事；
// ⑥ 申请到期：卡收起来；
// ⑦ 经飞书只放「允许 / 拒绝」这一条：名册、等着的申请、出码、请设备出去、换密钥一律 403；没绑定的账号连这一条也 403；
// ⑧ 发出之后换了绑定（解绑重绑、换了人绑）：出口不再放行，收卡时换成中性的收起卡；
// ⑨ 通道起来时按现状对：此刻等着、还没有卡的补上；
// ⑩ 点下按钮时 ash 重启（信封占着没结局）：照实说申请作废了，不说「重新发命令」；
// ⑪ 多人模式：不推卡，经飞书点也放不进设备。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-im-pairing-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-im-pairing");

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { imActions, imBindings, imOutbox } = await import("../src/db/schema-im.js");
  const { and, asc, eq } = await import("drizzle-orm");
  const { dispatchAsIm } = await import("../src/auth/im-actor.js");
  const mode = await import("../src/auth/mode.js");
  const { listDevices } = await import("../src/auth/remote-access.js");
  const { claimPairRequest, decidePairRequest, openPairRequest, pendingPairRequests, PAIR_REQUEST_TTL_MS } = await import("../src/auth/remote-pairing.js");
  const { ACTED } = await import("../src/im/reconcile.js");
  const { PairingCards, PAIR_KIND } = await import("../src/im/pairing.js");
  const { admit, scopeOfRow } = await import("../src/im/scope.js");
  const { APP, OWNER, FakeFeishu, buildApp, assemble, contentOf, textOf, buttonsOf } = await import("./im-fixture.js");

  await ensureSchema();
  const app = buildApp();
  const fake = new FakeFeishu();
  const im = await assemble(app, fake);
  let pairing = new PairingCards({ appId: APP, reconciler: im.reconciler });
  pairing.start();

  const at = new Date().toISOString();
  await db.insert(imBindings).values({ channel: "feishu", appId: APP, openId: OWNER, userId: null, boundAt: at });
  const cardsOf = (requestId: string) => db.select().from(imOutbox)
    .where(and(eq(imOutbox.kind, PAIR_KIND), eq(imOutbox.subject, requestId))).orderBy(asc(imOutbox.createdAt));
  /** 订阅回调是放手去办的：等到这张申请的卡落了库（或者确认它不会来）。 */
  const cardOf = async (requestId: string, expected = true) => {
    for (let i = 0; i < 40; i++) {
      const [row] = await cardsOf(requestId);
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, expected ? 50 : 10));
    }
    return null;
  };
  const fresh = async (id: string) => (await db.select().from(imOutbox).where(eq(imOutbox.id, id))).at(0)!;
  const button = (row: { content: string }, op: string) => buttonsOf(JSON.parse(row.content)).find((item) => item.value?.op === op)!;
  const apply = (name = "iPhone · Safari", address = "192.168.1.23") => openPairRequest({ name, address })!;
  const asIm = async (openId: string, method: "GET" | "POST" | "DELETE", path: `/api/${string}`) => {
    const res = await dispatchAsIm(app.fetch, { channel: "feishu", appId: APP, openId }, { method, path, ...(method === "GET" ? {} : { body: {} }) });
    return { status: res.status, text: await res.text() };
  };

  // ── ① 递申请 → 机主收到卡 ───────────────────────────────────────────────
  const first = apply();
  {
    const row = (await cardOf(first.id))!;
    assert.ok(row, "申请一递上来就有一张卡入队");
    assert.equal(row.receiveType, "open_id");
    assert.equal(row.receiveId, OWNER, "发到机主的单聊");
    assert.equal(row.taskId, null);
    assert.equal(scopeOfRow(row)?.kind, "instance", "授权来源：实例自己的事");
    await im.settle();
    const [sent] = fake.sends();
    assert.ok(sent, "卡发出去了");
    const said = textOf(contentOf(sent!));
    assert.match(said, /新设备想连接这台 ash/);
    assert.match(said, /iPhone · Safari/);
    assert.match(said, /192\.168\.1\.23/);
    assert.ok(said.includes(first.code), "卡上有配对码");
    const buttons = buttonsOf(contentOf(sent!));
    assert.deepEqual(buttons.map((item) => [item.text, item.value?.op, item.confirm]), [["允许", "approve", true], ["拒绝", "deny", false]]);
    assert.doesNotMatch(JSON.stringify(contentOf(sent!)), new RegExp(first.secret), "设备领结果用的 secret 不上卡");
    assert.equal((await cardsOf(first.id)).length, 1);
  }

  // ── ④ 别的飞书账号点不动 ────────────────────────────────────────────────
  {
    const row = (await cardOf(first.id))!;
    const other = await im.click("ou_stranger", button(row, "approve").value!);
    assert.match(other.toast?.content ?? "", /不是发给你的/);
    assert.equal(pendingPairRequests().length, 1, "申请还等着");
  }

  // ── ② 点「允许」 ────────────────────────────────────────────────────────
  {
    fake.reset();
    const row = (await cardOf(first.id))!;
    const done = await im.click(OWNER, button(row, "approve").value!);
    assert.match(textOf(done.card?.data), /已允许「iPhone · Safari」连接/, JSON.stringify(done));
    assert.equal(buttonsOf(done.card?.data).length, 0, "结果卡上没有按钮");
    assert.equal(pendingPairRequests().length, 0);
    await im.settle();
    const after = await fresh(row.id);
    assert.equal(after.state, "resolved");
    assert.equal(after.resolution, ACTED);
    assert.match(textOf(JSON.parse(after.content)), /已允许/, "别处处理的那一路没有把这张卡改成「已在别处」");
    assert.equal(listDevices().length, 0, "设备还没来领，名册里不多出一台");
    const claim = claimPairRequest(first.id, first.secret, "192.168.1.23");
    assert.equal(claim.status, "approved");
    assert.equal(listDevices().length, 1);
    assert.equal(listDevices()[0]!.via, "approval");
    const again = await im.click(OWNER, button(row, "approve").value!);
    assert.match(again.toast?.content ?? "", /已经处理过了/);
  }

  // ── ③ 点「拒绝」 ────────────────────────────────────────────────────────
  {
    const ticket = apply("Mac · Chrome", "192.168.1.40");
    const row = (await cardOf(ticket.id))!;
    const done = await im.click(OWNER, button(row, "deny").value!);
    assert.match(textOf(done.card?.data), /已拒绝/);
    assert.equal(claimPairRequest(ticket.id, ticket.secret, "192.168.1.40").status, "denied");
    assert.equal(listDevices().length, 1, "拒绝了就不登记设备");
    const bogus = await im.click(OWNER, { ...button((await cardOf(apply("x", "10.0.0.9").id))!, "approve").value!, op: "confirm" });
    assert.match(bogus.toast?.content ?? "", /认不出这个按钮/);
    for (const request of pendingPairRequests()) decidePairRequest(request.id, false);
    await im.settle();
  }

  // ── ⑤ 网页上先处理了 ────────────────────────────────────────────────────
  {
    const ticket = apply("iPad · Safari", "192.168.1.50");
    const row = (await cardOf(ticket.id))!;
    await im.settle();
    fake.reset();
    const web = await app.fetch(new Request(`http://127.0.0.1:4317/api/remote-access/requests/${ticket.id}/approve`, { method: "POST" }));
    assert.equal(web.status, 200, `本机页面上点允许：${await web.clone().text()}`);
    await im.settle();
    const after = await fresh(row.id);
    assert.equal(after.state, "resolved");
    assert.match(textOf(JSON.parse(after.content)), /已在别处允许这台设备连接/);
    assert.equal(buttonsOf(JSON.parse(after.content)).length, 0);
    assert.equal(fake.patches().length, 1, "发出去的那张卡改成了收好的样子");
    // 旧卡（飞书客户端上还没刷新）再点：申请已经不在等着，什么都不改。
    const late = await im.click(OWNER, button(row, "deny").value!);
    assert.match(textOf(late.card?.data), /已经过期，或者在别处处理过了/, JSON.stringify(late));
    assert.equal(claimPairRequest(ticket.id, ticket.secret, "192.168.1.50").status, "approved", "先到的那个决定算数");
    assert.equal(listDevices().length, 2);
  }

  // ── ⑥ 申请到期 ──────────────────────────────────────────────────────────
  {
    const ticket = apply("Android · Chrome", "192.168.1.60");
    const row = (await cardOf(ticket.id))!;
    await im.settle();
    assert.equal((await fresh(row.id)).state, "sent");
    const envelope = (await db.select().from(imActions).where(eq(imActions.outboxId, row.id))).at(0)!;
    assert.ok(Date.parse(envelope.expiresAt) - Date.now() <= PAIR_REQUEST_TTL_MS, "按钮和申请一起过期");
    assert.equal(pendingPairRequests(Date.now() + PAIR_REQUEST_TTL_MS + 1).length, 0);
    await pairing.settle();
    await im.settle();
    const after = await fresh(row.id);
    assert.equal(after.state, "resolved");
    assert.match(textOf(JSON.parse(after.content)), /这张申请失效了/);
  }

  // ── ⑦ 经飞书只放「允许 / 拒绝」 ─────────────────────────────────────────
  {
    for (const [method, path] of [
      ["GET", "/api/remote-access"], ["GET", "/api/remote-access/requests"], ["POST", "/api/remote-access/pair-code"],
      ["DELETE", `/api/remote-access/devices/${listDevices()[0]!.id}`], ["POST", "/api/remote-access/rotate"],
      ["POST", "/api/auth/pair"], ["POST", "/api/auth/pair/redeem"],
    ] as const) {
      const res = await asIm(OWNER, method, path);
      assert.equal(res.status, 403, `${method} ${path} 不该经飞书放行：${res.status} ${res.text}`);
    }
    assert.equal(listDevices().length, 2, "名册没被动过");
    const ticket = apply("Linux · Firefox", "192.168.1.70");
    const stranger = await asIm("ou_stranger", "POST", `/api/remote-access/requests/${ticket.id}/approve`);
    assert.equal(stranger.status, 403, "没绑定的账号放不进设备");
    assert.equal(pendingPairRequests().length, 1);
    const gone = await asIm(OWNER, "POST", "/api/remote-access/requests/nope/approve");
    assert.equal(gone.status, 404);
    const owner = await asIm(OWNER, "POST", `/api/remote-access/requests/${ticket.id}/deny`);
    assert.equal(owner.status, 200, owner.text);
    await im.settle();
  }

  // ── ⑧ 发出之后换了绑定 ──────────────────────────────────────────────────
  {
    const ticket = apply("Windows · Edge", "192.168.1.80");
    const row = (await cardOf(ticket.id))!;
    await im.settle();
    assert.equal((await admit(APP, row, [])).ok, true);
    await db.update(imBindings).set({ boundAt: new Date(Date.now() + 1000).toISOString() }).where(eq(imBindings.openId, OWNER));
    const verdict = await admit(APP, row, []);
    assert.equal(verdict.ok, false, "入队时的那一次绑定已经不在：过不了出口");
    assert.match(verdict.ok ? "" : verdict.why, /换了绑定/);
    decidePairRequest(ticket.id, false);
    await im.settle();
    const after = await fresh(row.id);
    assert.equal(after.state, "resolved");
    assert.match(textOf(JSON.parse(after.content)), /这张卡已收起/, "改卡时出口再核：换成中性的收起卡，不把处理结果告诉后来绑上的人");
  }

  // ── ⑨ 通道起来时按现状对 ────────────────────────────────────────────────
  {
    pairing.stop();
    const ticket = apply("Mac · Safari", "192.168.1.90");
    assert.equal(await cardOf(ticket.id, false), null, "通道没在跟着：不入队");
    pairing = new PairingCards({ appId: APP, reconciler: im.reconciler });
    pairing.start();
    const row = (await cardOf(ticket.id))!;
    assert.ok(row, "通道起来时补上这张卡");
    await im.settle();
    assert.equal((await fresh(row.id)).state, "sent");

    // ── ⑩ 点下按钮时 ash 重启 ─────────────────────────────────────────────
    const envelope = (await db.select().from(imActions).where(eq(imActions.outboxId, row.id))).at(0)!;
    await db.update(imActions).set({ usedAt: new Date().toISOString(), claimedBy: "上一次运行" }).where(eq(imActions.id, envelope.id));
    // 申请不在了（重启丢了内存里的申请），可这张卡上的那一下还没结局：收卡这一路不碰它，留给接管。
    assert.equal(pendingPairRequests(Date.now() + PAIR_REQUEST_TTL_MS + 1).length, 0);
    await pairing.settle();
    assert.equal((await fresh(row.id)).state, "sent", "正被点着的卡不由收卡这一路改");
    assert.equal(await im.actions.recover(), 1);
    const after = await fresh(row.id);
    assert.equal(after.state, "resolved");
    assert.match(textOf(JSON.parse(after.content)), /这张申请作废了：在那台设备上重新打开 ash 再申请一次/);
    assert.doesNotMatch(textOf(JSON.parse(after.content)), /重新发命令/);
    await im.settle();
  }

  // ── ⑪ 多人模式 ──────────────────────────────────────────────────────────
  {
    const held = apply("iPhone · Chrome", "192.168.1.99");
    const row = (await cardOf(held.id))!;
    const root = join(stage, "root");
    mkdirSync(root, { recursive: true });
    await mode.setInstanceMode("multi", root);
    assert.equal((await admit(APP, row, [])).ok, false, "转成多人模式之后，排着的配对卡过不了出口");
    const ticket = apply("iPad · Chrome", "192.168.1.98");
    assert.equal(await cardOf(ticket.id, false), null, "多人模式不推配对卡");
    const res = await asIm(OWNER, "POST", `/api/remote-access/requests/${ticket.id}/approve`);
    assert.notEqual(res.status, 200, "多人模式下经飞书放不进设备");
    assert.ok(pendingPairRequests().some((request) => request.id === ticket.id), "申请没被动过");
  }

  pairing.stop();
  im.reconciler.stop();
  im.sender.stop();
  console.log("test-im-pairing: ok");
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
