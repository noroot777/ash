import type { SessionTraceEntry } from "./transcript.js";
import { readClaudeAgentModel, readCodexAgentModel } from "./executors/native-agent-models.js";
import { nativeAgentModel, nativeToolName } from "./executors/native-work.js";

interface NativeModelSession {
  agentType: string;
  cliSessionId: string | null;
  cwd: string | null;
  worktreePath?: string | null;
}

export async function enrichNativeWorkModels(
  trace: SessionTraceEntry[],
  session: NativeModelSession,
  configDir: string | null,
): Promise<SessionTraceEntry[]> {
  const parent = session.cliSessionId;
  if (!parent || !["codex", "claude"].includes(session.agentType)) return trace;
  const children = new Map<string, { nativeId: string; entry: SessionTraceEntry }>();
  const calls = new Set<string>();
  for (const entry of trace) {
    const work = entry.event.kind === "tool" ? entry.event.nativeWork : undefined;
    if (!work) continue;
    if (work.type === "call" && ["agent", "task", "spawn_agent"].includes(nativeToolName(work.name))) calls.add(work.id);
    if (work.type === "agent" || work.type === "activity") {
      const nativeId = work.type === "agent" ? work.nativeId : undefined;
      children.set(work.id, { nativeId: nativeId || children.get(work.id)?.nativeId || work.id, entry });
    } else if (work.type === "result" && calls.has(work.id) && !work.failed) {
      let result: any;
      try { result = JSON.parse(work.result); } catch { /* Text results can carry agentId. */ }
      const nativeId = result?.agent_id ?? result?.agentId ?? /agentId:\s*([\w-]+)/.exec(work.result)?.[1];
      if (typeof nativeId === "string") children.set(session.agentType === "codex" ? nativeId : work.id, { nativeId, entry });
    }
  }
  const additions: SessionTraceEntry[] = [];
  const entries = [...children].slice(0, 64);
  for (let index = 0; index < entries.length; index += 4) {
    const batch = await Promise.all(entries.slice(index, index + 4).map(async ([id, { nativeId, entry }]) => {
      const model = session.agentType === "codex"
        ? await readCodexAgentModel(nativeId, parent, configDir)
        : await readClaudeAgentModel(nativeId, parent, session.cwd || session.worktreePath || "", configDir);
      const event = nativeAgentModel(id, model);
      return event?.kind === "tool" ? { ...entry, event: { ...event, nativeWork: { ...event.nativeWork!, at: entry.at } } } : null;
    }));
    for (const entry of batch) if (entry) additions.push(entry);
  }
  return additions.length ? [...trace, ...additions] : trace;
}
