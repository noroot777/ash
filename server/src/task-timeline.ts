import { createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentType, SessionRole } from "@ash/shared";
import type { TimelineNotice } from "@ash/shared/timeline-notice";
import { desc, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { withRunFileLock } from "./run-file-lock.js";
import { sessionTranscriptPath, TURN_SENTINEL, writeTurn } from "./transcript.js";
import { bindTranscript, liveTranscript } from "./transcript-identity.js";
import type { RecordIdentity } from "@ash/shared/session-output";
import { now } from "./util.js";

// Persist one system event to a task session and mirror it over SSE.
// Tasks that have never run have no conversation timeline yet; callers still
// update the task itself and receive false so the API can report that honestly.
//
// 这里写的每一条都标 `aside`：它们是**任务**的时间线（预约审查、验收阶段更新、预览
// 起停…），不是会话里的一个回合——agent 从没见过这些字，它们落在哪一秒也纯属偶然，
// 多半正砸在某一回合说到一半的地方。读端据此不拿它当回合边界（见 shared/src/events.ts
// 的 `aside`、web 的 conversationModel）。说给 agent 听的那种「继续（从中断处）」由
// orchestrator / task-run 直接 writeTurn，不带这个标。
//
// `target` 是给「这条说明属于某一位智能体」的调用方用的。默认挑最新会话在单飞任务上
// 一直够用，但一个任务里可以有多条会话（用户 @ 谁谁就多一条）：起跑失败的交代要是按
// 「最新」投递，用户 @codex 却看见 claude 的时间线里冒出一条不属于它的失败，而被 @
// 的那位那边一片空白 —— 跟没说一样。所以先按会话 id 认人，再按 agent(+role) 认，
// 都找不到才退回最新会话。
//
// 每一条带着自己是**哪一类事**（`line.notice`，见 shared/src/timeline-notice.ts）：展示端
// 据它决定摆法（里程碑常显 / 回执记在回合上 / 出了岔子留在明面）和说法，不再回头认原文里的
// 字。原文（`line.text`）照旧落盘，是点开以后看的细节，也是移动端与 MCP 读转录的依据。
// 写法用下面三个小工具：`receiptLine(text)` / `alertLine(text)` / `noticeLine(notice, text)`。
export type TimelineLine = { text: string; notice: TimelineNotice };

/** 回执：记在所属回合上、平时不画的那一类。原文就是它的话。 */
export const receiptLine = (text: string): TimelineLine => ({ text, notice: { kind: "receipt" } });
/** 出了岔子 / 需要用户知道的：留在会话明面上。原文就是它的话。 */
export const alertLine = (text: string): TimelineLine => ({ text, notice: { kind: "alert" } });
/** 有专门 kind 的那几类（审查起止与结论、验收完成、哨兵起停……）。 */
export const noticeLine = (notice: TimelineNotice, text: string): TimelineLine => ({ text, notice });

export async function appendTaskTimeline(
  taskId: string,
  line: TimelineLine,
  target?: { sessionId?: string; agentType?: AgentType; role?: SessionRole; eventKey?: string },
): Promise<boolean> {
  const { text, notice } = line;
  try {
    const all = await db
      .select()
      .from(sessions)
      .where(eq(sessions.taskId, taskId))
      .orderBy(desc(sessions.startedAt));
    const session =
      (target?.sessionId && all.find((s) => s.id === target.sessionId)) ||
      (target?.agentType &&
        all.find(
          (s) => s.agentType === target.agentType && (!target.role || s.role === target.role),
        )) ||
      all.at(0);
    if (!session) return false;

    if (target?.eventKey) for (const candidate of all) {
      let transcript: string;
      try { transcript = await readFile(sessionTranscriptPath(taskId, candidate.id), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (transcript.split("\n").some((line) => {
        if (!line.startsWith(TURN_SENTINEL)) return false;
        try { return (JSON.parse(line.slice(TURN_SENTINEL.length)) as { eventKey?: string }).eventKey === target.eventKey; }
        catch { return false; }
      })) return true;
    }

    const at = now();
    const line = { t: "system" as const, agent: session.agentType as AgentType, text, aside: true as const, notice,
      ...(target?.eventKey ? { eventKey: target.eventKey } : {}),
    };
    const identity = await appendTranscriptLine(taskId, session, (out) => writeTurn(out, line, at));
    bus.publish({
      type: "agent.event",
      taskId,
      sessionId: session.id,
      role: session.role as SessionRole,
      agentType: session.agentType as AgentType,
      ...identity,
      event: { kind: "system", text, at, aside: true, notice },
    });
    return true;
  } catch (error) {
    console.warn(`[ash] failed to append task timeline for ${taskId}:`, error);
    return false;
  }
}

/**
 * 往一条会话的正文里追加一行（回合之外的那些追加者共用：时间线旁注、会话轮换注记）。
 *
 * 这条会话此刻有回合在跑，就从那条正在写的流写（transcript-identity.ts 的「一条会话在跑的时候只有
 * 一个写者」）：自己另开一条追加流的话，这一行会砸进正在流式写的正文中间。没在跑就另开一条，跟删除
 * 消息的改写排同一把锁（run-file-lock.ts）；单飞那几种会话照样带身份（团队调度台、duet 的正文不带，
 * 页面对它们一直走老读法）。返回这一行的身份，实时事件带上同一份。
 */
export async function appendTranscriptLine(
  taskId: string,
  session: { id: string; role: string },
  write: (out: NodeJS.WritableStream) => RecordIdentity | null,
): Promise<RecordIdentity | null> {
  const running = liveTranscript(session.id);
  if (running) return write(running);
  const transcriptPath = sessionTranscriptPath(taskId, session.id);
  mkdirSync(dirname(transcriptPath), { recursive: true });
  return withRunFileLock([transcriptPath], () => {
    // 排锁期间可能刚有一回合起跑、登记成了写者（claimTranscript 也在这把锁里登记）：拿到锁再看一次。
    const claimed = liveTranscript(session.id);
    if (claimed) return write(claimed);
    return appendThroughOwnStream(taskId, session, transcriptPath, write);
  });
}

/** 没有正式流时自己开一条短命的流写这一行：只发号，不登记成这条会话的写者（见 transcript-identity.ts）。 */
function appendThroughOwnStream(
  taskId: string,
  session: { id: string; role: string },
  transcriptPath: string,
  write: (out: NodeJS.WritableStream) => RecordIdentity | null,
): Promise<RecordIdentity | null> {
  return new Promise<RecordIdentity | null>((resolve, reject) => {
    const out = createWriteStream(transcriptPath, { flags: "a" });
    if (identityRole(session.role)) bindTranscript(out, { taskId, sessionId: session.id, turnStartedAt: null }, { register: false });
    let identity: RecordIdentity | null = null;
    out.once("error", reject);
    out.once("finish", () => resolve(identity));
    identity = write(out);
    out.end();
  });
}

/** 正文带身份的会话：单飞那一路写的那几种（团队调度台 lead、duet 的两位讨论者不算）。 */
const identityRole = (role: string): boolean => role !== "lead" && role !== "voiceA" && role !== "voiceB";
