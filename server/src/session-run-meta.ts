import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { agents, sessions, tasks } from "./db/schema.js";

type SessionRow = typeof sessions.$inferSelect;
type RunMeta = { model: string | null; reasoningEffort: string | null };

function clean(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function lastFlagValue(command: string, flags: string[]): string | null {
  const names = flags.map((flag) => flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?:^|\\s)(?:${names})(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, "g");
  let value: string | null = null;
  for (const match of command.matchAll(pattern)) value = clean(match[1] ?? match[2] ?? match[3]);
  return value;
}

function lastConfigValue(command: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}=(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, "g");
  let value: string | null = null;
  for (const match of command.matchAll(pattern)) value = clean(match[1] ?? match[2] ?? match[3]);
  return value;
}

function commandRunMeta(commandLine: string | null): RunMeta {
  const command = commandLine ?? "";
  return {
    model: lastFlagValue(command, ["--model", "-m"]) ?? lastConfigValue(command, "model.name"),
    reasoningEffort: lastConfigValue(command, "model_reasoning_effort")
      ?? lastFlagValue(command, ["--reasoning-effort", "--effort"]),
  };
}

/** Existing sessions predate per-turn run markers, so their API metadata is reconstructed read-only. */
export async function sessionRunMeta(taskId: string, rows: SessionRow[]): Promise<Map<string, RunMeta>> {
  const [[task], profiles] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.id, taskId)),
    db.select().from(agents),
  ]);
  const selected = task?.executorId
    ? profiles.find((profile) => profile.id === task.executorId)
    : profiles.find((profile) => profile.type === task?.agentType && profile.isDefault)
      ?? profiles.find((profile) => profile.type === task?.agentType);
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  return new Map(rows.map((row) => {
    const command = commandRunMeta(row.commandLine);
    const profile = byName.get(row.executor);
    const taskOverridesApply = !!selected && selected.name === row.executor;
    return [row.id, {
      model: command.model ?? (taskOverridesApply ? clean(task?.model) : null) ?? clean(profile?.model),
      reasoningEffort: command.reasoningEffort
        ?? (taskOverridesApply ? clean(task?.reasoningEffort) : null)
        ?? clean(profile?.reasoningEffort),
    }];
  }));
}
