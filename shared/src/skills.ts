// CLI 技能(输入框的 `/` 补全)的数据形状。
// `/{名字}` 原样留在正文里；server 运行前会用这份清单注入准确 SKILL.md。
//
// 从 `index.ts` 拆出来只有一个理由:那个文件到 700 行了。类型经 index 原样 re-export,
// 调用方仍从 `@harness/shared` 拿(**只能是 type-only 转发**——server 直接跑 .ts 源码,
// 运行时转发会因说明符扩展名对不上而起不来,见 server/CLAUDE.md)。
import type { AgentType } from "./index.ts";

export type SkillSource = "project" | "user" | "plugin" | "builtin";

export interface SkillEntry {
  /** 技能名,不含斜杠;插件技能带 `插件名:` 前缀。 */
  name: string;
  /** 直接补进正文的那串文本(含斜杠)。 */
  command: string;
  description: string;
  source: SkillSource;
  /** 软链跟随后的物理路径,用来跨 CLI 认出「这是同一个技能」;内置技能没有。 */
  realPath: string | null;
  /** 除了当前这个 CLI,还有谁也装了同一份(按 realPath 认)。 */
  alsoIn: AgentType[];
}

export interface SkillList {
  agentType: AgentType;
  cwd: string;
  /** 每个 SKILL.md 的 mtime+size 拼串;前端可拿它短路。 */
  fingerprint: string;
  /** true = 这份清单被 claude 的 init 事件校准过(含内置技能)。 */
  authoritative: boolean;
  /** true = 目标是 ssh 远端,扫不到它的技能;不报错也不假装有。 */
  remote: boolean;
  skills: SkillEntry[];
}

/**
 * 设置页里「谁扫到了什么」的一行:一个 **CLI 类型 × 本机/远端** 的组合。
 *
 * 不按执行器 profile 逐行列:技能目录是按 CLI 类型定的(`~/.claude/skills` 之类),
 * 同一个 CLI 的几个 profile 差别只在供应商——那影响的是「谁来算」,不是「装了什么」,
 * 扫出来必然是同一份。四个 claude profile 各占一行、条数样本一模一样,是噪声不是信息。
 * 唯一真会改变结果的是 ssh:那台的技能在它自己的盘上,所以只按这一维再分一行。
 */
export interface SkillScanRow {
  agentType: AgentType;
  /** true = 这一行说的是跑在 ssh 远端的那些 profile。 */
  remote: boolean;
  /** 这一行覆盖了哪些已注册的 profile(按名字);空 = 该 CLI 还没注册 profile。 */
  executors: string[];
  /** 这个 CLI 有没有技能目录约定(claude/codex/gemini 之外的返回 false)。 */
  scannable: boolean;
  count: number;
  /** 按来源分桶的条数,给设置页画一句「项目 2 · 个人 51 · 插件 4」。 */
  bySource: Record<SkillSource, number>;
  /** 前几个名字,让人一眼认出扫的是不是自己那批。 */
  sample: string[];
}


export interface SkillScanOverview {
  /** 扫的是哪个项目的仓库根;空串 = 只有用户级/插件级技能。 */
  cwd: string;
  scannedAt: string;
  rows: SkillScanRow[];
}
