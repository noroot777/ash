// 会话流里那些不是「谁说的话」的行：预约审查、验收阶段更新、合并&清理完成、
// 验证轮开始/结束、预览起停…… 服务端有 70 多处 appendTaskTimeline 写它们，文案各写各的，
// 所以这里**只按关键词判语气，不判结构**——判错了最多是颜色不对，不会把会话切错段。
//
// 结构由 conversationModel 统一决定：
//   note     旁注,贴着上一段说话继续,不重复头像/执行器名(system 时间线通告都归这档)
//   boundary 回合边界(本轮执行结束 / 执行异常结束 / 本回合结束),保留整宽横线
import { SESSION_POISON_DIAGNOSIS_PREFIX, stripSessionNotes } from "@ash/shared/session-notes";

// notice = 结算说明（「这一轮为什么落成这个状态」）。它由服务端**显式标记**（事件和落盘
// 行上的 level:"notice"），不参与下面的关键词推断 —— 这类说明里天然带着「未完成」，猜出
// 来永远是红的，而一条红字对第一次用 ash 的人只有一个读法：它崩了。
export type ConversationEventTone = "neutral" | "error" | "notice";
export type ConversationEventVariant = "note" | "boundary";
// 只收「这件事没办成」的词。「未通过」是审查结论、也确实要显眼,归红;
// 「通过」「完成」「开始」这类正常推进不进表。
const FAILED_HINTS = [
  "失败",
  "异常",
  "未通过",
  "没通过",
  "未完成",
  "打回",
  "暂缓",
  "已取消",
  "没起来",
  "起不来",
  "用完了",
  "警告",
  "错误",
];

export function noteTone(text: string): ConversationEventTone {
  // poisoned 诊断整条都在**转述** Codex 报的 rollout/world-state 异常,自己带着「异常」
  // 二字,讲的却是「为什么判这条会话坏了」——不是这一轮失败。它的正文由 stderr 指纹拼
  // 出来、以后还会加新指纹,摘不干净,所以认前缀先拦一道(@ash/shared/session-notes)。
  if (text.includes(SESSION_POISON_DIAGNOSIS_PREFIX)) return "neutral";
  // 会话轮换旁注（「这条 CLI 会话接不回了，下次开新的」）是中性事实，不是本回合失败：
  // 它照样会出现在一个 exit 0 的成功回合、甚至用户自己点的「停止全组」上。文案里带着
  // 「异常」这类词，蹭上关键词表就成了红的。判据用 @ash/shared/session-notes 那份**同一
  // 源文本**，不靠「写文案时记得绕开那几个词」。
  // 摘掉再判、而不是「含轮换旁注就中性」：收尾那句是拼出来的，后半段可能正是「恢复字段
  // 写入数据库失败」这类真失败，整句判中性会把它一起洗白。
  return FAILED_HINTS.some((hint) => stripSessionNotes(text).includes(hint)) ? "error" : "neutral";
}

// 「这条旁注在讲一轮审查的事吗，是开头还是结尾，第几轮」—— 会话里验证段的起止就是
// 这两条旁注，跟审查者的气泡同一套青色，读者才看得出它们是一段；轮次号还要拿来补给
// 气泡上的徽标。
//
// 两种审查在时间线上各写各的话：就地验证写「第 N 轮验证…」（review.ts），自由派审写
// 「自由工作流第 N 轮审查…」（free-workflow.ts）。两边分开认，因为它们能推出的东西不
// 一样：就地验证是搭在被验任务自己会话上的，区间内说话的那个人**就是**审查者；自由
// 派审另开一条 reviewer 会话，区间只能用来补轮次，不能拿来改别人的身份。
//
// 跟 noteTone 一样**只认关键词**：措辞由服务端那两处定，判错了最多是竖条颜色不对，
// 不会把会话切错段。
export type VerifyNoteMark = {
  kind: "inline" | "free" | "merge";
  round: number | null;
  phase: "start" | "end";
};

const VERIFY_NOTE = /(自由工作流)?第\s*(\d+)\s*轮(验证|审查)/;
// 收尾时不带轮号的那几条：复审次数用完、验证打回本身报错。
const TAILS = /自由工作流审查仍未通过|验证打回/;
// 合并结果审查（post-merge-review.ts）跑在验收后的只读快照上，从头到尾没有轮号，
// 所以只能按前缀认。这里**不能**跟上面一样只认关键词：「合并结果审查临时工作区清理
// 失败」「已从合并结果审查创建独立修复任务」都带同一个词却不是这一轮的起止，认宽了
// 会把审查段切碎。故起止各用一张白名单，只收服务端确实写过的那几句。
const MERGE_START = /^合并结果审查(开始|重跑上一回合)/;
const MERGE_END = /^合并结果审查(通过|未通过|未能正常给出结论|启动失败)/;
// 开区间的词：「开始」，以及「重跑上一回合」——它开的是同一轮的新回合，把它判成收口
// 的话，重跑后审查者的发言会整段掉出区间（没徽标、也进不了折叠卡）。
const STARTS = /开始|重跑上一回合/;

export function verifyNoteOf(text: string): VerifyNoteMark | null {
  const matched = VERIFY_NOTE.exec(text);
  if (matched) {
    const round = Number(matched[2]);
    return {
      kind: matched[1] ? "free" : "inline",
      round: Number.isFinite(round) ? round : null,
      // 收区间的是：通过 / 未通过 / 以…结束 / 启动失败 / 按意见发起修复，其中
      // 「启动失败」收的是一个根本没跑起来的区间。
      phase: STARTS.test(text) ? "start" : "end",
    };
  }
  if (MERGE_START.test(text)) return { kind: "merge", round: null, phase: "start" };
  if (MERGE_END.test(text)) return { kind: "merge", round: null, phase: "end" };
  if (TAILS.test(text)) return { kind: "free", round: null, phase: "end" };
  return null;
}

export function isVerifyNote(text: string): boolean {
  return !!verifyNoteOf(text);
}

// worktree 被验收清理后，用户继续追问会触发这一条持久系统回执。它不是警告，也不是
// 新的一段对话；渲染层只把这条已知文案收成一行中性恢复记录，其他系统旁注保持原样。
export function isWorkspaceRecoveryNote(text: string): boolean {
  return text.includes("原工作目录(worktree 与分支)已不存在")
    && text.includes("已重建为空目录");
}
