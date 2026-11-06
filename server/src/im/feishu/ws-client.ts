// 飞书长连接客户端：拉接入点 → 建 WebSocket → 心跳 → 收事件帧、合并分片 → 回执。
//
// 协议照官方 @larksuiteoapi/node-sdk 1.76.0 的 WSClient 逐条对齐（2026-11-06 读源码 + 真实应用实测）。
// 不直接依赖 SDK：它解包 30MB、带进 axios/protobufjs/lodash，而 server 只需要其中这一条
// 连接；更要紧的是合并后主仓若没重新 npm install，引用它的 server 一启动就崩。undici
// 本来就是 server 的依赖，自带 WebSocket。
//
// 事件帧一律原样交给 onEvent，由上层决定怎么处理；onEvent 的返回值会作为回执里的 data
// 带回飞书 —— 卡片回调的「同步回卡」就是这么实现的。回执必须在 3 秒内发出，超时飞书
// 不会重推（实测），所以 onEvent 里只能做毫秒级的事。
import { WebSocket } from "undici";
import { decodeFrame, encodeFrame, FRAME_CONTROL, FRAME_DATA, headerOf, type Frame } from "./frame.js";

export interface FeishuEnvelope {
  eventId: string;
  eventType: string;
  createTime?: string;
  appId?: string;
  /** 2.0 事件体（`event` 字段），没有拍平。 */
  event: Record<string, unknown>;
}

export type ConnState = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

export interface ConnStatus {
  state: ConnState;
  /** 进入当前状态的时间。 */
  since: number;
  /** 最近一次失败的原因（不含凭据）。 */
  error?: string;
  lastEventAt?: number;
  connectedAt?: number;
  reconnectAttempts: number;
}

export interface WsLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: any) => void): void;
}

export interface FeishuWsDeps {
  fetch: typeof fetch;
  createSocket: (url: string) => WsLike;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  random: () => number;
}

export interface FeishuWsOptions {
  appId: string;
  appSecret: string;
  /** 开放平台域名，如 https://open.feishu.cn（Lark 国际版是 https://open.larksuite.com）。 */
  domain: string;
  onEvent: (envelope: FeishuEnvelope) => Promise<unknown> | unknown;
  /** 事件处理完时收它的那条连接已经断了：回执（连同随回执带回的卡）没送出去。 */
  /** 回执发出去了（只代表交给了那条连接；elapsedMs = 从收到事件到发出回执，飞书只等 3 秒）。 */
  onAcked?: (envelope: FeishuEnvelope, result: unknown, elapsedMs: number) => void;
  onAckLost?: (envelope: FeishuEnvelope, result: unknown) => void;
  onStatus?: (status: ConnStatus) => void;
  deps?: Partial<FeishuWsDeps>;
}

const OPEN = 1;
// 接入点返回的 code（与飞书官方 SDK 同一张表：0 成功、1 忙、403 无权、514 鉴权失败、1000040343 内部错误、
// 1000040350 超连接数）。只有 403 / 514 是配置问题、重试也不会好，停在 failed 等人改；别的（包括不认识的码、
// 超连接数 —— 别处的旧连接断掉就好了）按退避接着重连，状态里照实显示错误，不能把一次没见过的码当成永久失败。
const PERMANENT_CODES = new Set([403, 514]);
// 看门狗：发出 ping 后这么久没有任何入站帧，就当连接已死、主动重连。SDK 默认不开看门狗，
// 但长连接静默断掉是先例里踩过的坑（cc-connect），宁可多重连一次。
const LIVENESS_MS = 60_000;
// 接入点下发的重连间隔有时很长（实测 120 秒）；第一次掉线先快速重试一次。
const FIRST_RETRY_MS = 3_000;
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 10 * 60_000;
const FRAGMENT_TTL_MS = 10_000;

interface Fragments {
  parts: (Uint8Array | undefined)[];
  createdAt: number;
}

