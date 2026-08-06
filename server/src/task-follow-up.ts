import { open, stat } from "node:fs/promises";
import type { ConvSeg, TaskFollowUp } from "@harness/shared";
import { isUserFollowUp, parseSessionOutput } from "@harness/shared";
import { parseAttachmentText } from "@harness/shared/attachments";
import { desc, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { sessionTranscriptPath } from "./transcript.js";

type UserSeg = Extract<ConvSeg, { kind: "user" }>;
const isFollowUp = (seg: ConvSeg): seg is UserSeg => isUserFollowUp(seg);

// 会话正文是一路追加的 Markdown，长的有几 MB，而要找的那句话往往在末尾附近，所以
// 分档往回读：先 64KB（绝大多数情况一把就够），没找到再 1MB，还没有就整个文件读到头。
// 只读固定长度的尾巴是不够的 —— agent 一条回复动辄几十 KB，我说的那句很容易被它盖住。
const TAIL_STEPS = [64 * 1024, 1024 * 1024, 32 * 1024 * 1024];
// 一个任务最多往回翻几次会话：追问一般就在最新那次里，但重试/续跑过的任务，最新
// 那次可能是刚起的会话（我还一句都没说），得再往前找。
const MAX_SESSIONS = 4;
// 悬浮卡片显示的上限。再长的正文没人在悬浮里读，也不该为它撑大列表接口的响应。
const TEXT_CAP = 1200;

async function readTail(path: string, bytes: number): Promise<{ text: string; whole: boolean }> {
  const info = await stat(path);
  const handle = await open(path, "r");
  try {
    const length = Math.min(info.size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const text = buffer.toString("utf8");
    const whole = length >= info.size;
    // 从中间切进去的话，第一行多半是半截字（可能还劈开了一个 UTF-8 字符），丢掉。
    // 只丢开头不影响结果：要的是**最后**一条，它离切口最远，永远是完整的。
    return { text: whole ? text : text.slice(text.indexOf("\n") + 1), whole };
  } finally {
    await handle.close();
  }
}

// 一次会话里我说的最后一句。读到头都没有就是真没有（这次会话全程我没插过话）。
async function lastFollowUpIn(path: string): Promise<UserSeg | null> {
  for (const step of TAIL_STEPS) {
    const { text, whole } = await readTail(path, step);
    const hit = parseSessionOutput(text).filter(isFollowUp).at(-1);
    if (hit || whole) return hit ?? null;
  }
  return null;
}

function toFollowUp(taskId: string, seg: UserSeg): TaskFollowUp {
  const { body, paths } = parseAttachmentText(seg.text);
  const text = body.trim();
  return {
    taskId,
    text: text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text,
    truncated: text.length > TEXT_CAP,
    // 真人发言的时间来自它自己那条围栏；老会话（写围栏之前跑的）没有，那就如实
    // 给 null —— 前端退回任务的 updatedAt，不在这里编一个时间出来。
    at: seg.at ?? null,
    attachments: paths,
  };
}

// 一批任务各自「我发的最后一条追问」。找不到（没跑过 / 文件没了 / 我压根没插过话）
// 的任务直接不出现在结果里 —— 前端据此显示「还没追问过」，而不是把读盘失败伪装成空。
export async function followUpsFor(taskIds: string[]): Promise<TaskFollowUp[]> {
  const unique = [...new Set(taskIds.filter((id) => typeof id === "string" && id))];
  if (!unique.length) return [];
  const rows = await db
    .select({ id: sessions.id, taskId: sessions.taskId, startedAt: sessions.startedAt })
    .from(sessions)
    .where(inArray(sessions.taskId, unique))
    .orderBy(desc(sessions.startedAt));
  // 一个任务可能跑过很多轮；startedAt 倒序后每个任务取最近的几次，新的排前面。
  const recent = new Map<string, string[]>();
  for (const row of rows) {
    const list = recent.get(row.taskId) ?? [];
    if (list.length >= MAX_SESSIONS) continue;
    list.push(row.id);
    recent.set(row.taskId, list);
  }

  const results = await Promise.all([...recent].map(async ([taskId, sessionIds]) => {
    for (const sessionId of sessionIds) {
      try {
        const seg = await lastFollowUpIn(sessionTranscriptPath(taskId, sessionId));
        if (seg) return toFollowUp(taskId, seg);
      } catch {
        // 这次会话的正文读不动（被删了/权限），往前一次接着找。
      }
    }
    return null;
  }));
  return results.filter((row): row is TaskFollowUp => row !== null && row.text.length + row.attachments.length > 0);
}
