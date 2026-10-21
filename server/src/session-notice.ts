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
import type { AgentEvent, AgentType, SessionNotice, SessionRole } from "@ash/shared";
import { bus } from "./bus.js";
import { sessionTranscriptPath, writeTurn, type SessionTraceEntry } from "./transcript.js";
import { now } from "./util.js";

// 刻意**不**写成类型守卫(`event is Extract<AgentEvent, { kind: "error" }>`):那样
// 一写 else,TS 就把整个 error 变体从否定分支里剔掉,普通 error 的 `.message` 当场编译
// 不过 —— 而「带 scope 的 error」在类型上本来就不是一个独立变体(scope 是可选字段)。
// 调用方按老规矩先 `kind === "error"` 收窄,再用这个判据分流。
export function isSessionScopeNotice(event: AgentEvent): boolean {
  return event.kind === "error" && event.scope === "session";
}

/**
 * 这条 error 只是**执行过程里的一条提示**(上游在重试、还在等回话),不是执行故障。
 *
 * 跟上面那个判据的分工:`scope:"session"` 说的是「这条恢复会话作废了」,要降成**会话级
 * 旁注**;`level:"notice"` 说的是「本回合正在正常进行,只是顺带报一句」,要留在**执行
 * 过程**里它发生的那个位置(走 trace)。所以两者的消费方式正相反,别合并成一个判据。
 *
 * 所有消费链的口径一致:照落 trace、照发给前端,但一概不当失败处理 —— 不写「执行诊断」
 * 红块、不并进 SessionResumeFault、不置 sawExecutionError、不让 duet 判这一轮失败。
 * 同样刻意不写成类型守卫,理由见上。
 */
export function isExecutionNotice(event: AgentEvent): boolean {
  return event.kind === "error" && event.level === "notice";
}

// 一条会话上最多回这么多条过程提示(只留最近的)。上游连环重试能刷出几十条,而这个出口
// 要答的是「现在卡住了没有」,不是完整流水 —— 完整流水在 trace 自己那份里。
const NOTICE_LIMIT = 50;

/** 这条 trace 条目算「上游接着往下走了」—— 它一出现,在它之前的等待提示就解除了。 */
const tracedProgress = (entry: SessionTraceEntry): boolean => {
  const event = entry.event;
  if (event.kind === "error") return !isExecutionNotice(event);
  return event.kind === "text" || event.kind === "thinking" || event.kind === "tool"
    || event.kind === "attachment" || event.kind === "usage";
};

/**
 * 这条会话**此刻还悬着**的过程提示(形状与去处见 shared 的 SessionNotice)。
 *
 * 判据分三档,都只认这条会话行自己记着的事实:
 * - 跑完且收在 0 上 → 一条不给。重试成功了的那几句话没有任何此刻意义,而这个出口的消费者
 *   只能把它们贴在会话末尾 —— 恰恰是「排在整篇回答后面的一坨」那个毛病。
 * - 还在飞 → 只给**最后一条真进度之后**的那几句。提示之后上游又吐了东西就等于已经恢复,
 *   那时它属于执行过程里它发生的那一步,不属于「此刻状态」。
 * - 收在非 0 上 → 这一轮全部提示照给:失败时它们就是现场,用户要的正是「它卡在哪儿」。
 *
 * 只看 `turnStartedAt` 等于会话行当前回合的那些条目:trace 是跨回合追加的,上一轮悬着的
 * 提示在新回合开跑那一刻就已经是历史了。
 */
export function pendingSessionNotices(
  entries: SessionTraceEntry[],
  session: { turnStartedAt?: string | null; endedAt: string | null; exitStatus: number | null },
): SessionNotice[] {
  const turn = session.turnStartedAt;
  if (!turn) return [];
  const settled = session.endedAt !== null;
  if (settled && session.exitStatus === 0) return [];
  const inTurn = entries.filter((entry) => entry.turnStartedAt === turn);
  let from = 0;
  if (!settled) {
    for (const [index, entry] of inTurn.entries()) if (tracedProgress(entry)) from = index + 1;
  }
  const out: SessionNotice[] = [];
  for (const entry of inTurn.slice(from)) {
    const event = entry.event;
    if (event.kind !== "error" || !isExecutionNotice(event)) continue;
    out.push({ at: entry.at, turnStartedAt: entry.turnStartedAt, text: event.message });
  }
  return out.slice(-NOTICE_LIMIT);
}

/**
 * 两处一起落：`.md` 原始产物里的 `t:"system"` 回合行（刷新后还在）+ SSE（实时）。
 *
 * 用的就是别处系统注记那套写法（`session-version-guard.ts`、`task-run.ts`、
 * `team/session.ts` 的 teamNote），所以读端不需要认新形状：`conversationModel` 的
 * 落盘路与直播路都已经把 system 渲染成 note，`turnKey("system", …)` 也天然去重。
 * 反过来说,这里**不能**改用 trace(那条路见 isExecutionNotice):trace 是按回合回放的
 * 执行过程,而会话轮换讲的是「这条会话本身怎么了」—— 它跨回合、也可能发生在压根没有
 * 回合的时候(announceSessionNote 就在 spawn 之前写),塞进某一回合的执行过程里就等于
 * 挂在一个与它无关的回合名下。
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
