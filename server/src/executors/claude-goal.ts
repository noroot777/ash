import { writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { isGoalExecution, type CliGoal } from "@navi/shared/cli-commands";
import type { RunOpts } from "./types.js";
import { LEGACY_CLAUDE_GOAL_CONTEXT_TAG, LEGACY_CLAUDE_GOAL_FILE_PREFIX } from "@navi/shared/legacy-names";
import { formatGoal } from "./codex-native-commands.js";

// 目标上下文文件（系统临时目录下）和命令行里指着它的那一段记号。记号随命令行落库，服务重启后
// 收尾时按它找回文件删掉 —— 升级前起的回合写的是旧名，所以两代都认。
const GOAL_FILE_PREFIX = "navi-claude-goal-";
const GOAL_CONTEXT_TAG = "navi-goal-context";
const GOAL_FILE_RE = new RegExp(`^(?:${[GOAL_FILE_PREFIX, LEGACY_CLAUDE_GOAL_FILE_PREFIX].join("|")})\\d+-[\\w-]+\\.md$`);
const GOAL_CONTEXT_RE = new RegExp(`<(?:${[GOAL_CONTEXT_TAG, LEGACY_CLAUDE_GOAL_CONTEXT_TAG].join("|")}):("(?:[^"\\\\]|\\\\.)*")>`);

export function formatClaudeGoal(goal: CliGoal | null): string {
  if (!goal) return formatGoal(null);
  return `${formatGoal(goal).split("\n").slice(0, 2).join("\n")}\n这是 Navi 保存的目标快照；实时评估与用量见 Claude 的会话输出。`;
}

export function claudeGoalInvocation(opts: RunOpts): { input: string; args: string[]; marker: string; cleanup(): void } {
  if (!isGoalExecution(opts.cliCommand ?? null)) return { input: opts.prompt, args: [], marker: "", cleanup() {} };
  const objective = opts.cliCommand?.args === "resume" ? opts.cliState?.goal?.objective : opts.cliCommand?.args;
  if (!objective) throw new Error("没有可恢复的 Claude 目标，请先 /goal 描述");
  const path = join(tmpdir(), `${GOAL_FILE_PREFIX}${process.pid}-${randomUUID()}.md`);
  writeFileSync(path, opts.prompt, { mode: 0o600 });
  return { input: `/goal ${objective}`, args: ["--append-system-prompt-file", path], marker: ` <${GOAL_CONTEXT_TAG}:${JSON.stringify(path)}>`,
    cleanup() { try { unlinkSync(path); } catch {} } };
}

export function cleanupClaudeGoalContext(commandLine: string): void {
  const match = GOAL_CONTEXT_RE.exec(commandLine);
  if (!match) return;
  try {
    const path = JSON.parse(match[1]!) as string;
    if (GOAL_FILE_RE.test(basename(path)) && path === join(tmpdir(), basename(path))) unlinkSync(path);
  } catch {}
}
