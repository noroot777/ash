import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { findRollout } from "./codex-rollout.js";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const safeId = /^[A-Za-z0-9_-]+$/;
const cache = new Map<string, { stamp: string; model: string | null }>();
const modelName = (value: unknown): string | null => typeof value === "string" && value.trim()
  && value !== "<synthetic>" ? value.trim() : null;

async function readModel(
  file: string,
  identity: string,
  scan: (line: string, ordinal: number) => void,
  result: () => string | null,
): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) return null;
    const key = `${file}\0${identity}`;
    const stamp = `${info.size}:${info.mtimeMs}`;
    const cached = cache.get(key);
    if (cached?.stamp === stamp) return cached.model;
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      let ordinal = 0;
      for await (const line of lines) scan(line, ordinal++);
    } finally {
      lines.close();
      stream.destroy();
    }
    const model = result();
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(key, { stamp, model });
    return model;
  } catch {
    return null;
  }
}

export async function readCodexAgentModel(
  id: string,
  parentThreadId: string,
  configDir?: string | null,
): Promise<string | null> {
  if (!uuid.test(id) || !uuid.test(parentThreadId) || id === parentThreadId) return null;
  const file = await findRollout(id, configDir);
  if (!file) return null;
  let valid = false;
  let historyEnd = 0;
  let model: string | null = null;
  return readModel(file, parentThreadId, (line, ordinal) => {
    if (ordinal > 0 && (!valid || ordinal < historyEnd || !line.includes('"turn_context"'))) return;
    let row: any;
    try { row = JSON.parse(line.trimStart()); } catch { return; }
    const p = row.payload;
    if (ordinal === 0) {
      const parent = p?.parent_thread_id ?? p?.forked_from_id ?? p?.source?.subagent?.thread_spawn?.parent_thread_id;
      valid = row.type === "session_meta" && (p?.id ?? p?.session_id) === id && parent === parentThreadId;
      if (p?.forked_from_id) {
        if (!Number.isSafeInteger(p.subagent_history_start_ordinal) || p.subagent_history_start_ordinal < 1) valid = false;
        else historyEnd = p.subagent_history_start_ordinal;
      }
      return;
    }
    if (row.type === "turn_context") model = modelName(p?.model) ?? model;
  }, () => valid ? model : null);
}

export async function readClaudeAgentModel(
  id: string,
  parentSessionId: string,
  cwd: string,
  configDir?: string | null,
): Promise<string | null> {
  if (!safeId.test(id) || !uuid.test(parentSessionId) || !cwd) return null;
  const root = configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const file = join(root, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), parentSessionId, "subagents", `agent-${id}.jsonl`);
  let model: string | null = null;
  return readModel(file, `${parentSessionId}:${id}`, (line) => {
    if (!line.includes('"assistant"')) return;
    let row: any;
    try { row = JSON.parse(line); } catch { return; }
    if (row.type === "assistant" && row.agentId === id && row.sessionId === parentSessionId) {
      model = modelName(row.message?.model) ?? model;
    }
  }, () => model);
}
