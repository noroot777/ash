// 内置 Monitor 改道 hook 的**失败兜底**:这条回调路径上,任何没能给出决定的结局都收口成
// 一句明确的「拒绝原工具、也没替你代办」。
//
// 为什么要一道横切的中间件,而不是在路由里 try/catch 就够了:**鉴权跑在路由之前**。
// 身份闸排在 `app.route("/api", api)` 前面(index.ts),多人模式下它会
// 先去查 `agentActor` 的回合凭据 —— 那一步也查库。查库抛异常时 Hono 按默认错误处理回
// HTTP 500,路由回调里的 try 一个字都碰不到。而 http hook 的契约是「2xx + JSON 才算一个
// 决定」:非 2xx 会被 CLI 当成 non-blocking error,也就是**放行** —— 放过去的内置 Monitor
// 进程照样活不过这一轮,到点没有任何东西会把任务叫醒,正是这个 hook 要堵的那一幕
// (第 2 轮审查 F3 实测:注入一次身份查库异常,端点回 500 `Internal Server Error`)。
//
// **收口成 deny 不等于放宽权限**:deny 是安全的那一边 —— 原生工具不执行、ash 也没代办,
// agent 拿到的是一句说清了怎么自己补的拒绝。鉴权真的判这次请求没权限(401/403)时同样
// 落在这里:不放行、不代办,与「服务端出错」只差 reason 里那句话。
import type { MiddlewareHandler } from "hono";
import {
  isMonitorHookCall, monitorHookInternalError, MONITOR_HOOK_PATH, type ClaudeMonitorHookInput,
} from "./claude-monitor-hook.js";

/**
 * **把身份闸包起来**,而不是另注册一道排在它前面的中间件:顺序是这件事的全部 —— 排到
 * 后面就包不住它,而「两次 `app.use` 的先后」是个谁都可能顺手改掉、又不会报错的东西。
 * 包成装饰器之后只有一个注册点,写错的那种形状根本不存在。
 *
 * 只对**确实是内置 Monitor 调用**的请求表态:别的路径、以及正文解析不出来的,原样交给
 * 里面那层 —— 那种请求本来也拿不到代办,替它编一个 deny 只会在别处添乱。
 */
export const guardMonitorHook = (inner: MiddlewareHandler): MiddlewareHandler => async (c, next) => {
  if (new URL(c.req.url).pathname !== MONITOR_HOOK_PATH) return inner(c, next);
  // 正文在这里先读一次:Hono 把解析结果缓在 `bodyCache` 里,下游路由再 `c.req.json()`
  // 拿的是同一份,不会因为读过而少一次。
  const input = await c.req.json<ClaudeMonitorHookInput>().catch(() => null);
  if (!isMonitorHookCall(input)) return inner(c, next);
  let thrown: unknown = null;
  let returned: Response | void = undefined;
  try {
    returned = await inner(c, next);
  } catch (error) {
    thrown = error;
  }
  // 中间件可以**用返回值**表达响应 —— 身份闸的 401/403 就是 `return c.json(..., 401)`。自己
  // 手动调它就得自己把这一条接住:丢掉返回值的话这次请求谁都没给出响应,Hono 抛
  // 「Context is not finalized」,最终又是一个非 2xx = 放行。
  if (returned instanceof Response) c.res = returned;
  const status = thrown === null ? c.res?.status ?? 500 : 500;
  if (thrown === null && status >= 200 && status < 300) return;
  const detail = thrown !== null
    ? (thrown instanceof Error ? thrown.message : String(thrown))
    : `服务端回了 HTTP ${status}`;
  console.error(`[ash] Monitor 改道 hook 没能给出决定（${detail}），已按拒绝收口`, thrown ?? "");
  c.res = new Response(JSON.stringify(monitorHookInternalError(detail)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
