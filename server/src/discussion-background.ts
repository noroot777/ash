// 讨论交给各方的那几份只读材料，都落在这场讨论自己的目录下（runs/<任务>/discussions/<讨论>/）。
//
// ① 发起那一刻的共同背景：把本任务现有的每一份对话记录截一份只读副本。被叫来的人得知道讨论之前聊过什么、
//    用户补过哪些约束，可本任务那几份实时的 .md（peer-context.ts 告诉它的路径）在第一轮里就会写进本场别人刚说的
//    第一段——读了就不是「各写各的」，不读又拿不到背景。副本截在第一段起跑之前，之后不再变。
// ② 第二轮起每一段之前、以及合稿之前：本场前面各段的完整发言（含它自己说过的）。
//
// 两样都**整份交给每一方**，不按「同一种执行器就记得自己说过什么」裁掉它自己那份：同一种执行器在这一轮未必接上了
// 原来那条 CLI 会话（会话失效重开、换了配置目录、任务从别的机器搬过来，见 turn-session-pick.ts）。读不到的历史
// 记录也如实列出来，不当成「没有历史」。
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { RUNS_DIR } from "./paths.js";
import { readableRunPath, sessionTranscriptPath } from "./transcript.js";

/** 一份发起前的对话记录：是谁的（审查者那几条另标身份）、副本落在哪；`path: null` = 这条会话的记录读不到了。 */
export type BackgroundFile = { agentType: string; role: string; sessionId: string; path: string | null };

const dirOf = (taskId: string, discussionId: string) => join(RUNS_DIR, taskId, "discussions", discussionId);

/** 截下本任务此刻的全部对话记录。还没有对话（从没跑过）就是空的；拷不出来就抛，讨论不开。 */
export async function snapshotDiscussionBackground(taskId: string, discussionId: string): Promise<BackgroundFile[]> {
  const rows = await db.select({ id: sessions.id, agentType: sessions.agentType, role: sessions.role })
    .from(sessions).where(eq(sessions.taskId, taskId)).orderBy(asc(sessions.startedAt));
  const dir = join(dirOf(taskId, discussionId), "background");
  const files: BackgroundFile[] = [];
  for (const row of rows) {
    const entry = { agentType: row.agentType, role: row.role, sessionId: row.id };
    const source = readableRunPath(sessionTranscriptPath(taskId, row.id));
    if (!existsSync(source)) {
      files.push({ ...entry, path: null });
      continue;
    }
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${row.agentType}${row.role === "single" ? "" : `-${row.role}`}-${row.id}.md`);
    await copyFile(source, path);
    await chmod(path, 0o444);
    files.push({ ...entry, path });
  }
  return files;
}

export function backgroundOf(raw: string | null): BackgroundFile[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as BackgroundFile[];
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item?.agentType === "string" && (typeof item.path === "string" || item.path === null))
      : [];
  } catch {
    return [];
  }
}

export type SpokenRecordSegment = { seq: number; speaker: string; statement: string };

/**
 * 本场到此为止各段的完整发言，写成一份只读文件交给接下来那一段（`label` 区分是第几段之前 / 合稿之前）。
 * 第一轮各写各的，不写这一份。没有说过的话（不该发生）回 null。
 */
export async function writeSpokenRecord(
  taskId: string, discussionId: string, label: string, segments: readonly SpokenRecordSegment[],
): Promise<string | null> {
  if (!segments.length) return null;
  const dir = dirOf(taskId, discussionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `spoken-before-${label}.md`);
  const body = segments.map((item) => `=== ${item.speaker} · 第 ${item.seq} 段 ===\n${item.statement}`).join("\n\n");
  await rm(path, { force: true });
  await writeFile(path, `${body}\n`);
  await chmod(path, 0o444);
  return path;
}
