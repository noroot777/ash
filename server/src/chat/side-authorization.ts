const quotedText = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu;
const target = "(?:主任务|主会话|主聊天|主对话)";
const politeness = "(?:(?:请你|请|麻烦|劳烦|现在|立即|马上|帮我|替我|帮忙|直接)\\s*)*";
const action = "(?:发给|发回|发送给|发送到|转发给|回传给|传给|告诉|转告|通知|同步给|同步到|交给|转交给)";
const englishTarget = "(?:the\\s+)?(?:main|parent)\\s+(?:task|chat|thread|conversation)";
const sendPatterns = [
  new RegExp(`^${politeness}(?:把|将).+?${action}${target}`, "u"),
  new RegExp(`^${politeness}${action}${target}`, "u"),
  new RegExp(`^${politeness}(?:给|向|跟)${target}(?:发(?:一?条|个)?消息|发送(?:一?条)?消息|说一声|说一下|回传|同步)`, "u"),
  new RegExp(`^(?:please\\s+)?(?:send|forward|relay)\\s+.+?\\s+to\\s+${englishTarget}\\b`, "iu"),
  new RegExp(`^(?:please\\s+)?(?:tell|notify)\\s+${englishTarget}\\b`, "iu"),
];

function proseOf(text: string): string {
  const prose = text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`|^\s*>.*$/gmu, "\uFFFC").trim();
  const quotes = [...prose.matchAll(quotedText)];
  const wrapper = quotes.length === 1 && quotes[0]![0] === prose.replace(/[。.!]$/u, "");
  return (wrapper ? quotes[0]![0].slice(1, -1) : prose).replace(quotedText, "\uFFFC");
}

function sendingInstruction(clause: string): boolean {
  for (const pattern of sendPatterns) {
    const matched = clause.match(pattern);
    if (!matched) continue;
    const rest = clause.slice(matched[0].length).trim();
    // 接收对象后只接语气词或显式正文，避免“主任务的结论/负责人”被当成绑定的主任务。
    if (!rest || /^[吧啊呀]$/u.test(rest) || /^[:：]\s*\S[\s\S]*$/u.test(rest)) return true;
  }
  return false;
}

function supplementalInstruction(clause: string): boolean {
  if (/^等(?:它|主任务)(?:跑完|完成|结束)再(?:看|检查|验证)$/u.test(clause)) return true;
  return /^(?:(?:后续|以后|之后|接下来|今后|现在|马上|立即|就|都|请|麻烦|同时|并且|并|再|也|比如|例如|优先|先)\s*)*(?:按|用|选|采用|继续|补|加|添加|修复|修正|调整|改|实现|保持|保留|删除|移除|检查|验证|测试|运行|执行|确保|让(?:它|主任务)|说明|解释|说一下|说一声|整理|汇总|总结|记录|标注|注意|记得)/u.test(clause)
    || /^(?:(?:and|then|please)\s+)*(?:use|choose|implement|continue|add|fix|keep|remove|check|test|run|explain|summarize|document)\b/iu.test(clause);
}

function hasReservation(prose: string): boolean {
  return /[?？]|如果|假如|假设|倘若|除非|要是|只要|只有|前提|视情况|看情况|是否|是不是|能否|会不会|不过|但是|然而|否则|不然/u.test(prose)
    || /不要|别|不必|不用|不准|禁止|先不|暂不|无需|不想|不能|不应该|不希望|[没未](?:有)?(?:要求|让|授权|发送)|算了|取消|撤回|撤销|作废|不对|不发|等等|等一下|等一等|再想|想想|考虑|缓一缓|缓缓|稍等|且慢|先停|暂停|稍后|下次|改天|过会|随口|随便说|开玩笑/u.test(prose)
    || /等(?:我|你|确认)|待.{0,12}确认|确认(?:后|之后)|(?:等.{0,20}再|以后).{0,8}(?:发|通知|告诉|回传|同步)/u.test(prose)
    || /引用|例子|演示|这句|说过|曾经|(?:已经|早就).{0,12}(?:发|告诉|通知)|[吗么呢](?:[。！.!\s]|$)/u.test(prose)
    || /\b(?:not|never|don't|do\s+not|if|unless|whether|wait|hold\s+on|later|previously|already|said|actually|maybe|perhaps|joking|kidding)\b/iu.test(prose);
}

export function sideForwardAuthorized(source: string, authorization: string): boolean {
  const quote = authorization.trim();
  if (!quote || !source.includes(quote)) return false;
  const prose = proseOf(source);
  // 检查当前消息的全部句子，模型截取的 authorization 不会缩小撤回/条件检查范围。
  if (hasReservation(prose)) return false;
  const clauses = prose.split(/[，,；;。！!\n.]/u).map((clause) => clause.trim()).filter(Boolean);
  const authorized = proseOf(quote).split(/[，,；;。！!\n.]/u).map((clause) => clause.trim());
  if (!clauses.length || !authorized.some(sendingInstruction)) return false;
  const sending = clauses.map(sendingInstruction);
  return sending.some(Boolean) && clauses.every((clause, index) => sending[index] || supplementalInstruction(clause));
}
