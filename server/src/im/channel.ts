// 飞书通道的装配与生命周期：读凭证 → 连长连接 → 订阅 bus 驱动对账；凭证/开关一改就整套重来。
//
// 不去连的几种情况（状态里如实报出来，网页上能看到为什么没连）：没配凭证、凭证文件坏了、
// 预览实例（index.ts 压根不调 startFeishuChannel）、同一个库起了多个实例（ASH_ALLOW_MULTI：
// 飞书长连接是集群模式，两个客户端连同一个应用会随机分走事件）、总开关关着。
//
// bus 订阅里只记任务 id（Reconciler.mark），不读库也不抛错：订阅回调是同步跑在发布方栈上的，
// 那里抛错会打断发布方。漏掉的事件（删任务不发事件、某些状态变化只改库）由定时全量对账兜住 ——
// 对账只读库，没有变化就一次 API 都不花。
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { FeishuConnection, ImConnectionState, ImHealthState, ImUsage } from "@ash/shared";
import { bus } from "../bus.js";
import { resolveAshDbFile } from "../db/path.js";
import { IS_PREVIEW_INSTANCE } from "../preview-instance.js";
import { isMultiUser } from "../auth/mode.js";
import { getUser } from "../auth/store.js";
import type { AppFetch } from "../auth/im-actor.js";
import { CardActions, type CallbackEvent } from "./actions.js";
import { AshClient } from "./ash-client.js";
import { bindingsOfApp } from "./binding.js";
import { CommandRunner } from "./commands.js";
import { domainUrl, readCredentials, type FeishuCredentials } from "./config.js";
import { FeishuApi } from "./feishu/api.js";
import { FeishuWsClient, type ConnStatus, type FeishuEnvelope } from "./feishu/ws-client.js";
import { InboundRouter, type MessageEvent } from "./inbound.js";
import { readMeta, readOptions, writeMeta } from "./meta.js";
import { OutboxSender } from "./outbox.js";
import { QuotaMeter } from "./quota.js";
import { Reconciler } from "./reconcile.js";
import { RoomRelay } from "./relay.js";

const FULL_SWEEP_MS = 10 * 60_000;

export interface FeishuRuntime {
  appId: string;
  api: FeishuApi;
  ws: FeishuWsClient;
  sender: OutboxSender;
  reconciler: Reconciler;
  bot: { openId: string; name: string } | null;
}

interface Running extends FeishuRuntime {
  relay: RoomRelay;
  sweep: ReturnType<typeof setInterval>;
  unsubscribe: () => void;
}

let host: { fetch: AppFetch; exclusive: boolean } | null = null;
let running: Running | null = null;
let gate: ImConnectionState = IS_PREVIEW_INSTANCE ? "preview" : "idle";
let configError: string | null = null;
let chain: Promise<void> = Promise.resolve();
// 计数跨重连共用一份：换凭证不清零（额度是按应用算的，但同一个月里换应用很少见，宁可多算）。
const meter = new QuotaMeter();
let meterLoaded: Promise<void> | null = null;
// 「实例已上线」每个进程每个应用只发一次：断线重连不再发，省额度。
const announced = new Set<string>();

/** 本机实例的短指纹：主机名 + 库文件路径。两台机器连了同一个应用时，上线消息里能看出来。 */
export const instanceTag = (): string =>
  createHash("sha256").update(`${hostname()}\n${resolveAshDbFile()}`).digest("hex").slice(0, 8).toUpperCase().replace(/^(.{4})/, "$1-");

/** index.ts 在拿到单实例锁、路由就绪之后调一次（预览实例不调）。 */
export function startFeishuChannel(input: { fetch: AppFetch; exclusive: boolean }): Promise<void> {
  host = input;
  return restartFeishuChannel();
}

/** 凭证、开关变了：整套拆掉重来。调用串行，并发的几次只按顺序各跑一遍。 */
export function restartFeishuChannel(): Promise<void> {
  chain = chain.then(bringUp).catch((error) => {
    gate = "failed";
    configError = null;
    console.error("[ash] 飞书通道启动失败:", error);
  });
  return chain;
}

