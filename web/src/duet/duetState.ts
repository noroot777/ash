import type { DuetConsensusBy, DuetSpeaker, GateName, ServerEvent, TurnImageRef } from "@ash/shared";
import { isVisibleExecutionEvent } from "@ash/shared/native-work";
import { resumesWaiting } from "@ash/shared/waiting";
import { appendExecutionEvent, type ExecutionEvent } from "../lib/executionTrace.ts";

export type DuetTurn = {
  round: number;
  speaker: DuetSpeaker;
  text: string;
  // 合稿轮的停止原因(consensus/agreedToStop/roundCap/midway);其余轮与旧行为 undefined。
  stop?: string;
  /** 本回合的执行过程(工具/思考),与普通任务、团队共用一个「执行过程」折叠块。 */
  events: ExecutionEvent[];
  /**
   * 正文第几处 `![](…)` 引用对上哪份拷贝(逐处引用一条,见 shared 的 TurnImageRef)。
   * 配对规则跟会话流**同一份**(turnImages):少了它,同一张图在会话流里画的是「说那句话
   * 时的快照」,在讨论区画的是「现在的文件」(审查第 1 轮 F1 同类路径)。
   */
  images?: TurnImageRef[];
  raised: boolean;
  /**
   * 本回合停在一条等待提示上(上游在重试/还没回话),由归约层维护:提示置上、下一条
   * 真进度置回。展示入口一律读它,别自己从「最后一条事件是不是提示」倒推 —— 回合里的
   * 正文和事件都是整轮累积的,倒推不出「这条提示之后有没有新东西来」。
   */
  awaiting: boolean;
  agrees?: boolean;
  conclusion?: string;
  done: boolean;
  error?: string;
  notice?: string;
  at?: string;
  startedAt?: string;
  durationMs?: number;
  target?: "A" | "B";
};

export type DuetGate = {
  gate: GateName;
  open: boolean;
  consensus?: boolean;
  consensusBy?: DuetConsensusBy;
  conclusionA?: string | null;
  conclusionB?: string | null;
};

export type DuetState = { turns: DuetTurn[]; gate: DuetGate | null };
// 落盘的回合行:events 是后加的,旧 transcript 里没有(缺省当作没有执行过程)。
// awaiting 只在回合进行中有意义,落盘的都是已结束的回合,所以不进这份投影。
export type PersistedDuetTurn = Omit<DuetTurn, "events" | "done" | "raised" | "awaiting"> & { raised?: boolean; events?: ExecutionEvent[] };
export type PersistedDuetEntry =
  | PersistedDuetTurn
  | Extract<ServerEvent, { type: "duet.gate" | "duet.progress" }>;

export const emptyDuet = (): DuetState => ({ turns: [], gate: null });

function isPersistedGate(entry: PersistedDuetEntry): entry is Extract<ServerEvent, { type: "duet.gate" }> {
  return (entry as { type?: string }).type === "duet.gate";
}

function isPersistedProgress(entry: PersistedDuetEntry): entry is Extract<ServerEvent, { type: "duet.progress" }> {
  return (entry as { type?: string }).type === "duet.progress";
}

function speakerOf(role: string): DuetSpeaker {
  if (role === "voiceB") return "B";
  if (role === "implementer") return "impl";
  if (role === "reviewer") return "review";
  return "A";
}

