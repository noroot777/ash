import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentEvent, ExecTarget } from "@harness/shared";
import type { AgentExecutor, RunHandle, RunOpts } from "./types.js";
import { spawnAgent, resumeFor, resumeInner, spawnErrorMessage, killChild, forceFinishOnExit } from "./spawn.js";

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
    return resumeFor(this.target, cwd, resumeInner.claude(sessionId));
  }

  run(opts: RunOpts): RunHandle {
    const sessionId = opts.sessionId ?? randomUUID();
    const model = opts.model ?? this.model;
    // --include-partial-messages turns on token-level streaming: the CLI emits
    // `stream_event` lines (content_block_delta) AS the model types, instead of
    // only one complete `assistant` message per turn. Without it the mobile/web
    // client sees nothing until a whole message lands, then the entire block
    // appears at once — the "laggy, dumps-in-one-go" feel. See parseClaudeStream.
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"];
    if (opts.sessionId) args.push("--resume", sessionId);
    else args.push("--session-id", sessionId);
    if (model) args.push("--model", model);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    const commandLine = `${this.bin} ${args.join(" ")} <prompt via stdin>`;
    const child = spawnAgent(this.target, opts.cwd, this.bin, args, opts.prompt);
    return { sessionId, commandLine, events: parseClaudeStream(child), kill: () => killChild(child) };
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

  // Coalesce token-level text_delta into small chunks: flush on a newline or once
  // ~40 chars have accrued, so the client streams smoothly without a re-render per
  // character (a long reply would otherwise fire thousands of setStates). The
  // chunks concatenate downstream with no separator, so the joined text is exactly
  // the model's output. With partial streaming ON, the complete `assistant`
  // message that trails the deltas is used ONLY for tool_use — replaying its text
  // would duplicate everything the deltas already streamed.
  let textBuf = "";
  const flushText = () => {
    if (textBuf) {
      push({ kind: "text", text: textBuf });
      textBuf = "";
    }
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
    if (ev.type === "stream_event") {
      const se = ev.event;
      if (se?.type === "content_block_delta" && se.delta?.type === "text_delta" && se.delta.text) {
        textBuf += se.delta.text;
        if (textBuf.length >= 40 || textBuf.includes("\n")) flushText();
      }
      return; // deltas drive the live stream; the trailing complete message handles tools
    }
    if (ev.type === "system" && ev.session_id) {
      push({ kind: "session", cliSessionId: ev.session_id });
    } else if (ev.type === "assistant" && ev.message?.content) {
      flushText(); // settle this message's text-delta tail before its tools
      let hadText = false;
      for (const block of ev.message.content) {
        if (block.type === "text") hadText = true; // already streamed via deltas — don't re-push
        else if (block.type === "tool_use") push({ kind: "tool", name: block.name, detail: shortJson(block.input) });
      }
      if (hadText) push({ kind: "text", text: "\n\n" }); // paragraph break, identical live & on reload
    } else if (ev.type === "result") {
      flushText();
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
    flushText(); // emit any text tail that never hit the flush threshold
    const exit = code ?? 0;
    if (exit !== 0 && stderr.trim()) push({ kind: "error", message: stderr.trim().slice(0, 2000) });
    push({ kind: "done", exitStatus: exit });
    finished = true;
    resolve?.();
    resolve = null;
  });
  forceFinishOnExit(child, () => finished, (exit) => {
    flushText();
    push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
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
    return s && s.length > 1500 ? s.slice(0, 1497) + "…" : s;
  } catch {
    return undefined;
  }
};
