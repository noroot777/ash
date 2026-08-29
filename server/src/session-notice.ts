// 会话轮换（Codex thread 被判 poisoned、CLI 否认了恢复 id）跟**本回合成败正交**：
// exit 0、正文完整的一轮照样可能带一条轮换诊断。所以这类信号一律以**持久 system
// 注记**落地，而不是 `kind:"error"` —— error 在时间线上渲染成红色「异常」，会让一次
// 健康产出被用户读成执行失败（自由工作流第 1 轮审查 P2：single/team 当时同时显示
// 「本轮执行结束」和两条红色异常）。真实执行失败不带这个 scope，仍走 error。
//
// 判据只有 `scope === "session"` 一个（`shared/src/events.ts`），生产方是
// `executors/codex.ts` 里的 poisoned 诊断。single-run / team / duet 三条链共用下面
// 这两个函数，别再各自内联判断 —— duet 早先只在自己那条链上分流，另外两条漏了。
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";
import type { AgentEvent, AgentType, SessionRole } from "@ash/shared";
import { bus } from "./bus.js";
import { sessionTranscriptPath, writeTurn } from "./transcript.js";
import { now } from "./util.js";

// 刻意**不**写成类型守卫(`event is Extract<AgentEvent, { kind: "error" }>`):那样
// 一写 else,TS 就把整个 error 变体从否定分支里剔掉,普通 error 的 `.message` 当场编译
// 不过 —— 而「带 scope 的 error」在类型上本来就不是一个独立变体(scope 是可选字段)。
// 调用方按老规矩先 `kind === "error"` 收窄,再用这个判据分流。
export function isSessionScopeNotice(event: AgentEvent): boolean {
  return event.kind === "error" && event.scope === "session";
}

/**
 * 两处一起落：`.md` 原始产物里的 `t:"system"` 回合行（刷新后还在）+ SSE（实时）。
 *
 * 用的就是别处系统注记那套写法（`session-version-guard.ts`、`task-run.ts`、
 * `team/session.ts` 的 teamNote），所以读端不需要认新形状：`conversationModel` 的
 * 落盘路与直播路都已经把 system 渲染成 note，`turnKey("system", …)` 也天然去重。
 * 反过来说,这里**不能**改用 trace —— `SessionTraceEvent` 只收 thinking/tool/error,
 * 落进去就又变回红色异常了。
 */
export function emitSessionNotice(args: {
  out: NodeJS.WritableStream;
  agentType: AgentType;
  text: string;
  publish: (event: AgentEvent) => void;
  at?: string;
}): void {
  const at = args.at ?? now();
  writeTurn(args.out, { t: "system", agent: args.agentType, text: args.text }, at);
  args.publish({ kind: "system", text: args.text, at });
}

/**
 * 跨人回合接不上旧会话时,留在**旧会话**时间线上的那一句。
 *
 * 单飞(orchestrator)与 duet 共用一份文本:两条链遇到的是同一件事,措辞漂了只会让
 * 用户以为是两种毛病。
 * 会话流里这条渲染成纯文本一行小字(ConversationFeed 的 conversation-note),所以
 * **文案里不能带 Markdown 标记** —— 星号和反引号会原样露给用户。
 */
export const CROSS_OWNER_SESSION_NOTE =
  "〔换人接手〕这一轮由另一位用户发起。CLI 的会话记录存在发起人自己的配置目录里"
  + "（多人模式下一人一份），这条会话不在那儿，续用它只会当场扑空，所以本轮另开了一条新会话。"
  + "这条会话原样保留，原来那位再回来时仍从这里接着跑。";

/**
 * 同样的一条注记，但用在**手上还没有那条会话的输出流**的时候：自己开一次 transcript
 * 追加、等它真正落盘，再广播。
 *
 * 「等落盘」是刻意的：这类注记全都写在「接下来还要解析工作目录 / 过暂停闸 / spawn」
 * 之前，中途任何一处抛错,用户刷新页面仍得能看出这条会话为什么被换掉。
 */
export async function announceSessionNote(args: {
  taskId: string;
  sessionId: string;
  role: SessionRole;
  agentType: AgentType;
  text: string;
  publish?: boolean;
}): Promise<string> {
  const at = now();
  const transcriptPath = sessionTranscriptPath(args.taskId, args.sessionId);
  mkdirSync(dirname(transcriptPath), { recursive: true });
  const out = createWriteStream(transcriptPath, { flags: "a" });
  writeTurn(out, { t: "system", agent: args.agentType, text: args.text }, at);
  out.end();
  await finished(out);
  if (args.publish !== false) {
    bus.publish({
      type: "agent.event",
      taskId: args.taskId,
      sessionId: args.sessionId,
      role: args.role,
      agentType: args.agentType,
      event: { kind: "system", text: args.text, at },
    });
  }
  return args.text;
}
