import { open, stat } from "node:fs/promises";
import type { ConvSeg, TaskLastMessage } from "@harness/shared";
import { parseSessionOutput } from "@harness/shared";
import { parseAttachmentText } from "@harness/shared/attachments";
import { desc, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { sessionTranscriptPath } from "./transcript.js";

// 会话正文是一路追加的 Markdown，长的有几 MB。要的只是最后一段，所以只读尾巴。
// 64KB 足够兜住一条正常发言；真有超过这个长度的单条消息，截断的也是它的开头，
// 而卡片本来就只展示前面一截。
const TAIL_BYTES = 64 * 1024;
// 悬浮卡片显示的上限。再长的正文没人在悬浮里读，也不该为它撑大列表接口的响应。
const TEXT_CAP = 1200;

async function readTail(path: string): Promise<string> {
  const info = await stat(path);
  const handle = await open(path, "r");
  try {
    const length = Math.min(info.size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const text = buffer.toString("utf8");
    // 从中间切进去的话，第一行多半是半截字（可能还劈开了一个 UTF-8 字符），丢掉。
    return info.size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

// 「最新一条」取的是最后一段有内容的发言，不论谁说的；系统提示（继续/从中断处恢复）
// 不是发言，只有全场都没别的可说时才退而求其次。
function pickSegment(segs: ConvSeg[]): ConvSeg | null {
  for (let index = segs.length - 1; index >= 0; index -= 1) {
    const seg = segs[index]!;
    if (seg.kind !== "system" && seg.text.trim()) return seg;
  }
  return segs.filter((seg) => seg.text.trim()).at(-1) ?? null;
}

function toLastMessage(taskId: string, seg: ConvSeg): TaskLastMessage {
  const { body, paths } = parseAttachmentText(seg.text);
  const text = body.trim();
  return {
    taskId,
    who: seg.kind,
    text: text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text,
    truncated: text.length > TEXT_CAP,
    // agent 发言的时间来自它后面那条 agentEnd 围栏；老会话（写围栏之前跑的）没有这条，
    // 那就如实给 null —— 前端退回任务的 updatedAt，不在这里编一个时间出来。
    at: seg.kind === "agent" ? seg.endedAt ?? null : seg.at ?? null,
    attachments: paths,
  };
}

// 一批任务各自的最后一条消息。读不到（没跑过 / 文件没了 / 全是系统提示）的任务
// 直接不出现在结果里 —— 前端据此显示「还没有消息」，而不是把读盘失败伪装成空消息。
export async function lastMessagesFor(taskIds: string[]): Promise<TaskLastMessage[]> {
  const unique = [...new Set(taskIds.filter((id) => typeof id === "string" && id))];
  if (!unique.length) return [];
  const rows = await db
    .select({ id: sessions.id, taskId: sessions.taskId, startedAt: sessions.startedAt })
    .from(sessions)
    .where(inArray(sessions.taskId, unique))
    .orderBy(desc(sessions.startedAt));
  // 一个任务可能跑过很多轮；startedAt 倒序后第一条就是最新那次会话。
  const newest = new Map<string, string>();
  for (const row of rows) if (!newest.has(row.taskId)) newest.set(row.taskId, row.id);

  const results = await Promise.all([...newest].map(async ([taskId, sessionId]) => {
    try {
      const seg = pickSegment(parseSessionOutput(await readTail(sessionTranscriptPath(taskId, sessionId))));
      return seg ? toLastMessage(taskId, seg) : null;
    } catch {
      return null;
    }
  }));
  return results.filter((row): row is TaskLastMessage => row !== null && row.text.length + row.attachments.length > 0);
}
