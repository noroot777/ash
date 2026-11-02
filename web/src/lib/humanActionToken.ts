// 真人专属动作的页面凭据（服务端那一侧与能力边界:server/src/auth/human-action-token.ts）。
//
// 凭据随**页面文档**下发（`<meta name="ash-human-action-token">`），发那几个只有用户按得动
// 的开关时带在头上。服务端用一次就烧掉，并在响应头里给回下一份 —— 所以这里要把它存住、
// 按响应轮换，不能每次都去读那个 meta（第二次读到的还是已经烧掉的那一份，开关就按不动了）。
//
// ## 轮换挂在**响应观察**上,不挂在「成功返回」上（第 5 轮审查 N2）
//
// 上一版是 `humanAction()` 自己从**响应体**里取 `nextHumanActionToken`,于是只有 2xx 才换得
// 到下一份:一次业务拒绝（400/409）或异常（500）之后,凭据已经被闸烧掉、页面手里还攥着那
// 串废号,同一个页面的下一次点击必然 403「需要页面凭据」,而那句话读起来像是开关坏了。
// 现在服务端改成由闸统一在响应头上发（不分状态码）,这边也相应改成**看每一个响应**:凡是带
// 着那个头的就换上,不管请求成不成、也不管它是从哪条路发出去的 —— 漏一处的可能性没有了。
import { HUMAN_ACTION_TOKEN_HEADER, HUMAN_ACTION_TOKEN_META, HUMAN_ACTION_TOKEN_NEXT_HEADER } from "@ash/shared";
import { observeResponses, request } from "./apiClient.ts";

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

/** 服务端在响应里给回的下一份。拿到就换上。 */
export function rotateHumanActionToken(next: string | null | undefined): void {
  current = next ?? null;
}

// 每一个响应都看一眼:带着「下一份凭据」的就换上。**不看状态码** —— 闸是在烧掉之后发的,
// 业务拒绝和异常那几条路径同样烧掉了手里这一份(理由见文件头与 HUMAN_ACTION_TOKEN_NEXT_HEADER)。
observeResponses((response) => {
  const next = response.headers.get(HUMAN_ACTION_TOKEN_NEXT_HEADER);
  if (next) rotateHumanActionToken(next);
});

/**
 * 真人动作的请求头。拿不出凭据时**不编一个** —— 让服务端按「拿不出来就是拒绝」回 403,
 * 前端据此提示刷新页面。编一个假的只会把一句准确的错误换成一句看不懂的。
 */
export function humanActionHeaders(): Record<string, string> {
  const token = humanActionToken();
  return token ? { [HUMAN_ACTION_TOKEN_HEADER]: token } : {};
}

/**
 * 这类动作**排成一条队**。
 *
 * 凭据是一次性的:两个真人动作同时发出去,两边带的是同一串,后到的那个必然 403（第 5 轮
 * 审查 N2 的后半段）。这不是「并发没优化好」,而是协议上就不允许并发 —— 所以在这里串起来:
 * 后一个等前一个的响应（也就是等那一份新凭据）再发。前一个失败也照样往下走,它只是让下一个
 * 等一等,不是把队堵死。
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * 发一个真人专属动作:带上凭据、排进那条队。下一份凭据由响应观察那一段换上（见文件头）——
 * 这里**不**读响应体:续发是闸的事,不是各条路由的事。
 */
export function humanAction<T>(path: string, init?: RequestInit): Promise<T> {
  const send = () => request<T>(path, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), ...humanActionHeaders() },
  });
  const result = queue.then(send, send);
  // 队列自己不许带着错误往下传,否则一次失败会把后面每一个都变成 rejected。
  queue = result.then(() => undefined, () => undefined);
  return result;
}
