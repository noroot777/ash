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
    // 它落在哪一秒纯属偶然,多半正砸在某一回合说到一半的地方,所以不能拿它当气泡边界
    // —— Conversation 会攒着它、等那颗气泡收口再吐出来（见 LogLine.aside）。
    aside: true,
  };
}

/**
 * 把过程提示（上游在重试、还在等回话）并回这条会话的时间线。
 *
 * 为什么要并:这些提示从前是 `.md` 里的 system 旁注,这条轮询顺带就看到了;改成只落 trace
 * (好让桌面端把它们排在出问题的那一步下面)之后,手机这边一条都看不见了。手机端不画工具
 * 调用,所以提示只能回到正文的时间线上。
 *
 * 位置按**它发生在哪一轮**算:agent 段带着那一轮的结束时刻(`endedAt`,来自 .md 的 agentEnd
 * 标),第一个「结束得比提示晚」的段就是那一轮,提示插在它后面。还在跑的那一轮没有 endedAt,
 * 于是落到末尾 —— 正是用户此刻在看的位置。
 */
export function mergeSessionNotices(lines: LogLine[], notices: SessionNotice[], sessionId: string): LogLine[] {
  if (!notices.length) return lines;
  const pending = [...notices].sort((a, b) => a.at.localeCompare(b.at));
  const out: LogLine[] = [];
  let index = 0;
  for (const line of lines) {
    out.push(line);
    const endedAt = line.kind === "text" ? line.endedAt : undefined;
    if (!endedAt) continue;
    while (pending.length && pending[0].at <= endedAt) {
      out.push(noticeLine(pending.shift() as SessionNotice, sessionId, index++));
    }
  }
  for (const notice of pending) out.push(noticeLine(notice, sessionId, index++));
  return out;
}
