import type { AgentType } from "@harness/shared";
import type { CliSpec } from "./types.js";
// 15 个 spec 静态 import,一次列全 —— 这个文件在 B 阶段(各 CLI 分别实测校准)
// 不需要再改,所以并行的执行者不会撞在这里。新增/删除一个智能体才动它,配套动作
// 是 shared 的 AGENT_TYPES 加/删同一个 key。
import { claudeSpec } from "./claude.js";
import { codexSpec } from "./codex.js";
import { antigravitySpec } from "./antigravity.js";
import { geminiSpec } from "./gemini.js";
import { opencodeSpec } from "./opencode.js";
import { traeSpec } from "./trae.js";
import { grokSpec } from "./grok.js";
import { kimiSpec } from "./kimi.js";
import { cursorSpec } from "./cursor.js";
import { qwenSpec } from "./qwen.js";
import { qoderSpec } from "./qoder.js";
import { copilotSpec } from "./copilot.js";
import { kiroSpec } from "./kiro.js";
import { kiloSpec } from "./kilo.js";
import { piSpec } from "./pi.js";

export type { CliSpec } from "./types.js";

/**
 * key → spec。`satisfies Record<AgentType, CliSpec>` 是这层唯一的硬保证:
 * AGENT_TYPES 里加了 key 却忘了写 spec(或反过来写了 spec 没登记 key),**编译不过**。
 * 字面量顺序就是展示顺序(见 CLI_SPECS)。
 */
const SPECS = {
  claude: claudeSpec,
  codex: codexSpec,
  antigravity: antigravitySpec,
  gemini: geminiSpec,
  opencode: opencodeSpec,
  trae: traeSpec,
  grok: grokSpec,
  kimi: kimiSpec,
  cursor: cursorSpec,
  qwen: qwenSpec,
  qoder: qoderSpec,
  copilot: copilotSpec,
  kiro: kiroSpec,
  kilo: kiloSpec,
  pi: piSpec,
} satisfies Record<AgentType, CliSpec>;

// key 与 spec.key 写串了(复制粘贴的经典失误)会让 detect 认 A 的 bin、执行 B 的
// 参数,而类型层查不出来 —— 所以在模块加载时直接炸,别等它变成运行期怪现象。
for (const [key, spec] of Object.entries(SPECS)) {
  if (spec.key !== key) throw new Error(`CLI 目录登记错位:SPECS["${key}"] 的 spec.key 是 "${spec.key}"`);
}

export const CLI_SPEC_BY_KEY: Record<AgentType, CliSpec> = SPECS;

/**
 * 已知 CLI 目录,**有序** —— 这个顺序就是「智能体」面板与各执行器下拉的展示顺序。
 * claude/codex 打头(自带专用执行器),其余按接入先后。
 */
export const CLI_SPECS: readonly CliSpec[] = Object.values(SPECS);

// 类型层已经保证全键,但库里可能存着「删掉的智能体」的旧行(agents.type 是纯
// 字符串),所以运行期也要有一句诚实的报错,而不是 undefined 往下漂。
export function cliSpec(key: AgentType): CliSpec {
  const spec = CLI_SPEC_BY_KEY[key];
  if (!spec) throw new Error(`"${key}" 不在已知 CLI 目录里(该智能体可能已被删除);请在「智能体」里改用一个现有执行器`);
  return spec;
}
