// claude 单飞：常驻那条可引导的流上，一个回合 = 一个进程（`ClaudeExecutor.runSteerable` / 接管单飞）。
// 从 claude.ts 拆出来的（那份逼近 700 行），内容没动；为什么要等后台、怎么收台见下面 `singleRunFromResident`。
import type { AgentEvent } from "@ash/shared";
import type { ResidentHandle, RunHandle } from "./types.js";
import type { StallVerdict } from "../turn-stall-verdict.js";
import { resolveSteerText, type SteerText } from "./steer-text.js";

/**
 * 单飞等后台工作最多等多久。工作流跑半小时到一小时很常见；到点还没跑完就收台，被收走的那几个
 * 照常记进时间线（claude-background-reaped.ts）。只认有限正数且不超过 setTimeout 的上限
 * （超了 Node 会按 1ms 触发，等于一进入等待就收台），坏值退回缺省。
 */
const BACKGROUND_HOLD_MS = (() => {
  const fallback = 2 * 60 * 60_000;
  const raw = process.env.ASH_BACKGROUND_HOLD_MS?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0 && value <= 2 ** 31 - 1) return value;
  console.warn(`[ash] ASH_BACKGROUND_HOLD_MS=${raw} 不是有效的毫秒数，按缺省 ${fallback} 处理`);
  return fallback;
})();

/**
 * 后台都跑完之后最多等多久让 CLI 开回合收尾。正常是立刻开(完成通知一到就开);等这么久还没开,
 * 就是主智能体这边出了问题,不再算后台的账。
 */
const WRAPUP_START_MS = 10 * 60_000;

/**
 * 单飞：一个回合 = 一个进程。回合 `result` 一到就关 stdin 收台 —— **除非名下还有后台子代理 /
 * 工作流没跑完**（turnEnd 带 `background`）。它们寄生在这个进程里，收了台就白跑了；而 CLI
 * 自己的口径是「后台的活没完，这一回合就没完」：`claude -p` 会一直压着结果，直到它们跑完、
 * 拿完成通知自己开一回合收尾（2026-11-06 实测）。所以这里照着等：进程留着、流接着读，任务
 * 仍是运行中，下一个不再带 `background` 的回合结尾才收台。等待期间插话照常送达（没有回合可
 * 打断，就直接送进去），停止照常杀进程；最多等 `BACKGROUND_HOLD_MS`。
 *
 * 等后台的期限只管「回合之间在等后台」这一段：开了下一回合（完成通知到了、主智能体开始整理
 * 结果，或者插话送进去）它就作废，那之后慢不慢归停滞看门狗管；那一回合结尾还有没跑完的再重新
 * 起算。作废靠回合身份（`resident.epoch` 对 turnEnd.epoch），不靠「新回合开始时回调一声」——
 * 结尾要排队才到这里，回调可能先跑，清掉的是还没建起来的那个定时器。同理，过期的结尾也不收台。
 *
 * 「后台跑完了」和「下一回合开始了」是两件事（自由审查 i8RAcPM3zvgD R2）：账本归零（最后一个
 * 完成通知到了）等后台的责任就结束，改成等 CLI 开回合收尾，最多 `wrapupMs`；判后台超时/丢失之前
 * 一律核对实时账本（`resident.backgroundPending`），跑完了就不能说成没跑完。
 *
 * 等到点还没跑完 = 这一轮的活没干完：硬杀进程（关 stdin 只是请它退出，它可以接着等自己的
 * 后台、一直不走），报一条真错误，并经 `failure()` 把「ash 判这一轮未完成」交给结算 —— 智能体
 * 可能早在发起后台工作那一回合就交过卷，不能让它落成完成。后台还没跑完进程就自己退了（哪怕
 * exit 0）同理，见 `done.unfinished`；后台跑完了却一直没开回合收尾（或者没开就退了）也同理，
 * 只是原因如实说成后者。
 */
