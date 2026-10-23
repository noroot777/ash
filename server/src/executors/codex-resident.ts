import {
  cleanupSettled, mergeCleanupResults, nothingToCollect, type CleanupResult,
} from "./kill.js";
import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "@ash/shared";
import type { ResidentHandle } from "./types.js";
import { sessionResumeFault } from "./session-lost.js";

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
  /**
   * 回收一个回合进程甩到后台的后代(幂等,`cleanup` 的单位)。
   * 返回三档结论 —— **只有 `empty` 才算收完**(见 executors/kill.ts 的 `CleanupResult`)。
   */
  finalizeTurn: (child: ChildProcess) => Promise<CleanupResult>;
}): ResidentHandle {
  let sessionId = params.initialSessionId;
  let commandLine = "";
  // 这个会话**起过而还没收尾**的回合进程。codex 的常驻是会话级的 —— 一个回合一个进程,所以
  // 「把这个句柄收干净」不等于「收掉当前这一个」:前面几轮 CLI 甩到后台的后代一样要收。
  // 以前这件事唯一的指望是 codex.ts 那个事件包装器,而它只在「事件流正常走到尽头 + 这条
  // thread 在桌面端可见」时才触发 —— 起跑失败、被杀、普通 exec 会话一条都走不到,于是句柄
  // 对外**没有任何**清理能力(第 1 轮审查 F1)。能力搬到句柄自己身上,`cleanup` 覆盖它起过
  // 的所有回合,且幂等。
  const unfinalized = new Set<ChildProcess>();
  // **这里曾经有一个「最多攒 16 轮,超了先收最老那一轮」的淘汰**,为的是不让长命调度台无限
  // 攒 ChildProcess 引用。它被删掉了:`finalizeTurn` 做的事是 `cleanupAfterRun` ——
  // 按继承 fd 反查并杀掉那一轮甩到后台的**所有**后代。调度台恰恰是「第 3 轮起一个服务,
  // 第 20 轮还在用它」的典型,第 17 轮一到就会把那个服务连根杀掉,而且是静默的:内存上限
  // 不能用「杀掉还在用的资源」去换(第 2 轮审查 F4)。
  //
  // 代价如实记下:一条活很久的调度台会把它起过的每个回合进程对象留到会话结束。单个对象是
  // 一个 EventEmitter 加几个已经 EOF 的 stdio 流,量级上远小于「误杀用户服务」的代价。
  // 真要给引用量设上限,方向是把每轮要记的东西**瘦成租约**(pid + 启动时间 + 追踪文件路径,
  // 不持有对象),而不是把 16 改成一个更大的常数 —— 换个常数只是把同一个误杀推迟到更后面。
  // 「这一轮收过了」的凭据是**那次清理真的做完了**,不是「从册上划掉了」。划掉早于 await
  // 时有两个缺口:另一个 cleanup 看到册上没它就直接返回,其实清理还在途(它以为收完了);
  // 清理失败时它也已经不在册上,再没有人会重试(第 2 轮审查 N1)。所以在途的那个 Promise
  // 本身就是凭据 —— 同一轮的并发调用等同一份,成功才注销,失败留在册上等下一次 cleanup。
  const inflight = new Map<ChildProcess, Promise<CleanupResult>>();
  const finalizeTurn = (child: ChildProcess): Promise<CleanupResult> => {
    const pending = inflight.get(child);
    if (pending) return pending;
    // 待收册上压根没有它 ⇒ 没有要收的东西(资源缺,见 cleanup-result.ts 顶部)。走工厂而不
    // 是 `as CleanupResult`:断言能绕过那道「手上有名单就答不出空」的闸(检查脚本也拦它)。
    if (!unfinalized.has(child)) return Promise.resolve(nothingToCollect());
    const run = (async (): Promise<CleanupResult> => {
      try {
        const result = await params.finalizeTurn(child);
        // **「这一轮收过了」的凭据是「确证清空」,不是「这个函数 resolve 了」**(本轮审查
        // F2):`remaining`/`unknown` 两档说的恰恰是「还有东西在,或者这一轮没问清楚」,
        // 把它们当成收完就等于亲手把待收册上那条唯一的线索划掉 —— 下一次 cleanup 看到
        // 册上没它便直接返回,没有任何人会再来追。所以这两档**留在册上**。
        if (cleanupSettled(result)) unfinalized.delete(child);
        return result;
      } catch (error) {
        console.warn("[ash] 回收 codex 常驻回合的后代失败(留在册上,下一次 cleanup 再试):", error);
        return {
          kind: "unknown", detail: error instanceof Error ? error.message : String(error),
          // 清理本身抛了异常:这一轮一个号都没点上来,名单只能是空的(它的责任由「留在
          // 待收册上」背着 —— 下一次 cleanup 会重新取证)。
          open: [],
        };
      }
    })().finally(() => {
      inflight.delete(child);
    });
    inflight.set(child, run);
    return run;
  };
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
    unfinalized.add(turn.child);
    current = turn;
    commandLine = turn.commandLine;
    return { turn, hadSession };
  }

  /** 把一个回合的事件转发出去。done 换成 turnEnd —— 流不能在这里断。 */
  async function consumeTurn(turn: CodexTurn, hadSession: boolean): Promise<void> {
    let receivedSessionThisTurn = false;
    let poisonedThisTurn = false;
    try {
      for await (const event of turn.events) {
        if (event.kind === "session") {
          receivedSessionThisTurn = true;
          sessionId = event.cliSessionId;
          emit(event);
          continue;
        }
        // 上层通过异步 outbox 消费事件；若用户消息已经排在 waiting 里，等上层收到
        // poisoned 诊断再 dropSession 就晚了，pump 会先 resume 一次。故在 resident
        // 自己转发诊断前同步作废，保证紧接着的排队回合也 fresh。
        if (event.kind === "error" && sessionResumeFault(event.message) === "poisoned") {
          poisonedThisTurn = true;
          sessionId = "";
        }
        // 进程退出对「会话级常驻」只是一个回合说完了,不是调度台没了。
        if (event.kind === "done") continue;
        emit(event);
      }
    } catch (error) {
      emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
    current = null;
    if (!hadSession && !sessionId && !receivedSessionThisTurn && !poisonedThisTurn && !warnedSessionLost) {
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
      // 收尾中/已结束就明确拒收:排进 waiting 也没人会跑它了(见 ResidentHandle.send)。
      if (ended || closing) return false;
      waiting.push(text);
      void pump();
      return true;
    },
    // codex 没有 claude 那种 control_request:打断 = 杀掉当前回合的进程。
    // stopRequested 让 parseCodexStream 把这次非零退出当预期结果,不报成故障。
    interrupt: () => {
      const turn = current;
      if (!turn) return;
      turn.lifecycle.stopRequested = true;
      params.killTurn(turn.child);
    },
    // 当前回合已经结束、上层从诊断确认恢复 thread 有问题时调用。只清闭包里的 id，
    // 排队中的下一条消息照常由 pump 起跑，但 startTurn 会收到空串并开新 thread。
    dropSession: () => {
      sessionId = "";
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
    // 幂等 finalizer:覆盖这个句柄起过的**每一个**回合进程的后代,不只是当前那一轮
    // (kill() 管的才是当前那一轮的进程本体)。无主回合的收尾就靠它(runs.ts
    // `finalizeAbandonedRun`),单飞原生常驻则由消费循环的 finally 调用。
    cleanup: async (): Promise<CleanupResult> => {
      const results = await Promise.all([...unfinalized].map((child) => finalizeTurn(child)));
      // 整个句柄的结论是**最保守的那一档**:任何一轮还没收干净,这个句柄就不算收干净。
      return mergeCleanupResults(results);
    },
  };
}
