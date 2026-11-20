import type { QuestionItem } from "./index.ts";

export type QuestionSource = {
  question?: string | null;
  questionOptions?: string[] | null;
  questionItems?: QuestionItem[] | null;
};

export type QuestionAnswerInput = {
  answers?: string[];
  questionKey?: string;
  /** 答的是哪一次提问（server 的 questionOccurrenceOf）；同样的题再问一次，旧的身份答不中新的。 */
  questionOccurrence?: string;
};

export type QuestionRecord = QuestionSource & {
  id: string;
  answeredAt: string;
  answer: string;
  answers?: string[];
  reply: string;
  /**
   * `reply` 还没交给智能体：等着的那一批派活处理完、说定了「派完就算完成」时不叫醒它（shared/dispatch-suggestion.ts `DispatchWait`），
   * 这段留到这条任务下一回合开头一并交给它，交过就摘掉（server/src/undelivered-replies.ts）。
   */
  undelivered?: true;
  /** 派完就算完成，这条任务还欠的那一下（跟派出同一笔落库，server/src/dispatch-suggestion-settle.ts 消费）。 */
  settleOwed?: LaunchSettleDebt;
  /** 用户删掉了这条答复（server/src/conversation-redact.ts）：只留 id 与时刻，问答正文已清空。 */
  deleted?: true;
  /** 删的是会话里哪一段（会话行 + 段序号；删除不挪段序号）。正文还没换成墓碑时靠它认回原主。 */
  deletedFrom?: { sessionId: string; index: number };
  /**
   * 等着的那一批派活处理完、真建了任务的那一下（server dispatch-suggestion-resolve.ts 写，只有它写）：建好了哪几条。
   * 会话里按它画成每条一句「开了新任务」，不画「你」的气泡（shared/dispatch-suggestion.ts `dispatchLaunchOf`）——
   * 认的是这一列，不看正文：用户在普通问答里贴一段派出回执，也只是一句普通答复。
   */
  dispatchLaunch?: DispatchLaunchTask[];
};

/**
 * 「派完就算完成」欠下的两段：`complete` = 还没结成完成；`followUp` = 完成已经落下，结算后续（预约的审查、
 * 推进链）还没交付——两段各自落库，后一段做成了才销账。`epoch` / `from` 是派出那一刻的方向世代与状态：
 * 之后起过新回合、被引导过、状态被别处改过，这份授权就过期了，不能越过后来的决定。
 */
export type LaunchSettleDebt = { stage: "complete" | "followUp"; epoch: number; from: string };

/** 派出去建好的一条：任务号、标题、交给了谁（读成一句人话的执行器名）。 */
export type DispatchLaunchTask = { id: string; title: string; agent: string };

/** 会话里的一句真人输入，拿去对问答记录（`answerIds` 见 session-output.ts 的 ConvSeg）。 */
export type AnswerMessage = {
  key: string;
  text: string;
  answerIds?: readonly string[];
  source?: { sessionId: string; index: number };
};

/**
 * 会话里的答复 ↔ 问答历史里的记录。服务端删除（conversation-redact.ts）与问答卡共用这一份，
 * 两边认的是同一条。依次三档：
 *  1. 这句话上写着 `answerIds`（发出答复时就记下的记录 id）—— 只认它；
 *  2. 墓碑记着自己删的是哪一段（`deletedFrom`）—— 删到一半（问答记录已清、正文没换成）时
 *     那一段仍归这条墓碑，不会被挪给另一条同文记录；
 *  3. 都没有（有 `answerIds` 之前的老会话）：同文的按出现先后与记录的答复先后一一对上，
 *     前两档认走的记录不参与。
 * `unpaired`：没有出处可对的未删记录（会话里那句话不在这几条会话里）。
 */
export function pairAnswerMessages(records: readonly QuestionRecord[], messages: readonly AnswerMessage[]): {
  paired: Map<string, QuestionRecord>;
  unpaired: QuestionRecord[];
} {
  const byId = new Map(records.map((record) => [record.id, record]));
  const claimed = new Set(messages.flatMap((message) => message.answerIds ?? []));
  const paired = new Map<string, QuestionRecord>();
  const legacy: AnswerMessage[] = [];
  for (const message of messages) {
    if (message.answerIds?.length) {
      const own = message.answerIds.map((id) => byId.get(id)).find((record) => record);
      if (own) paired.set(message.key, own);
      continue;
    }
    const source = message.source;
    const from = source && records.find((record) =>
      record.deletedFrom?.sessionId === source.sessionId && record.deletedFrom.index === source.index);
    if (from) {
      paired.set(message.key, from);
      claimed.add(from.id);
      continue;
    }
    legacy.push(message);
  }
  const pool = records.filter((record) => !record.deleted && !claimed.has(record.id))
    .sort((left, right) => left.answeredAt.localeCompare(right.answeredAt));
  for (const message of legacy) {
    const at = pool.findIndex((record) => record.reply === message.text);
    if (at < 0) continue;
    paired.set(message.key, pool[at]!);
    claimed.add(pool[at]!.id);
    pool.splice(at, 1);
  }
  return { paired, unpaired: records.filter((record) => !record.deleted && !claimed.has(record.id)) };
}

