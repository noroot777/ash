// 飞书通道调 ash 自己的接口：一律以「绑定的那个人」的身份走完整路由栈（../auth/im-actor.ts）。
import { dispatchAsIm, type AppFetch, type ImCall, type ImPrincipal } from "../auth/im-actor.js";

export type AshResult<T = Record<string, unknown>> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; data: Record<string, unknown> };

export class AshClient {
  constructor(private readonly fetch: AppFetch) {}

  async call<T = Record<string, unknown>>(principal: ImPrincipal, call: ImCall): Promise<AshResult<T>> {
    let response: Response;
    try {
      response = await dispatchAsIm(this.fetch, principal, call);
    } catch (error) {
      return { ok: false, status: 500, error: (error as Error).message, data: {} };
    }
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
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
