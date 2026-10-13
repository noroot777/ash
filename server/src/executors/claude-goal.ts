import { writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { isGoalExecution, type CliGoal } from "@ash/shared/cli-commands";
import type { RunOpts } from "./types.js";
import { formatGoal } from "./codex-native-commands.js";

export function formatClaudeGoal(goal: CliGoal | null): string {
  if (!goal) return formatGoal(null);
  return `${formatGoal(goal).split("\n").slice(0, 2).join("\n")}\n这是 ash 保存的目标快照；实时评估与用量见 Claude 的会话输出。`;
}

export function claudeGoalInvocation(opts: RunOpts): { input: string; args: string[]; marker: string; cleanup(): void } {
  if (!isGoalExecution(opts.cliCommand ?? null)) return { input: opts.prompt, args: [], marker: "", cleanup() {} };
  const objective = opts.cliCommand?.args === "resume" ? opts.cliState?.goal?.objective : opts.cliCommand?.args;
  if (!objective) throw new Error("没有可恢复的 Claude 目标，请先 /goal 描述");
  const path = join(tmpdir(), `ash-claude-goal-${process.pid}-${randomUUID()}.md`);
  writeFileSync(path, opts.prompt, { mode: 0o600 });
  return { input: `/goal ${objective}`, args: ["--append-system-prompt-file", path], marker: ` <ash-goal-context:${JSON.stringify(path)}>`,
    cleanup() { try { unlinkSync(path); } catch {} } };
}

export function cleanupClaudeGoalContext(commandLine: string): void {
  const match = /<ash-goal-context:("(?:[^"\\]|\\.)*")>/.exec(commandLine);
  if (!match) return;
  try {
    const path = JSON.parse(match[1]!) as string;
    if (/^ash-claude-goal-\d+-[\w-]+\.md$/.test(basename(path)) && path === join(tmpdir(), basename(path))) unlinkSync(path);
  } catch {}
}
