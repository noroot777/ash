import { createInterface } from "node:readline";
import type { AgentEvent, ExecTarget } from "@harness/shared";
import type { AgentExecutor, RunHandle, RunOpts } from "./types.js";
import { spawnAgent, resumeFor, spawnErrorMessage } from "./spawn.js";

// Drives the real `codex` CLI in non-interactive JSON mode (prompt via stdin, `-`).
//   first:  codex exec --json --skip-git-repo-check -C <cwd>
//             --dangerously-bypass-approvals-and-sandbox [-m model] -
//   resume: codex exec resume [opts] <session_id> -
export class CodexExecutor implements AgentExecutor {
  readonly type = "codex" as const;
  readonly label: string;
  private target: ExecTarget;
  private bin: string;
  private model?: string;
  constructor(opts: { model?: string; bin?: string; target?: ExecTarget; name?: string } = {}) {
    this.model = opts.model;
    this.bin = opts.bin ?? "codex";
    this.target = opts.target ?? { kind: "local" };
    const where = this.target.kind === "ssh" ? this.target.host : "local";
    this.label = opts.name ?? `codex@${where}${opts.model ? "·" + opts.model : ""}`;
  }

  resumeCommand(cwd: string, sessionId: string): string {
    return resumeFor(this.target, cwd, `codex exec resume ${sessionId}`);
  }

  run(opts: RunOpts): RunHandle {
    const model = opts.model ?? this.model;
    const common = ["--json", "--skip-git-repo-check", "-C", opts.cwd, "--dangerously-bypass-approvals-and-sandbox"];
    if (model) common.push("-m", model);
    if (opts.extraArgs?.length) common.push(...opts.extraArgs);
    // `-C`/`--json`/`-m`/sandbox are `codex exec` options; `resume` is a
    // subcommand that takes only its own flags + [SESSION_ID] [PROMPT]. So the
    // exec options must precede `resume`, not follow it (else: "unexpected argument '-C'").
    const args = opts.sessionId
      ? ["exec", ...common, "resume", opts.sessionId, "-"]
      : ["exec", ...common, "-"];

    const commandLine = `${this.bin} ${args.join(" ")} <prompt via stdin>`;
    const child = spawnAgent(this.target, opts.cwd, this.bin, args, opts.prompt);
    return { sessionId: opts.sessionId ?? "", commandLine, events: parseCodexStream(child) };
  }
}

async function* parseCodexStream(child: ReturnType<typeof spawnAgent>): AsyncIterable<AgentEvent> {
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
      else if (it.type === "command_execution") push({ kind: "tool", name: "exec", detail: shortStr(it.command) });
      else if (it.type === "file_change" || it.type === "patch") push({ kind: "tool", name: "edit", detail: shortStr(it.path ?? it.summary) });
    } else if (ev.type === "error" && ev.message) {
      push({ kind: "error", message: String(ev.message).slice(0, 2000) });
    }
  });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (finished) return;
    push({ kind: "error", message: spawnErrorMessage("codex", err) });
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

const shortStr = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
};
