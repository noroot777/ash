import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentEvent, ExecTarget } from "@harness/shared";
import type { AgentExecutor, RunHandle, RunOpts } from "./types.js";
import { spawnAgent, resumeFor, spawnErrorMessage } from "./spawn.js";

// Drives the real `claude` CLI in headless stream-json mode (prompt via stdin).
//   claude -p --output-format stream-json --verbose --dangerously-skip-permissions
//          (--session-id <uuid> | --resume <uuid>) [--model <m>]
export class ClaudeExecutor implements AgentExecutor {
  readonly type = "claude" as const;
  readonly label: string;
  private target: ExecTarget;
  private bin: string;
  private model?: string;
  constructor(opts: { model?: string; bin?: string; target?: ExecTarget; name?: string } = {}) {
    this.model = opts.model;
    this.bin = opts.bin ?? "claude";
    this.target = opts.target ?? { kind: "local" };
    const where = this.target.kind === "ssh" ? this.target.host : "local";
    this.label = opts.name ?? `claude@${where}${opts.model ? "·" + opts.model : ""}`;
  }

  resumeCommand(cwd: string, sessionId: string): string {
    return resumeFor(this.target, cwd, `claude --resume ${sessionId}`);
  }

  run(opts: RunOpts): RunHandle {
    const sessionId = opts.sessionId ?? randomUUID();
    const model = opts.model ?? this.model;
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    if (opts.sessionId) args.push("--resume", sessionId);
    else args.push("--session-id", sessionId);
    if (model) args.push("--model", model);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    const commandLine = `${this.bin} ${args.join(" ")} <prompt via stdin>`;
    const child = spawnAgent(this.target, opts.cwd, this.bin, args, opts.prompt);
    return { sessionId, commandLine, events: parseClaudeStream(child) };
  }
}

async function* parseClaudeStream(child: ReturnType<typeof spawnAgent>): AsyncIterable<AgentEvent> {
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
    if (ev.type === "system" && ev.session_id) {
      push({ kind: "session", cliSessionId: ev.session_id });
    } else if (ev.type === "assistant" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "text" && block.text) push({ kind: "text", text: block.text });
        else if (block.type === "tool_use") push({ kind: "tool", name: block.name, detail: shortJson(block.input) });
      }
    } else if (ev.type === "result") {
      if (ev.session_id) push({ kind: "session", cliSessionId: ev.session_id });
      if (ev.subtype && ev.subtype !== "success") push({ kind: "error", message: `result: ${ev.subtype}` });
    }
  });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (finished) return;
    push({ kind: "error", message: spawnErrorMessage("claude", err) });
    push({ kind: "done", exitStatus: 1 });
    finished = true;
    resolve?.();
    resolve = null;
  });
  child.on("close", (code) => {
    if (finished) return;
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

const shortJson = (v: unknown) => {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 120 ? s.slice(0, 117) + "…" : s;
  } catch {
    return undefined;
  }
};
