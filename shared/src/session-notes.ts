// 会话轮换说明的**唯一真相来源**。住在 shared 而不是 server,是因为前端要**认得出**
// 这几条:`noteTone` 只按关键词判语气,而这两条文案里本来就带「异常」(它们在转述
// Codex 报的那个 rollout/world-state 异常),于是一条「ash 已经替你换好会话了」的旁注
// 被画成红色,用户读成执行失败(自由工作流第 2 轮审查 P1 第一层)。
//
// 措辞放在这里、判据也放在这里:改文案时不用再想着去同步前端那张关键词表。
// server 侧仍从 `executors/session-lost.ts` 导出同名常量(它再从这里转出去),
// 老的 import 路径一个都不用动。

/**
 * 清掉失效 id 之后写给用户的那句话。
 *
 * 得说清三件事，少一件用户就会以为是随机失败：id 为什么会失效、ash 替他做了什么、
 * 下一次运行跟这一次有什么不同（**上下文不会带过来**——这是他有权提前知道的代价）。
 *
 * 措辞里**不许出现 Markdown 标记**:这三条现在都以 system 旁注呈现,而三处渲染点
 * (`ConversationFeed`、`TeamFeed`、duet 的 `duet-turn-notice`)都是纯文本 —— 写了
 * `**全新会话**`,用户看到的就是带星号的字面量。web 的 conversation-notes 回归钉着这条。
 */
export const SESSION_LOST_NOTE =
  "上一轮记下的 CLI 会话 id 在 CLI 那边已经不存在了（多半是第一次起跑就失败、"
  + "会话压根没建起来，也可能是 CLI 的会话记录被清过或换了机器/目录）。"
  + "ash 已经把这个失效的 id 清掉：再点一次运行会开一条全新会话，"
  + "之前的上下文不会带过来，任务正文和历史记录都还在。";

export const SESSION_POISONED_NOTE =
  "Codex 已在本轮 stderr 中报告这条 thread 的回合关联、world-state 或 rollout 落盘异常；"
  + "即使进程 exit 0 且发出 turn.completed，也不能再把它当作可恢复会话；"
  + "会话轮换不改变本回合真实的退出原因。"
  + "ash 已清掉这条会话的恢复字段：下一次运行会从任务正文自动开启一条全新会话，"
  + "旧对话与执行记录仍保留，但之前的上下文不会带过去。";

/**
 * 这条**不是**轮换说明:恢复字段没写进数据库,下一次可能再撞旧会话 —— 真出了问题,
 * 该红就红。所以它刻意不进 `isSessionRotationNote`。
 */
export const SESSION_DROP_PERSISTENCE_FAILED_NOTE =
  "ash 已停止本次进程继续使用这条失效的 CLI 会话；但恢复字段写入数据库失败，"
  + "下一次重新开台时可能再次尝试旧会话。";

/**
 * `executors/diagnostics.ts` 里 poisoned 诊断的固定前缀 —— 跟上面两条说的是同一件事的
 * 另一半(诊断说「为什么判它坏了」,说明说「ash 替你做了什么」),两条都要中性。
 *
 * 单拎出来当判据,是因为诊断正文由 stderr 指纹拼出来、以后还会加新指纹:哪天有一条
 * 写了「异常」,这条中性旁注就会无声地变红。认前缀就不吃这个亏。
 */
export const SESSION_POISON_DIAGNOSIS_PREFIX = "Codex 会话诊断：session=poisoned_session";

/**
 * 这条旁注在讲「ash 已经替你换了一条会话」吗。
 *
 * 用 `includes` 而不是相等:服务端会在前面接一句上下文(「更正上面那条…」「调度台进程
 * 意外退出(exit 1)。」),说的还是同一件事。
 */
export function isSessionRotationNote(text: string): boolean {
  return text.includes(SESSION_LOST_NOTE)
    || text.includes(SESSION_POISONED_NOTE)
    || text.includes(SESSION_POISON_DIAGNOSIS_PREFIX);
}
