import type { AgentType, SkillEntry, SkillSource } from "@harness/shared";

// `/` 补全的纯逻辑:哪些候选、按什么顺序、命中在第几位。
// 从 useSkills.ts 拆出来是为了能被 node 直接跑(那份带 react hooks,拉不进测试脚本)。

export interface SlashItem {
  /** 补进正文的文本,含斜杠。 */
  command: string;
  label: string;
  hint?: string;
  /** harness 自己的派生命令(/team、/duet)vs CLI 已装的技能。 */
  kind: "harness" | "skill";
  source?: SkillSource;
  /** 同一份技能还装在哪些别的 CLI 上(按物理路径认)。 */
  alsoIn?: AgentType[];
}

/** 正文里正在敲的那个斜杠 token(整段正文只有它时才算,免得句中的 `/` 也弹菜单)。 */
export function slashToken(text: string): string | null {
  return /^\s*(\/\S*)$/.exec(text)?.[1]?.toLowerCase() ?? null;
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
    kind: "skill" as const,
    source: skill.source,
    alsoIn: skill.alsoIn,
  }));
}

/**
 * 合成候选:**harness 自己的命令永远排在最前**。它们改变的是「谁来干这件事」
 * (派生一个团队/一场讨论),技能只是给当前这轮加一句提示词 —— 前者点错了代价大得多,
 * 不能让某个 CLI 装了个叫 team 的技能就把它挤下去。命中位置排序只在各自组内进行。
 */
export function mergeSlashItems(harness: SlashItem[], skills: SkillEntry[], token: string | null): SlashItem[] {
  if (!token) return [];
  return [...rankByMatch(harness, token), ...rankByMatch(toSlashItems(skills), token)];
}
