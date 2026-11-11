import type { AgentType, SkillEntry, SkillSource } from "@ash/shared";

// `/` 补全的纯逻辑:哪些候选、按什么顺序、命中在第几位。
// 从 useSkills.ts 拆出来是为了能被 node 直接跑(那份带 react hooks,拉不进测试脚本)。

export interface SlashItem {
  /** 补进正文的文本,含斜杠。 */
  command: string;
  label: string;
  hint?: string;
  /** ash 自己的派生命令(/team、/duet)vs CLI 已装的技能。 */
  kind: "ash" | "native" | "skill";
  source?: SkillSource;
  /** 同一份技能还装在哪些别的 CLI 上(按物理路径认)。 */
  alsoIn?: AgentType[];
}

/** 正文末尾正在敲的那个斜杠 token;start 是斜杠的下标,leading = 斜杠前面只有空白。 */
export interface SlashQuery {
  token: string;
  start: number;
  leading: boolean;
}

// 斜杠要么在开头,要么跟在连不进命令名的字符(空白、标点)后面 —— 与 server
// withSkillInvocation 认「正文里点了哪个技能」是同一条边界,所以菜单补进去的
// 一定被认得,而 `a/b`、`用/x` 这类句中斜杠不弹菜单。token 里不许再有 `/`:那是在敲路径。
const SLASH_TAIL = /(^|[^\p{L}\p{N}_./:\-])(\/[^\s/]*)$/u;

export function slashQuery(text: string): SlashQuery | null {
  const match = SLASH_TAIL.exec(text);
  if (!match) return null;
  const start = match.index + match[1]!.length;
  return { token: match[2]!.toLowerCase(), start, leading: !text.slice(0, start).trim() };
}

export function slashToken(text: string): string | null {
  return slashQuery(text)?.token ?? null;
}

/** 选中一条:只换掉末尾那个 token,前面已经写好的正文原样留着。 */
export function applySlashPick(text: string, command: string): string {
  const query = slashQuery(text);
  return `${query && !query.leading ? text.slice(0, query.start) : ""}${command} `;
}

/**
 * 敲的这几个字落在命令名的第几位;-1 = 不匹配。
 *
 * 是**子串**匹配而不是前缀匹配:技能名的关键词经常不在开头(插件前缀 `codex:rescue`、
 * 动宾结构 `high-end-visual-design`),从头匹配等于逼人先背全名。斜杠两边都剥掉,
 * 于是敲 `/rescue` 和敲 `/codex` 找得到同一条。
 */
export function slashMatchIndex(command: string, token: string): number {
  const needle = token.replace(/^\/+/, "").toLowerCase();
  if (!needle) return 0;
  return command.toLowerCase().replace(/^\/+/, "").indexOf(needle);
}

/** 命中位置升序:前缀命中排在中段命中前面;位置相同的保持原顺序(sort 稳定)。 */
export function rankByMatch(items: SlashItem[], token: string): SlashItem[] {
  return items
    .map((item) => ({ item, at: slashMatchIndex(item.command, token) }))
    .filter((row) => row.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((row) => row.item);
}

export function toSlashItems(skills: SkillEntry[]): SlashItem[] {
  return skills.map((skill) => ({
    command: skill.command,
    label: skill.description || "技能",
    kind: skill.native ? "native" as const : "skill" as const,
    source: skill.source,
    alsoIn: skill.alsoIn,
  }));
}

/**
 * 合成候选:**ash 自己的命令永远排在最前**。它们改变的是「谁来干这件事」
 * (派生一个团队/一场讨论),技能只是给当前这轮加一句提示词 —— 前者点错了代价大得多,
 * 不能让某个 CLI 装了个叫 team 的技能就把它挤下去。命中位置排序只在各自组内进行。
 *
 * 斜杠写在已有正文后面时只给技能:ash 命令和原生命令都得是整条消息的开头才生效,
 * 句中补一个进去 server 和 CLI 都不认。
 */
export function mergeSlashItems(ash: SlashItem[], skills: SkillEntry[], query: SlashQuery | null): SlashItem[] {
  if (!query) return [];
  const { token, leading } = query;
  const items = toSlashItems(skills);
  const skillItems = rankByMatch(items.filter((item) => item.kind === "skill"), token);
  if (!leading) return skillItems;
  return [...rankByMatch(ash, token), ...rankByMatch(items.filter((item) => item.kind === "native"), token), ...skillItems];
}

/**
 * 回车选中的是原生命令、而且正文已经一字不差就是它:直接发出去。
 * 原生命令不带参数也成立(/compact、/status…),这时再「补全」只是添个空格、逼人按第二次回车。
 * 技能不走这条:光一个 `/技能名` 没有正文,补全后让人接着写才是对的。
 */
export function slashSendsAsTyped(item: SlashItem | undefined, text: string): boolean {
  // 大小写必须一字不差:server 与 CLI 认原生命令是区分大小写的,`/COMPACT` 原样发出去
  // 只是一句普通话。差了大小写就走补全,由它换成候选的准确拼写。
  return item?.kind === "native" && text.trim() === item.command;
}
