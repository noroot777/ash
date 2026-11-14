// 提问那一轮结算时落进会话的两句说明(settle-status.ts 写,作为会话旁注持久化)。抽出来是因为
// 读端(legacy-answer-intent.ts)要靠它认出「这道题是在续聊回合里问的,还是执行回合里问的」——
// 那是这件事唯一不会被后续回合改写的持久记录,两边的字必须是同一份。
export const FOLLOW_UP_QUESTION_HEAD = "续聊回合以提问结束,等待答复:";
export const PAUSED_QUESTION_HEAD = "本回合以提问暂停,等待答复:";

export const followUpQuestionNote = (question: string, label: string) =>
  `${FOLLOW_UP_QUESTION_HEAD}「${question}」(任务状态仍为「${label}」)`;
export const pausedQuestionNote = (question: string) => `${PAUSED_QUESTION_HEAD}「${question}」`;
