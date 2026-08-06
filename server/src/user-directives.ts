// 任务跑起来之后**我自己在对话框里改的需求**，整理成一段交给验证者。
//
// 为什么非送不可：验证协议里的「目标正文」是 `tasks.body`，那是建任务那一刻的原始
// 需求，而对话框里改的需求从来不写回它。同一个 agent 回头验自己时这不成问题（追加的
// 话就在它自己的会话上下文里），可验证站一旦换了执行器，那是一条**全新会话** —— 它
// 只拿到原始正文，于是拿一份已经作废的需求打回一个正确的产物。
// 2026-08-06 实测过一次：用户 8/5 说「把『走到哪一步』这一列删掉」，第二天 codex 验收
// 时照着原始正文里的「多出来的位置就写上当前走到那一步」判了 verify_failed。
//
// 边界写死在这里：**只送真人自己打的字，一个字的 agent 发言都不送**。判据复用
// `isUserFollowUp`（与详情页「后续追问」、侧边栏铺开那一列同一份），因为
// `peer-context.ts` 那条决策仍然成立 —— 实现者的自辩不该先入为主地塞给审查者，那是
// 它自己该去挖的。但用户改的需求跟 `tasks.body` 是同一类东西，它从来就不是「别人的
// 上下文」；当初把这两样打包成「你自己判断要不要读」，漏的就是这一半。
import { open, stat } from "node:fs/promises";
import type { ConvSeg } from "@harness/shared";
import { isUserFollowUp, parseSessionOutput } from "@harness/shared";
import { parseAttachmentText } from "@harness/shared/attachments";
import { asc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { sessionTranscriptPath } from "./transcript.js";

export type UserDirective = {
  /** 真人那条围栏自带的时刻；写围栏之前的老会话没有，如实给 null 而不是编一个。 */
  at: string | null;
  text: string;
  /** 用户贴的截图/文件的绝对路径 —— 需求的一部分，验证者要能点开看。 */
  attachments: string[];
};

/** 带排序键的中间形态。`key` 只用来排序，不外露给提示词。 */
export type TimedDirective = UserDirective & { key: string };

export type CollectedDirectives = {
  /** 按时间先后排好，只保留最新的 MAX_ITEMS 条。 */
  items: UserDirective[];
  /** 因为条数上限被丢掉的更早的条数。**必须说出来**，不能悄悄砍。 */
  omitted: number;
  /** 会话正文太大只读了尾巴 —— 更早的追问可能压根没被扫到。同样要说出来。 */
  truncated: boolean;
  /** 完整记录的落盘路径，给验证者留一条自己去翻的路。 */
  transcripts: string[];
};

// 一条追问再长，进 prompt 也没必要全文照搬；超了截断并留省略号，验证者要全文可以去翻
// 原始记录（路径就在同一段话里给了）。
const TEXT_CAP = 700;
// 最多带几条。取**最新的**：需求是一路往后改的，越晚的越接近现在有效的那一版。
const MAX_ITEMS = 30;
// 单个会话正文读多少。.md 只存 assistant 正文和围栏（工具输出不进来），实测一个长任务
// 也就几十 KB，这个上限基本碰不到 —— 留着是防一个跑飞的任务把整个 prompt 撑爆。
const MAX_FILE_BYTES = 8 * 1024 * 1024;

async function readTranscript(path: string): Promise<{ text: string; whole: boolean }> {
  const info = await stat(path);
  const handle = await open(path, "r");
  try {
    const length = Math.min(info.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const text = buffer.toString("utf8");
    const whole = length >= info.size;
    // 从中间切进去时第一行多半是半截字（还可能劈开一个 UTF-8 字符），丢掉。
    return { text: whole ? text : text.slice(text.indexOf("\n") + 1), whole };
  } finally {
    await handle.close();
  }
}

/**
 * 一份会话正文里我说过的所有话，保持文件内的先后顺序，并给每条算一个排序键。
 *
 * 键取「这条自己的 `at`」，没有就沿用**同一份文件里前一条**的 `at`，再没有就退到会话
 * 的 `startedAt`。这是个单调下界：同一份文件内写入顺序就是时间顺序，所以沿用前一条只会
 * 让缺时刻的老围栏跟着它前面那条走，不会把文件内顺序搅乱。
 */
export function directivesIn(raw: string, sessionStartedAt: string): TimedDirective[] {
  let floor = sessionStartedAt;
  return parseSessionOutput(raw)
    .filter((seg): seg is Extract<ConvSeg, { kind: "user" }> => isUserFollowUp(seg))
    .map((seg) => {
      if (seg.at) floor = seg.at;
      const { body, paths } = parseAttachmentText(seg.text);
      return { at: seg.at ?? null, text: body.trim(), attachments: paths, key: floor };
    })
    .filter((item) => item.text.length > 0 || item.attachments.length > 0);
}

/**
 * 把各会话的条目合成一条时间线。**必须按时刻排，不能按会话先后拼**：一条会话可以被
 * 反复 resume（`continueTask` 复用同一行、`startedAt` 不动，只刷 `turnStartedAt`），
 * 所以「先开的会话」里完全可能有比「后开的会话」更晚的话。
 *
 * 真实形状：claude 会话 A 里说 X → @ 来 codex 开会话 B 说 Y → 切回 A 说 Z。按会话拼
 * 得到 X、Z、Y，而提示词紧接着写着「按时间先后，冲突以更晚的为准」—— 验证者会据此认定
 * Y 推翻了 Z，正好把最新的需求当成作废的。
 */
export function orderDirectives(items: TimedDirective[]): UserDirective[] {
  return items
    .map((item, index) => ({ item, index }))
    // 同一时刻并列时退回原始下标（会话顺序 + 文件顺序），保证结果稳定可复现。
    .sort((a, b) => a.item.key.localeCompare(b.item.key) || a.index - b.index)
    .map(({ item }) => ({ at: item.at, text: item.text, attachments: item.attachments }));
}

/**
 * 把上限应用到收集结果上。**丢掉的条数原样带出去**（AGENTS.md 那条：静默截断会让人
 * 以为「就这些了」），截断的是最早的几条 —— 需求一路往后改，最新的那几条才是现在有效的。
 */
export function capDirectives(
  items: UserDirective[],
  transcripts: string[],
  truncated: boolean,
): CollectedDirectives {
  const kept = items.slice(-MAX_ITEMS).map((item) => ({
    ...item,
    text: item.text.length > TEXT_CAP ? `${item.text.slice(0, TEXT_CAP)}…（此条已截断）` : item.text,
  }));
  return { items: kept, omitted: Math.max(0, items.length - kept.length), truncated, transcripts };
}

/**
 * 一个任务里我追加过的全部需求。**跨会话**收集：换过执行器、重试过、被打断续跑过的
 * 任务在盘上是好几份 .md，我的话散在各份里，只读最近那一份会漏。
 */
export async function collectUserDirectives(taskId: string): Promise<CollectedDirectives> {
  const rows = await db
    .select({ id: sessions.id, startedAt: sessions.startedAt })
    .from(sessions)
    .where(eq(sessions.taskId, taskId))
    .orderBy(asc(sessions.startedAt));

  const items: TimedDirective[] = [];
  const transcripts: string[] = [];
  let truncated = false;
  for (const row of rows) {
    const path = sessionTranscriptPath(taskId, row.id);
    try {
      const { text, whole } = await readTranscript(path);
      // 截断标记要**先于**「这份有没有找到东西」记下：一份超大会话的尾部没有真人追问，
      // 不代表它更早的地方也没有 —— 那正是最需要说出来的情况。
      if (!whole) truncated = true;
      const found = directivesIn(text, row.startedAt);
      items.push(...found);
      // 贡献了条目、或者可能藏着没扫到的条目，才值得把路径列给验证者。
      if (found.length || !whole) transcripts.push(path);
    } catch {
      // 这份正文读不动（被删了 / 权限）——跳过它，别让一份坏文件把整段上下文废掉。
    }
  }
  return capDirectives(orderDirectives(items), transcripts, truncated);
}

/** 拼成能直接塞进 prompt 的一段。没有追问、也没扫漏，就是空串（不留一句「（无）」占地方）。 */
export function formatDirectives(collected: CollectedDirectives): string {
  if (!collected.items.length) {
    // 一条都没收到**且**扫过的正文都是完整的 —— 这才是真的「没有追加需求」。
    if (!collected.truncated) return "";
    // 否则是「没扫到」，跟「没有」不是一回事：不说出来，验证者会当成后者。
    return `【任务开始之后我追加的需求变更】\n` +
      `没能读全：会话正文过大，只扫了尾部，更早的地方可能有改过的需求没收进来。` +
      `涉及原始正文之外的判断时，请自己去翻：${collected.transcripts.join("、") || "(记录路径不可用)"}\n\n`;
  }
  const lines = collected.items.map((item, index) => {
    const when = item.at ? `[${item.at}] ` : "";
    const files = item.attachments.length
      ? `\n   附带文件（需求的一部分，可以直接打开看）：${item.attachments.join("、")}`
      : "";
    return `${index + 1}. ${when}${item.text}${files}`;
  });
  const notes: string[] = [];
  if (collected.omitted > 0) {
    notes.push(`更早的 ${collected.omitted} 条未列出（只带最近 ${MAX_ITEMS} 条）`);
  }
  if (collected.truncated) notes.push("会话正文过大，只扫了尾部，更早的追问可能没收进来");
  if (notes.length) {
    notes.push(`完整记录在：${collected.transcripts.join("、")}`);
  }
  return `【任务开始之后我追加的需求变更】（按时间先后；与上面的原始正文**同等效力**，两者冲突时以更晚的为准）\n` +
    `原始正文是建任务那一刻写的，之后改的需求不会回写到它 —— 所以只照着上面那段验，会把已经按新要求改对的产物判成不合格。\n` +
    `${lines.join("\n")}\n` +
    (notes.length ? `（${notes.join("；")}）\n` : "") +
    `\n`;
}

/** 一站式：给提示词用。 */
export async function userDirectivesFor(taskId: string): Promise<string> {
  return formatDirectives(await collectUserDirectives(taskId));
}
