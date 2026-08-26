/**
 * 会话轮换旁注的**唯一真相源**（服务端写、前端判色，对着同一份文本）。
 *
 * 这几句讲的都是同一件事：这条 CLI 会话接不回了，下一次会开新的。它**不是本回合失败** ——
 * 一个 exit 0 的正常回合、甚至用户自己点的「停止全组」，都可能带上一句。于是两端各有一条
 * 硬要求：
 *
 * · 服务端按 scope 把它降成 system 旁注（`team/session.ts`、`single-run.ts`、`duet/turn.ts`）；
 * · 前端 `noteTone` 必须把它判成中性。前端那张表是**通用关键词表**（「异常」「失败」…），
 *   措辞里蹭上任何一个词，用户就会在一个成功交卷的回合上看到一笔红色「执行异常」。靠
 *   「以后写文案时绕开那几个词」是守不住的，所以把文本本身共享出来，让前端按身份认。
 *
 * 还有一条**渲染约束**：旁注在会话流里是纯文本的一行小字（`ConversationFeed` 的
 * `conversation-note`，`<p>{item.text}</p>`），所以正文里不能有 Markdown 标记 —— 写了
 * `**全新会话**`，用户看到的就是两侧的星号（2026-08-26 第 7 轮审查）。
 */

/**
 * CLI 说「这条会话我不认识」之后写给用户的那句话。
 *
 * 得说清三件事，少一件用户就会以为是随机失败：id 为什么会失效、ash 替他做了什么、
 * 下一次运行跟这一次有什么不同（上下文不会带过来——这是他有权提前知道的代价）。
 */
export const SESSION_LOST_NOTE =
  "上一轮记下的 CLI 会话 id 在 CLI 那边已经不存在了（多半是第一次起跑就失败、"
  + "会话压根没建起来，也可能是 CLI 的会话记录被清过或换了机器/目录）。"
  + "ash 已经把这个失效的 id 清掉：再点一次运行会开一条全新会话，"
  + "之前的上下文不会带过来，任务正文和历史记录都还在。";

/** Codex 报出恢复 thread 已不可续（poisoned）之后写给用户的那句话。 */
export const SESSION_POISONED_NOTE =
  "Codex 已在本轮 stderr 中报告这条 thread 的回合关联、world-state 或 rollout 落盘出了问题；"
  + "即使进程 exit 0 且发出 turn.completed，也不能再把它当作可恢复会话；"
  + "会话轮换不改变本回合真实的退出原因。"
  + "ash 已清掉这条会话的恢复字段：下一次运行会从任务正文自动开启一条全新会话，"
  + "旧对话与执行记录仍保留，但之前的上下文不会带过去。";

/** 中途已经播过完整轮换说明后，收尾那两句只补一个指路，不重复整段。 */
export const ROTATION_ALREADY_ANNOUNCED = "这条 CLI 会话此前已被作废，下次运行会开全新会话。";

/**
 * 手上压根没有可续会话 id 时的指路。跟上面那条的区别是**为什么**接不回：这条不是
 * 「作废了」，而是「还没建起来，或者建起来了却没写进库」。
 */
export const NO_RESUMABLE_SESSION_NOTE =
  "这台调度台没有可续的 CLI 会话 id（还没建起来，或者它没能写进数据库），"
  + "下次运行会开一条全新会话：之前的上下文不会带过来，任务正文和历史记录都还在。";

/** 这几句是「会话换了」的中性事实，不是失败。前端据此判中性。 */
export const NEUTRAL_SESSION_NOTES: readonly string[] = [
  SESSION_LOST_NOTE,
  SESSION_POISONED_NOTE,
  ROTATION_ALREADY_ANNOUNCED,
  NO_RESUMABLE_SESSION_NOTE,
];

/**
 * 把中性轮换旁注从一句话里摘掉，剩下的才交给关键词表判语气。
 *
 * 为什么不是「含轮换旁注就中性」：收尾那句是拼出来的（`更正上面那条：…` + 一段说明），
 * 而那段说明可能正是「恢复字段写入数据库失败」这类**真失败**。整句判中性就把真失败也
 * 洗白了；摘掉中性部分再判，两种句子各归各位。
 */
export function stripSessionNotes(text: string): string {
  let rest = text;
  for (const note of NEUTRAL_SESSION_NOTES) rest = rest.split(note).join("");
  return rest;
}
