import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentType, SessionRole } from "@ash/shared";
import { desc, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { sessionTranscriptPath, writeTurn } from "./transcript.js";
import { now } from "./util.js";

// Persist one system event to a task session and mirror it over SSE.
// Tasks that have never run have no conversation timeline yet; callers still
// update the task itself and receive false so the API can report that honestly.
//
// `target` 是给「这条说明属于某一位智能体」的调用方用的。默认挑最新会话在单飞任务上
// 一直够用，但一个任务里可以有多条会话（用户 @ 谁谁就多一条）：起跑失败的交代要是按
// 「最新」投递，用户 @codex 却看见 claude 的时间线里冒出一条不属于它的失败，而被 @
// 的那位那边一片空白 —— 跟没说一样。所以先按会话 id 认人，再按 agent(+role) 认，
// 都找不到才退回最新会话。
export async function appendTaskTimeline(
  taskId: string,
  text: string,
  target?: { sessionId?: string; agentType?: AgentType; role?: SessionRole },
): Promise<boolean> {
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

    const at = now();
    const transcriptPath = sessionTranscriptPath(taskId, session.id);
    mkdirSync(dirname(transcriptPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(transcriptPath, { flags: "a" });
      out.once("error", reject);
      out.once("finish", resolve);
      writeTurn(out, { t: "system", agent: session.agentType as AgentType, text }, at);
      out.end();
    });
    bus.publish({
      type: "agent.event",
      taskId,
      sessionId: session.id,
      role: session.role as SessionRole,
      agentType: session.agentType as AgentType,
      event: { kind: "system", text },
    });
    return true;
  } catch (error) {
    console.warn(`[ash] failed to append task timeline for ${taskId}:`, error);
    return false;
  }
}
