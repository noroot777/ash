// `GET /api/auth/state` 是整个 SPA 的第一道分叉:它没回来之前,前端不知道该渲染工作台、
// 向导还是登录页。这一个 RTT 原本**串**在 bundle 之后(React mount → effect → fetch),
// 本机上量不出来,远程访问时那段空窗足够把登录外壳闪出来再跳走。
//
// index.html 里那段内联脚本让这个请求在 HTML 解析阶段就起飞,与 bundle 的下载/解析并行;
// 这里只负责把它的结果接住。
import type { AuthState } from "@ash/shared";

declare global {
  interface Window {
    /** index.html 内联脚本预热的那一发;失败时兑现成 null,不会 reject。 */
    __ashAuthProbe?: Promise<AuthState | null>;
  }
}

/**
 * 取用预热结果,**只兑现一次** —— 它是页面加载那一刻的快照,登录/领取/加入项目之后的
 * 每一次 refresh 都必须重新问服务端,拿旧快照会把人卡在登录页上。
 *
 * 拿不到就返回 null(脚本被裁掉、模板被换、请求本身失败),调用方照常走一次正常请求。
 */
export async function takeAuthProbe(): Promise<AuthState | null> {
  const probe = window.__ashAuthProbe;
  if (!probe) return null;
  window.__ashAuthProbe = undefined;
  try {
    return await probe;
  } catch {
    return null;
  }
}
