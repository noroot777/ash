import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { findRollout } from "./codex-rollout.js";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const safeId = /^[A-Za-z0-9_-]+$/;

/**
 * 子智能体的身份:实跑模型、智能水平、派活时起的名字。
 *
 * 为什么三样一起读:它们同住一份 rollout(codex 的 `turn_context.model`/`turn_context.effort`
 * 与 `session_meta.agent_path`),分三次扫文件只是把同一份 I/O 做三遍。**派活正文不在里面**
 * —— codex 的 `spawn_agent` 正文在上游就加密了,父子两份记录里都只有密文。
 */
export interface NativeAgentProfile { model: string | null; effort: string | null; title: string | null }

const empty: NativeAgentProfile = { model: null, effort: null, title: null };
const cache = new Map<string, { stamp: string; profile: NativeAgentProfile }>();
const text = (value: unknown): string | null => typeof value === "string" && value.trim()
  && value !== "<synthetic>" ? value.trim() : null;

async function readProfile(
  file: string,
  identity: string,
  scan: (line: string, ordinal: number) => void,
  result: () => NativeAgentProfile,
): Promise<NativeAgentProfile> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) return empty;
    const key = `${file}\0${identity}`;
    const stamp = `${info.size}:${info.mtimeMs}`;
    const cached = cache.get(key);
    if (cached?.stamp === stamp) return cached.profile;
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      let ordinal = 0;
      for await (const line of lines) scan(line, ordinal++);
    } finally {
      lines.close();
      stream.destroy();
    }
    const profile = result();
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(key, { stamp, profile });
    return profile;
  } catch {
    return empty;
  }
}

export async function readCodexAgentProfile(
  id: string,
  parentThreadId: string,
  configDir?: string | null,
): Promise<NativeAgentProfile> {
  if (!uuid.test(id) || !uuid.test(parentThreadId) || id === parentThreadId) return empty;
  const file = await findRollout(id, configDir);
  if (!file) return empty;
  let valid = false;
  let historyEnd = 0;
  let found: NativeAgentProfile = { ...empty };
  return readProfile(file, parentThreadId, (line, ordinal) => {
    if (ordinal > 0 && (!valid || ordinal < historyEnd || !line.includes('"turn_context"'))) return;
    let row: any;
    try { row = JSON.parse(line.trimStart()); } catch { return; }
    const p = row.payload;
    if (ordinal === 0) {
      const spawn = p?.source?.subagent?.thread_spawn ?? p?.source?.subAgent?.thread_spawn;
      const parent = p?.parent_thread_id ?? p?.forked_from_id ?? spawn?.parent_thread_id;
      valid = row.type === "session_meta" && (p?.id ?? p?.session_id) === id && parent === parentThreadId;
      const path = text(p?.agent_path) ?? text(spawn?.agent_path);
      if (path) found.title = path.split("/").filter(Boolean).at(-1) ?? null;
      if (p?.forked_from_id) {
        if (!Number.isSafeInteger(p.subagent_history_start_ordinal) || p.subagent_history_start_ordinal < 1) valid = false;
        else historyEnd = p.subagent_history_start_ordinal;
      }
      return;
    }
    if (row.type !== "turn_context") return;
    found.model = text(p?.model) ?? found.model;
    found.effort = text(p?.effort) ?? text(p?.collaboration_mode?.settings?.reasoning_effort) ?? found.effort;
  }, () => valid ? found : empty);
}

export async function readClaudeAgentProfile(
  id: string,
  parentSessionId: string,
  cwd: string,
  configDir?: string | null,
): Promise<NativeAgentProfile> {
  if (!safeId.test(id) || !uuid.test(parentSessionId) || !cwd) return empty;
  const root = configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const file = join(root, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), parentSessionId, "subagents", `agent-${id}.jsonl`);
  const found: NativeAgentProfile = { ...empty };
  return readProfile(file, `${parentSessionId}:${id}`, (line) => {
    if (!line.includes('"assistant"')) return;
    let row: any;
    try { row = JSON.parse(line); } catch { return; }
    if (row.type === "assistant" && row.agentId === id && row.sessionId === parentSessionId) {
      found.model = text(row.message?.model) ?? found.model;
    }
  }, () => found);
}
