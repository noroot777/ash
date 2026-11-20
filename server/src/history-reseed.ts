// 删过消息的会话，下一轮换一条新的 CLI 会话接着干：这里把删除之后留下的 .md 重建成历史，
// 当作那一轮的前言（删除本体在 conversation-redact.ts，接线在 orchestrator.ts 的 reseed）。
//
// 另一种用法是「接着做」没接回旧上下文（`turnHistory`）：重试的「接着做」、审查的「从中断处继续」
// 只有一句续跑提示，原话在旧 CLI 会话里。选会话那一步要是没续上旧 CLI 会话（会话 id 被清掉、
// 跨人的配置目录、codex 版本守卫换了新会话），新会话里就只剩「接着做」—— 指令丢了。这时拿那条
// 会话的 .md 重建，原话和做到一半的回复都在里面。
//
// 只重建「说过的话」：真人与后端代发的输入、哨兵的自动输入、agent 的回复、说给 agent 听的
// 系统注记（「继续」那一类）。任务时间线旁注和结算说明从来不在 agent 的上下文里，不放。
// 当时的工具调用细节也不放 —— .md 里本来没有，trace 里那份逐回合对齐成本高、量又大；
// 重建上下文要交代的是「谈到哪了」，现状让 agent 自己去工作目录看。
//
// 体积：保留末尾 HISTORY_BUDGET 字，更早的截掉并指给它完整记录的路径（那份 .md 已经抹掉了
// 被删的内容，读它不会把原话读回来）。
import { readFile } from "node:fs/promises";
import { parseSessionOutput, type ConvSeg } from "@navi/shared/session-output";
import { readableRunPath, sessionTranscriptPath } from "./transcript.js";

const HISTORY_BUDGET = 60_000;

function speaker(seg: ConvSeg): string | null {
  if (seg.kind === "agent") return "你";
  if (seg.kind === "system") return seg.aside || seg.level === "notice" ? null : "系统";
  if (seg.monitorWake) return "哨兵自动输入";
  return seg.bySystem ? "系统（代用户发送）" : "用户";
}

/**
 * 回合收尾时这条会话行的重建标记了不了结（`sessions.context_rebuild_at`，single-run.ts 收尾写库时并进去）。
 *
 * 只在这一轮在新 CLI 会话上完整、成功地跑完，且拿到了它的会话 id 时了结 —— 重建的历史这才确实
 * 存进了一条接得回的会话。进程起来不算：新 CLI 可能在 init / 收下历史之前就失败（认证、供应商
 * 连接），也可能被停、被引导、被判会话作废。这些情况标记都留着，下一轮照样拿删除后的记录重建，
 * 而不是退回只带任务正文从头开始。删除期间不可能有回合在跑，所以收尾时看到的标记就是这一轮
 * 起跑时兑现的那个。
 */
export function settleContextRebuild(turn: { succeeded: boolean; cliSessionId: string }): { contextRebuildAt?: null } {
  return turn.succeeded && turn.cliSessionId ? { contextRebuildAt: null } : {};
}

const REBUILT_BECAUSE = {
  redacted: "【上下文已重建】用户删除了这条会话里的部分消息。为了让被删的内容不再影响你，这一轮起你在一条新的 CLI 会话里继续："
    + "下面是删除之后留下的对话记录（只有说过的话，当时的工具调用细节不在其中，需要时请重新查看工作目录的现状）。"
    + "被删除的内容当作从未出现过，不要打听或试图还原。",
  lost: "【上下文已重建】你上一回合中途断了，原来那条 CLI 会话这一轮接不上，你在一条新的 CLI 会话里继续："
    + "下面是这条会话的对话记录（只有说过的话，当时的工具调用细节不在其中，做到哪一步请查看工作目录的现状）。",
} as const;

/**
 * 这一轮要垫在输入前面的重建历史（不需要就是空串）：删过消息（`reseed`）照旧重建；输入只在接回旧上下文
 * 时才说得通（`presumesContext`），而这一轮最终没续上旧 CLI 会话的，也拿那条会话的记录重建。判据必须
 * 在选完会话之后下 —— 续不续得上要到那一步才定（turn-session-pick.ts）。
 */
export async function turnHistory(input: {
  taskId: string; taskBody: string; reseed: boolean; cliResume: boolean;
  presumesContext?: boolean; prevId?: string; resumeSessionId?: string;
}): Promise<string> {
  if (input.reseed) return reseedHistory(input.taskId, input.prevId!, input.taskBody);
  const from = input.resumeSessionId ?? input.prevId;
  if (!input.presumesContext || input.cliResume || !from) return "";
  return reseedHistory(input.taskId, from, input.taskBody, "lost");
}

export async function reseedHistory(
  taskId: string, sessionId: string, taskBody: string, because: keyof typeof REBUILT_BECAUSE = "redacted",
): Promise<string> {
  const path = sessionTranscriptPath(taskId, sessionId);
  const raw = await readFile(readableRunPath(path), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const blocks = parseSessionOutput(raw).flatMap((seg) => {
    const who = speaker(seg);
    const text = seg.text.trim();
    const at = seg.kind !== "agent" && seg.at ? ` · ${seg.at}` : "";
    return who && text ? [`【${who}${at}】\n${text}`] : [];
  });
  const kept: string[] = [];
  let size = 0;
  for (const block of [...blocks].reverse()) {
    if (kept.length && size + block.length > HISTORY_BUDGET) break;
    const clipped = block.length > HISTORY_BUDGET ? `…${block.slice(-HISTORY_BUDGET)}` : block;
    kept.unshift(clipped);
    size += clipped.length;
  }
  const omitted = blocks.length - kept.length;
  return [
    REBUILT_BECAUSE[because],
    "",
    "<task-brief>",
    taskBody.trim(),
    "</task-brief>",
    "",
    "<conversation-history>",
    ...(omitted ? [`（更早的 ${omitted} 段已省略，完整记录见 ${path}）`, ""] : []),
    kept.join("\n\n"),
    "</conversation-history>",
    "",
    "以下是这一轮的新消息：",
    "",
    "",
  ].join("\n");
}
