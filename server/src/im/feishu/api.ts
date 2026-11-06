// 飞书开放平台 REST 调用：只用到发消息、回复、改卡、表情、下载消息里的附件、查机器人信息。
//
// 每一次 HTTP 调用都先过 `beforeCall`：免费版自建应用每月只有 1 万次 API 调用（用户
// 2026-11-06 在后台核实），额度用尽后所有调用都会被拒，所以计数和「到线就降级」必须卡在
// 发请求之前，而不是事后统计。调用方传进来的用途（purpose）决定它在降级时能不能被砍掉
// （见 ../quota.ts）。
//
// 卡片回调的同步回卡不经过这里、不花额度 —— 能在回调里改完的卡，一律在回调里改。
import type { ImApiKind } from "@ash/shared";
import type { ImPurpose } from "../quota.js";

type ApiKind = ImApiKind;

export interface ApiDeps {
  fetch: typeof fetch;
  now: () => number;
}

export interface FeishuApiOptions {
  appId: string;
  appSecret: string;
  domain: string;
  /** 发请求前调用。返回 false = 这次调用被额度闸拦下，不发。 */
  beforeCall: (kind: ApiKind, purpose: ImPurpose) => boolean;
  deps?: Partial<ApiDeps>;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: number; msg: string; retryable: boolean; throttled?: boolean };

export interface SentMessage {
  messageId: string;
  chatId?: string;
}

export type ReceiveIdType = "open_id" | "chat_id";

// 4xx 里只有限流值得重试；鉴权、权限、参数错误重试多少次都一样。
const RATE_LIMIT_CODES = new Set([99991400, 11232, 230020]);
const TOKEN_INVALID_CODES = new Set([99991661, 99991663, 99991668]);
// 被额度闸拦下的调用：不重试（下一次对账会再判一遍）。
const QUOTA_BLOCKED = -1;

export class FeishuApi {
  private readonly deps: ApiDeps;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenInflight: Promise<ApiResult<string>> | null = null;

  constructor(private readonly options: FeishuApiOptions) {
    this.deps = { fetch: (...args) => fetch(...args), now: () => Date.now(), ...options.deps };
  }

  private async tenantToken(force = false): Promise<ApiResult<string>> {
    if (!force && this.token && this.token.expiresAt > this.deps.now()) return { ok: true, data: this.token.value };
    if (this.tokenInflight) return this.tokenInflight;
    this.tokenInflight = (async (): Promise<ApiResult<string>> => {
      if (!this.options.beforeCall("token", "token")) return blocked();
      const res = await this.raw("POST", "/open-apis/auth/v3/tenant_access_token/internal", {
        app_id: this.options.appId, app_secret: this.options.appSecret,
      }, null);
      if (!res.ok) return res;
      const body = res.data as { tenant_access_token?: string; expire?: number };
      if (!body.tenant_access_token) return { ok: false, code: 0, msg: "没拿到 tenant_access_token", retryable: true };
      // 提前 5 分钟换：飞书在过期前半小时内重新取会拿到新 token，旧的同时仍有效。
      const ttl = Math.max(60, (body.expire ?? 7200) - 300) * 1000;
      this.token = { value: body.tenant_access_token, expiresAt: this.deps.now() + ttl };
      return { ok: true, data: this.token.value };
    })().finally(() => { this.tokenInflight = null; });
    return this.tokenInflight;
  }

