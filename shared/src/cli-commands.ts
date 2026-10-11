import type { AgentType } from "./index.ts";

export const CODEX_COMMANDS = {
  goal: "持续目标：/goal 描述；pause / resume / clear；--budget 数量",
  plan: "计划模式：/plan [问题]；/plan off 退出",
  compact: "原生压缩当前会话",
  review: "原生代码审查：/review [--base 分支 | --commit SHA | 要求]",
  status: "查看当前会话、模型及上下文状态",
  usage: "查看账号 token 用量与额度（供应商不支持时明确提示）",
  mcp: "查看当前 MCP 服务及工具",
  ps: "查看当前会话的后台终端",
  stop: "停止当前会话的后台终端，不取消 ash 任务",
  "debug-config": "查看有效配置，敏感字段隐藏",
  hooks: "查看当前项目的生命周期 hooks",
  apps: "查看可用连接器",
  plugins: "查看当前项目及用户的插件清单（不安装或改配置）",
  personality: "当前任务的表达风格：friendly / pragmatic / none",
  fast: "当前任务的快速档：on / off",
  fork: "在当前任务内分叉会话，保留原会话记录",
  new: "在当前任务内新建会话，保留旧记录",
  clear: "新建会话（/new 的别名，不删除历史）",
  rename: "重命名当前会话及 ash 任务：/rename 名称",
} as const;

export type CliCommandName = keyof typeof CODEX_COMMANDS;
export interface CliCommand { name: CliCommandName; args: string; text: string; }
export interface CliGoal {
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}
export interface CliSessionState {
  profileId?: string | null;
  ownerUserId?: string | null;
  plan?: boolean;
  personality?: "friendly" | "pragmatic" | "none";
  serviceTier?: "priority" | "default";
  goal?: CliGoal | null;
  goalHold?: boolean;
}
export function hasCliGoalHold(raw?: string | null): boolean {
  try { return Object.values(JSON.parse(raw ?? "{}")).some((state) => (state as CliSessionState | null)?.goalHold === true); }
  catch { return false; }
}

export function cliCommandCatalog(agentType: string): Partial<Record<CliCommandName, string>> {
  if (agentType === "codex") return CODEX_COMMANDS;
  if (agentType === "claude") return { goal: "持续目标：/goal 描述；pause / resume / clear", compact: CODEX_COMMANDS.compact };
  return {};
}
export function cliCommandsForMode<Entry extends { name: string; source: string }>(entries: Entry[] = [], agentType: string, mode: string): Entry[] {
  if (mode === "single") return entries;
  const catalog = cliCommandCatalog(agentType);
  return entries.filter((entry) => entry.source !== "builtin" || !Object.hasOwn(catalog, entry.name) || (agentType === "claude" && entry.name === "compact"));
}
export function parseCliCommand(agentType: string, text: string): CliCommand | null {
  const match = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match || !Object.hasOwn(cliCommandCatalog(agentType), match[1]!)) return null;
  return { name: match[1] as CliCommandName, args: match[2]?.trim() ?? "", text: text.trim() };
}
export function isGoalExecution(command: CliCommand | null): boolean {
  return command?.name === "goal" && !!command.args && !/^(pause|clear|stop|off|reset|none|cancel|budget)(?:\s|$)/.test(command.args);
}
export function goalRequest(command: CliCommand, agentType: AgentType): { objective?: string; status?: CliGoal["status"]; tokenBudget?: number } {
  if (command.args === "resume") return { status: "active" };
  if (command.args === "pause") return { status: "paused" };
  const budget = /(?:^|\s)--budget\s+(\S+)(?=\s|$)/.exec(command.args);
  const budgetOnly = /^budget\s+(\S+)$/.exec(command.args);
  const value = budget?.[1] ?? budgetOnly?.[1];
  const tokenBudget = value === undefined ? undefined : Number(value);
  if (value !== undefined && (agentType !== "codex" || !Number.isSafeInteger(tokenBudget) || tokenBudget! <= 0)) throw new Error(agentType !== "codex" ? "Claude Code 的原生目标不支持 token 预算参数" : "目标预算必须是正整数");
  if (budgetOnly) return { tokenBudget };
  const objective = budget ? command.args.replace(budget[0], " ").trim() : command.args;
  if (!objective || objective.length > 4000 || /(?:^|\s)--budget\b/.test(objective)) throw new Error("目标必须为 1–4000 字符；预算写作 --budget 正整数");
  return { objective, status: "active", ...(tokenBudget !== undefined ? { tokenBudget } : {}) };
}
export function validateCliCommand(agentType: string, text: string): CliCommand | null {
  const name = /^\/([\w-]+)(?:\s|$)/.exec(text.trim())?.[1];
  if (agentType === "claude" && name === "review") return null;
  if (name && Object.hasOwn(CODEX_COMMANDS, name) && !Object.hasOwn(cliCommandCatalog(agentType), name)) throw new Error(`当前执行器的 ash 通道不支持 /${name}`);
  const command = parseCliCommand(agentType, text);
  if (!command) return null;
  if (command.name === "goal" && /^(pause|resume|clear|stop|off|reset|none|cancel)\s/.test(command.args)) throw new Error("目标控制命令不接受额外参数；调整预算使用 /goal budget 正整数");
  if (command.name === "goal" && /^budget(?:\s|$)/.test(command.args) && !/^budget\s+\S+$/.test(command.args)) throw new Error("调整预算使用 /goal budget 正整数");
  if (command.name === "goal" && command.args && !/^(pause|resume|clear|stop|off|reset|none|cancel)$/.test(command.args)) goalRequest(command, agentType as AgentType);
  if (command.name === "personality" && command.args && !/^(friendly|pragmatic|none)$/.test(command.args)) throw new Error("/personality 支持 friendly、pragmatic、none");
  if (command.name === "fast" && command.args && !/^(on|off)$/.test(command.args)) throw new Error("/fast 支持 on、off");
  if (command.name === "rename" && (!command.args || command.args.length > 200)) throw new Error("/rename 后填写 1–200 字符的名称");
  if (command.name === "review" && /^--(base|commit)\b/.test(command.args) && !/^--(base|commit)\s+\S+$/.test(command.args)) throw new Error("审查目标写作 /review --base 分支 或 /review --commit SHA");
  if (!["goal", "plan", "review", "personality", "fast", "rename"].includes(command.name) && !(agentType === "claude" && command.name === "compact") && command.args) throw new Error(`/${command.name} 不接受参数`);
  return command;
}
