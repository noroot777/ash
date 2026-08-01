import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "@harness/shared";
import type { ResidentHandle } from "./types.js";

// ── codex 的常驻会话:「会话级常驻」,不是「进程级常驻」────────────────────
//
// claude 的常驻靠 `--input-format stream-json`:一个进程活着,消息一行行喂进
// stdin。**codex exec 没有这根管子** —— 它的 stdin 就是一次性 prompt,读完即关。
// 但 `ResidentHandle` 的契约要的是**会话不断**,不是**进程不断**:events 直到
// close()/kill() 才结束、send 进来的消息落进同一个会话、sessionId 全程同一个。
// 这三条用 `codex exec resume <thread_id>` 都满足得了 —— 每个回合起一个进程,
// 会话在 codex 自己的 thread 里连着。
//
// ── 实测结论(codex-cli 0.144.0,别再试一遍)────────────────────────────────
// ①连着三个回合 `exec resume <tid>`,thread_id 一次没变,上下文正常累积
//   (记住 4217 → 答 4217 → 加一答 4218)。
// ②中途 SIGTERM 打断的回合只留下 thread.started/turn.started(没有
//   turn.completed),但**会话本身完好**:下一个 resume 照常接上,连打断前记住
//   的东西都还在。
// ③首回合的 thread_id 得等 CLI 自己生成(`codex exec` 没有 `--session-id` 这类
//   预指定选项),所以 sessionId 初始为空、靠 `{kind:"session"}` 事件回填 ——
//   team/session.ts 本来就在做这件事(它要拿它更新 resumeCommand)。
//
// 由此带来的、对上层可见的两处差异(是取舍,不是 bug):
//   • **interrupt() 是硬杀**。claude 有原生 control_request,能让被打断的回合
//     体面收尾;codex 只能杀进程,所以打断那一刻它正在写的文件不会回滚。
//   • **回合之间没有进程赖着**,团队那套「空闲回收进程」对 codex 是空操作。

/** 一个回合的产物:进程 + 这次实际发出去的命令行(展示用)。 */
export interface CodexTurn {
  child: ChildProcess;
  commandLine: string;
  lifecycle: { stopRequested: boolean };
  events: AsyncIterable<AgentEvent>;
}

export function openCodexResident(params: {
  /** 续跑已有会话时传进来;首次为空,等 CLI 生成。 */
  initialSessionId: string;
  initialPrompt: string;
  /** 起一个回合。sessionId 为空 = 新会话,非空 = `exec resume <sid>`。 */
  startTurn: (prompt: string, sessionId: string) => CodexTurn;
  /** 硬杀一个回合进程(走三层击杀)。 */
  killTurn: (child: ChildProcess) => void;
}): ResidentHandle {
  let sessionId = params.initialSessionId;
  let commandLine = "";
  // 回合排队:codex 一次只跑一个回合,回合进行中来的消息攒着,结束后依次送。
  const waiting: string[] = [];
  let current: CodexTurn | null = null;
  let closing = false;
  let ended = false;
  // 首回合还没拿到 thread_id 就失败的话,后面的回合会开成**全新会话**(上下文
  // 断了)。这件事不能闷着办 —— 只报一次,免得每回合刷屏。
  let warnedSessionLost = false;

  const outbox: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  const emit = (event: AgentEvent) => {
    outbox.push(event);
    wake?.();
    wake = null;
  };

  /**
   * 同步起一个回合(spawn + 记下命令行)。**同步**这件事是有讲究的:
   * team/session.ts 在 openResident() 一返回就读 `commandLine` 写进 sessions
   * 表,晚一个微任务它存进去的就是空串。
   */
  function beginTurn(prompt: string): { turn: CodexTurn; hadSession: boolean } {
    const hadSession = !!sessionId;
    const turn = params.startTurn(prompt, sessionId);
    current = turn;
    commandLine = turn.commandLine;
    return { turn, hadSession };
  }

  /** 把一个回合的事件转发出去。done 换成 turnEnd —— 流不能在这里断。 */
  async function consumeTurn(turn: CodexTurn, hadSession: boolean): Promise<void> {
    try {
      for await (const event of turn.events) {
        if (event.kind === "session") {
          sessionId = event.cliSessionId;
          emit(event);
          continue;
        }
        // 进程退出对「会话级常驻」只是一个回合说完了,不是调度台没了。
        if (event.kind === "done") continue;
        emit(event);
      }
    } catch (error) {
      emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
    current = null;
    if (!hadSession && !sessionId && !warnedSessionLost) {
      warnedSessionLost = true;
      emit({
        kind: "error",
        message: "codex 没有报出会话 id(thread.started),这一轮之后的消息会开一个新会话,上下文接不上。",
      });
    }
    emit({ kind: "turnEnd" });
  }

  /**
   * 串行泵:一个回合接一个回合,队列空了就停下等 send。
   * 首次调用同步跑到 `beginTurn` 之后(async 函数体在第一个 await 前是同步的),
   * 所以 openCodexResident 返回时 sessionId/commandLine 已经就位。
   */
  let pumping = false;
  async function pump(): Promise<void> {
    if (pumping) return; // 已经在跑了,它自己会把队列抽干
    pumping = true;
    try {
      let next = waiting.shift();
      while (next !== undefined && !ended) {
        const { turn, hadSession } = beginTurn(next);
        await consumeTurn(turn, hadSession);
        next = waiting.shift();
      }
    } finally {
      pumping = false;
    }
    // close() 等的就是这一刻:手头活干完了,可以收摊。
    if (closing && !waiting.length) finish();
  }

  const finish = () => {
    if (ended) return;
    ended = true;
    wake?.();
    wake = null;
  };

  waiting.push(params.initialPrompt);
  void pump();

  async function* stream(): AsyncIterable<AgentEvent> {
    while (true) {
      if (outbox.length) {
        yield outbox.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  return {
    // getter:codex 的 thread_id 是 CLI 生成的,首回合结束前还没出生 ——
    // 调用方读到的必须是最新值,不是构造那一刻的快照。
    get sessionId() {
      return sessionId;
    },
    get commandLine() {
      return commandLine;
    },
    events: stream(),
    send: (text: string) => {
      if (ended || closing) return;
      waiting.push(text);
      void pump();
    },
    // codex 没有 claude 那种 control_request:打断 = 杀掉当前回合的进程。
    // stopRequested 让 parseCodexStream 把这次非零退出当预期结果,不报成故障。
    interrupt: () => {
      const turn = current;
      if (!turn) return;
      turn.lifecycle.stopRequested = true;
      params.killTurn(turn.child);
    },
    // 优雅收尾:不再收新消息,手头这轮跑完就结束事件流。
    close: () => {
      if (ended) return;
      closing = true;
      if (!current && !waiting.length) finish();
    },
    kill: () => {
      closing = true;
      waiting.length = 0;
      const turn = current;
      if (turn) {
        turn.lifecycle.stopRequested = true;
        params.killTurn(turn.child);
      }
      finish();
    },
  };
}
