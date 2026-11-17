// R 键那张「我说过的话」：跨全部任务、按时间倒序列出真人自己打的每一句（原始需求 + 每次追问）。
// 判据跟会话左侧的输入导航、侧栏铺开那一列同一份（isUserFollowUp）；端点 GET /user-messages。

/**
 * 一句话在会话里的位置。`sessionId + index` 是它在那条会话 .md 里的段号（parseSessionSpans 的
 * 下标，含删掉的段），页面上每颗用户气泡的出处（ConversationSource）记的就是这一对，落点靠它认；
 * 原始需求不在会话里，两样都是 null。
 */
export interface UserMessage {
  /** 列表里的稳定 key，也是翻页游标的一半。 */
  id: string;
  taskId: string;
  sessionId: string | null;
  index: number | null;
  /** 已摘掉附件块的正文，超长截断。 */
  text: string;
  truncated: boolean;
  attachments: string[];
  /** 发言时刻；老会话没写的退回会话开始时刻，原始需求是任务创建时刻。 */
  at: string;
}

/** 这一页里出现过的任务，列表上要露的那几样（前端手里有实时的那份就用实时的）。 */
export interface UserMessageTask {
  id: string;
  title: string;
  status: string;
  projectId: string;
  archived: boolean;
}

export interface UserMessagePage {
  messages: UserMessage[];
  tasks: UserMessageTask[];
  /** 下一页的游标；null = 到底了。 */
  next: string | null;
}

/** 一页多少条。 */
export const USER_MESSAGE_PAGE = 60;

/**
 * 一句话前后的对话（GET /user-messages/context）：智能体上一段说到哪（取末尾）、这一轮它怎么回的
 * （取最后那段正文的开头）。都截过；没有就是 null。
 */
export interface UserMessageContext {
  before: { text: string; truncated: boolean } | null;
  after: { text: string; truncated: boolean } | null;
}
