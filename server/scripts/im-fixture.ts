// 飞书通道端到端测试的公共台子：假飞书开放平台 + 真路由栈 + 通道各部件（不起长连接）。
// test-im-cards.ts / test-im-inbound.ts 共用。调用方先设好 ASH_DB / ASH_RUNS_DIR 再 import 这里。
import { Hono } from "hono";
import { authGate } from "../src/auth/middleware.js";
import { resourceGate } from "../src/auth/resource-gate.js";
import { personalWriteGate } from "../src/auth/personal-gate.js";
import { api as apiRoutes } from "../src/routes.js";
import { CardActions } from "../src/im/actions.js";
import { AshClient } from "../src/im/ash-client.js";
import { CommandRunner } from "../src/im/commands.js";
import { FeishuApi } from "../src/im/feishu/api.js";
import { InboundRouter, type MessageEvent } from "../src/im/inbound.js";
import { QuotaMeter } from "../src/im/quota.js";
import { Reconciler } from "../src/im/reconcile.js";
import { RoomRelay } from "../src/im/relay.js";

export const APP = "cli_app0000000";
export const OWNER = "ou_owner";

export interface FakeCall { method: string; path: string; body: any }

/** 假开放平台：记下每一次调用；发消息按 uuid 幂等（与真飞书一致）。 */
export class FakeFeishu {
  calls: FakeCall[] = [];
  /** 撤回消息回什么码（0 = 撤回成功；230009 = 发出超过一天、撤不回）。 */
  recallCode = 0;
  /** 撤回成了、回执却丢在路上（超时、断网）：消息照样撤掉，调用方看到的是网络错误。 */
  dropRecallReply = false;
  /** 发消息时先等它（测「发的途中」）。 */
  holdSend: Promise<void> | null = null;
  /** 已经撤回的消息：再撤、再改都回 230011（与真飞书一致）。 */
  private recalled = new Set<string>();
  private byUuid = new Map<string, string>();
  private serial = 0;

  fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname + url.search;
    this.calls.push({ method, path, body });
    const json = (data: unknown) => Response.json(data);
    if (path.endsWith("/tenant_access_token/internal")) return json({ code: 0, tenant_access_token: "t-fake", expire: 7200 });
    if (method === "POST" && /\/im\/v1\/messages(\?|\/[^/]+\/reply$)/.test(path)) {
      if (this.holdSend) await this.holdSend;
      const known = body?.uuid ? this.byUuid.get(body.uuid) : undefined;
      const messageId = known ?? `om_${++this.serial}`;
      if (body?.uuid) this.byUuid.set(body.uuid, messageId);
      return json({ code: 0, data: { message_id: messageId, chat_id: "oc_fake" } });
    }
    const target = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if ((method === "DELETE" || method === "PATCH") && this.recalled.has(target)) return json({ code: 230011, msg: "fake: 消息已撤回" });
    if (method === "DELETE") {
      if (this.recallCode) return json({ code: this.recallCode, msg: "fake: 撤不回" });
      this.recalled.add(target);
      if (this.dropRecallReply) throw new Error("fake: 回执丢了");
      return json({ code: 0, data: {} });
    }
    if (method === "PATCH" || path.endsWith("/reactions")) return json({ code: 0, data: {} });
    if (path.includes("/resources/")) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), { headers: { "content-type": "image/png" } });
    }
    if (path.startsWith("/open-apis/bot/v3/info")) return json({ code: 0, bot: { open_id: "ou_bot", app_name: "ash 机器人" } });
    if (path.startsWith("/open-apis/im/v1/chats/")) return json({ code: 0, data: { name: "研发群" } });
    return json({ code: 404, msg: `fake: 没有 ${method} ${path}` });
  }) as unknown as typeof fetch;

  sends() {
    return this.calls.filter((call) => call.method === "POST" && /\/im\/v1\/messages(\?|\/[^/]+\/reply$)/.test(call.path));
  }
  patches() { return this.calls.filter((call) => call.method === "PATCH"); }
  recalls() { return this.calls.filter((call) => call.method === "DELETE" && /\/im\/v1\/messages\/[^/]+$/.test(call.path)); }
  reactions() { return this.calls.filter((call) => call.path.endsWith("/reactions")); }
  reset() { this.calls = []; }
}

export const contentOf = (call: FakeCall) => JSON.parse(call.body.content) as any;

