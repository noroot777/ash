// 一条执行故障**来自模型 API** 时是哪一类（`ModelFailure`，shared/src/events.ts）。
//
// 只在执行器**认得出来源**的那几处调（claude 的 result 带 `api_error_status` 或 CLI 自己的
// 「API Error: N」；codex 回合里的 error / turn.failed）：那一刻手上的东西确知是这一轮发给模型的
// 请求失败了。别处（进程 stderr、MCP、CLI 启动期）的报错不经过这里 —— 一段 stderr 里出现个
// 「403」可能是本机某个 MCP 的，见数就当模型认证坏了是误诊（审查 I2TbHFxtSVAv 第 1 轮第 1 条）。
//
// 分类本身也不能只看状态码：同是 4xx，「对话超出长度上限」原样继续还会撞上，「限流」等一会儿
// 就好，「认证」得先修凭据 —— 读端据它给下一步，所以必须分开。读端只对 `rate_limit` / `unavailable`
// 两类说「等一会儿再继续」，所以这两类只给**确知会自行恢复**的那种：同是 429，「账户额度用完了、
// 去看套餐和账单」等多久都不会好（审查 I2TbHFxtSVAv 第 2 轮第 1 条）。判定顺序因此是「原话里说清了
// 要用户处理的（超长、额度）」先于「状态码」，状态码先于「原话里的宽泛字眼」。
import type { ModelFailure } from "@ash/shared";

/** 原话里说的是「对话 / 输入超出模型长度上限」。 */
const OVERFLOW = /prompt is too long|context[ _-]?(?:length|window)|maximum context|too many tokens|exceeds? (?:the )?(?:context|token|max)|input (?:is )?too long|context_length_exceeded/i;
/** 没有状态码时，说的是「这一刻连不上模型」（断流、网络层错误、过载、超时）。 */
const UNAVAILABLE = /stream disconnected|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|connection (?:lost|reset|refused|closed)|overloaded|service unavailable|bad gateway|gateway time-?out|timed out/i;
/** 原话里说的是「账户额度 / 余额 / 套餐用完了」：要用户去处理，等多久都不会自己好。 */
const QUOTA = /insufficient_quota|exceeded your (?:current )?quota|quota (?:exceeded|exhausted|has been exhausted)|resource_exhausted|billing|credit balance|out of credits|insufficient (?:balance|credits?|funds)|payment required|usage limit|spending limit|budget (?:exceeded|limit)/i;
/** 没有状态码时，说的是短时限流（不提额度）。 */
const RATE_LIMIT = /rate.?limit|too many requests/i;

/**
 * 按状态码和原话归类。`status` 由调用方从**它认得的那个位置**取（claude 的 `api_error_status`、
 * codex 的「unexpected status N」），这里不再在原话里找数 —— 原话里常夹着网关错误页，页里的
 * 数不是这次请求的状态。认不出类型给 null（调用方就不挂）。
 */
export function modelFailureOf(message: string, status: number | null): ModelFailure | null {
  if (OVERFLOW.test(message) || status === 413) return { kind: "context_overflow", status };
  if (QUOTA.test(message) || status === 402) return { kind: "quota_exhausted", status };
  if (status != null) {
    if (status === 429) return { kind: "rate_limit", status };
    if (status === 401 || status === 403) return { kind: "auth", status };
    if (status === 408 || status >= 500) return { kind: "unavailable", status };
    if (status >= 400) return { kind: "invalid_request", status };
    return null;
  }
  if (RATE_LIMIT.test(message)) return { kind: "rate_limit", status: null };
  if (UNAVAILABLE.test(message)) return { kind: "unavailable", status: null };
  return null;
}

/** claude CLI 把模型 API 的失败写成「API Error: 529 {…}」；它在 result 里没带 `api_error_status` 时从这里取。 */
export function claudeApiStatus(detail: string): number | null {
  const code = Number(/^API Error:?\s*(\d{3})\b/i.exec(detail.trim())?.[1]);
  return code >= 100 && code <= 599 ? code : null;
}

/**
 * codex 回合里那条错误（error 通知 / turn.failed）。codex 自己报模型请求失败的写法是
 * 「unexpected status 503 Service Unavailable: …」或「exceeded retry limit, last status: 429 …」，
 * 状态码只认这两个位置。回合里的错误本身就是这一轮对模型那次请求的结局，所以没有状态码时
 * 再按原话认断流 / 超限这几种。
 */
export function codexModelFailure(message: string): ModelFailure | null {
  const code = Number(/\b(?:unexpected status|last status:?)\s*(\d{3})\b/i.exec(message)?.[1]);
  return modelFailureOf(message, code >= 100 && code <= 599 ? code : null);
}

/** codex 回合里那条错误的事件形状：认得出模型 API 的类型就挂上。 */
export function codexTurnError(message: string): { kind: "error"; message: string; model?: ModelFailure } {
  const model = codexModelFailure(message);
  return model ? { kind: "error", message, model } : { kind: "error", message };
}
