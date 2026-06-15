import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent } from "@harness/shared";
import type { AgentExecutor, RunHandle, RunOpts } from "./types.js";

// Drives the real `codex` CLI in non-interactive JSON mode.
//   first:  codex exec --json --skip-git-repo-check -C <cwd>
//             --dangerously-bypass-approvals-and-sandbox [-m model] <prompt>
//   resume: codex exec resume [opts] <session_id> <prompt>
// Unlike claude, codex assigns the thread id itself (thread.started event), so
// the session id is discovered from the stream rather than set up front.
export class CodexExecutor implements AgentExecutor {
  readonly type = "codex" as const;
  readonly label: string;
  constructor(private opts: { model?: string; bin?: string } = {}) {
    this.label = `codex@local${opts.model ? "·" + opts.model : ""}`;
  }

  resumeCommand(cwd: string, sessionId: string): string {
    return `cd ${shq(cwd)} && codex exec resume ${sessionId}`;
  }

  run(opts: RunOpts): RunHandle {
    const bin = this.opts.bin ?? "codex";
    const model = opts.model ?? this.opts.model;
    const common = ["--json", "--skip-git-repo-check", "-C", opts.cwd, "--dangerously-bypass-approvals-and-sandbox"];
    if (model) common.push("-m", model);
    if (opts.extraArgs?.length) common.push(...opts.extraArgs);

    const args = opts.sessionId
      ? ["exec", "resume", ...common, opts.sessionId, opts.prompt]
      : ["exec", ...common, opts.prompt];

    const commandLine = `${bin} ${args.slice(0, -1).join(" ")} <prompt>`;
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    return { sessionId: opts.sessionId ?? "", commandLine, events: parseCodexStream(child) };
  }
}

async function* parseCodexStream(child: ReturnType<typeof spawn>): AsyncIterable<AgentEvent> {
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  const push = (e: AgentEvent) => {
    queue.push(e);
    resolve?.();
    resolve = null;
  };

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      return;
    }
    if (ev.type === "thread.started" && ev.thread_id) {
      push({ kind: "session", cliSessionId: ev.thread_id });
    } else if (ev.type === "item.completed" && ev.item) {
      const it = ev.item;
      if (it.type === "agent_message" && it.text) push({ kind: "text", text: it.text });
      else if (it.type === "reasoning" && it.text) push({ kind: "thinking", text: it.text });
      else if (it.type === "command_execution")
        push({ kind: "tool", name: "exec", detail: shortStr(it.command) });
      else if (it.type === "file_change" || it.type === "patch")
        push({ kind: "tool", name: "edit", detail: shortStr(it.path ?? it.summary) });
    } else if (ev.type === "error" && ev.message) {
      push({ kind: "error", message: String(ev.message).slice(0, 2000) });
    }
  });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  child.on("close", (code) => {
    const exit = code ?? 0;
    if (exit !== 0 && stderr.trim()) push({ kind: "error", message: stderr.trim().slice(0, 2000) });
    push({ kind: "done", exitStatus: exit });
    finished = true;
    resolve?.();
    resolve = null;
  });

  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (finished) return;
    await new Promise<void>((r) => (resolve = r));
  }
}

const shortStr = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
};
const shq = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
