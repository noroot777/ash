// 会话落盘格式的单点：assistant 正文写 <sessId>.md；结构化事件顺序写
// <sessId>.trace.jsonl，其中相邻 text delta 会先合并成正文片段再落盘。一次性 run
// 与常驻调度台都走这里，因此刷新能把每组 thinking/tool 放回它所启动的正文片段，
// 同时非正文事件绝不会混进 assistant Markdown。
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { AgentEvent, AgentType } from "@ash/shared";
import { RUNS_DIR, RUNS_FALLBACK_DIR } from "./paths.js";

type AgentTraceEvent = Extract<AgentEvent, { kind: "thinking" | "tool" | "error" }>;
type TraceTextEvent = { kind: "text"; text: string };
// 本回合的 token 用量。落 trace 而不是只落库,是因为**会话行只有累计值**——刷新
// 后要按回合把「这一轮花了多少」放回各自的气泡,就得有一份按 turnStartedAt 分组
// 的记录,而 trace 天生就是这个形状。
type TraceUsageEvent = Extract<AgentEvent, { kind: "usage" }>;
type TraceAttachmentEvent = Extract<AgentEvent, { kind: "attachment" }>;
// 本回合的执行器参数。verifyRound 记「这一回合是就地验证的第几轮」（不是验证轮时缺省），
// 读端据此把审查者的发言跟同一条会话里的实现回合分开——它俩本来长得一模一样。
type TraceRunEvent = { kind: "run"; model: string | null; reasoningEffort: string | null; verifyRound?: number | null };
export type SessionTraceEvent = AgentTraceEvent | TraceTextEvent | TraceUsageEvent | TraceAttachmentEvent | TraceRunEvent;
export type SessionTraceEntry = {
  at: string;
  turnStartedAt: string;
  event: SessionTraceEvent;
};

// Canonical persisted Markdown path for one session. Keep API serialization and
// cross-task handoffs on the same derivation as the writers in orchestrator/team.
export function sessionTranscriptPath(taskId: string, sessionId: string): string {
  return join(RUNS_DIR, taskId, `${sessionId}.md`);
}

export function sessionTracePath(taskId: string, sessionId: string): string {
  return join(RUNS_DIR, taskId, `${sessionId}.trace.jsonl`);
}

/**
 * **读**一份 run 产物时用的路径：本地没有就回退到 `RUNS_FALLBACK_DIR`（见 paths.ts）。
 *
 * 只有预览实例设了那个变量，其余情况这个函数恒等于原样返回。**写入一律不要过这里**——
 * 回退目录是别人的（主仓的）data/runs，往里写等于篡改真实历史。
 */
export function readableRunPath(path: string): string {
  if (!RUNS_FALLBACK_DIR || existsSync(path)) return path;
  const rel = relative(RUNS_DIR, path);
  // 不在 RUNS_DIR 底下的路径不归这条规则管（别把回退目录当成任意路径的前缀）。
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return path;
  return join(RUNS_FALLBACK_DIR, rel);
}

