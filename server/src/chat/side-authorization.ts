const quotedText = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu;
const target = "(?:主任务|主会话|主聊天|主对话)";
const action = "(?:发给|发回|发送给|发送到|转发给|回传给|传给|告诉|转告|通知|同步给|同步到|交给|转交给)";
const englishTarget = "(?:the\\s+)?(?:main|parent)\\s+(?:task|chat|thread|conversation)";
const quotedTarget = new RegExp(`^(?:${target}|${englishTarget})$`, "iu");
const sendPatterns = [
  new RegExp(`${action}\\s*${target}`, "u"),
  new RegExp(`(?:给|向|跟)\\s*${target}\\s*(?:发(?:一?条|个)?消息|发送(?:一?条)?消息|说一声|说一下|回传|同步)`, "u"),
  new RegExp(`^(?:please\\s+)?(?:send|forward|relay)\\s+.+?\\s+to\\s+${englishTarget}\\b`, "iu"),
  new RegExp(`^(?:please\\s+)?(?:tell|notify)\\s+${englishTarget}\\b`, "iu"),
];

function proseOf(text: string, reservations = false): string {
  const prose = text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`|^\s*>.*$/gmu, "\uFFFC").trim();
  const quotes = [...prose.matchAll(quotedText)];
  const wrapper = quotes.length === 1 && quotes[0]![0] === prose.replace(/[。.!]$/u, "");
  return (wrapper ? quotes[0]![0].slice(1, -1) : prose).replace(quotedText, (quote, index: number, whole: string) => {
    const contents = quote.slice(1, -1).trim();
    const standalone = /(?:^|[，,；;。！!\n.])\s*(?:(?:不过|但是|改成|改为|还是)\s*)?$/u.test(whole.slice(0, index))
      && /^\s*(?:[，,；;。！!\n.]|$)/u.test(whole.slice(index + quote.length));
    // 独立的“明天再说”仍是延后；作为发送内容的引号不参与指令识别。
    return quotedTarget.test(contents) || (reservations && standalone) ? contents : "\uFFFC";
  });
}

function sendingInstruction(clause: string): boolean {
  for (const pattern of sendPatterns) {
    const matched = clause.match(pattern);
    if (!matched) continue;
    const beforeAction = clause.slice(0, matched.index);
    const objectStart = beforeAction.search(/[把将]/u);
    const prefix = objectStart < 0 ? beforeAction : beforeAction.slice(0, objectStart);
    // 句首可有主语、催促或客套话；追述和讨论中的发送动作不是本次指令。
    if (/之前|刚才|昨天|曾经|(?:上|前)(?:一)?[轮次]|(?:我|你|他|她|它)(?:说|写|问)(?:过|了)?\s*[:：]|如何|怎么|怎样|解释|讨论|提到|比如|例如|譬如|打算|计划|准备/u.test(prefix)
      || /\b(?:how|explain|discuss|example|asked|told|used\s+to|plan\s+to|will)\b/iu.test(prefix)) continue;
    const rest = clause.slice(matched.index! + matched[0].length).trim();
    // “和我”由侧聊回答承接；接收对象后的所有格仍不能把负责人等对象当成主任务。
    if (/^(?:(?:和|以及|还有)我)?[吧啊呀]?$/u.test(rest) || /^[:：]\s*\S[\s\S]*$/u.test(rest)) return true;
  }
  return false;
}

function hasDeferral(prose: string): boolean {
  // “明天再发”推迟回传，“明天补测试”则只是发给主任务的后续安排。
  return prose.split(/[，,；;。！!\n.]/u).some((part) => {
    const clause = part.trim();
    return /(?:明天|后天|明早|今晚|下周|下个月|晚点|晚些|[一二三四五六七八九十几\d]+(?:分钟|小时|天|周)后).{0,16}(?:再|才)(?:说|发(?!布|版)|通知|告诉|回传|同步)/u.test(clause)
      || /(?:延后|延迟|推迟|暂缓)(?:发送|通知|告诉|回传|同步)|(?:发送|回传|这条消息).{0,4}(?:延后|延迟|推迟|暂缓)/u.test(clause)
      || /^(?:(?:请|先|暂且|暂时|继续|还是|就|那就|不过|但是|我们|再)\s*)*(?:延后|延迟|推迟|暂缓|搁置|按兵不动|观望)(?:一下|一会儿?|一阵子)?[吧啊呀]?$/u.test(clause)
      || /用不着.{0,6}急[吧啊呀]?$|(?:主意|方案|决定).{0,4}[没未](?:有)?定(?:下来|好)?$/u.test(clause)
      || /(?:让|叫)(?:它|主任务)(?:先|暂时)?(?:忽略|无视)(?:这条(?:消息|指令)?|刚才的(?:要求|指令))?$/u.test(clause);
  });
}

function hasReservation(prose: string): boolean {
  return hasDeferral(prose)
    || /[?？]|如果|假如|假设|倘若|除非|要是|只要|只有|前提|视情况|看情况|是否|是不是|能否|会不会|否则|不然/u.test(prose)
    || /不要|别|不必|不用|不准|禁止|先不|暂不|无需|不想|不能|不应该|不希望|[没未](?:有)?(?:要求|让|授权|发送)|算了|取消|撤回|撤销|作废|不对|不发|等等|等一下|等一等|再想|想想|考虑|缓一缓|缓缓|稍等|且慢|先停|暂停|稍后|下次|改天|过会|随口|随便说|开玩笑/u.test(prose)
    || /等(?:我|你|确认)|待.{0,12}确认|确认(?:后|之后)|(?:等.{0,20}再|以后).{0,8}(?:发|通知|告诉|回传|同步)/u.test(prose)
    || /引用|例子|演示|这句|说过|曾经|(?:已经|早就).{0,12}(?:发|告诉|通知)|[吗么呢](?:[。！.!\s]|$)/u.test(prose)
    || /(?:^|[，,；;。！!\n.])\s*(?:比如|例如|譬如)\s*[，,：:]/u.test(prose)
    || /\b(?:not|never|don't|do\s+not|if|unless|whether|wait|hold\s+on|later|previously|already|said|actually|maybe|perhaps|joking|kidding)\b/iu.test(prose);
}

export function sideForwardAuthorized(source: string, authorization: string): boolean {
  const quote = authorization.trim();
  if (!quote || !source.includes(quote)) return false;
  const prose = proseOf(source);
  // 检查当前消息的全部句子，模型截取的 authorization 不会缩小撤回/条件检查范围。
  if (hasReservation(proseOf(source, true))) return false;
  const clauses = prose.split(/[，,；;。！!\n.]/u).map((clause) => clause.trim()).filter(Boolean);
  const authorized = proseOf(quote).split(/[，,；;。！!\n.]/u).map((clause) => clause.trim());
  if (!clauses.length || !authorized.some(sendingInstruction)) return false;
  return clauses.some(sendingInstruction);
}