export function stopFeishuChannel(): Promise<void> {
  chain = chain.then(() => tearDown());
  return chain;
}

export function feishuRuntime(): FeishuRuntime | null {
  return running;
}

/**
 * 本月计数只从库里读一次：之后内存里那份才是准的（每次计数都排队落库，重读会读到还没落下去
 * 的旧值）。没读之前不许计数 —— 那会拿 0 起数，把库里本月的计数覆盖掉。
 */
export function quotaMeter(): Promise<QuotaMeter> {
  meterLoaded ??= meter.load();
  return meterLoaded.then(() => meter);
}

export async function quotaUsage(): Promise<ImUsage> {
  return (await quotaMeter()).usage();
}

async function tearDown(): Promise<void> {
  const current = running;
  running = null;
  if (!current) return;
  current.unsubscribe();
  clearInterval(current.sweep);
  current.ws.stop();
  current.relay.stop();
  current.reconciler.stop();
  current.sender.stop();
}

async function bringUp(): Promise<void> {
  await tearDown();
  configError = null;
  if (!host) return;
  const read = readCredentials();
  if (read.kind === "missing") { gate = "unconfigured"; return; }
  if (read.kind === "broken") { gate = "broken"; configError = read.error; return; }
  if (!host.exclusive) { gate = "not_exclusive"; return; }
  const options = await readOptions();
  if (!options.enabled) { gate = "disabled"; return; }
  (await quotaMeter()).setQuota(options.monthlyQuota);
  gate = "idle";
  running = assemble(read.credentials, host.fetch);
  running.ws.start();
  running.sender.start();
  running.relay.start();
  const self = running;
  void (async () => {
    self.bot = await botOf(self);
    await self.reconciler.full();
  })().catch((error) => console.error("[ash] 飞书通道初次对账出错:", error));
}

function assemble(credentials: FeishuCredentials, fetch: AppFetch): Running {
  const appId = credentials.appId;
  const api = new FeishuApi({
    appId, appSecret: credentials.appSecret, domain: domainUrl(credentials.domain),
    beforeCall: (kind, purpose) => meter.take(kind, purpose),
  });
  const ash = new AshClient(fetch);
  const sender = new OutboxSender(api, appId);
  const reconciler = new Reconciler(appId, sender);
  const commands = new CommandRunner({ appId, ash, reconciler });
  const actions = new CardActions({ appId, ash, reconciler, sender, commands });
  const relay = new RoomRelay({ appId, ash, commands });
  let runtime: Running | null = null;
  const inbound = new InboundRouter({ appId, api, ash, commands, relay, reconciler, botOpenId: () => runtime?.bot?.openId ?? null });
  const ws = new FeishuWsClient({
    appId, appSecret: credentials.appSecret, domain: domainUrl(credentials.domain),
    onEvent: (envelope) => dispatch(envelope, inbound, actions),
    onStatus: (status) => { if (status.state === "connected" && runtime) void announce(runtime); },
  });
  const unsubscribe = bus.subscribe((ev) => {
    switch (ev.type) {
      case "task.created":
      case "task.updated":
        reconciler.mark(ev.task.id);
        break;
      case "task.status":
      case "task.stage":
      case "task.question":
      case "task.acceptGate":
      case "task.review":
      case "duet.gate":
        reconciler.mark(ev.taskId);
        break;
    }
  });
  const sweep = setInterval(() => void reconciler.full().catch((error) => console.error("[ash] 飞书定时对账出错:", error)), FULL_SWEEP_MS);
  sweep.unref?.();
  runtime = { appId, api, ws, sender, reconciler, relay, bot: null, sweep, unsubscribe };
  return runtime;
}

/**
 * 长连接上来的事件。消息事件不等处理完就回执（下载附件、投进房间都可能超过 3 秒；
 * 重推了也有 im_inbound 去重）；卡片回调要等结果，结果卡随回执带回去。
 */
