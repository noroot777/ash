// 飞书通道的「线」这一层：长连接帧编解码、分片合并与回执、REST 调用的 token 与额度闸、月额度
// 计数与降级、消息正文解析、文本脱敏、命令与绑定码识别。一个真飞书都不连：接入点、WebSocket、
// REST 全用假的（方案见 docs/feishu-integration.md）。
//
// 钉住的几件事：
// ① 帧：编码再解码逐字段相同（含 bigint seqId、空 payload）；
// ② 长连接：分片按 message_id 合并、只在收齐后回执一次；回执原样带回帧头并附 biz_rt，
//    payload 是 {code:200,data:base64(onEvent 的返回)}；onEvent 抛错回 500；旧连接迟到的帧丢弃；
//    接入点鉴权失败停在 failed（不无限重试）；处理期间连接断了，回执不发到新连接上、报给 onAckLost；
// ③ REST：token 缓存复用；被额度闸拦下的调用不发请求、标成 quota blocked；token 失效换一次重试；
//    下载回来的文件哪怕是 JSON 类型也是文件本身，只有错误包装才按错误算；
// ④ 额度：70/90/99% 三道线各砍掉该砍的用途；计数落库、重读接得上；北京时间跨月清零；
// ⑤ 消息解析 / 脱敏 / 命令 / 绑定码 / 多题答复按题号拆。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-im-wire-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const tick = () => new Promise((resolve) => setImmediate(resolve));

