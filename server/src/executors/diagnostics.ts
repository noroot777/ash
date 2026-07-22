import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface RunTracePaths {
  eventsPath: string;
  stderrPath: string;
  diagnosticsPath: string;
}

export type RunFailureKind =
  | "spawn_error"
  | "turn_failed"
  | "process_signal"
  | "stream_flush_timeout"
  | "silent_nonzero_exit"
  | "nonzero_exit"
  | "missing_turn_completion";

export type RunTerminationKind = RunFailureKind | "completed" | "manual_stop";

export interface RunDiagnostics {
  version: 1;
  recordedAt: string;
  terminationKind: RunTerminationKind;
  failureKind: RunFailureKind | null;
  failureReason: string | null;
  exitStatus: number;
  exitSignal: NodeJS.Signals | null;
  stopRequested: boolean;
  turnCompleted: boolean;
  turnFailed: boolean;
  agentMessageCount: number;
  lastEventType: string | null;
  lastEventSummary: string | null;
  stderrTail: string | null;
  structuredErrors: string[];
  traceWriteError: string | null;
  eventsPath: string | null;
  stderrPath: string | null;
}

export interface CodexExitEvidence {
  exitStatus: number;
  exitSignal: NodeJS.Signals | null;
  stopRequested: boolean;
  turnCompleted: boolean;
  turnFailedMessage: string | null;
  structuredErrors: string[];
  stderrTail: string;
  lastEventType: string | null;
  lastEventSummary: string | null;
  agentMessageCount: number;
  spawnError?: string | null;
  forceFinished?: boolean;
}

export function classifyCodexExit(e: CodexExitEvidence): Pick<RunDiagnostics, "terminationKind" | "failureKind" | "failureReason"> {
  if (e.stopRequested) {
    return { terminationKind: "manual_stop", failureKind: null, failureReason: null };
  }
  if (e.spawnError) {
    return { terminationKind: "spawn_error", failureKind: "spawn_error", failureReason: e.spawnError };
  }
  if (e.turnFailedMessage) {
    return { terminationKind: "turn_failed", failureKind: "turn_failed", failureReason: e.turnFailedMessage };
  }
  if (e.exitSignal) {
    return {
      terminationKind: "process_signal",
      failureKind: "process_signal",
      failureReason: `Codex 进程收到 ${e.exitSignal} 后结束。`,
    };
  }
  if (e.forceFinished) {
    return {
      terminationKind: "stream_flush_timeout",
      failureKind: "stream_flush_timeout",
      failureReason: "Codex 进程已经退出，但 stdout/stderr 流未在宽限期内关闭。",
    };
  }
  if (e.exitStatus !== 0) {
    const explicit = e.structuredErrors.at(-1) || e.stderrTail.trim();
    if (explicit) {
      return {
        terminationKind: "nonzero_exit",
        failureKind: "nonzero_exit",
        failureReason: explicit,
      };
    }
    return {
      terminationKind: "silent_nonzero_exit",
      failureKind: "silent_nonzero_exit",
      failureReason: `Codex 以 exit ${e.exitStatus} 结束，但未收到 turn.failed/error，stderr 为空，且${e.turnCompleted ? "已" : "未"}收到 turn.completed。`,
    };
  }
  if (!e.turnCompleted) {
    return {
      terminationKind: "missing_turn_completion",
      failureKind: "missing_turn_completion",
      failureReason: "Codex 进程以 exit 0 结束，但事件流中没有 turn.completed，无法确认回合正常收尾。",
    };
  }
  return { terminationKind: "completed", failureKind: null, failureReason: null };
}

export function formatFailureForTimeline(d: RunDiagnostics): string | null {
  if (!d.failureKind || !d.failureReason) return null;
  const evidence = [
    `类型 ${d.failureKind}`,
    `exit ${d.exitStatus}`,
    d.exitSignal ? `signal ${d.exitSignal}` : null,
    d.lastEventType ? `最后事件 ${d.lastEventType}` : null,
    d.turnCompleted ? "收到 turn.completed" : "未收到 turn.completed",
    d.stderrTail ? "stderr 有内容" : "stderr 为空",
  ].filter(Boolean).join("；");
  const files = [d.eventsPath, d.stderrPath].filter(Boolean).join("；");
  return `执行诊断：${d.failureReason}\n证据：${evidence}${files ? `\n原始日志：${files}` : ""}`;
}

export class RunTraceRecorder {
  private eventsFd: number | null = null;
  private stderrFd: number | null = null;
  private stderrTail = "";
  private traceWriteError: string | null = null;

  constructor(private readonly paths?: RunTracePaths) {
    if (!paths) return;
    try {
      mkdirSync(dirname(paths.eventsPath), { recursive: true });
      this.eventsFd = openSync(paths.eventsPath, "a", 0o600);
      this.stderrFd = openSync(paths.stderrPath, "a", 0o600);
    } catch (err) {
      this.traceWriteError = String(err instanceof Error ? err.message : err);
      this.closeFiles();
    }
  }

  event(rawLine: string): void {
    this.write(this.eventsFd, `${rawLine}\n`);
  }

  stderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-8000);
    this.write(this.stderrFd, chunk);
  }

  finish(evidence: Omit<CodexExitEvidence, "stderrTail">): RunDiagnostics {
    this.closeFiles();
    const classified = classifyCodexExit({ ...evidence, stderrTail: this.stderrTail });
    const diagnostics: RunDiagnostics = {
      version: 1,
      recordedAt: new Date().toISOString(),
      ...classified,
      exitStatus: evidence.exitStatus,
      exitSignal: evidence.exitSignal,
      stopRequested: evidence.stopRequested,
      turnCompleted: evidence.turnCompleted,
      turnFailed: !!evidence.turnFailedMessage,
      agentMessageCount: evidence.agentMessageCount,
      lastEventType: evidence.lastEventType,
      lastEventSummary: evidence.lastEventSummary,
      stderrTail: this.stderrTail.trim() || null,
      structuredErrors: evidence.structuredErrors,
      traceWriteError: this.traceWriteError,
      eventsPath: this.paths?.eventsPath ?? null,
      stderrPath: this.paths?.stderrPath ?? null,
    };
    if (this.paths) {
      try {
        writeFileSync(this.paths.diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, { mode: 0o600 });
      } catch (err) {
        diagnostics.traceWriteError ??= String(err instanceof Error ? err.message : err);
      }
    }
    return diagnostics;
  }

  private write(fd: number | null, text: string): void {
    if (fd === null || !text) return;
    try {
      writeSync(fd, text);
    } catch (err) {
      this.traceWriteError ??= String(err instanceof Error ? err.message : err);
    }
  }

  private closeFiles(): void {
    for (const fd of [this.eventsFd, this.stderrFd]) {
      if (fd === null) continue;
      try {
        closeSync(fd);
      } catch {
        // Best effort: diagnostics should not change the agent's exit outcome.
      }
    }
    this.eventsFd = null;
    this.stderrFd = null;
  }
}
