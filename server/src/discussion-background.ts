// 讨论发起那一刻的共同背景：把本任务现有的每一份对话记录截一份只读副本，放在这场讨论自己的目录下。
//
// 为什么要截：被叫来的人得知道讨论之前聊过什么、用户补过哪些约束，可本任务那几份实时的 .md（peer-context.ts
// 告诉它的路径）在第一轮里就会写进本场别人刚说的第一段——读了就不是「各写各的」，不读又拿不到背景。副本截在
// 第一段起跑之前，之后不再变，各方拿到的是同一份；第一轮只叫它们别碰实时那几份（discussion-prompts.ts）。
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";
import { readableRunPath, sessionTranscriptPath } from "./transcript.js";

/** 一份副本：是谁的对话（审查者那几条另标身份），落在哪。 */
export type BackgroundFile = { agentType: string; role: string; path: string };

/** 截下本任务此刻的全部对话记录。还没有对话（从没跑过）就是空的；拷不出来就抛，讨论不开。 */
export async function snapshotDiscussionBackground(taskId: string, discussionId: string): Promise<BackgroundFile[]> {
  const rows = await db.select({ id: sessions.id, agentType: sessions.agentType, role: sessions.role })
    .from(sessions).where(eq(sessions.taskId, taskId)).orderBy(asc(sessions.startedAt));
  const dir = join(RUNS_DIR, taskId, "discussions", discussionId, "background");
  const files: BackgroundFile[] = [];
  for (const row of rows) {
    const source = readableRunPath(sessionTranscriptPath(taskId, row.id));
    if (!existsSync(source)) continue;
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${row.agentType}${row.role === "single" ? "" : `-${row.role}`}-${row.id}.md`);
    await copyFile(source, path);
    await chmod(path, 0o444);
    files.push({ agentType: row.agentType, role: row.role, path });
  }
  return files;
}

export function backgroundOf(raw: string | null): BackgroundFile[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as BackgroundFile[];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item?.path === "string") : [];
  } catch {
    return [];
  }
}