/**
 * 提问那一轮结算时落进会话的两句说明的起头（server 的 settle-status.ts 写，question-settle-notes.ts
 * 拼）。服务端靠它认「这道题是在哪种回合里问的」（legacy-answer-intent.ts）；界面靠它认出这句话问的
 * 是哪道题——那道题此刻在答题卡上、或者已经跟着答案留在你那颗气泡里，这句就不再抄一遍（题目没别处
 * 可看时照画，比如收起答题卡改发了一句别的、旧题被撤下）。
 */
export const FOLLOW_UP_QUESTION_HEAD = "续聊回合以提问结束,等待答复:";
export const PAUSED_QUESTION_HEAD = "本回合以提问暂停,等待答复:";

/** 这句结算说明里问的那道题（原样），不是这两种说明就是 null。 */
export function settleNoteQuestion(text: string): string | null {
  const said = text.replace(/^〔系统〕/, "").trim();
  if (said.startsWith(`${PAUSED_QUESTION_HEAD}「`) && said.endsWith("」")) {
    return said.slice(PAUSED_QUESTION_HEAD.length + 1, -1);
  }
  const followUp = /」\(任务状态仍为「[^」]*」\)$/.exec(said);
  if (said.startsWith(`${FOLLOW_UP_QUESTION_HEAD}「`) && followUp) {
    return said.slice(FOLLOW_UP_QUESTION_HEAD.length + 1, followUp.index);
  }
  return null;
}

export function questionItems(source: QuestionSource): QuestionItem[] {
  return source.questionItems?.length
    ? source.questionItems
    : [{ question: source.question ?? "", options: source.questionOptions ?? undefined }];
}

export function questionKey(source: QuestionSource): string {
  return JSON.stringify([source.question ?? "", source.questionOptions ?? [], source.questionItems ?? []]);
}

export function formatQuestionAnswers(answers: readonly string[]): string {
  if (answers.length === 1) return answers[0]!.trim();
  return answers.map((answer, index) => `${index + 1}. ${answer.trim() || "（未答）"}`).join("\n");
}

/**
 * 答题卡上一题的答复：勾了的那几项按选项顺序一项一行，补充的话接在最后一行。跟从前「勾选把那句话
 * 落进输入框」拼出来的是同一种形状——智能体收到的字、已答气泡认「选了哪几项」（questionOptionSelected，
 * 按整行认）都照旧。
 */
export function joinQuestionAnswer(options: readonly string[], picked: ReadonlySet<number>, note: string): string {
  return [...options.filter((_option, index) => picked.has(index)), note.trim()].filter(Boolean).join("\n");
}

export function questionOptionSelected(value: string, option: string): boolean {
  return `\n${value.trim()}\n`.includes(`\n${option}\n`);
}

export function legacyQuestionRecord(text: string, id: string, at = ""): QuestionRecord | null {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const prefix = /^【答复】\s*你之前的提问[:：]\s*「/.exec(normalized);
  if (!prefix) return null;
  let depth = 1;
  let end = prefix[0].length;
  for (; end < normalized.length; end += 1) {
    if (normalized[end] === "「") depth += 1;
    if (normalized[end] === "」" && --depth === 0) break;
  }
  if (depth || !/^\s*\n/.test(normalized.slice(end + 1))) return null;
  const question = normalized.slice(prefix[0].length, end).trim();
  const answer = normalized.slice(end + 1).trim()
    .replace(/\n\s*\n请据此(?:继续完成任务|接着安排)。$/, "").trim();
  if (!answer) return null;
  const parts = [...answer.matchAll(/(?:^|\n\n)【\d+】([\s\S]*?)\n答：([\s\S]*?)(?=\n\n【\d+】|$)/g)];
  return {
    id, answeredAt: at, question, answer, reply: text,
    ...(parts.length ? {
      questionItems: parts.map((part) => ({ question: part[1]! })),
      answers: parts.map((part) => part[2] === "(未答)" ? "" : part[2]!),
    } : { answers: [answer] }),
  };
}

export function isQuestionAnswer(text: string): boolean {
  return text.trimStart().startsWith("【答复】");
}
