// 真人专属动作的页面凭据（服务端那一侧与能力边界:server/src/auth/human-action-token.ts）。
//
// 凭据随**页面文档**下发（`<meta name="ash-human-action-token">`），发那几个只有用户按得动
// 的开关时带在头上。服务端用一次就烧掉，并在响应里给回下一份 —— 所以这里要把它存住、
// 按响应轮换，不能每次都去读那个 meta（第二次读到的还是已经烧掉的那一份，开关就按不动了）。
//
// **`npm -w web run dev` 下这几个开关会 403**，这不是 bug:那一档的页面文档是 vite 发的、
// 不经过 ash，所以没有凭据可读，而凭据只活在 ash 自己的进程内存里，另起一个进程发不出来。
// 要点这几个开关就对着**构建产物**或真实实例验（`npm -w web run build` 之后的 :4317）。
import { HUMAN_ACTION_TOKEN_FIELD, HUMAN_ACTION_TOKEN_HEADER, HUMAN_ACTION_TOKEN_META } from "@ash/shared";
import { request } from "./apiClient.ts";

let current: string | null = null;

function fromDocument(): string | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector(`meta[name="${HUMAN_ACTION_TOKEN_META}"]`);
  return meta?.getAttribute("content")?.trim() || null;
}

/** 这次页面加载拿到的那一份（第一次调用时从文档里读走）。 */
export function humanActionToken(): string | null {
  if (current === null) current = fromDocument();
  return current;
}

/** 服务端在响应里给回的下一份。拿到就换上，没给就把手里这份丢掉（它已经被烧了）。 */
export function rotateHumanActionToken(next: string | null | undefined): void {
  current = next ?? null;
}

/**
 * 真人动作的请求头。拿不出凭据时**不编一个** —— 让服务端按「拿不出来就是拒绝」回 403,
 * 前端据此提示刷新页面。编一个假的只会把一句准确的错误换成一句看不懂的。
 */
export function humanActionHeaders(): Record<string, string> {
  const token = humanActionToken();
  return token ? { [HUMAN_ACTION_TOKEN_HEADER]: token } : {};
}

/**
 * 发一个真人专属动作:带上凭据，并把响应里给回的下一份换上。
 *
 * 所有这类端点都走这一个出口 —— 漏一处就是那个开关「按一次之后再也按不动」，而编译器
 * 不会说一句话（服务端那一侧的清单是 `HUMAN_ONLY_PATHS`）。
 */
export async function humanAction<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await request<T>(path, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), ...humanActionHeaders() },
  });
  if (result && typeof result === "object" && HUMAN_ACTION_TOKEN_FIELD in result) {
    rotateHumanActionToken((result as Record<string, unknown>)[HUMAN_ACTION_TOKEN_FIELD] as string | null);
  }
  return result;
}
