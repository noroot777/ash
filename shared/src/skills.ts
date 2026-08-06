// CLI 技能(输入框的 `/` 补全)的数据形状。
// harness 在这件事上一行提示词都不写：`/名字` 原样留在 prompt 里，CLI 自己认。
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

/** 设置页里「谁扫到了什么」的一行:一个**已注册的执行器 profile**。 */
export interface SkillScanRow {
  /** agents.id;为空 = 这个 CLI 还没注册 profile,只是按类型扫了一下。 */
  executorId: string | null;
  executorLabel: string;
  agentType: AgentType;
  /** ssh 远端:技能在那头的盘上,本机扫不到,不假装有。 */
  remote: boolean;
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