const defaultDeps: FeishuWsDeps = {
  fetch: (...args) => fetch(...args),
  createSocket: (url) => new WebSocket(url) as unknown as WsLike,
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export class FeishuWsClient {
  private readonly deps: FeishuWsDeps;
  private status: ConnStatus;
  private socket: WsLike | null = null;
  private serviceId = 0;
  private pingIntervalMs = 120_000;
  private reconnectIntervalMs = 120_000;
  private reconnectNonceMs = 30_000;
  private pingTimer: unknown = null;
  private livenessTimer: unknown = null;
  private retryTimer: unknown = null;
  private fragments = new Map<string, Fragments>();
  // 每次（重）连自增：旧连接迟到的 close/message 一律按代次丢弃，不会把新连接拆掉。
  private generation = 0;
  private stopped = true;

  constructor(private readonly options: FeishuWsOptions) {
    this.deps = { ...defaultDeps, ...options.deps };
    this.status = { state: "idle", since: this.deps.now(), reconnectAttempts: 0 };
  }

  getStatus(): ConnStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    this.dropSocket();
    this.fragments.clear();
    this.setStatus({ state: "idle", error: undefined });
  }

  private setStatus(patch: Partial<ConnStatus>): void {
    const next = { ...this.status, ...patch };
    if (patch.state && patch.state !== this.status.state) next.since = this.deps.now();
    this.status = next;
    try {
      this.options.onStatus?.(this.getStatus());
    } catch (error) {
      console.error("[ash] 飞书连接状态回调抛错:", error);
    }
  }

  private clearTimers(): void {
    for (const handle of [this.pingTimer, this.livenessTimer, this.retryTimer]) {
      if (handle) this.deps.clearTimeout(handle);
    }
    this.pingTimer = this.livenessTimer = this.retryTimer = null;
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // 已经断了的连接 close 可能抛，丢弃即可。
    }
  }

  private async pullEndpoint(): Promise<{ ok: true; url: string } | { ok: false; retryable: boolean; error: string }> {
    const { appId, appSecret, domain } = this.options;
    let response: Response;
    try {
      response = await this.deps.fetch(`${domain}/callback/ws/endpoint`, {
        method: "POST",
        headers: { "content-type": "application/json", locale: "zh" },
        body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return { ok: false, retryable: true, error: `接入点请求失败：${(error as Error).message}` };
    }
    let body: any;
    try {
      body = await response.json();
    } catch {
      return { ok: false, retryable: true, error: `接入点返回非 JSON（HTTP ${response.status}）` };
    }
    if (body?.code !== 0) {
      const code = Number(body?.code);
      return { ok: false, retryable: !PERMANENT_CODES.has(code), error: `接入点拒绝：code=${code} ${body?.msg ?? ""}`.trim() };
    }
    const url = String(body.data?.URL ?? "");
    const config = body.data?.ClientConfig ?? {};
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, retryable: true, error: "接入点返回的连接地址无法解析" };
    }
    this.serviceId = Number(parsed.searchParams.get("service_id") ?? 0);
    this.applyClientConfig(config);
    return { ok: true, url };
  }

  private applyClientConfig(config: Record<string, unknown>): void {
    const sec = (value: unknown) => (typeof value === "number" && value > 0 ? value * 1000 : undefined);
    this.pingIntervalMs = sec(config.PingInterval) ?? this.pingIntervalMs;
    this.reconnectIntervalMs = sec(config.ReconnectInterval) ?? this.reconnectIntervalMs;
    this.reconnectNonceMs = sec(config.ReconnectNonce) ?? this.reconnectNonceMs;
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const reconnecting = this.status.connectedAt !== undefined;
    this.setStatus({ state: reconnecting ? "reconnecting" : "connecting" });
    const endpoint = await this.pullEndpoint();
    if (generation !== this.generation || this.stopped) return;
    if (!endpoint.ok) {
      if (!endpoint.retryable) {
        this.setStatus({ state: "failed", error: endpoint.error });
        return;
      }
      this.scheduleRetry(endpoint.error);
      return;
    }

    let socket: WsLike;
    try {
      socket = this.deps.createSocket(endpoint.url);
    } catch (error) {
      this.scheduleRetry(`建连失败：${(error as Error).message}`);
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let opened = false;
    socket.addEventListener("open", () => {
      if (generation !== this.generation) return;
      opened = true;
      this.setStatus({ state: "connected", connectedAt: this.deps.now(), error: undefined, reconnectAttempts: 0 });
      this.ping(generation);
    });
    socket.addEventListener("message", (ev: { data: unknown }) => {
      if (generation !== this.generation) return;
      void this.onMessage(ev.data, socket);
    });
    socket.addEventListener("error", () => {
      // 真正的善后统一放在 close 里；undici 出错后总会再发 close。
    });
    socket.addEventListener("close", () => {
      if (generation !== this.generation || this.stopped) return;
      this.socket = null;
      this.clearTimers();
      this.scheduleRetry(opened ? "连接断开" : "WebSocket 握手失败");
    });
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped) return;
    const attempts = this.status.reconnectAttempts + 1;
    const base = attempts === 1 ? FIRST_RETRY_MS : Math.max(MIN_RETRY_MS, this.reconnectIntervalMs);
    const delay = Math.min(MAX_RETRY_MS, base + this.deps.random() * this.reconnectNonceMs);
    this.setStatus({
      state: this.status.connectedAt !== undefined ? "reconnecting" : "connecting",
      error: reason,
      reconnectAttempts: attempts,
    });
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  /** 发一帧。via = 必须走这条连接（回执只能回给收到事件的那条）。返回有没有发出去。 */
  private send(frame: Frame, via: WsLike | null = this.socket): boolean {
    if (!via || via.readyState !== OPEN) return false;
    try {
      via.send(encodeFrame(frame));
      return true;
    } catch (error) {
      console.error("[ash] 飞书长连接发帧失败:", (error as Error).message);
      return false;
    }
  }

  private ping(generation: number): void {
    if (generation !== this.generation || this.stopped) return;
    this.send({
      seqId: 0n, logId: 0n, service: this.serviceId, method: FRAME_CONTROL,
      headers: [{ key: "type", value: "ping" }],
    });
    if (this.livenessTimer) this.deps.clearTimeout(this.livenessTimer);
    this.livenessTimer = this.deps.setTimeout(() => {
      this.livenessTimer = null;
      if (generation !== this.generation) return;
      console.warn("[ash] 飞书长连接 ping 后无应答，主动重连");
      this.generation++;
      this.clearTimers();
      this.dropSocket();
      this.scheduleRetry("心跳无应答");
    }, LIVENESS_MS);
    this.pingTimer = this.deps.setTimeout(() => this.ping(generation), this.pingIntervalMs);
  }

  private async onMessage(data: unknown, source: WsLike): Promise<void> {
    if (this.livenessTimer) {
      this.deps.clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
    let frame: Frame;
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : null;
      if (!bytes) return;
      frame = decodeFrame(bytes);
    } catch (error) {
      console.error("[ash] 飞书长连接收到无法解码的帧:", (error as Error).message);
      return;
    }
    if (frame.method === FRAME_CONTROL) {
      if (headerOf(frame, "type") === "pong" && frame.payload) {
        try {
          this.applyClientConfig(JSON.parse(new TextDecoder().decode(frame.payload)));
        } catch {
          // pong 里的配置坏了就沿用旧值。
        }
      }
      return;
    }
    if (frame.method !== FRAME_DATA) return;
    // type=card 是旧版「消息卡片回传交互」，长连接不支持；新版卡片回调走 type=event。
    if (headerOf(frame, "type") !== "event") return;
    const merged = this.merge(frame);
    if (!merged) return;
    this.status.lastEventAt = this.deps.now();

    const started = this.deps.now();
    const resp: { code: number; data?: string } = { code: 200 };
    let envelope: FeishuEnvelope | null = null;
    let result: unknown;
    try {
      envelope = parseEnvelope(merged);
      if (envelope) {
        result = await this.options.onEvent(envelope);
        if (result !== undefined && result !== null) {
          resp.data = Buffer.from(JSON.stringify(result)).toString("base64");
        }
      }
    } catch (error) {
      resp.code = 500;
      console.error("[ash] 飞书事件处理抛错:", error);
    }
    // 回执只回给收到这一帧的那条连接：处理期间重连了，旧帧的头发到新连接上对不上任何请求。
    const acked = this.send({
      ...frame,
      headers: [...frame.headers, { key: "biz_rt", value: String(this.deps.now() - started) }],
      payload: new TextEncoder().encode(JSON.stringify(resp)),
    }, source);
    if (envelope && resp.code === 200) {
      if (acked) this.options.onAcked?.(envelope, result, this.deps.now() - started);
      else this.options.onAckLost?.(envelope, result);
    }
  }

  private merge(frame: Frame): Record<string, unknown> | null {
    const messageId = headerOf(frame, "message_id") ?? "";
    const sum = Number(headerOf(frame, "sum") ?? 1);
    const seq = Number(headerOf(frame, "seq") ?? 0);
    const payload = frame.payload ?? new Uint8Array();
    if (!Number.isInteger(sum) || sum <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= sum) {
      console.error(`[ash] 飞书事件分片元数据非法 message_id=${messageId} sum=${sum} seq=${seq}`);
      return null;
    }
    const now = this.deps.now();
    for (const [key, entry] of this.fragments) {
      if (now - entry.createdAt > FRAGMENT_TTL_MS) this.fragments.delete(key);
    }
    let bytes: Uint8Array;
    if (sum === 1) {
      bytes = payload;
    } else {
      let entry = this.fragments.get(messageId);
      if (!entry) {
        entry = { parts: new Array(sum).fill(undefined), createdAt: now };
        this.fragments.set(messageId, entry);
      }
      if (entry.parts.length !== sum) {
        this.fragments.delete(messageId);
        return null;
      }
      entry.parts[seq] = payload;
      if (entry.parts.some((part) => !part)) return null;
      this.fragments.delete(messageId);
      bytes = Buffer.concat(entry.parts as Uint8Array[]);
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      console.error(`[ash] 飞书事件不是合法 JSON message_id=${messageId}:`, (error as Error).message);
      return null;
    }
  }
}

/** 2.0 事件：`{schema, header:{event_id, event_type, ...}, event:{...}}`。加密事件（配了 Encrypt Key）不支持。 */
export function parseEnvelope(raw: Record<string, unknown>): FeishuEnvelope | null {
  if ("encrypt" in raw) {
    console.warn("[ash] 收到加密的飞书事件：请在开发者后台清空 Encrypt Key，长连接不需要它");
    return null;
  }
  const header = (raw.header ?? {}) as Record<string, unknown>;
  const eventType = typeof header.event_type === "string" ? header.event_type : "";
  const eventId = typeof header.event_id === "string" ? header.event_id : "";
  if (!eventType || !eventId) return null;
  return {
    eventId,
    eventType,
    createTime: typeof header.create_time === "string" ? header.create_time : undefined,
    appId: typeof header.app_id === "string" ? header.app_id : undefined,
    event: (raw.event ?? {}) as Record<string, unknown>,
  };
}