async function dispatch(envelope: FeishuEnvelope, inbound: InboundRouter, actions: CardActions): Promise<unknown> {
  if (envelope.eventType === "im.message.receive_v1") {
    void inbound.handle(envelope.event as MessageEvent).catch((error) => console.error("[ash] 飞书消息处理出错:", error));
    return undefined;
  }
  if (envelope.eventType === "card.action.trigger") {
    const event = callbackOf(envelope);
    return event ? actions.handle(event) : undefined;
  }
  return undefined;
}

export function callbackOf(envelope: FeishuEnvelope): CallbackEvent | null {
  const event = envelope.event as {
    operator?: { open_id?: string };
    action?: { value?: unknown; form_value?: unknown; name?: unknown };
  };
  const operatorOpenId = event.operator?.open_id;
  if (!operatorOpenId) return null;
  let value = event.action?.value;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = {}; }
  }
  const asRecord = (input: unknown) => (input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {});
  return {
    eventId: envelope.eventId,
    operatorOpenId,
    value: asRecord(value),
    formValue: asRecord(event.action?.form_value),
    name: typeof event.action?.name === "string" ? event.action.name : null,
  };
}

/** 机器人自己的 open_id（群里判断有没有 @ 它）。同一个应用不会变，记在库里免得每次重启都查。 */
async function botOf(runtime: FeishuRuntime): Promise<{ openId: string; name: string } | null> {
  const key = `bot:${runtime.appId}`;
  const cached = await readMeta(key);
  if (cached) {
    try { return JSON.parse(cached) as { openId: string; name: string }; } catch { /* 重新查 */ }
  }
  const info = await runtime.api.botInfo();
  if (!info.ok || !info.data.openId) return null;
  await writeMeta(key, JSON.stringify(info.data));
  return info.data;
}

async function announce(runtime: FeishuRuntime): Promise<void> {
  if (announced.has(runtime.appId)) return;
  announced.add(runtime.appId);
  // 这句话是给管实例的人看的：自用模式发给机主，多人模式只发给管理员。
  const multi = await isMultiUser();
  const bindings = await bindingsOfApp(runtime.appId);
  const targets: typeof bindings = [];
  for (const binding of bindings) {
    if (!multi ? !binding.userId : !!binding.userId && (await getUser(binding.userId))?.role === "admin") targets.push(binding);
  }
  const text = `ash 实例 ${instanceTag()} 已上线。若你同时看到别的指纹的上线消息，说明另一台机器连着同一个飞书应用，事件会被两边随机分走。`;
  await runtime.reconciler.run(async () => {
    for (const binding of targets) {
      await runtime.reconciler.insert({
        dest: { receiveType: "open_id", receiveId: binding.openId, recipientOpenId: binding.openId },
        taskId: null, kind: "online", subject: `online:${process.pid}:${Date.now()}`, msgType: "text", content: JSON.stringify({ text }),
      });
    }
  });
  runtime.reconciler.kick();
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);

export function connectionOf(): FeishuConnection {
  if (!running) {
    return { state: gate, since: null, connectedAt: null, lastEventAt: null, error: configError, reconnectAttempts: 0, botName: null };
  }
  const status: ConnStatus = running.ws.getStatus();
  return {
    state: status.state,
    since: iso(status.since),
    connectedAt: iso(status.connectedAt),
    lastEventAt: iso(status.lastEventAt),
    error: status.error ?? null,
    reconnectAttempts: status.reconnectAttempts,
    botName: running.bot?.name ?? null,
  };
}

export function channelConfigError(): string | null {
  return configError;
}

/** 免登录的 `/api/health` 只看这一档：连没连上，不带任何标识或错误原文。 */
export function feishuHealthPublic(): ImHealthState {
  const state = connectionOf().state;
  if (state === "connected" || state === "reconnecting" || state === "failed") return state;
  if (state === "connecting" || (state === "idle" && running)) return "connecting";
  return "off";
}
