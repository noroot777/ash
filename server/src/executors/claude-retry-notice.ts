// Claude 的一次重试(`system/api_retry`)**说成人话**那一句。
//
// 单独一个文件、而不是留在 `claude-stream.ts` 里,是因为同一条原始事件有**两个**入口,而它们
// 必须说同一句话、落同一级:
//   · 主线程那条流(claude-stream.ts);
//   · 子智能体那条(native-agent-activity.ts 的 `ClaudeChildActivity`)—— 带
//     `parent_tool_use_id` 的事件在主线程那边**提前 return**,不走下面那段 `system` 分支。
//     少了这一处,一个子线程里连不上上游的回合在 ash 眼里是全程静默:看门狗一条错误都收不到,
//     报警和熔断都无从谈起(第 2 轮审查 F1 的同类缺口;codex 那一侧的同一个洞是第 1 轮第 1 条)。
//
// 一律 `level:"notice"`:重试期间回合仍然正常进行中,裸 error 的代价见 session-notice.ts 顶部。
// 「最终失败了没有」由收尾的 result / synthetic 消息答,这里只负责把过程留在它发生的位置上。

/** 这条原始事件是不是一次重试。 */
export const isClaudeRetry = (ev: { type?: unknown; subtype?: unknown }): boolean =>
  ev.type === "system" && ev.subtype === "api_retry";

/**
 * 重试那一句的正文。
 *
 * `error` 常常就是字符串 "unknown"(连接挂住、没有响应体),那时它不比「没有响应」多说什么,
 * 别原样抬给用户看。
 */
export function claudeRetryMessage(ev: Record<string, any>): string {
  const attempt = Number(ev.attempt) || 0;
  const max = Number(ev.max_retries) || 0;
  const status = Number(ev.error_status) || 0;
  const reason = typeof ev.error === "string" && ev.error.trim() && ev.error !== "unknown" ? ev.error.trim() : "";
  const cause = status
    ? `上游返回 ${status}${reason ? ` ${reason}` : ""}`
    : reason ? `上游报 ${reason}` : "上游没有响应";
  const wait = Number(ev.retry_delay_ms) || 0;
  const parts: string[] = [];
  if (attempt) parts.push(max ? `第 ${attempt}/${max} 次` : `第 ${attempt} 次`);
  if (wait) parts.push(`等 ${wait >= 1000 ? `${Math.round(wait / 1000)} 秒` : `${(wait / 1000).toFixed(1)} 秒`}`);
  return `${cause}，正在重试${parts.length ? `（${parts.join("，")}）` : ""}`;
}
