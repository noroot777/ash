// Display model for a task's conversation. The transcript is parsed from each
// session's persisted .md — parseSessionOutput lives in @ash/shared so web and
// mobile agree on the format: agent prose becomes a "text" line (Conversation
// merges consecutive ones into one bubble); the interleaved 你→ / 〔系统〕 turns keep
// their timestamp and get a unique sessionId so each renders as its own bubble.
import type { AgentType, SessionNotice } from "@ash/shared";
import { parseSessionOutput } from "@ash/shared";

export type LogLine = {
  kind: "text" | "thinking" | "tool" | "error" | "done" | "user" | "system";
  text: string;
  name?: string; // tool name (kind "tool")
  agent?: AgentType; // which agent produced it (@-mention multi-agent threads)
  sessionId?: string; // groups lines into bubbles + locates the resume credential
  at?: string; // ISO time (user replies / system traces show a timestamp)
  endedAt?: string; // exec end of an agent turn (from the .md agentEnd marker) — excludes idle wait
  // 任务时间线旁注（预约审查、验收阶段更新…）：不是说给 agent 听的话，落在哪一秒纯属
  // 偶然，多半正砸在某个回合说到一半的地方。所以它既不拆气泡也不定回合起止（见 shared
  // ConvSeg 的 aside）。2026-09-14 之前的老会话没有这个标，照旧当边界。
  aside?: boolean;
};

export function snapshotToLogLines(out: string, sessionId: string, agentType?: AgentType): LogLine[] {
  return parseSessionOutput(out).map((seg, i): LogLine => {
    if (seg.kind === "agent") return { kind: "text", text: seg.text, agent: agentType, sessionId, endedAt: seg.endedAt };
    return {
      kind: seg.kind,
      text: seg.text,
      at: seg.at,
      sessionId: `${sessionId}-seg-${i}`,
      ...(seg.kind === "system" && seg.aside ? { aside: true } : {}),
    };
  });
}

function noticeLine(notice: SessionNotice, sessionId: string, index: number): LogLine {
  return {
    kind: "system",
    text: notice.text,
    at: notice.at,
    sessionId: `${sessionId}-notice-${index}`,
    // 不是 agent 说的话,也不开/不收一个回合:Conversation 会等当前那颗气泡收口再吐出来
    // （见 LogLine.aside）,正在流式输出的回答才不会被它从中间劈成两半。
    aside: true,
  };
}

/**
 * 把这条会话**此刻还悬着**的过程提示（上游在重试、还在等回话）接在它的时间线末尾。
 *
 * 为什么要接:这些提示从前是 `.md` 里的 system 旁注,这条轮询顺带就看到了;改成只落 trace
 * (好让桌面端把它们排在出问题的那一步下面)之后,手机这边一条都看不见了。手机端不画工具
 * 调用,所以提示只能回到正文的时间线上。
 *
 * 为什么是末尾:服务端只给「还悬着」的那几条(见 shared 的 SessionNotice),意思就是上游在
 * 这条提示之后一个字都没再吐 —— 它确实是这条会话此刻的最新状态。**不能再按正文的结束
 * 时间猜它该插在哪两段之间**:`.md` 里只有 agentEnd 一个时间戳,一轮压根没出正文(光是工具
 * 调用、或者卡在重试上)时猜出来的位置会把提示塞到下一轮的回答后面,又变回「堆在会话结尾
 * 的一坨」(第 2 轮审查 F1)。
 */
export function mergeSessionNotices(lines: LogLine[], notices: SessionNotice[], sessionId: string): LogLine[] {
  if (!notices.length) return lines;
  return [
    ...lines,
    ...[...notices]
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((notice, index) => noticeLine(notice, sessionId, index)),
  ];
}