export function applyDuetEvent(state: DuetState, event: ServerEvent): DuetState {
  if (event.type === "duet.progress") {
    if (event.phase === "start") {
      const turns = [...state.turns];
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index]!;
        if (turn.round !== event.round || turn.speaker !== event.speaker || turn.done) continue;
        turns[index] = { ...turn, startedAt: event.startedAt ?? event.at ?? turn.startedAt };
        return { ...state, turns };
      }
      return {
        ...state,
        turns: [...turns, {
          round: event.round,
          speaker: event.speaker,
          text: "",
          events: [],
          raised: false,
          awaiting: false,
          done: false,
          startedAt: event.startedAt ?? event.at,
        }],
      };
    }
    const turns = [...state.turns];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index]!.speaker === event.speaker && !turns[index]!.done) {
        turns[index] = {
          ...turns[index]!,
          done: true,
          awaiting: false,
          raised: !!event.raisedHand,
          at: event.at,
          startedAt: event.startedAt ?? turns[index]!.startedAt,
          durationMs: event.durationMs,
        };
        break;
      }
    }
    return { ...state, turns };
  }
  if (event.type === "duet.gate") {
    const previous = state.gate?.gate === event.gate ? state.gate : null;
    return {
      ...state,
      gate: {
        gate: event.gate,
        open: event.open,
        consensus: event.consensus ?? previous?.consensus,
        consensusBy: event.consensusBy ?? previous?.consensusBy ?? (event.consensus ? "both" : undefined),
        conclusionA: event.conclusionA ?? previous?.conclusionA,
        conclusionB: event.conclusionB ?? previous?.conclusionB,
      },
    };
  }
  if (event.type === "duet.user") {
    return {
      ...state,
      turns: [...state.turns, {
        round: event.round,
        speaker: "user",
        text: event.text,
        events: [],
        raised: false,
        awaiting: false,
        done: true,
        at: event.at,
        target: event.target,
      }],
    };
  }
  if (event.type === "agent.event") {
    const speaker = speakerOf(event.role);
    const turns = [...state.turns];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index]!.speaker !== speaker || turns[index]!.done) continue;
      const turn = { ...turns[index]! };
      if (event.event.kind === "text") turn.text += event.event.text;
      // 正文引用到的图:实时这一路同样逐处留下(落盘那一路见 duet/turn.ts 的 images)。
      if (event.event.kind === "attachment" && event.event.source) {
        turn.images = [...(turn.images ?? []), { path: event.event.path, source: event.event.source, ref: event.event.ref, pos: event.event.pos, lost: event.event.lost }];
      }
      // label 兜底同 task-detail/conversationSegments.ts 的 auxEvent：下游按字符串用它，
      // 一条没名字的 tool 事件能把整页打崩。
      if (event.event.kind === "tool" && isVisibleExecutionEvent(event.event)) turn.events = [...turn.events, { kind: "tool", label: typeof event.event.name === "string" ? event.event.name : "", detail: event.event.detail }];
      // 思考是流式小块,相邻的合并成一行(见 appendExecutionEvent)。
      if (event.event.kind === "thinking") turn.events = appendExecutionEvent(turn.events, { kind: "thinking", label: "思考过程", detail: event.event.text });
      // error / notice 都累积:服务端 runTurn 落 transcript 时就是拼接的,实时这边要是
      // 覆盖,同一个回合出多条时实时只剩最后一条、刷新后又变成全部,两个面读不一样。
      // level:"notice" 的 error 不是故障,是过程里的一句提示(上游在重试、还在等回话):
      // 跟服务端 runTurn 同一个去处 —— 进本回合的执行过程,不进 error(那会把一场正常
      // 收敛的讨论标成失败)。
      if (event.event.kind === "error") {
        if (event.event.level === "notice") turn.events = [...turn.events, { kind: "notice", label: "提示", detail: event.event.message }];
        else turn.error = `${turn.error ?? ""}\n${event.event.message}`.trim();
      }
      // 等待状态在这里一处算完(见 DuetTurn.awaiting):提示置上,随后任何一条真进度置回。
      if (event.event.kind === "error" && event.event.level === "notice") turn.awaiting = true;
      else if (resumesWaiting(event.event)) turn.awaiting = false;
      if (event.event.kind === "system") turn.notice = `${turn.notice ?? ""}\n${event.event.text}`.trim();
      turns[index] = turn;
      break;
    }
    return { ...state, turns };
  }
  return state;
}

export function latestActiveDuetTurn(turns: DuetTurn[]): DuetTurn | null {
  return [...turns].reverse().find((turn) =>
    !turn.done && (turn.speaker === "A" || turn.speaker === "B"),
  ) ?? null;
}

export function rebuildDuetState(entries: PersistedDuetEntry[]): DuetState {
  let state = emptyDuet();
  for (const entry of entries) {
    if (isPersistedGate(entry)) state = applyDuetEvent(state, entry);
    else if (isPersistedProgress(entry)) state = applyDuetEvent(state, entry);
    else {
      const completed: DuetTurn = { ...entry, raised: !!entry.raised, events: entry.events ?? [], awaiting: false, done: true };
      const turns = [...state.turns];
      let replaced = false;
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index]!;
        if (turn.round !== completed.round || turn.speaker !== completed.speaker || turn.done) continue;
        // 旧 transcript 的回合行没有 events / images:别让落盘那份把实时攒到的执行过程和
        // 图片关联抹掉(关联没了,正文就只能退到「当前文件」那一档,见 turnImages)。
        turns[index] = {
          ...completed,
          events: completed.events.length ? completed.events : turn.events,
          images: completed.images ?? turn.images,
        };
        replaced = true;
        break;
      }
      state = { ...state, turns: replaced ? turns : [...turns, completed] };
    }
  }
  return state;
}