export function appendSessionTrace(
  taskId: string,
  sessionId: string,
  turnStartedAt: string,
  event: SessionTraceEvent,
  at = new Date().toISOString(),
): void {
  const path = sessionTracePath(taskId, sessionId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at, turnStartedAt, event } satisfies SessionTraceEntry)}\n`);
  } catch (error) {
    // Trace persistence is diagnostic UI state. A disk failure must not alter the
    // executor's outcome, but it must remain visible to operators.
    console.warn(`[ash] failed to persist session trace ${sessionId}:`, error);
  }
}

// 只读尾巴：判据要的那条事件属于**最后一回合**，它一定贴在文件末尾；整份读进来对长会话
// 是白白几 MB。切口那半行 JSON 解析不过，parseSessionTrace 自己会丢掉。
const TRACE_TAIL_BYTES = 256 * 1024;

/**
 * 这一回合的 CLI 到底干没干活 —— 本回合的 trace 里有没有正文 / 工具调用 / 落盘附件。
 *
 * 用处是「崩掉的回合能不能**从中断处**接着说」：干过活就证明 CLI 真的起来了、本回合的
 * 任务书已经在它手里、产出也进了 CLI 自己的会话历史，于是续跑只需要一句「接着做」；
 * 反之（只剩 run/error —— 503 起不来、启动就挂）那条 CLI 会话压根没见过本回合的任务，
 * 对它说「继续」等于什么都没说，必须把任务书整份重发。
 *
 * 判据取 trace 不取 `.md`：trace 每条都带 turnStartedAt，天然按回合分得开；`.md` 里的
 * agent 段没有自己的时间戳，得靠前后段落推，跨轮复用的会话上尤其容易推错。
 */
export async function turnProducedWork(taskId: string, sessionId: string, turnStartedAt: string): Promise<boolean> {
  const path = readableRunPath(sessionTracePath(taskId, sessionId));
  let raw: string;
  try {
    const info = await stat(path);
    const length = Math.min(info.size, TRACE_TAIL_BYTES);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, info.size - length);
      raw = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    // 没有 trace（老会话、产物被清过）= 无从证明它干过活。默认走「重发整份任务书」那档，
    // 那一档在任何上下文状态下都是对的，只是费一点 token。
    return false;
  }
  return parseSessionTrace(raw).some((entry) => entry.turnStartedAt === turnStartedAt
    && (entry.event.kind === "text" || entry.event.kind === "tool" || entry.event.kind === "attachment"));
}

export function parseSessionTrace(raw: string): SessionTraceEntry[] {
  const entries: SessionTraceEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Partial<SessionTraceEntry>;
      const event = entry.event;
      const validRun = event?.kind !== "run" || (
        (event.model === null || typeof event.model === "string")
        && (event.reasoningEffort === null || typeof event.reasoningEffort === "string")
      );
      if (
        typeof entry.at !== "string"
        || typeof entry.turnStartedAt !== "string"
        || !event
        || !["text", "thinking", "tool", "error", "usage", "attachment", "run"].includes(event.kind)
        || !validRun
        || (event.kind === "text" && typeof event.text !== "string")
        || (event.kind === "attachment" && typeof event.path !== "string")
        || (event.kind === "usage" && (!event.usage || typeof event.usage !== "object"))
      ) continue;
      entries.push(entry as SessionTraceEntry);
    } catch {
      // A partially written final JSONL line should not hide earlier valid trace.
    }
  }
  return entries;
}

// A non-text interjection in the run timeline — a 你→@agent reply or a 〔系统〕
// continue — is persisted as ONE sentinel line: RS (\x1e, which never occurs in
// agent text) + JSON. JSON keeps it to a single physical line even when the text
// has newlines, so the reload parser can lift it back into its own bubble (with
// the timestamp it carries) instead of letting it bleed into the surrounding
// agent Markdown. Live, the same turn rides its own channel (a user reply shows
// optimistically client-side; a system trace via a `system` event), so both
// surfaces read identically.
export const TURN_SENTINEL = "\x1e";

export function writeTurn(
  out: NodeJS.WritableStream,
  // by:"system" = 这条虽然占的是真人回合（它必须是 user 回合，否则 followUpFrom 护不住
  // 任务原来的终态），但字是后端写的（验证打回、验收冲突交接）。不标的话，「我发的最后
  // 一条追问」那类读端只能看着一模一样的 user 回合瞎猜。
  // level:"notice" = 结算说明（这一轮为什么落成这个状态）。落盘也要带着，否则刷新之后
  // 展示端只剩正文可读，又得回到「按关键词猜语气」那条路上去。
  turn: { t: "user" | "system"; agent: AgentType; text: string; by?: "system"; level?: "notice" },
  at: string,
): void {
  out.write(`\n${TURN_SENTINEL}${JSON.stringify({ ...turn, at })}\n`);
}

// Fence where an agent turn ACTUALLY finished (real exec end), so per-turn 用时 in
// the conversation brackets [你→ reply → agent done] instead of [reply → your NEXT
// reply] — i.e. it excludes the idle wait while the agent sat waiting for you.
// Distinct from writeTurn (which fences human/system interjections, not exec ends).
export function writeTurnEnd(out: NodeJS.WritableStream, at: string): void {
  out.write(`\n${TURN_SENTINEL}${JSON.stringify({ t: "agentEnd", at })}\n`);
}

export function writeRunError(out: NodeJS.WritableStream, message: string): void {
  const quoted = message.trim().split("\n").map((line) => `> ${line}`).join("\n");
  out.write(`\n> **执行诊断**\n${quoted}\n`);
}

// codex 的原始事件/stderr/诊断落盘路径(每会话每回合一组)。
export function runTracePaths(runDir: string, sessionId: string, turnStart: string) {
  const turn = turnStart.replace(/[^0-9A-Za-z]/g, "");
  const base = join(runDir, `${sessionId}-${turn}`);
  return {
    eventsPath: `${base}.codex-events.jsonl`,
    stderrPath: `${base}.stderr.log`,
    diagnosticsPath: `${base}.diagnostics.json`,
  };
}
