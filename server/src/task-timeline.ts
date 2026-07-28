import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentType, SessionRole } from "@harness/shared";
import { desc, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { sessionTranscriptPath, writeTurn } from "./transcript.js";
import { now } from "./util.js";

// Persist one system event to the latest task session and mirror it over SSE.
// Tasks that have never run have no conversation timeline yet; callers still
// update the task itself and receive false so the API can report that honestly.
export async function appendTaskTimeline(taskId: string, text: string): Promise<boolean> {
  try {
    const session = (
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.taskId, taskId))
        .orderBy(desc(sessions.startedAt))
        .limit(1)
    ).at(0);
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
    console.warn(`[harness] failed to append task timeline for ${taskId}:`, error);
    return false;
  }
}