  private async raw(
    method: string,
    path: string,
    body: unknown,
    token: string | null,
    binary = false,
  ): Promise<ApiResult<any>> {
    let response: Response;
    try {
      response = await this.deps.fetch(`${this.options.domain}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return { ok: false, code: 0, msg: `网络错误：${(error as Error).message}`, retryable: true };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (binary && response.ok && !contentType.includes("application/json")) {
      return { ok: true, data: { bytes: new Uint8Array(await response.arrayBuffer()), contentType } };
    }
    let json: any;
    try {
      json = await response.json();
    } catch {
      return { ok: false, code: response.status, msg: `HTTP ${response.status}，响应不是 JSON`, retryable: response.status >= 500 };
    }
    const code = Number(json?.code ?? (response.ok ? 0 : response.status));
    if (code !== 0) {
      const throttled = RATE_LIMIT_CODES.has(code) || response.status === 429;
      return {
        ok: false, code, msg: String(json?.msg ?? ""), throttled,
        retryable: throttled || response.status >= 500 || TOKEN_INVALID_CODES.has(code),
      };
    }
    return { ok: true, data: json.data ?? json };
  }

  /** 保存凭证前核一次：拿得到 tenant_access_token 就说明 App ID / Secret 对得上（一次调用）。 */
  async checkCredentials(): Promise<ApiResult<void>> {
    const token = await this.tenantToken(true);
    return token.ok ? { ok: true, data: undefined } : token;
  }

  /** 带 token 调用；token 失效时换一次重试。 */
  private async call<T>(
    kind: ApiKind, purpose: ImPurpose, method: string, path: string, body?: unknown, binary = false,
  ): Promise<ApiResult<T>> {
    const token = await this.tenantToken();
    if (!token.ok) return token;
    if (!this.options.beforeCall(kind, purpose)) return blocked();
    const res = await this.raw(method, path, body, token.data, binary);
    if (res.ok || !TOKEN_INVALID_CODES.has(res.code)) return res;
    const fresh = await this.tenantToken(true);
    if (!fresh.ok) return fresh;
    if (!this.options.beforeCall(kind, purpose)) return blocked();
    return this.raw(method, path, body, fresh.data, binary);
  }

  /** 发一条消息。uuid 让飞书在 1 小时内对同一 uuid 只成功一次（实测重复调用返回同一 message_id）。 */
  async send(
    to: { type: ReceiveIdType; id: string },
    msg: { msgType: "interactive" | "text"; content: unknown },
    uuid: string,
    purpose: ImPurpose,
  ): Promise<ApiResult<SentMessage>> {
    const res = await this.call<any>("send", purpose, "POST", `/open-apis/im/v1/messages?receive_id_type=${to.type}`, {
      receive_id: to.id,
      msg_type: msg.msgType,
      content: JSON.stringify(msg.content),
      uuid: uuid.slice(0, 50),
    });
    return res.ok ? { ok: true, data: { messageId: res.data.message_id, chatId: res.data.chat_id } } : res;
  }

  /** 回复某条消息；replyInThread=true 时回复进话题（群里一个任务一个话题）。 */
  async reply(
    messageId: string,
    msg: { msgType: "interactive" | "text"; content: unknown },
    uuid: string,
    purpose: ImPurpose,
    replyInThread = false,
  ): Promise<ApiResult<SentMessage>> {
    const res = await this.call<any>("send", purpose, "POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: msg.msgType,
      content: JSON.stringify(msg.content),
      reply_in_thread: replyInThread,
      uuid: uuid.slice(0, 50),
    });
    return res.ok ? { ok: true, data: { messageId: res.data.message_id, chatId: res.data.chat_id } } : res;
  }

  /** 原地改卡（只对 update_multi 的卡片有效，单条消息 5 QPS，14 天内）。改卡不会触发推送提醒。 */
  async patchCard(messageId: string, card: unknown, purpose: ImPurpose): Promise<ApiResult<void>> {
    const res = await this.call<void>("patch", purpose, "PATCH", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      content: JSON.stringify(card),
    });
    return res.ok ? { ok: true, data: undefined } : res;
  }

  async react(messageId: string, emoji: string): Promise<ApiResult<void>> {
    const res = await this.call<void>("reaction", "reaction", "POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
      reaction_type: { emoji_type: emoji },
    });
    return res.ok ? { ok: true, data: undefined } : res;
  }

  /** 下载用户发来的图片/文件。type 取 image 或 file。 */
  async download(messageId: string, fileKey: string, type: "image" | "file"): Promise<ApiResult<{ bytes: Uint8Array; contentType: string }>> {
    return this.call("download", "download", "GET",
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`,
      undefined, true);
  }

  async botInfo(): Promise<ApiResult<{ openId: string; name: string }>> {
    const res = await this.call<any>("info", "info", "GET", "/open-apis/bot/v3/info");
    if (!res.ok) return res;
    const bot = res.data?.bot ?? res.data;
    return { ok: true, data: { openId: String(bot?.open_id ?? ""), name: String(bot?.app_name ?? "") } };
  }

  async chatInfo(chatId: string): Promise<ApiResult<{ name: string }>> {
    const res = await this.call<any>("info", "info", "GET", `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`);
    return res.ok ? { ok: true, data: { name: String(res.data?.name ?? "") } } : res;
  }
}

function blocked<T>(): ApiResult<T> {
  return { ok: false, code: QUOTA_BLOCKED, msg: "本月飞书 API 额度已到降级线，这次调用没有发出", retryable: false };
}

export function isQuotaBlocked(result: ApiResult<unknown>): boolean {
  return !result.ok && result.code === QUOTA_BLOCKED;
}
