// 单飞这一回合**对外说话的出口**：实时 SSE（`publishEvent`）、执行过程（trace，`persistTrace`）、会话
// 正文 `.md`（`emitText`、会话轮换旁注）。团队调度台那一路的同一件事在 team/lead-voice.ts。
//
// 从 single-run.ts 拆出来（单文件 700 行），也因为这几样要一起守一条规矩：**同一条记录在三处带同一个
// 身份**（记录号 + 回合，见 shared/src/session-output.ts 的 RecordIdentity）。落进 trace 的那条、写进
// .md 的那一行领的号，实时事件原样带出去；页面凭它认「这条实时事件就是盘上那条」，不比时间和文字。
import type { AgentEvent, AgentType, SessionRole } from "@ash/shared";
import type { RecordIdentity } from "@ash/shared/session-output";
import { bus } from "./bus.js";
import { appendSessionTrace, writeTurn } from "./transcript.js";
import { isIdentityStream, onRecord, reserveRecord, writeProse } from "./transcript-identity.js";
import { noteAgentEventUpload } from "./uploads.js";
import { now } from "./util.js";

type RunMeta = { model: string | null; reasoningEffort: string | null; verifyRound?: number };

export function createRunVoice(a: {
  taskId: string;
  sessId: string;
  turnStart: string;
  role: SessionRole;
  agentType: AgentType;
  runMeta: RunMeta;
  out: NodeJS.WritableStream;
}) {
  const { taskId, sessId, turnStart, role, agentType, runMeta, out } = a;
  let pendingTraceText = "";
  // 会话轮换旁注的缓冲。先取空再写：正常尾部（agentEnd 之后）跑一次，异常路径的兜底再跑一次也只是
  // 空转 —— 既不会把同一条写两遍，也不会往已经 end 掉的流上再写（写已 end 的流会当场打崩 server）。
  // identity：实时播出去那一刻就领好的号（reserveRecord），落盘时原样带上。
  const sessionNotices: { text: string; at: string; level?: "notice"; identity: RecordIdentity | null }[] = [];

  // record：这条事件在盘上那条记录的号（trace 落下的那条、.md 那一行），正文增量另带它在那段正文里的位置。
  // 这一回合带身份时，不是记录的那几种（收口、水位、簿记）不带号，信封上标 identityTurn 说明它归哪一路
  // （见 transcript-identity.ts 文件头）。
  const identityTurn = isIdentityStream(out);
  const publishEvent = (event: AgentEvent, record?: { seq: number; textOffset?: number } | null) => bus.publish({
    type: "agent.event", taskId, sessionId: sessId, role, agentType, ...runMeta, turnStartedAt: turnStart,
    ...(identityTurn ? { identityTurn: true as const } : {}),
    ...(record ? { seq: record.seq, ...(record.textOffset !== undefined ? { textOffset: record.textOffset } : {}) } : {}),
    event,
  });
  const flushTraceText = (at?: string) => {
    if (!pendingTraceText) return;
    appendSessionTrace(taskId, sessId, turnStart, { kind: "text", text: pendingTraceText }, at);
    pendingTraceText = "";
  };
  // 往这条流上写任何一行记录之前（插话、旁注、收口），先把 trace 里攒着的正文落下：两份文件在同一处
  // 切开，回合中间插进来的那句话前后各是哪几个字，盘上一看就知道（见 transcript-identity.ts）。
  onRecord(out, () => flushTraceText());

  return {
    publishEvent,
    flushTraceText,
    // 会话轮换旁注：实时立刻播（用户正看着），落盘攒到 writeTurnEnd 之后再补 —— 夹在正文和 agentEnd
    // 之间会让重建出来的回合用时失准（见 single-run.ts 事件循环里那段注释）。
    noteSessionNotice: (text: string, at = now(), level?: "notice") => {
      const identity = reserveRecord(out);
      sessionNotices.push({ text, at, level, identity });
      publishEvent({ kind: "system", text, at, ...(level ? { level } : {}) }, identity);
    },
    flushSessionNotices: () => {
      for (const notice of sessionNotices.splice(0)) {
        writeTurn(out, { t: "system", agent: agentType, text: notice.text, level: notice.level }, notice.at, notice.identity);
      }
    },
    emitText: (text: string) => {
      if (!text) return;
      const prose = writeProse(out, text);
      pendingTraceText += text;
      publishEvent({ kind: "text", text }, prose && { seq: prose.seq, textOffset: prose.offset });
    },
    // 返回落进 trace 的那条的号（没落就是 null），实时事件带上同一个。
    persistTrace: (event: AgentEvent, at?: string): { seq: number } | null => {
      // `context` 刻意不进 trace：trace 是「按回合回放各自的气泡」，而水位属于整条会话的
      // 此刻、只有最后一个值有意义，它的家在 sessions 行上（setSessionContext）。
      if (event.kind === "thinking" || event.kind === "tool" || event.kind === "error" || event.kind === "usage" || event.kind === "attachment") {
        // agent 自己产出的图(工具结果截图之类)也躺在 uploads 目录里,归属跟着这个任务走 ——
        // 不登记的话多人模式下它是「无主资产」,同项目的人在会话里打不开(uploads.ts)。
        // 团队那条链的同一处在 team/session-consumer.ts 的 traceLead:改一处记得看另一处。
        noteAgentEventUpload(taskId, event);
        flushTraceText();
        const seq = appendSessionTrace(taskId, sessId, turnStart, event, at);
        return seq === null ? null : { seq };
      }
      if (event.kind === "done" || event.kind === "turnEnd") flushTraceText();
      return null;
    },
  };
}
