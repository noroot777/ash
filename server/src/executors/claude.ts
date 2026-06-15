import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentEvent } from "@harness/shared";
import type { AgentExecutor, RunHandle, RunOpts } from "./types.js";

// Drives the real `claude` CLI in headless stream-json mode.
// Mirrors the proven invocation from the cxc prototype:
//   claude -p --output-format stream-json --verbose --session-id <uuid> [--resume <uuid>]
//          --dangerously-skip-permissions [--model <m>]  <prompt>
export class ClaudeExecutor implements AgentExecutor {
  readonly type = "claude" as const;
  readonly label: string;
  constructor(private opts: { model?: string; bin?: string } = {}) {
    this.label = `claude@local${opts.model ? "·" + opts.model : ""}`;
  }

  resumeCommand(cwd: string, sessionId: string): string {
    return `cd ${shq(cwd)} && claude --resume ${sessionId}`;
  }

  run(opts: RunOpts): RunHandle {
    const bin = this.opts.bin ?? "claude";
    const sessionId = opts.sessionId ?? randomUUID();
    const model = opts.model ?? this.opts.model;

    const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    if (opts.sessionId) args.push("--resume", sessionId);
    else args.push("--session-id", sessionId);
    if (model) args.push("--model", model);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    args.push(opts.prompt);

    const commandLine = `${bin} ${args.slice(0, -1).join(" ")} <prompt>`;
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });

    const events = parseClaudeStream(child);
    return { sessionId, commandLine, events };
  }
}

async function* parseClaudeStream(
  child: ReturnType<typeof spawn>,
): AsyncIterable<AgentEvent> {
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  let exitCode = 0;
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
      return; // non-JSON noise
    }
    if (ev.type === "system" && ev.session_id) {
      push({ kind: "session", cliSessionId: ev.session_id });
    } else if (ev.type === "assistant" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "text" && block.text) push({ kind: "text", text: block.text });
        else if (block.type === "tool_use")
          push({ kind: "tool", name: block.name, detail: shortJson(block.input) });
      }
    } else if (ev.type === "result") {
      if (ev.session_id) push({ kind: "session", cliSessionId: ev.session_id });
      if (ev.subtype && ev.subtype !== "success")
        push({ kind: "error", message: `result: ${ev.subtype}` });
    }
  });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));

  child.on("close", (code) => {
    exitCode = code ?? 0;
    if (exitCode !== 0 && stderr.trim())
      push({ kind: "error", message: stderr.trim().slice(0, 2000) });
    push({ kind: "done", exitStatus: exitCode });
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

// shell-quote a single argument
const shq = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