export function singleRunFromResident(
  resident: ResidentHandle,
  detached?: RunHandle["detached"],
  holdMs = BACKGROUND_HOLD_MS,
  wrapupMs = WRAPUP_START_MS,
): RunHandle {
  let intermediateEnds = 0;
  let accepting = true;
  // 在等什么:`background` = 后台还有没跑完的;`wrapup` = 后台都跑完了,等 CLI 开回合收尾。
  // `epoch` 是开始等的那个结尾的回合身份,之后开了新回合这份等待就作废。
  let hold: { phase: "background" | "wrapup"; epoch: number | undefined; timer: ReturnType<typeof setTimeout> } | null = null;
  let verdict: StallVerdict | null = null;
  let stopped = false; // 用户停止:不另外判「后台没跑完」,停止自有它的结算
  const clearHold = () => {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  };
  const stale = (epoch: number | undefined) => epoch !== undefined && resident.epoch !== undefined && resident.epoch() !== epoch;
  // 这一刻还在等:等的那个回合之后没再开新回合。
  const holding = () => !!hold && !stale(hold.epoch);
  // 后台账本此刻怎么样。没有实时账本的常驻答不上来,按还在跑。
  const ledger = (): "pending" | "unknown" | "settled" => {
    const pending = resident.backgroundPending?.();
    if (!pending || pending.agent + pending.workflow > 0) return "pending";
    return pending.unknown ? "unknown" : "settled";
  };
  const judge = (kind: StallVerdict["kind"], reason: string): StallVerdict => {
    const at = new Date().toISOString();
    return { kind, reason, at, since: at, durable: false };
  };
  const fail = (failed: StallVerdict) => {
    verdict = failed;
    accepting = false;
    resident.kill();
  };
  const wait = (phase: "background" | "wrapup", epoch: number | undefined, ms: number) => {
    clearHold();
    const timer = setTimeout(() => {
      const current = hold;
      hold = null;
      if (stopped || !accepting || !current || stale(current.epoch)) return; // 已经不在等了
      if (current.phase === "wrapup") return fail(judge("wrapup_missing", wrapupTimeoutMessage(wrapupMs)));
      const state = ledger();
      if (state === "settled") return wait("wrapup", current.epoch, wrapupMs);
      fail(state === "unknown"
        ? judge("background_unverified", holdUnverifiedMessage(holdMs))
        : judge("background_timeout", holdTimeoutMessage(holdMs)));
    }, ms);
    timer.unref?.();
    hold = { phase, epoch, timer };
  };
  // 最后一个完成通知到了:等后台的责任到此为止,改等收尾。
  const reassess = () => {
    if (hold?.phase === "background" && holding() && ledger() === "settled") wait("wrapup", hold.epoch, wrapupMs);
  };
  const events = (async function* (): AsyncIterable<AgentEvent> {
    try {
      for await (const event of resident.events) {
        if (event.kind === "turnEnd") {
          // 插话打断出来的结尾:进程还要接着跑插话开的那一回合。接管回来的这一代没发过那次打断
          // (计数是 0),只能靠这个标记认。
          if (event.interrupted) {
            intermediateEnds = Math.max(0, intermediateEnds - 1);
            continue;
          }
          // 消费到它时已经开了新回合(CLI 自己开的,或者插话送进去了):这个结尾过期了,既不收台
          // 也不开始等,新回合的结尾再定。
          if (stale(event.epoch)) continue;
          if (intermediateEnds > 0) {
            intermediateEnds -= 1;
            continue;
          }
          clearHold();
          if (event.background) {
            // 期限从开始等的那一刻算,不随重启接管重新给满(起点由解析层落盘,见 claude-recovery.ts)。
            const since = Date.parse(event.background.since ?? "");
            wait("background", event.epoch, Number.isFinite(since) ? Math.max(0, holdMs - (Date.now() - since)) : holdMs);
            reassess(); // 排队到这里的这段时间里,它们可能已经全跑完了
            continue;
          }
          accepting = false;
          resident.close();
          yield { kind: "done", exitStatus: 0 };
          return;
        }
        if (event.kind === "done") {
          accepting = false;
          // 进程没了的那一刻账上还有没跑完的、跑没跑完说不准的:都不是跑完了。在等着的时候没了、
          // 账上却都跑完了:是没开回合收尾,不是后台丢了。
          if (!verdict && !stopped) {
            if (event.unfinished) {
              verdict = event.unfinished.unknown
                ? judge("background_unverified", BACKGROUND_UNVERIFIED_MESSAGE)
                : judge("background_lost", backgroundLostMessage(event.unfinished));
            } else if (holding()) {
              verdict = resident.backgroundPending
                ? judge("wrapup_missing", WRAPUP_LOST_MESSAGE)
                : judge("background_lost", backgroundLostMessage());
            }
          }
          const failed = verdict as StallVerdict | null; // 定时器回调里也会写,控制流分析看不见
          if (failed) yield { kind: "error", message: failed.reason };
        } else reassess();
        yield event;
        if (event.kind === "done") return;
      }
    } finally {
      clearHold();
    }
  })();
  return {
    sessionId: resident.sessionId,
    commandLine: resident.commandLine,
    launchCompact: resident.launchCompact,
    events,
    detached,
    failure: () => verdict,
    async steer(text: SteerText, beforeSend) {
      if (!accepting) throw new Error("Claude 当前回合已经结束");
      // 等后台工作的空档:没有回合可打断(打断一个空闲会话不会再吐 result,计数就错位了),
      // 消息直接送进去自己开一回合;那一回合的结尾照常判要不要接着等。
      if (resident.turnActive?.() === false) {
        await beforeSend?.();
        const body = await resolveSteerText(text);
        // 准备正文的这段 await 里,完成通知可能已经让 CLI 自己开了一回合:那就照忙碌那条路打断
        // 再送,而不是排在它后面(beforeSend 已经跑过,不再跑第二遍)。
        if (resident.turnActive?.() === false) {
          if (!resident.send(body)) throw new Error("Claude 没收下这条消息（stdin 已关闭，或记不下发送记录）");
          clearHold();
          return;
        }
        text = body;
        beforeSend = undefined;
      }
      intermediateEnds += 1;
      let interrupted = false;
      try {
        if (resident.steer) await resident.steer(text, () => { interrupted = true; }, beforeSend);
        else {
          resident.interrupt();
          interrupted = true;
          resident.send(await resolveSteerText(text));
        }
      } catch (error) {
        if (!interrupted) intermediateEnds = Math.max(0, intermediateEnds - 1);
        else {
          accepting = false;
          stopped = true; // 为了带着插话重开而杀,不是后台工作丢了
          clearHold();
          resident.kill();
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { nativeSteerRestart: true });
        }
        throw error;
      }
      // 插话开了新的一回合:要不要接着等后台,由那一回合的结尾重新判,旧的等待期限作废。
      clearHold();
    },
    kill() {
      accepting = false;
      stopped = true;
      clearHold(); // 停止 = 不再等后台,别让旧期限在进程退出前补报一条超时
      resident.kill();
    },
    cleanup: resident.cleanup,
  };
}