/** 卡片 / 文本消息里所有给人看的字。 */
export function textOf(content: any): string {
  if (typeof content?.text === "string" && !content.schema) return content.text;
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const record = node as Record<string, unknown>;
    if (record.tag === "plain_text" && typeof record.content === "string") out.push(record.content);
    Object.values(record).forEach(walk);
  };
  walk(content);
  return out.join("\n");
}

/** 卡片上的回调按钮（文字 + value）与打开链接的按钮。 */
export function buttonsOf(content: any): { text: string; value?: Record<string, unknown>; url?: string; confirm: boolean }[] {
  const out: { text: string; value?: Record<string, unknown>; url?: string; confirm: boolean }[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const record = node as Record<string, any>;
    if (record.tag === "button") {
      const behavior = record.behaviors?.[0];
      out.push({ text: record.text?.content, value: behavior?.value, url: behavior?.default_url, confirm: !!record.confirm });
    }
    Object.values(record).forEach(walk);
  };
  walk(content);
  return out;
}

/** 卡片上整行可点的链接（interactive_container）：这一行的字 + 打开的地址。 */
export function linksOf(content: any): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const record = node as Record<string, any>;
    if (record.tag === "interactive_container") {
      out.push({ text: textOf(record.elements), url: record.behaviors?.[0]?.default_url });
      return;
    }
    Object.values(record).forEach(walk);
  };
  walk(content);
  return out;
}

export function buildApp() {
  const app = new Hono();
  app.use("*", authGate());
  app.use("/api/*", resourceGate());
  app.use("/api/*", personalWriteGate());
  app.route("/api", apiRoutes);
  return app;
}

export async function assemble(app: Hono, fake: FakeFeishu) {
  const meter = new QuotaMeter();
  await meter.load();
  meter.setQuota(1_000_000);
  const api = new FeishuApi({ appId: APP, appSecret: "s", domain: "https://open.fake", beforeCall: (kind, purpose) => meter.take(kind, purpose), deps: { fetch: fake.fetch } });
  const ash = new AshClient(app.fetch);
  const reconciler = new Reconciler(APP, api, { now: () => Date.now(), sleep: async () => {} });
  const sender = reconciler.sender;
  const commands = new CommandRunner({ appId: APP, ash, reconciler });
  const actions = new CardActions({ appId: APP, ash, reconciler, sender, commands });
  const relay = new RoomRelay({ appId: APP, ash, commands });
  const inbound = new InboundRouter({ appId: APP, api, ash, commands, relay, reconciler, botOpenId: () => "ou_bot" });
  let events = 0;
  /** 等防抖的对账跑完、发件队列排空。 */
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 360));
    await reconciler.run(async () => {});
    await sender.drainNow();
  };
  const click = (operatorOpenId: string, value: Record<string, unknown>, formValue: Record<string, unknown> = {}, name: string | null = null) =>
    actions.handle({ eventId: `ev-${++events}`, operatorOpenId, value, formValue, name });
  let messages = 0;
  const say = async (input: {
    openId?: string; text?: string; chatType?: "p2p" | "group"; chatId?: string; parentId?: string; rootId?: string;
    messageType?: string; content?: unknown; mentionBot?: boolean;
  }) => {
    const messageId = `om_in_${++messages}`;
    const mentions = input.mentionBot ? [{ key: "@_user_1", id: { open_id: "ou_bot" } }] : [];
    const event: MessageEvent = {
      sender: { sender_id: { open_id: input.openId ?? OWNER }, sender_type: "user" },
      message: {
        message_id: messageId, chat_id: input.chatId ?? "oc_p2p", chat_type: input.chatType ?? "p2p",
        parent_id: input.parentId, root_id: input.rootId ?? input.parentId,
        message_type: input.messageType ?? "text",
        content: JSON.stringify(input.content ?? { text: `${input.mentionBot ? "@_user_1 " : ""}${input.text ?? ""}` }),
        mentions,
      },
    };
    await inbound.handle(event);
    return messageId;
  };
  return { meter, api, ash, sender, reconciler, commands, actions, relay, inbound, settle, click, say };
}

/**
 * 等后台的回合收尾（答复/重试会真去起执行器，ASH_RUNS_DIR 下 spawn 被拦、很快落 failed）。
 * 传了 from 就先等它离开这个状态：点完按钮那一刻任务多半还停在 paused，续跑还没排上。
 */
export async function waitIdle(read: () => Promise<string | undefined>, from?: string, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const status = await read();
    if (status !== "running" && status !== "queued" && status !== from) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