let failure: unknown = null;
try {
  const { ensureSchema } = await import("../src/db/index.js");
  await ensureSchema();
  const { decodeFrame, encodeFrame, FRAME_CONTROL, FRAME_DATA, headerOf } = await import("../src/im/feishu/frame.js");
  const { FeishuWsClient } = await import("../src/im/feishu/ws-client.js");
  const { FeishuApi, isQuotaBlocked } = await import("../src/im/feishu/api.js");
  const { QuotaMeter, levelOf, monthOf, purposeAllowed } = await import("../src/im/quota.js");
  const { parseMessage } = await import("../src/im/feishu/message.js");
  const { scrubText, scrubTitle } = await import("../src/im/scrub.js");
  const { parseCommand } = await import("../src/im/commands.js");
  const { extractCode } = await import("../src/im/binding.js");
  const { splitNumberedAnswers } = await import("../src/im/inbound.js");
  const { callbackOf } = await import("../src/im/channel.js");

  // ── ① 帧编解码 ─────────────────────────────────────────────────────────────
  {
    const frame = {
      seqId: 9007199254740993n, logId: 42n, service: 7, method: FRAME_DATA,
      headers: [{ key: "type", value: "event" }, { key: "message_id", value: "m-中文" }],
      payloadEncoding: "", payloadType: "", payload: new TextEncoder().encode('{"a":1}'), logIdNew: "x",
    };
    const back = decodeFrame(encodeFrame(frame));
    assert.equal(back.seqId, frame.seqId);
    assert.equal(back.logId, frame.logId);
    assert.equal(back.service, 7);
    assert.equal(back.method, FRAME_DATA);
    assert.equal(headerOf(back, "message_id"), "m-中文");
    assert.equal(new TextDecoder().decode(back.payload!), '{"a":1}');
    const ping = decodeFrame(encodeFrame({ seqId: 0n, logId: 0n, service: 1, method: FRAME_CONTROL, headers: [{ key: "type", value: "ping" }] }));
    assert.equal(ping.method, FRAME_CONTROL);
    assert.equal(ping.payload === undefined || ping.payload.length === 0, true);
  }

  // ── ② 长连接 ──────────────────────────────────────────────────────────────
  type Listener = (ev: any) => void;
  class FakeSocket {
    binaryType = "";
    readyState = 0;
    sent: Uint8Array[] = [];
    private listeners = new Map<string, Listener[]>();
    constructor(readonly url: string) {}
    send(data: Uint8Array) { this.sent.push(data); }
    close() { this.readyState = 3; this.emit("close", {}); }
    addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
    emit(type: string, ev: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(ev); }
    open() { this.readyState = 1; this.emit("open", {}); }
    deliver(frame: Parameters<typeof encodeFrame>[0]) { this.emit("message", { data: encodeFrame(frame).slice().buffer }); }
  }
  const endpointOk = async () => new Response(JSON.stringify({
    code: 0, data: { URL: "wss://fake.feishu/ws?service_id=33", ClientConfig: { PingInterval: 90 } },
  }), { headers: { "content-type": "application/json" } });
  const sockets: FakeSocket[] = [];
  const timers: (() => void)[] = [];
  const handled: unknown[] = [];
  const lost: { eventId: string; result: unknown }[] = [];
  let respond: (event: unknown) => unknown = () => ({ toast: { type: "success", content: "ok" } });
  const ws = new FeishuWsClient({
    appId: "cli_test0000", appSecret: "s", domain: "https://open.fake",
    onEvent: (envelope) => { handled.push(envelope); return respond(envelope); },
    onAckLost: (envelope, result) => { lost.push({ eventId: envelope.eventId, result }); },
    deps: {
      fetch: endpointOk as typeof fetch,
      createSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket as never; },
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      random: () => 0,
    },
  });
  ws.start();
  for (let i = 0; i < 5 && !sockets.length; i++) await tick();
  assert.equal(sockets.length, 1, "拉到接入点后建一条连接");
  const first = sockets[0]!;
  first.open();
  assert.equal(ws.getStatus().state, "connected");
  const pingFrame = decodeFrame(first.sent[0]!);
  assert.equal(pingFrame.method, FRAME_CONTROL);
  assert.equal(pingFrame.service, 33, "service_id 从接入点 URL 里取");
  assert.equal(headerOf(pingFrame, "type"), "ping");

  const body = JSON.stringify({
    schema: "2.0",
    header: { event_id: "ev-1", event_type: "card.action.trigger", create_time: "1", app_id: "cli_test0000" },
    event: { operator: { open_id: "ou_a" }, action: { value: { e: "env", op: "accept" }, form_value: { a0: "x" }, name: "submit" } },
  });
  const bytes = new TextEncoder().encode(body);
  const half = Math.floor(bytes.length / 2);
  const part = (seq: number, payload: Uint8Array) => ({
    seqId: 5n, logId: 6n, service: 33, method: FRAME_DATA,
    headers: [{ key: "type", value: "event" }, { key: "message_id", value: "msg-1" }, { key: "sum", value: "2" }, { key: "seq", value: String(seq) }],
    payload,
  });
  first.deliver(part(1, bytes.slice(half)));
  await tick();
  assert.equal(handled.length, 0, "分片没收齐不交给上层");
  assert.equal(first.sent.length, 1, "没收齐也不回执");
  first.deliver(part(0, bytes.slice(0, half)));
  for (let i = 0; i < 5 && first.sent.length < 2; i++) await tick();
  assert.equal(handled.length, 1, "收齐后合并成一个事件交给上层");
  const envelope = handled[0] as { eventId: string; eventType: string; event: Record<string, unknown> };
  assert.equal(envelope.eventId, "ev-1");
  assert.equal(envelope.eventType, "card.action.trigger");
  const ack = decodeFrame(first.sent[1]!);
  assert.equal(ack.seqId, 5n, "回执原样带回帧头");
  assert.equal(headerOf(ack, "message_id"), "msg-1");
  assert.ok(headerOf(ack, "biz_rt") !== undefined, "回执带处理耗时");
  const ackBody = JSON.parse(new TextDecoder().decode(ack.payload!)) as { code: number; data: string };
  assert.equal(ackBody.code, 200);
  assert.deepEqual(JSON.parse(Buffer.from(ackBody.data, "base64").toString()), { toast: { type: "success", content: "ok" } });

  // 卡片回调的事件体 → CallbackEvent。
  const callback = callbackOf(envelope as never);
  assert.deepEqual(callback, { eventId: "ev-1", operatorOpenId: "ou_a", value: { e: "env", op: "accept" }, formValue: { a0: "x" }, name: "submit" });
  assert.equal(callbackOf({ eventId: "x", eventType: "card.action.trigger", event: {} }), null, "没有操作人就不处理");

  respond = () => { throw new Error("boom"); };
  first.deliver({ ...part(0, bytes), headers: [{ key: "type", value: "event" }, { key: "message_id", value: "msg-2" }] });
  for (let i = 0; i < 5 && first.sent.length < 3; i++) await tick();
  assert.equal(JSON.parse(new TextDecoder().decode(decodeFrame(first.sent[2]!).payload!)).code, 500, "上层抛错回 500");

  // 掉线 → 重连；旧连接迟到的帧丢弃。
  respond = () => undefined;
  first.close();
  assert.equal(ws.getStatus().state, "reconnecting");
  timers.at(-1)!();
  for (let i = 0; i < 5 && sockets.length < 2; i++) await tick();
  assert.equal(sockets.length, 2, "重连建了第二条");
  sockets[1]!.open();
  const before = handled.length;
  first.deliver({ ...part(0, bytes), headers: [{ key: "type", value: "event" }, { key: "message_id", value: "msg-3" }] });
  await tick();
  assert.equal(handled.length, before, "旧连接的帧不再处理");

  // 处理到一半连接断了、又连上一条新的：回执不能发到新连接上（帧头对不上任何请求），报给上层补写。
  let finish: (value: unknown) => void = () => {};
  respond = () => new Promise((resolve) => { finish = resolve; });
  const second = sockets[1]!;
  second.deliver({ ...part(0, bytes), headers: [{ key: "type", value: "event" }, { key: "message_id", value: "msg-4" }] });
  for (let i = 0; i < 5 && handled.length === before; i++) await tick();
  assert.equal(handled.length, before + 1);
  second.close();
  timers.at(-1)!();
  for (let i = 0; i < 5 && sockets.length < 3; i++) await tick();
  const third = sockets[2]!;
  third.open();
  finish({ toast: { type: "success", content: "late" } });
  for (let i = 0; i < 5 && !lost.length; i++) await tick();
  const ackedOn = (socket: FakeSocket) => socket.sent.map((data) => decodeFrame(data)).filter((frame) => headerOf(frame, "message_id") === "msg-4");
  assert.equal(ackedOn(third).length, 0, "旧帧的回执不发到新连接");
  assert.equal(ackedOn(second).length, 0, "断掉的那条也发不出去");
  assert.deepEqual(lost, [{ eventId: "ev-1", result: { toast: { type: "success", content: "late" } } }], "回执没送出报给上层");
  ws.stop();

  // 接入点鉴权失败：停在 failed，不安排重试。
  const failed = new FeishuWsClient({
    appId: "cli_test0000", appSecret: "bad", domain: "https://open.fake", onEvent: () => undefined,
    deps: {
      fetch: (async () => new Response(JSON.stringify({ code: 514, msg: "auth failed" }))) as typeof fetch,
      createSocket: () => { throw new Error("不该建连"); },
      setTimeout: () => { throw new Error("不该安排重试"); },
      clearTimeout: () => {},
    },
  });
  failed.start();
  for (let i = 0; i < 5 && failed.getStatus().state !== "failed"; i++) await tick();
  assert.equal(failed.getStatus().state, "failed");
  assert.match(failed.getStatus().error ?? "", /514/);
  assert.equal((failed.getStatus().error ?? "").includes("bad"), false, "错误里不带 App Secret");
  failed.stop();

  // ── ③ REST ────────────────────────────────────────────────────────────────
  {
    const calls: { url: string; body: any; auth: string | null }[] = [];
    let tokenSerial = 0;
    let invalidOnce = true;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body, auth: new Headers(init.headers).get("authorization") });
      if (url.endsWith("/tenant_access_token/internal")) {
        tokenSerial += 1;
        return Response.json({ code: 0, tenant_access_token: `t-${tokenSerial}`, expire: 7200 });
      }
      if (url.includes("/im/v1/messages?") && invalidOnce) {
        invalidOnce = false;
        return Response.json({ code: 99991663, msg: "token invalid" });
      }
      return Response.json({ code: 0, data: { message_id: "om_1", chat_id: "oc_1" } });
    }) as unknown as typeof fetch;
    let allow = true;
    const purposes: string[] = [];
    const api = new FeishuApi({
      appId: "cli_test0000", appSecret: "s", domain: "https://open.fake",
      beforeCall: (_kind, purpose) => { purposes.push(purpose); return allow; },
      deps: { fetch: fakeFetch },
    });
    const sent = await api.send({ type: "open_id", id: "ou_a" }, { msgType: "text", content: { text: "hi" } }, "u".repeat(80), "decision");
    assert.equal(sent.ok, true);
    const sends = calls.filter((call) => call.url.includes("/im/v1/messages?"));
    assert.equal(sends.length, 2, "token 失效换一次重试");
    assert.equal(sends[0]!.auth, "Bearer t-1");
    assert.equal(sends[1]!.auth, "Bearer t-2");
    assert.equal(sends[1]!.body.uuid.length, 50, "uuid 截到 50 位");
    await api.react("om_1", "OK");
    assert.equal(calls.filter((call) => call.url.endsWith("/tenant_access_token/internal")).length, 2, "token 缓存复用");
    assert.deepEqual(purposes.slice(-1), ["reaction"]);
    allow = false;
    const before = calls.length;
    const blocked = await api.patchCard("om_1", {}, "resolved");
    assert.equal(isQuotaBlocked(blocked), true, "被额度闸拦下");
    assert.equal(calls.length, before, "拦下的调用不发请求");

    // 下载：类型是 JSON 的文件照样是文件；明确的错误包装才是错误。
    const file = new TextEncoder().encode('{"name":"配置","items":[1,2]}');
    let resource: () => Response = () => new Response(file, { headers: { "content-type": "application/json" } });
    const downloads = new FeishuApi({
      appId: "cli_test0000", appSecret: "s", domain: "https://open.fake", beforeCall: () => true,
      deps: {
        fetch: (async (url: string) => url.endsWith("/tenant_access_token/internal")
          ? Response.json({ code: 0, tenant_access_token: "t", expire: 7200 })
          : resource()) as unknown as typeof fetch,
      },
    });
    const json = await downloads.download("om_1", "file_1", "file");
    assert.equal(json.ok, true, "JSON 类型的文件下载成功");
    assert.deepEqual(json.ok && [...json.data.bytes], [...file], "拿到的是文件原样的字节");
    resource = () => Response.json({ code: 234003, msg: "File not in msg." });
    const missing = await downloads.download("om_1", "file_1", "file");
    assert.equal(!missing.ok && missing.code, 234003, "错误包装按接口错误算");
  }

  // ── ④ 额度 ────────────────────────────────────────────────────────────────
  {
    assert.equal(levelOf(69, 100), "normal");
    assert.equal(levelOf(70, 100), "frugal");
    assert.equal(levelOf(90, 100), "essential");
    assert.equal(levelOf(99, 100), "exhausted");
    assert.equal(purposeAllowed("frugal", "reaction"), false);
    assert.equal(purposeAllowed("frugal", "notice"), true);
    assert.equal(purposeAllowed("essential", "notice"), false);
    assert.equal(purposeAllowed("essential", "resolved"), false);
    assert.equal(purposeAllowed("essential", "decision"), true);
    assert.equal(purposeAllowed("exhausted", "decision"), false);
    assert.equal(purposeAllowed("exhausted", "result"), true);
    assert.equal(purposeAllowed("exhausted", "token"), true);
    assert.equal(monthOf(Date.parse("2026-10-31T15:59:59Z")), "2026-10");
    assert.equal(monthOf(Date.parse("2026-10-31T16:00:00Z")), "2026-11", "按北京时间切月");

    let clock = Date.parse("2026-11-10T00:00:00Z");
    const meter = new QuotaMeter(() => clock);
    await meter.load();
    meter.setQuota(100);
    for (let i = 0; i < 70; i++) assert.equal(meter.take("send", "decision"), true);
    assert.equal(meter.take("reaction", "reaction"), false, "70% 起不加表情");
    assert.equal(meter.usage().calls, 70, "拦下的不计数");
    for (let i = 0; i < 20; i++) meter.take("send", "decision");
    assert.equal(meter.take("send", "notice"), false, "90% 起不发通知");
    for (let i = 0; i < 9; i++) meter.take("send", "decision");
    assert.equal(meter.level(), "exhausted");
    assert.equal(meter.take("send", "decision"), false, "99% 起决策卡也不发");
    assert.equal(meter.take("patch", "result"), true, "回写点击结果照发");
    await meter.flush();
    const again = new QuotaMeter(() => clock);
    await again.load();
    assert.equal(again.usage().calls, 100, "计数落库后重读接得上");
    assert.equal(again.usage().byKind.patch, 1);
    clock = Date.parse("2026-11-30T16:00:01Z");
    assert.equal(again.usage().month, "2026-12");
    assert.equal(again.usage().calls, 0, "跨月清零");
  }

  // ── ⑤ 解析 / 脱敏 / 命令 / 绑定码 / 多题答复 ─────────────────────────────
  {
    const mentions = [{ key: "@_user_1", openId: "ou_bot" }];
    assert.deepEqual(parseMessage("text", JSON.stringify({ text: "@_user_1  帮我看看" }), mentions), { text: "帮我看看", attachments: [], supported: true });
    const post = parseMessage("post", JSON.stringify({ zh_cn: { title: "标题", content: [[{ tag: "text", text: "第一行" }, { tag: "img", image_key: "img_1" }], [{ tag: "a", text: "链接" }]] } }), []);
    assert.equal(post.text, "标题\n第一行\n链接");
    assert.deepEqual(post.attachments, [{ kind: "image", key: "img_1", name: null }]);
    assert.deepEqual(parseMessage("file", JSON.stringify({ file_key: "f1", file_name: "a.pdf" }), []).attachments, [{ kind: "file", key: "f1", name: "a.pdf" }]);
    assert.equal(parseMessage("sticker", "{}", []).supported, false);
    assert.equal(parseMessage("text", "不是 JSON", []).text, "");

    const scrubbed = scrubText("key=sk-abcdefghijklmnopqrstuvwxyz0123 <at id=all></at> 全体 t-abcdefghijklmnopqrstuvwxyz");
    assert.equal(scrubbed.includes("abcdefghijklmnopqrstuvwxyz"), false, `密钥要抹掉：${scrubbed}`);
    assert.equal(/<\s*at/i.test(scrubbed), false, "@ 标签要去掉");
    assert.match(scrubText("x".repeat(50), 10), /^x{10}…/);
    assert.equal(scrubTitle("  多行\n标题  "), "多行 标题");
    assert.equal(scrubTitle(""), "（无标题任务）");

    assert.deepEqual(parseCommand("/new 修个 bug\n详细说明"), { name: "new", rest: "修个 bug\n详细说明" });
    assert.deepEqual(parseCommand("  /TODO "), { name: "todo", rest: "" });
    assert.equal(parseCommand("/unknown x"), null, "不认识的斜杠开头当普通话");
    assert.equal(parseCommand("路径 /new 在中间"), null);

    assert.equal(extractCode("绑定码 ash-abcd-efgh 发你"), "ABCDEFGH");
    assert.equal(extractCode("ASH-ABCD-EFG"), null);

    assert.deepEqual(splitNumberedAnswers("1. 用 A\n2、先不动\n补充一行", 2), ["用 A", "先不动\n补充一行"]);
    assert.equal(splitNumberedAnswers("就按你说的来", 2), null, "没写题号就整段当一条");
    assert.equal(splitNumberedAnswers("1. x", 1), null, "单题不拆");
  }
  console.log("test-im-wire: ok");
} catch (error) {
  failure = error;
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