function backgroundLostMessage(unfinished?: { agent: number; workflow: number }): string {
  const parts = [
    unfinished?.workflow ? `${unfinished.workflow} 个工作流` : "",
    unfinished?.agent ? `${unfinished.agent} 个后台子代理` : "",
  ].filter(Boolean).join("、");
  return `后台工作${parts ? `（${parts}）` : ""}还没跑完，智能体进程就退出了，本回合按未完成结算。`;
}

const BACKGROUND_UNVERIFIED_MESSAGE =
  "重启接管时读不出之前的输出，确认不了后台工作跑没跑完，智能体进程就退出了，本回合按未完成结算。";

const holdTimeoutMessage = (ms: number) =>
  `后台工作等了 ${Math.round(ms / 60_000)} 分钟还没跑完，已收掉进程，本回合按未完成结算。`;

const holdUnverifiedMessage = (ms: number) =>
  `重启接管时读不出之前的输出，确认不了后台工作跑没跑完；等了 ${Math.round(ms / 60_000)} 分钟智能体也没接着干，已收掉进程，本回合按未完成结算。`;

const wrapupTimeoutMessage = (ms: number) =>
  `后台工作都跑完了，智能体等了 ${Math.round(ms / 60_000)} 分钟还没开始整理结果，已收掉进程，本回合按未完成结算。`;

const WRAPUP_LOST_MESSAGE = "后台工作都跑完了，智能体还没开始整理结果进程就退出了，本回合按未完成结算。";
