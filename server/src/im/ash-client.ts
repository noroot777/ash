// 飞书通道调 ash 自己的接口：一律以「绑定的那个人」的身份走完整路由栈（../auth/im-actor.ts）。
import { dispatchAsIm, type AppFetch, type ImCall, type ImPrincipal } from "../auth/im-actor.js";

export type AshResult<T = Record<string, unknown>> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; data: Record<string, unknown> };

/**
 * 一次调用没成功，该怎么认。absent = 404：没有，或者不再归他看（chat、任务路由有意把两者合成 404，防枚举）；
 * denied = 403：imGate 拒了（绑定失效、账号停用、路由不在白名单）；rejected = 别的 4xx：请求本身不对；
 * transient = 5xx 或根本没调通（call 把抛出记成 500）。只有 absent 能当「确实没有」处理 —— transient 是结局不明，
 * 不能据此换掉、删掉、收掉任何东西，也不能对人说成确定的原因。
 */
export type AshFailure = "absent" | "denied" | "rejected" | "transient";

export function failureOf(result: AshResult & { ok: false }): AshFailure {
  if (result.status === 404) return "absent";
  if (result.status === 403) return "denied";
  return result.status >= 400 && result.status < 500 ? "rejected" : "transient";
}

export class AshClient {
  constructor(private readonly fetch: AppFetch) {}

  async call<T = Record<string, unknown>>(principal: ImPrincipal, call: ImCall): Promise<AshResult<T>> {
    let response: Response;
    try {
      response = await dispatchAsIm(this.fetch, principal, call);
    } catch (error) {
      return { ok: false, status: 500, error: (error as Error).message, data: {} };
    }
    // 2xx 但正文没读成（读到一半断了、不是 JSON）不能当成「成功、什么都没有」：拿空对象往下走，房间快照就成了「房间
    // 不在这个项目里」、列表成了「一个都没有」（审查第 2 轮同类）。记成瞬时失败（502），结局不明。
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return { ok: false, status: 502, error: `读接口回应时断了：${(error as Error).message}`, data: {} };
    }
    let data: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        if (response.ok) return { ok: false, status: 502, error: `接口回了读不懂的内容（HTTP ${response.status}）`, data: {} };
      }
    }
    if (response.ok) return { ok: true, status: response.status, data: data as T };
    return { ok: false, status: response.status, error: typeof data.error === "string" ? data.error : `HTTP ${response.status}`, data };
  }

  get<T = Record<string, unknown>>(principal: ImPrincipal, path: ImCall["path"]) {
    return this.call<T>(principal, { method: "GET", path });
  }

  post<T = Record<string, unknown>>(principal: ImPrincipal, path: ImCall["path"], body: unknown = {}) {
    return this.call<T>(principal, { method: "POST", path, body });
  }
}

export const taskPath = (taskId: string, rest = "") => `/api/tasks/${encodeURIComponent(taskId)}${rest}` as const;
